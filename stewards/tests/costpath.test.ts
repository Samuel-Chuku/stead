import { describe, expect, it } from "vitest";
import { costPath, pickWindow, type Hourly } from "../src/costpath.js";

const H = 3_600_000;
const series = (closes: number[]): Hourly => closes.map((c, i) => [i * H, c]);
const flat = (n: number, p = 100) => Array.from({ length: n }, () => p);

describe("cost chart price path", () => {
  it("picks the fastest real liquidation, ties to the earliest hour", () => {
    // HF 1.25 is liquidated by a fall below 80 % of the start price
    // a two-hour fall from hour 2 (100 → 90 → 79), then two one-hour falls (hours 9 and 15): the
    // one-hour falls are faster, and of those the earlier wins
    const s = series([100, 100, 100, 90, 79, ...flat(4, 100), 79, ...flat(5, 100), 79, ...flat(30, 79)]);
    expect(pickWindow(s, 1.25, 24)).toEqual({ i: 8, k: 1 });
    expect(pickWindow(series(flat(60)), 1.25, 24)).toBeNull();
  });

  it("runs both lines on the same path and stops the unrescued one at its liquidation", () => {
    const s = series([...flat(8), 100, 95, 85, 79, 82, ...flat(40, 82)]);
    const p = costPath(s, { source: "test", hfTrigger: 1.25, hfAfter: 1.5, debtUsd: 1000, liqBonusBps: 1000, premiumUsd: 5, before: 2, horizon: 24 })!;
    const at = (h: number) => p.hours.indexOf(h);
    expect(p.liqHour).toBe(3);
    expect(p.without[at(3)]).toBeCloseTo(1.25 * 0.79, 9);
    expect(p.without.slice(at(3) + 1).every((x) => x === null)).toBe(true);
    // identical before the rescue, then the post-rescue HF along the same ratio
    expect(p.with[at(-1)]).toBe(p.without[at(-1)]);
    expect(p.with[at(3)]).toBeCloseTo(1.5 * 0.79, 9);
    expect(p.lowestWith).toBeGreaterThan(1);
  });

  it("prices the saving as Aave's bonus on a half and a full close, minus the premium", () => {
    const s = series([...flat(8), 100, 79, ...flat(40, 79)]);
    const p = costPath(s, { source: "test", hfTrigger: 1.2, hfAfter: 1.5, debtUsd: 1000, liqBonusBps: 1000, premiumUsd: 5, before: 2 })!;
    expect(p.penaltyUsd).toEqual({ low: 50, high: 100 });
    expect(p.savedUsd).toEqual({ low: 45, high: 95 });
  });
});
