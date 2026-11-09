import { describe, expect, it } from "vitest";
import { siteStats, worseOff, type RescueRec } from "../src/sitestats.js";

const S = 1_000_000_000n;
const r = (id: number, pos: number, state: string, bps: number[], o: Partial<RescueRec> = {}): RescueRec => ({
  id, position_id: pos, state, opened_at: (100n * S).toString(), claims_opened_at: (220n * S).toString(), cap_bps: 1000, topup_base: "100000",
  members: bps.map((b) => ({ steward: "deep.steadfi.testnet", premium_bps: b, premium_base: String(100000 * b / 10000) })), ...o,
});

describe("homepage totals", () => {
  it("counts only finished rescues on real chains and keeps fork runs apart", () => {
    const s = siteStats([
      { contract: "a", rescues: [r(0, 0, "bought_back", [150]), r(1, 1, "settled", [268]), r(2, 1, "failed", [400]), r(3, 1, "auction", [])], positionMarket: { 0: 0, 1: 1 }, marketChain: { 0: 31337, 1: 11155111 } },
      { contract: "b", rescues: [r(0, 0, "settled", [100, 150])], positionMarket: { 0: 2 }, marketChain: { 2: 11155111 } },
    ]);
    expect(s).toMatchObject({ rescues: 2, settled: 2, boughtBack: 0, forkRescues: 1, chains: [11155111], worseOff: 0, medianPremiumBps: 184, medianTriggerToClaimS: 120 });
  });

  it("flags a rescue whose premiums exceed the contract's cap, and only that", () => {
    expect(worseOff(r(0, 0, "settled", [1000]))).toBe(false);
    expect(worseOff(r(0, 0, "settled", [600, 600]))).toBe(true);
  });
});
