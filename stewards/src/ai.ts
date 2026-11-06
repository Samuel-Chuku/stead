// Optional AI risk tuning. Off unless an API key (or a base URL and model) is set.
// Every few minutes a steward asks a model for new RiskSettings. Any OpenAI-compatible
// chat-completions endpoint works (AI_BASE_URL, AI_API_KEY, AI_MODEL, AI_FALLBACK_MODEL); the
// default is NEAR AI Cloud, whose TEE-hosted models sign each response.
//
// With AI_REQUIRE_SIGNATURE on (the default), an answer is used only if the response signature
// checks out: the signed text must carry the SHA-256 of the exact request and response bytes, and
// the EIP-191 signer must equal the signing address the gateway reports. Only NEAR AI Cloud
// provides that today, so with another provider nothing is applied unless the operator switches
// AI_REQUIRE_SIGNATURE off; every such adjustment is then labelled UNVERIFIED. Either way the result
// is clamped to BOUNDS, and the contract still caps the premium of every bid.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { recoverMessageAddress, type Hex } from "viem";
import { env, hasEnv, REPO } from "./config.js";
import { BOUNDS, clamp, type RiskSettings } from "./risk.js";

export const NEAR_AI_BASE = "https://cloud-api.near.ai/v1";
/** NEAR AI defaults: the cheapest TEE-hosted model, then a fallback. */
export const MODELS = ["z-ai/glm-5.3-flash", "Qwen/Qwen3.6-35B-A3B-FP8"] as const;
const TIMEOUT_MS = 30_000;
const MAX_TOKENS = 250; // the answer is a ~100-token JSON object
const LOG_DIR = join(REPO, "stewards", "logs");

export interface AiConfig {
  base: string;
  host: string;
  key?: string;
  models: string[];
  /** "near-ai": the gateway signs responses; "none": the provider signs nothing. */
  attestation: "near-ai" | "none";
  requireSignature: boolean;
}

const opt = (name: string) => (hasEnv(name) ? env(name) : undefined);

export function aiConfig(): AiConfig {
  const base = (opt("AI_BASE_URL") ?? NEAR_AI_BASE).replace(/\/+$/, "");
  const host = new URL(base).host;
  const near = host === new URL(NEAR_AI_BASE).host;
  const model = opt("AI_MODEL");
  const fallback = opt("AI_FALLBACK_MODEL");
  const models = model ? [model, ...(fallback ? [fallback] : [])] : near ? [...MODELS] : [];
  return {
    base,
    host,
    // the old NEAR_AI_API_KEY name only ever goes to NEAR AI, never to another provider
    key: opt("AI_API_KEY") ?? (near ? opt("NEAR_AI_API_KEY") : undefined),
    models,
    attestation: near ? "near-ai" : "none",
    requireSignature: (opt("AI_REQUIRE_SIGNATURE") ?? "true").toLowerCase() !== "false",
  };
}

/** On with a key, or keyless only for a local server named explicitly (AI_BASE_URL and AI_MODEL,
 *  not NEAR AI). A base URL alone (as our compose file pins it) never switches it on. */
export function aiEnabled(): boolean {
  const c = aiConfig();
  if (c.models.length === 0) return false;
  if (c.key) return true;
  return c.attestation === "none" && hasEnv("AI_BASE_URL") && hasEnv("AI_MODEL");
}

/** A one-line warning when the settings can never apply anything, else undefined. */
export function aiWarning(): string | undefined {
  const c = aiConfig();
  if (c.requireSignature && c.attestation === "none")
    return `AI_REQUIRE_SIGNATURE is on but ${c.host} signs nothing: suggestions are logged, never applied`;
  if (!c.requireSignature) return `AI_REQUIRE_SIGNATURE is off: adjustments from ${c.host} apply UNVERIFIED (bounds and the contract cap still hold)`;
  return undefined;
}

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
  provider: string;
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
  /** The response signature checked out. */
  verified: boolean;
  /** Applied without a signature (AI_REQUIRE_SIGNATURE off). Always labelled UNVERIFIED. */
  applied_unverified?: boolean;
  error?: string;
  verify_url?: string;
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
      'steward\'s role. Change little unless recent outcomes or price moves justify it. Answer only with a JSON object: {"settings": {' +
      Object.keys(BOUNDS).join(", ") +
      '}, "reason": "<one sentence>"}.',
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

