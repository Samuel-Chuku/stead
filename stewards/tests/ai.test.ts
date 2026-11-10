import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { clamp, BOUNDS, DEFAULTS, type RiskSettings } from "../src/risk.js";
import { checkSignature, adjust, MODELS, aiConfig, aiWarning, parseAnswer } from "../src/ai.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const signer = privateKeyToAccount(generatePrivateKey());

describe("risk settings clamp", () => {
  it("keeps every field in bounds for hostile values", () => {
    const hostile = { spreadBps: 1e9, minMargin: -5, minTopupUsd: Infinity, shareFraction: 7, bidDelayS: -1 };
    const out = clamp(hostile, DEFAULTS.deep);
    for (const k of Object.keys(BOUNDS) as (keyof RiskSettings)[]) {
      if (k === "minTopupUsd") continue; // Infinity is not finite: keeps the base value
      expect(out[k]).toBeGreaterThanOrEqual(BOUNDS[k][0]);
      expect(out[k]).toBeLessThanOrEqual(BOUNDS[k][1]);
    }
    expect(out.minTopupUsd).toBe(DEFAULTS.deep.minTopupUsd);
  });
  it("ignores non-numbers and unknown fields", () => {
    const out = clamp({ spreadBps: "9999" as unknown as number, evil: 1 } as never, DEFAULTS.pool);
    expect(out).toEqual(DEFAULTS.pool);
  });
});

describe("response signature check", () => {
  const model = MODELS[0];
  const req = '{"model":"m","messages":[]}';
  const resp = '{"id":"chat-1","choices":[]}';
  it("accepts a signature over our exact request and response hashes", async () => {
    const text = `${model}:${sha(req)}:${sha(resp)}`;
    const sig = { text, signature: await signer.signMessage({ message: text }), signing_address: signer.address };
    expect((await checkSignature(model, req, resp, sig)).ok).toBe(true);
  });
  it("rejects a tampered response body", async () => {
    const text = `${model}:${sha(req)}:${sha(resp)}`;
    const sig = { text, signature: await signer.signMessage({ message: text }), signing_address: signer.address };
    expect((await checkSignature(model, req, resp.replace("chat-1", "chat-2"), sig)).ok).toBe(false);
  });
  it("rejects a signer other than the reported signing address", async () => {
    const text = `${model}:${sha(req)}:${sha(resp)}`;
    const other = privateKeyToAccount(generatePrivateKey());
    const sig = { text, signature: await other.signMessage({ message: text }), signing_address: signer.address };
    expect((await checkSignature(model, req, resp, sig)).ok).toBe(false);
  });
  it("rejects a missing signature", async () => {
    expect((await checkSignature(model, req, resp, {})).ok).toBe(false);
  });
});

describe("adjust (network stubbed)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEAR_AI_API_KEY;
  });
  const ctx = { steward: "test", role: "test", current: DEFAULTS.deep, recent: [], prices: [] };

  function stub(proposal: object, signRight: boolean, reason = "adjust spread, margin, top-up, share and delay") {
    let reqBody = "";
    let respBody = "";
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.includes("/chat/completions")) {
        reqBody = init.body as string;
        const model = JSON.parse(reqBody).model;
        respBody = JSON.stringify({ id: "chat-x", model, choices: [{ message: { content: JSON.stringify({ settings: proposal, reason }) } }] });
        return new Response(respBody, { status: 200 });
      }
      const model = MODELS[0];
      const text = `${model}:${sha(reqBody)}:${sha(signRight ? respBody : respBody + " ")}`;
      return new Response(JSON.stringify({ text, signature: await signer.signMessage({ message: text }), signing_address: signer.address, signature_kind: "provider_tee" }), { status: 200 });
    });
  }

  it("a verified but ungrounded, out-of-range answer is rejected by the guard: settings kept, proposal logged", async () => {
    process.env.NEAR_AI_API_KEY = "test";
    stub({ ...DEFAULTS.deep, spreadBps: 99_999 }, true);
    const r = await adjust(ctx);
    expect(r.verified).toBe(true);
    expect(r.rejected).toBeTruthy();
    expect(r.applied).toEqual(DEFAULTS.deep);
    expect((r.proposed as { spreadBps: number }).spreadBps).toBe(99_999);
  });
  it("a verified, grounded, one-step answer is applied", async () => {
    process.env.NEAR_AI_API_KEY = "test";
    const lost = { ...ctx, steward: "deep", recent: [{ rescue: 12, outcome: "bid", bps: 150 }] };
    stub({ ...DEFAULTS.deep, spreadBps: 130 }, true, "Lower spreadBps to 130: outbid on rescue 12 at 150 bps.");
    const r = await adjust(lost);
    expect(r.verified).toBe(true);
    expect(r.rejected).toBeUndefined();
    expect(r.applied.spreadBps).toBe(130);
  });
  it("an answer whose signature doesn't cover the exact response is never applied", async () => {
    process.env.NEAR_AI_API_KEY = "test";
    stub({ ...DEFAULTS.deep, spreadBps: 900 }, false);
    const r = await adjust(ctx);
    expect(r.verified).toBe(false);
    expect(r.applied).toEqual(DEFAULTS.deep);
  });
  it("a network failure or timeout keeps the current settings", async () => {
    process.env.NEAR_AI_API_KEY = "test";
    vi.stubGlobal("fetch", async () => {
      throw new Error("aborted");
    });
    const r = await adjust(ctx);
    expect(r.verified).toBe(false);
    expect(r.applied).toEqual(DEFAULTS.deep);
  });
});

