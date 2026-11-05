// Optional AI risk tuning on NEAR AI Cloud (TEE-hosted models). Off unless NEAR_AI_API_KEY is set.
// Every few minutes a steward asks a model for new RiskSettings. The answer is used only if the
// response signature checks out: the signed text must carry the SHA-256 of the exact request and
// response bytes, and the EIP-191 signer must equal the signing address the gateway reports. The
// result is then clamped to BOUNDS; the contract still enforces its own limits on every bid.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { recoverMessageAddress, type Hex } from "viem";
import { env, hasEnv, REPO } from "./config.js";
import { BOUNDS, clamp, type RiskSettings } from "./risk.js";

const BASE = "https://cloud-api.near.ai/v1";
export const MODELS = ["z-ai/glm-5.3-flash", "Qwen/Qwen3.6-35B-A3B-FP8"] as const;
const TIMEOUT_MS = 30_000;
const LOG_DIR = join(REPO, "stewards", "logs");

export const aiEnabled = () => hasEnv("NEAR_AI_API_KEY");
const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
export const verifyUrl = (model: string) => `https://cloud.near.ai/verify?model=${encodeURIComponent(model)}`;

export interface AiContext {
  steward: string;
  role: string;
  current: RiskSettings;
  recent: { rescue: number; outcome: string; bps?: number; margin?: number }[];
  prices: { at: string; collateralUsd: number }[];
}

export interface AiRecord {
  at: string;
  steward: string;
  model: string;
  chat_id?: string;
  before: RiskSettings;
  proposed?: unknown;
  applied: RiskSettings;
  reason?: string;
  request_hash?: string;
  response_hash?: string;
  signature?: string;
  signing_address?: string;
  signature_kind?: string;
  verified: boolean;
  error?: string;
  verify_url: string;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["settings", "reason"],
  properties: {
    reason: { type: "string", maxLength: 300 },
    settings: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(BOUNDS),
      properties: Object.fromEntries(Object.entries(BOUNDS).map(([k, [lo, hi]]) => [k, { type: "number", minimum: lo, maximum: hi }])),
    },
  },
};

function prompt(c: AiContext): { system: string; user: string } {
  return {
    system:
      "You tune the risk settings of one steward bot in a liquidation-rescue market. Stewards bid a premium to top up a borrower's " +
      "collateral when the health factor falls below 1.15; the lowest premium wins and the contract caps the premium. Keep the " +
      "steward's role. Change little unless recent outcomes or price moves justify it. Answer only with the JSON object.",
    user: JSON.stringify({ steward: c.steward, role: c.role, current: c.current, bounds: BOUNDS, recent_auctions: c.recent, collateral_price_history: c.prices }),
  };
}

async function fetchText(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    return { status: r.status, text: await r.text() };
  } finally {
    clearTimeout(t);
  }
}

/** Check a gateway signature against our own hashes of the exact bytes. Pure apart from the
 *  signature recovery; exported for tests. */
export async function checkSignature(model: string, requestBody: string, responseBody: string, sig: { text?: string; signature?: string; signing_address?: string }): Promise<{ ok: boolean; why?: string; request_hash: string; response_hash: string }> {
  const request_hash = sha256(requestBody);
  const response_hash = sha256(responseBody);
  if (!sig.text || !sig.signature || !sig.signing_address) return { ok: false, why: "signature missing", request_hash, response_hash };
  const expected = [`${model}:${request_hash}:${response_hash}`, `${request_hash}:${response_hash}`];
  if (!expected.includes(sig.text)) return { ok: false, why: "signed text doesn't match our request/response hashes", request_hash, response_hash };
  const signer = await recoverMessageAddress({ message: sig.text, signature: sig.signature as Hex }).catch(() => undefined);
  if (!signer || signer.toLowerCase() !== sig.signing_address.toLowerCase()) return { ok: false, why: "signer doesn't match signing_address", request_hash, response_hash };
  return { ok: true, request_hash, response_hash };
}

async function ask(model: string, c: AiContext): Promise<AiRecord> {
  const key = env("NEAR_AI_API_KEY");
  const p = prompt(c);
  const body = JSON.stringify({
    model,
    messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }],
    response_format: { type: "json_schema", json_schema: { name: "risk_settings", strict: true, schema: SCHEMA } },
    temperature: 0.2,
    max_tokens: 400,
  });
  const rec: AiRecord = { at: new Date().toISOString(), steward: c.steward, model, before: c.current, applied: c.current, verified: false, verify_url: verifyUrl(model) };
  const res = await fetchText(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-no-aliasing": "true" },
    body,
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  const j = JSON.parse(res.text);
  rec.chat_id = j.id;
  // the signature is fetched at once: how long the gateway keeps it isn't documented
  const s = await fetchText(`${BASE}/signature/${encodeURIComponent(j.id)}?signing_algo=ecdsa`, { headers: { authorization: `Bearer ${key}` } });
  const sig = s.status === 200 ? JSON.parse(s.text) : {};
  const chk = await checkSignature(model, body, res.text, sig);
  Object.assign(rec, { request_hash: chk.request_hash, response_hash: chk.response_hash, signature: sig.signature, signing_address: sig.signing_address, signature_kind: sig.signature_kind });
  const content = j.choices?.[0]?.message?.content;
  const out = typeof content === "string" ? JSON.parse(content) : content;
  rec.proposed = out?.settings;
  rec.reason = typeof out?.reason === "string" ? out.reason.slice(0, 300) : undefined;
  if (!chk.ok) {
    rec.error = chk.why ?? `signature HTTP ${s.status}`;
    return rec; // unverified: never applied
  }
  if (!out?.settings || typeof out.settings !== "object") {
    rec.error = "no settings in the answer";
    return rec;
  }
  rec.applied = clamp(out.settings, c.current);
  rec.verified = true;
  return rec;
}

/** One adjustment: primary model, then the fallback once. Never throws; an unverified or failed
 *  answer keeps the current settings. Every attempt is appended to logs/ai-<steward>.jsonl. */
export async function adjust(c: AiContext): Promise<AiRecord> {
  let last: AiRecord | undefined;
  for (const model of MODELS) {
    let rec: AiRecord;
    try {
      rec = await ask(model, c);
    } catch (e) {
      rec = { at: new Date().toISOString(), steward: c.steward, model, before: c.current, applied: c.current, verified: false, error: (e as Error).message, verify_url: verifyUrl(model) };
    }
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      appendFileSync(join(LOG_DIR, `ai-${c.steward}.jsonl`), JSON.stringify(rec) + "\n");
    } catch {
      /* logging must never stop the steward */
    }
    if (rec.verified) return rec;
    last = rec;
  }
  return last!;
}
