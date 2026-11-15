import { describe, it, expect } from "vitest";
import { payItsWay, rescueGasUsd, gasFloorBps, type AuctionView, type Decision } from "../src/strategy.js";

// A real pooled rescue on Ethereum mainnet: a $17.18 top-up (0.00966 WETH), cap 574 bps.
const a: AuctionView = {
  capBps: 574,
  topupUnits: 9_659_920_852_372_862n,
  topupBase: 1_717_623_250n,
  openedAtNs: 0n,
  closesAtNs: 120n * 10n ** 9n,
  nowNs: 60n * 10n ** 9n,
  netHf: 1.13,
  ltBps: 8400,
  debtBase: 3_949_064_924n,
  earlyHf: 1.1,
};
const share = 6_000_000_000_000_000n; // 0.006 WETH, $10.67
const gwei = 10n ** 9n;
const gasAt = (g: bigint) => rescueGasUsd({ gasPriceWei: g, ethUsd: 1778.09, needsApprove: true, nearUsd: 3.104 });
const bid = (bps: number): Decision => ({ bid: true, bps, amountUnits: share, why: "strategy" });

describe("gas-aware bidding", () => {
  it("prices the gas a won rescue costs (approve + supply on Ethereum, NEAR calls)", () => {
    // 210k gas at 0.232 gwei and $1,778 ≈ $0.087, plus 0.006 NEAR ≈ $0.019
    expect(gasAt(232n * gwei / 1000n)).toBeCloseTo(0.1052, 3);
  });
  it("leaves a bid that already pays its gas alone (the run: 280 bps at 0.23 gwei)", () => {
    const x = { ...a, gasUsd: gasAt(232n * gwei / 1000n) };
    expect(gasFloorBps(x, share, x.gasUsd!)).toBeLessThan(280);
    expect(payItsWay(bid(280), x)).toEqual(bid(280));
  });
  it("raises a bid under its gas floor to the floor, inside the cap (1 gwei)", () => {
    const x = { ...a, gasUsd: gasAt(gwei) };
    const d = payItsWay(bid(280), x);
    expect(d.bid).toBe(true);
    if (d.bid) {
      expect(d.bps).toBe(gasFloorBps(x, share, x.gasUsd!));
      expect(d.bps).toBeGreaterThan(280);
      expect(d.bps).toBeLessThanOrEqual(a.capBps);
    }
  });
  it("skips a rescue too small to pay its gas even at the cap", () => {
    const tiny = { ...a, topupBase: 100_000_000n, gasUsd: gasAt(gwei) }; // a $1 top-up
    expect(payItsWay({ ...bid(280), amountUnits: tiny.topupUnits }, tiny).bid).toBe(false);
  });
  it("never bids above the cap to cover gas", () => {
    const x = { ...a, gasUsd: gasAt(10n * gwei) };
    const d = payItsWay(bid(280), x);
    expect(d.bid === false || d.bps <= a.capBps).toBe(true);
  });
  it("changes nothing where gas has no value (testnets)", () => {
    expect(payItsWay(bid(150), a)).toEqual(bid(150));
  });
});