describe("any provider (OpenAI-compatible), require_signature", () => {
  const ENV = ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "AI_FALLBACK_MODEL", "AI_REQUIRE_SIGNATURE", "NEAR_AI_API_KEY"];
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV) delete process.env[k];
  });
  const ctx = { steward: "test", role: "test", current: DEFAULTS.deep, recent: [], prices: [] };

  /** A provider with no signature endpoint; records every request. */
  function other(proposal: object, opts: { rejectSchema?: boolean; text?: boolean } = {}) {
    const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body });
      if (opts.rejectSchema && body?.response_format?.type === "json_schema") return new Response('{"error":"unsupported response_format"}', { status: 400 });
      const answer = JSON.stringify({ settings: proposal, reason: "adjust spread, margin, top-up, share and delay" });
      const content = opts.text ? `Sure! Here you go:\n${answer}\nHope that helps.` : answer;
      return new Response(JSON.stringify({ id: "o-1", choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });
    });
    return calls;
  }

  it("defaults: NEAR AI, signature required", () => {
    process.env.NEAR_AI_API_KEY = "k";
    const c = aiConfig();
    expect(c.host).toBe("cloud-api.near.ai");
    expect(c.attestation).toBe("near-ai");
    expect(c.requireSignature).toBe(true);
    expect(c.models).toEqual([...MODELS]);
  });

  it("with the signature required, an unsigned provider's answer is logged, never applied", async () => {
    process.env.AI_BASE_URL = "https://api.example.com/v1";
    process.env.AI_API_KEY = "k";
    process.env.AI_MODEL = "some-model";
    const calls = other({ ...DEFAULTS.deep, spreadBps: 900 });
    const r = await adjust(ctx);
    expect(r.verified).toBe(false);
    expect(r.applied_unverified).toBeUndefined();
    expect(r.applied).toEqual(DEFAULTS.deep);
    expect(r.error).toMatch(/no response signature/);
    expect(calls.every((c) => !c.url.includes("/signature/"))).toBe(true);
    expect(aiWarning()).toMatch(/never applied/);
  });

  it("with the signature requirement off, any provider's answer is considered, labelled UNVERIFIED, and still guarded", async () => {
    process.env.AI_BASE_URL = "https://api.example.com/v1";
    process.env.AI_API_KEY = "k";
    process.env.AI_MODEL = "some-model";
    process.env.AI_REQUIRE_SIGNATURE = "false";
    other({ ...DEFAULTS.deep, spreadBps: 99_999 });
    const r = await adjust(ctx);
    expect(r.verified).toBe(false);
    expect(r.applied_unverified).toBe(true);
    // unsigned answers still go through the guard: this one is ungrounded and far out of range
    expect(r.rejected).toBeTruthy();
    expect(r.applied).toEqual(DEFAULTS.deep);
    expect(aiWarning()).toMatch(/UNVERIFIED/);
  });

  it("NEAR AI with the requirement off still never applies a bad signature as verified", async () => {
    process.env.NEAR_AI_API_KEY = "k";
    process.env.AI_REQUIRE_SIGNATURE = "false";
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("/chat/completions")
        ? new Response(JSON.stringify({ id: "n-1", choices: [{ message: { content: JSON.stringify({ settings: DEFAULTS.swift, reason: "x" }) } }] }), { status: 200 })
        : new Response("{}", { status: 404 }),
    );
    const r = await adjust(ctx);
    expect(r.verified).toBe(false);
    expect(r.applied_unverified).toBe(true);
  });

  it("the NEAR AI key is never sent to another provider", async () => {
    process.env.NEAR_AI_API_KEY = "near-secret";
    process.env.AI_BASE_URL = "http://localhost:11434/v1";
    process.env.AI_MODEL = "llama";
    const calls = other(DEFAULTS.deep);
    await adjust(ctx);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(JSON.stringify(c.headers)).not.toContain("near-secret");
    for (const c of calls) expect(c.headers["x-no-aliasing"]).toBeUndefined();
    for (const c of calls) expect(c.body?.chat_template_kwargs).toBeUndefined();
  });

  it("falls back to JSON mode when structured output is refused, and reads JSON out of prose", async () => {
    process.env.AI_BASE_URL = "https://api.example.com/v1";
    process.env.AI_API_KEY = "k";
    process.env.AI_MODEL = "m";
    process.env.AI_REQUIRE_SIGNATURE = "false";
    const calls = other({ ...DEFAULTS.deep, bidDelayS: 20 }, { rejectSchema: true, text: true });
    const r = await adjust(ctx);
    expect(calls.map((c) => c.body?.response_format?.type)).toEqual(["json_schema", "json_object"]);
    expect((r.proposed as { bidDelayS: number }).bidDelayS).toBe(20); // read out of the prose
  });

  it("parseAnswer finds the object in prose and rejects garbage", () => {
    expect(parseAnswer('ok {"settings":{"spreadBps":1},"reason":"r"} done')?.reason).toBe("r");
    expect(parseAnswer("no json here")).toBeUndefined();
  });
});
