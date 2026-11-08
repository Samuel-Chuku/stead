import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generatePrivateKey } from "viem/accounts";

// The contract as the steward sees it: roles, removals, the deposit, and the calls it makes.
const chain = vi.hoisted(() => ({
  stewards: [] as string[],
  removed: [] as string[],
  payouts: {} as Record<string, string>,
  calls: [] as { signer: string; method: string; args: Record<string, unknown>; deposit?: bigint }[],
}));

vi.mock("../src/near.js", () => ({
  NEAR: 10n ** 24n,
  TGAS: 10n ** 12n,
  view: vi.fn(async (method: string, args: Record<string, unknown> = {}) => {
    if (method === "get_roles") return ["steadfi.testnet", [], chain.stewards, false];
    if (method === "get_removed_stewards") return chain.removed;
    if (method === "get_steward_deposit") return "5000000000000000000000";
    if (method === "get_evm_payout") return chain.payouts[args.account_id as string] ?? null;
    throw new Error(`unexpected view ${method}`);
  }),
  call: vi.fn(async (signer: string, method: string, args: Record<string, unknown>, opts: { deposit?: bigint } = {}) => {
    chain.calls.push({ signer, method, args, deposit: opts.deposit });
    if (method === "register_steward") chain.stewards.push(signer);
    return { hash: "0xhash", logs: [] };
  }),
}));

const { Steward } = await import("../src/steward.js");
const { DEFAULTS, BOUNDS } = await import("../src/risk.js");

const ENV = ["STEWARD_ACCOUNT", "STEWARD_EVM_KEY", "STEWARD_SETTINGS", "STEWARD_CAPACITY", "STEWARD_AUTO_REGISTER", "STEWARD_DEEP_EVM_KEY"];
beforeEach(() => {
  chain.stewards = [];
  chain.removed = [];
  chain.payouts = {};
  chain.calls = [];
  for (const k of ENV) delete process.env[k];
  process.env.STEWARD_ACCOUNT = "alice.testnet";
  process.env.STEWARD_EVM_KEY = generatePrivateKey();
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

describe("steward start-up", () => {
  it("an outside account registers itself with the deposit, paying out to its own wallet", async () => {
    const s = new Steward("deep");
    expect(s.account).toBe("alice.testnet");
    expect(await s.ensureRegistered()).toBe("steward");
    expect(chain.calls).toEqual([{ signer: "alice.testnet", method: "register_steward", args: { payout: s.evm.address }, deposit: 5_000_000_000_000_000_000_000n }]);
    // a second start doesn't register again
    chain.payouts["alice.testnet"] = s.evm.address;
    await s.ensureRegistered();
    expect(chain.calls).toHaveLength(1);
  });

  it("a steward removed by the owner never re-registers", async () => {
    chain.removed = ["alice.testnet"];
    const s = new Steward("swift");
    expect(await s.ensureRegistered()).toBe("removed");
    expect(chain.calls).toEqual([]);
  });

  it("refuses to spend the deposit when auto-registration is off", async () => {
    process.env.STEWARD_AUTO_REGISTER = "false";
    await expect(new Steward("pool").ensureRegistered()).rejects.toThrow("not a steward");
    expect(chain.calls).toEqual([]);
  });

  it("a registered steward without a payout sets one", async () => {
    chain.stewards = ["alice.testnet"];
    const s = new Steward("patient");
    await s.ensureRegistered();
    expect(chain.calls.map((c) => [c.method, c.args])).toEqual([["set_evm_payout", { address: s.evm.address }]]);
  });

  it("STEWARD_SETTINGS overrides are clamped to the same bounds as any other change", () => {
    process.env.STEWARD_SETTINGS = JSON.stringify({ spreadBps: 1, shareFraction: 0.5, bidDelayS: 999 });
    const s = new Steward("deep");
    expect(s.settings).toEqual({ ...DEFAULTS.deep, spreadBps: BOUNDS.spreadBps[0], shareFraction: 0.5, bidDelayS: BOUNDS.bidDelayS[1] });
  });

  it("our own stewards keep their names and per-name keys", () => {
    delete process.env.STEWARD_ACCOUNT;
    delete process.env.STEWARD_EVM_KEY;
    process.env.STEWARD_DEEP_EVM_KEY = generatePrivateKey();
    const s = new Steward("deep");
    expect(s.account).toBe("deep.steadfi.testnet");
    expect(s.settings).toEqual(DEFAULTS.deep);
  });
});
