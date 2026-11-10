// Undercutting: deep and swift re-bid one step below the best when outbid, never under their floor,
// at most three times, never in the last 5 s, never above the cap. Offline.
import { describe, expect, it } from "vitest";
import { undercut, UNDERCUT, type StandingBid } from "../src/strategy.js";
import { DEFAULTS } from "../src/risk.js";

const S = 1_000_000_000n;
const open = { capBps: 1041, closesAtNs: 100n * S, nowNs: 60n * S }; // 40 s left
const bids = (...b: [string, number, number][]): StandingBid[] => b.map(([steward, premium_bps, seq]) => ({ steward, premium_bps, seq }));
const DEEP = "deep.steadfi.testnet";

describe("undercut", () => {
  it("re-bids one step below the best bid ahead of it", () => {
    const r = undercut("deep", DEEP, bids([DEEP, 150, 1], ["hedged.steadfi.testnet", 130, 2]), open, DEFAULTS.deep, 0);
    expect(r?.bps).toBe(125);
  });

  it("never goes under its floor (70 % of its spread); at the floor it stays", () => {
    expect(undercut("deep", DEEP, bids([DEEP, 150, 1], ["hedged.steadfi.testnet", 63, 2]), open, DEFAULTS.deep, 0)?.bps).toBe(105);
    expect(undercut("deep", DEEP, bids([DEEP, 105, 3], ["hedged.steadfi.testnet", 63, 2]), open, DEFAULTS.deep, 1)).toBeNull();
    expect(undercut("swift", "swift.steadfi.testnet", bids(["swift.steadfi.testnet", 400, 1], [DEEP, 150, 2]), open, DEFAULTS.swift, 0)?.bps).toBe(280);
  });

  it("at most three re-bids per auction", () => {
    const b = bids([DEEP, 140, 4], ["swift.steadfi.testnet", 130, 5]);
    expect(undercut("deep", DEEP, b, open, DEFAULTS.deep, UNDERCUT.maxRebids - 1)?.bps).toBe(125);
    expect(undercut("deep", DEEP, b, open, DEFAULTS.deep, UNDERCUT.maxRebids)).toBeNull();
  });

  it("no re-bid in the last 5 seconds", () => {
    const late = { ...open, nowNs: 96n * S };
    expect(undercut("deep", DEEP, bids([DEEP, 150, 1], ["hedged.steadfi.testnet", 130, 2]), late, DEFAULTS.deep, 0)).toBeNull();
  });

  it("only deep and swift undercut", () => {
    for (const n of ["patient", "pool", "hedged"] as const)
      expect(undercut(n, `${n}.steadfi.testnet`, bids([`${n}.steadfi.testnet`, 300, 1], [DEEP, 150, 2]), open, DEFAULTS[n], 0)).toBeNull();
  });

  it("no re-bid when already best; a tie placed earlier ranks ahead", () => {
    expect(undercut("deep", DEEP, bids([DEEP, 150, 1], ["swift.steadfi.testnet", 400, 2]), open, DEFAULTS.deep, 0)).toBeNull();
    expect(undercut("deep", DEEP, bids([DEEP, 150, 1], ["hedged.steadfi.testnet", 150, 2]), open, DEFAULTS.deep, 0)).toBeNull(); // mine came first
    expect(undercut("deep", DEEP, bids([DEEP, 150, 3], ["hedged.steadfi.testnet", 150, 2]), open, DEFAULTS.deep, 0)?.bps).toBe(145);
  });

  it("never above the auction's cap, and never under its floor to fit one", () => {
    expect(undercut("deep", DEEP, bids([DEEP, 150, 1], ["hedged.steadfi.testnet", 130, 2]), { ...open, capBps: 140 }, DEFAULTS.deep, 0)?.bps).toBe(125);
    const tight = { ...open, capBps: 100 };
    expect(undercut("swift", "swift.steadfi.testnet", bids(["swift.steadfi.testnet", 400, 1], [DEEP, 380, 2]), tight, DEFAULTS.swift, 0)).toBeNull(); // floor 280 > cap 100: it stays rather than price under its floor
  });
});