/** The model's JSON: the whole content, or the first {...} in it (providers without structured output). */
export function parseAnswer(content: unknown): { settings?: unknown; reason?: unknown } | undefined {
  if (content && typeof content === "object") return content as never;
  if (typeof content !== "string") return undefined;
  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    try {
      return m ? JSON.parse(m[0]) : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Structured output where the provider supports it, then plain JSON mode, then none. */
const FORMATS = [{ type: "json_schema", json_schema: { name: "risk_settings", strict: true, schema: SCHEMA } }, { type: "json_object" }, undefined];

async function ask(model: string, c: AiContext, conf: AiConfig): Promise<AiRecord> {
  const near = conf.attestation === "near-ai";
  const p = prompt(c);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (conf.key) headers.authorization = `Bearer ${conf.key}`;
  if (near) headers["x-no-aliasing"] = "true"; // NEAR AI: answer from exactly this model
  const rec: AiRecord = { at: new Date().toISOString(), steward: c.steward, provider: conf.host, model, before: c.current, applied: c.current, verified: false, verify_url: near ? verifyUrl(model) : undefined };

  let body = "";
  let res = { status: 0, text: "" };
  for (const format of FORMATS) {
    body = JSON.stringify({
      model,
      messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }],
      ...(format ? { response_format: format } : {}),
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
      // NEAR AI's reasoning models: answer directly instead of spending the budget thinking
      ...(near ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    });
    res = await fetchText(`${conf.base}/chat/completions`, { method: "POST", headers, body });
    if (res.status !== 400) break; // a 400 usually means this response_format isn't supported
  }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  const j = JSON.parse(res.text);
  rec.chat_id = j.id;
  const out = parseAnswer(j.choices?.[0]?.message?.content);
  rec.proposed = out?.settings;
  rec.reason = typeof out?.reason === "string" ? out.reason.slice(0, 300) : undefined;

  if (near) {
    // fetched at once: how long the gateway keeps a signature isn't documented
    const s = await fetchText(`${conf.base}/signature/${encodeURIComponent(j.id)}?signing_algo=ecdsa`, { headers: conf.key ? { authorization: `Bearer ${conf.key}` } : {} });
    const sig = s.status === 200 ? JSON.parse(s.text) : {};
    const chk = await checkSignature(model, body, res.text, sig);
    Object.assign(rec, { request_hash: chk.request_hash, response_hash: chk.response_hash, signature: sig.signature, signing_address: sig.signing_address, signature_kind: sig.signature_kind });
    rec.verified = chk.ok;
    if (!chk.ok) rec.error = chk.why ?? `signature HTTP ${s.status}`;
  } else {
    rec.request_hash = sha256(body);
    rec.response_hash = sha256(res.text);
    rec.error = `${conf.host} provides no response signature`;
  }

  if (!out?.settings || typeof out.settings !== "object") {
    rec.verified = false;
    rec.error = `no settings in the answer (finish_reason ${j.choices?.[0]?.finish_reason ?? "?"})`;
    return rec;
  }
  if (rec.verified) {
    rec.applied = clamp(out.settings as Partial<RiskSettings>, c.current);
  } else if (!conf.requireSignature) {
    rec.applied = clamp(out.settings as Partial<RiskSettings>, c.current);
    rec.applied_unverified = true;
  }
  return rec;
}

/** One adjustment: the primary model, then the fallback once. Never throws; an answer that may
 *  not be applied keeps the current settings. Every attempt is appended to logs/ai-<steward>.jsonl. */
export async function adjust(c: AiContext, conf: AiConfig = aiConfig()): Promise<AiRecord> {
  let last: AiRecord | undefined;
  for (const model of conf.models) {
    let rec: AiRecord;
    try {
      rec = await ask(model, c, conf);
    } catch (e) {
      rec = { at: new Date().toISOString(), steward: c.steward, provider: conf.host, model, before: c.current, applied: c.current, verified: false, error: (e as Error).message, verify_url: conf.attestation === "near-ai" ? verifyUrl(model) : undefined };
    }
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      appendFileSync(join(LOG_DIR, `ai-${c.steward}.jsonl`), JSON.stringify(rec) + "\n");
    } catch {
      /* logging must never stop the steward */
    }
    if (rec.verified || rec.applied_unverified) return rec;
    last = rec;
  }
  return last ?? { at: new Date().toISOString(), steward: c.steward, provider: conf.host, model: "-", before: c.current, applied: c.current, verified: false, error: "no model configured" };
}
