import { describe, it, expect } from "vitest";
import { replayPath, summarize, auction, liquidate, fallThroughEvents, STEAD_PARAMS } from "../src/evidence.js";

// The borrower replay model. One test per rule.
const R = { lt: 0.8, bonus: 0.05, vol: 0.04 };
const path = (prices: number[]): [number, number][] => prices.map((p, i) => [i * 3_600_000, p]);
const ramp = (from: number, to: number, n: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
const week = (prices: number[]) => [...prices, ...Array(200 - prices.length).fill(prices[prices.length - 1])];

describe("liquidation model", () => {
  it("50 % close at HF in [0.95, 1): loss = bonus × half the debt", () => {
    const d = 10_000;
    const c = (0.98 * d) / (0.8 * 100); // HF 0.98 at 100 → 50 %
    const l = liquidate(path([100]), 0, 0, c, d, R);
    expect(l.count).toBe(1);
    expect(l.loss).toBeCloseTo(0.05 * 0.5 * d, 6);
  });
  it("full close when the debt is under $2,000, whatever the health", () => {
    const d = 1_500;
    const c = (0.98 * d) / (0.8 * 100);
    expect(liquidate(path([100]), 0, 0, c, d, R).d).toBeCloseTo(0, 9);
  });
  it("full close below HF 0.95", () => {
    const d = 10_000;
    const c = (0.9 * d) / (0.8 * 100); // HF 0.9 at 100
    const l = liquidate(path([100]), 0, 0, c, d, R);
    expect(l.loss).toBeCloseTo(0.05 * d, 6);
    expect(l.d).toBeCloseTo(0, 6);
  });
  it("repeat liquidations within the horizon are counted", () => {
    const d = 10_000;
    const c = (0.99 * d) / (0.8 * 100);
    const l = liquidate(path([100, 80, 70]), 0, 2, c, d, R);
    expect(l.count).toBeGreaterThan(1);
  });
});

describe("borrower replay", () => {
  it("a price that only falls: liquidated without Stead, the premium only with it", () => {
    const r = replayPath(path(week(ramp(100, 85, 25))), 0, R); // −15 %: below HF 1 from the trigger
    expect(r.liqWithout.count).toBeGreaterThan(0);
    expect(r.fills.length).toBeGreaterThan(0);
    expect(r.exit).not.toBe("liquidated");
    expect(r.lossWithUsd).toBeLessThan(r.lossWithoutUsd);
    expect(summarize([r]).saved).toBe(1);
  });

  it("a price that recovers: Stead costs the premium, counted under 'cost more'", () => {
    const r = replayPath(path(week(ramp(100, 104, 25))), 0, R);
    expect(r.lossWithoutUsd).toBe(0);
    expect(r.lossWithUsd).toBeGreaterThan(0);
    expect(summarize([r]).costMore).toBe(1);
  });

  it("a premium above the cap is reported as a violation", () => {
    const r = replayPath(path(week([100])), 0, R);
    const bad = { ...r, i1: false };
    expect(summarize([r]).violations).toBe(0);
    expect(summarize([r, bad]).violations).toBe(1);
  });

  it("partial bids fill the top-up together, lowest premium first", () => {
    const f = auction(5_000, 1_000, 10_000, 0.8, STEAD_PARAMS);
    expect(f.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 9);
    for (let i = 1; i < f.length; i++) expect(f[i].bps).toBeGreaterThanOrEqual(f[i - 1].bps);
  });

  it("the hedged steward (modelled) bids below deep's 150 bps and wins", () => {
    const plain = replayPath(path(week([100])), 0, R);
    const hedged = replayPath(path(week([100])), 0, R, { hedged: true });
    expect(hedged.fills[0].steward).toBe("hedged");
    expect(hedged.premiumBps).toBeLessThan(plain.premiumBps);
  });

  it("a trigger price below the next close starts the path at that close", () => {
    // trigger at 100, the next close already 80: −20 % right after the trigger
    const r = replayPath(path(week([80])), 0, R, { p0: 100 });
    expect(r.liqWithout.count).toBeGreaterThan(0);
  });

  it("break-even: at the break-even premium the mean losses match", () => {
    const rows = [replayPath(path(week(ramp(100, 85, 25))), 0, R), replayPath(path(week(ramp(100, 104, 25))), 0, R)];
    const s = summarize(rows);
    // with the mean premium scaled to the break-even, mean loss with ≈ mean loss without
    const scaled = s.meanLossWith - s.meanPremiumUsd * (s.rescued / s.events) + (s.meanPremiumUsd / s.meanPremiumBps) * s.breakEvenBps * (s.rescued / s.events);
    expect(scaled).toBeCloseTo(s.meanLossWithout, 0);
  });
});

describe("fall-through events", () => {
  it("one event the hour the price first falls through the trigger level", () => {
    const day = 86_400_000;
    const px: [number, number][] = Array.from({ length: 72 }, (_, i) => [i * 3_600_000, i < 30 ? 100 : 80]);
    const ev = fallThroughEvents(px, 0, day, 1.15, [1.35]);
    expect(ev).toHaveLength(1);
    expect(ev[0].i).toBe(30);
    expect(ev[0].p0).toBeCloseTo((100 * 1.15) / 1.35, 9);
  });
});
