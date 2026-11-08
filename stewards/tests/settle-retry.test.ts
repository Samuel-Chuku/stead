import { describe, it, expect, vi, beforeEach } from "vitest";
import { generatePrivateKey } from "viem/accounts";

// The settler's repay: retried while nothing was broadcast, never sent twice.
const ev = vi.hoisted(() => ({ attempts: 0, broadcasts: 0, failBeforeBroadcast: 0, failAfterBroadcast: false }));

vi.mock("../src/near.js", () => ({
  NEAR: 10n ** 24n,
  TGAS: 10n ** 12n,
  view: vi.fn(async (method: string) => {
    if (method === "get_position") return { evm_address: "0x00000000000000000000000000000000000000aa" };
    if (method === "get_market") return { collateral: "0x29f2d40b0605204364af54ec677bd022da425d03", debt: "0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357", collateral_decimals: 8, debt_decimals: 18, gas_limit_cap: "600000", lt_bps: 7800 };
    if (method === "get_watch") return null;
    throw new Error(`unexpected view ${method}`);
  }),
  call: vi.fn(),
}));
vi.mock("../src/fork.js", async (orig) => {
  const real = await orig<typeof import("../src/fork.js")>();
  return {
    ...real,
    ensureTokens: vi.fn(async () => undefined),
    pub: { readContract: vi.fn(async (q: { functionName: string }) => (q.functionName === "symbol" ? "WBTC" : real.MAX)) },
    write: vi.fn(async (_w: unknown, _a: unknown, _abi: unknown, fn: string, _args: unknown[], onSent?: (h: string) => void) => {
      if (fn !== "repay") throw new Error(`unexpected write ${fn}`);
      ev.attempts++;
      if (ev.attempts <= ev.failBeforeBroadcast) throw new Error("execution reverted (stale node)");
      ev.broadcasts++;
      onSent?.("0xrepay");
      if (ev.failAfterBroadcast) throw new Error("timed out waiting for the receipt");
      return "0xrepay";
    }),
  };
});

const { Steward } = await import("../src/steward.js");
const settling = { id: 7, position_id: 12, state: "settling", settlement: { settler: "alice.testnet", repay_confirmed: false, repay_units: "1000", started_at: "0" } };
const go = (s: InstanceType<typeof Steward>) => (s as unknown as { onSettling(r: unknown): Promise<void> }).onSettling(settling);

beforeEach(() => {
  Object.assign(ev, { attempts: 0, broadcasts: 0, failBeforeBroadcast: 0, failAfterBroadcast: false });
  process.env.STEWARD_ACCOUNT = "alice.testnet";
  process.env.STEWARD_EVM_KEY = generatePrivateKey();
});

describe("settlement repay", () => {
  it("a repay refused before broadcast is retried and lands once", async () => {
    ev.failBeforeBroadcast = 1;
    const s = new Steward("deep");
    await expect(go(s)).rejects.toThrow("stale node");
    await go(s);
    await go(s);
    expect([ev.attempts, ev.broadcasts]).toEqual([2, 1]);
  });

  it("a broadcast repay is never sent again", async () => {
    ev.failAfterBroadcast = true;
    const s = new Steward("deep");
    await expect(go(s)).rejects.toThrow("receipt");
    await go(s);
    expect(ev.broadcasts).toBe(1);
  });
});
