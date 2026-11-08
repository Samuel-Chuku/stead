import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generatePrivateKey } from "viem/accounts";

// A won top-up: retried while nothing was broadcast, never sent twice, never started too close
// to the deadline (a late supply would be a gift to the borrower).
const ev = vi.hoisted(() => ({
  attempts: 0,
  broadcasts: 0,
  failBeforeBroadcast: 0, // how many attempts fail in the pre-flight (nothing sent)
  failAfterBroadcast: false, // the supply is sent, then the receipt wait fails
  asset: "",
}));

vi.mock("../src/near.js", () => ({
  NEAR: 10n ** 24n,
  TGAS: 10n ** 12n,
  view: vi.fn(async (method: string) => {
    if (method === "get_position") return { evm_address: "0x00000000000000000000000000000000000000aa" };
    if (method === "get_market") return { collateral: "0x29f2d40b0605204364af54ec677bd022da425d03", debt: "0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357", collateral_decimals: 8, debt_decimals: 18, gas_limit_cap: "600000", lt_bps: 7800 };
    throw new Error(`unexpected view ${method}`);
  }),
  call: vi.fn(),
}));
vi.mock("../src/intents.js", () => ({ sourceCapital: vi.fn(async () => 0n) }));
vi.mock("../src/fork.js", async (orig) => {
  const real = await orig<typeof import("../src/fork.js")>();
  return {
    ...real,
    pub: { readContract: vi.fn(async (q: { functionName: string }) => (q.functionName === "symbol" ? "WBTC" : real.MAX)) },
    write: vi.fn(async (_w: unknown, _a: unknown, _abi: unknown, fn: string, args: unknown[], onSent?: (h: string) => void) => {
      if (fn !== "supply") throw new Error(`unexpected write ${fn}`);
      ev.asset = String(args[0]);
      ev.attempts++;
      if (ev.attempts <= ev.failBeforeBroadcast) throw new Error("execution reverted: ERC20: transfer amount exceeds allowance");
      ev.broadcasts++;
      onSent?.("0xsupply");
      if (ev.failAfterBroadcast) throw new Error("timed out waiting for the receipt");
      return "0xsupply";
    }),
  };
});

const { Steward } = await import("../src/steward.js");

const S = 1_000_000_000n;
const rescue = (deadlineInS: bigint) => ({
  id: 15,
  position_id: 12,
  state: "top_up_pending",
  topup_deadline: (BigInt(Date.now()) * 1_000_000n + deadlineInS * S).toString(),
  members: [{ steward: "alice.testnet", confirmed: false, premium_bps: 400, share_units: "63156329629666666667" }],
});
const topUp = (s: InstanceType<typeof Steward>, r: unknown) => (s as unknown as { onTopUp(r: unknown): Promise<void> }).onTopUp(r);

beforeEach(() => {
  Object.assign(ev, { attempts: 0, broadcasts: 0, failBeforeBroadcast: 0, failAfterBroadcast: false, asset: "" });
  process.env.STEWARD_ACCOUNT = "alice.testnet";
  process.env.STEWARD_EVM_KEY = generatePrivateKey();
});
afterEach(() => {
  delete process.env.STEWARD_ACCOUNT;
  delete process.env.STEWARD_EVM_KEY;
});

describe("won top-up", () => {
  it("a supply refused before broadcast (a lagging RPC node) is retried on the next tick and lands once", async () => {
    ev.failBeforeBroadcast = 1;
    const s = new Steward("swift");
    const r = rescue(170n);
    await expect(topUp(s, r)).rejects.toThrow("exceeds allowance");
    await topUp(s, r);
    await topUp(s, r); // already supplied: nothing more
    expect(ev.attempts).toBe(2);
    expect(ev.broadcasts).toBe(1);
  });

  it("a supply that was broadcast is never sent again, even if waiting for it fails", async () => {
    ev.failAfterBroadcast = true;
    const s = new Steward("swift");
    const r = rescue(170n);
    await expect(topUp(s, r)).rejects.toThrow("receipt");
    await topUp(s, r);
    expect(ev.broadcasts).toBe(1);
  });

  it("no supply starts with less than 30 s to the deadline", async () => {
    const s = new Steward("swift");
    await topUp(s, rescue(20n));
    expect(ev.attempts).toBe(0);
    await topUp(s, rescue(60n));
    expect(ev.attempts).toBe(1);
  });

  it("supplies the market's collateral (here WBTC, 8 decimals), not a hard-coded asset", async () => {
    const s = new Steward("swift");
    await topUp(s, rescue(170n));
    expect(ev.asset.toLowerCase()).toBe("0x29f2d40b0605204364af54ec677bd022da425d03");
  });
});
