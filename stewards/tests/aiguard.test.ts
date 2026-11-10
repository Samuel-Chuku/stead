// The guard on AI risk tuning: each rule rejects what it should and lets real reasoning through.
import { describe, expect, it } from "vitest";
import { judge, grounded, evidence, type GuardInput } from "../src/aiguard.js";
import { DEFAULTS } from "../src/risk.js";

const deep = DEFAULTS.deep;
const calm = [{ at: "a", collateralUsd: 30 }, { at: "b", collateralUsd: 30.1 }];
const falling = [{ at: "a", collateralUsd: 30 }, { at: "b", collateralUsd: 28.5 }]; // -5 %
const lostOne: GuardInput = { steward: "deep", recent: [{ rescue: 12, outcome: "bid", bps: 150 }], prices: calm };
const wonTwo: GuardInput = { steward: "deep", recent: [{ rescue: 12, outcome: "won", bps: 150 }, { rescue: 13, outcome: "won", bps: 150 }], prices: calm };

describe("AI tuning guard", () => {
  it("no change always passes", () => {
    expect(judge(lostOne, deep, deep, "")).toEqual({ ok: true, why: "no change" });
  });

  it("a grounded, one-step change in the direction the evidence points is applied", () => {
    expect(judge(lostOne, deep, { ...deep, spreadBps: 130 }, "Lower spreadBps: outbid on rescue 12 at 150 bps.").ok).toBe(true);
    expect(judge(wonTwo, deep, { ...deep, spreadBps: 170 }, "Raise spreadBps: won rescues 12 and 13 at 150 bps.").ok).toBe(true);
  });

  it("rejects more than two changes, or a change bigger than one step", () => {
    const three = { ...deep, spreadBps: 140, minTopupUsd: 400, bidDelayS: 10 };
    expect(judge(lostOne, deep, three, "Outbid on rescue 12 at 150 bps, so adjust three settings.")).toMatchObject({ ok: false, why: expect.stringContaining("at most 2") });
    expect(judge(lostOne, deep, { ...deep, spreadBps: 60 }, "Lower spreadBps: outbid on rescue 12 at 150 bps.")).toMatchObject({ ok: false, why: expect.stringContaining("more than one step") });
  });

  it("rejects a reason that cites nothing from the steward's own data", () => {
    expect(judge(lostOne, deep, { ...deep, spreadBps: 130 }, "Lower spreadBps because markets look competitive today.")).toMatchObject({ ok: false, why: expect.stringContaining("cites no rescue") });
    expect(judge(lostOne, deep, { ...deep, spreadBps: 130 }, "Lower spreadBps, rescue 99 went badly.").ok).toBe(false); // rescue 99 isn't in its data
    expect(grounded("price fell 5% to 28.5", { ...lostOne, prices: falling })).toBe(true);
  });

  it("rejects a change against the evidence", () => {
    // lower premium without having lost an auction
    expect(judge(wonTwo, deep, { ...deep, spreadBps: 130 }, "Lower spreadBps after winning rescue 12 at 150 bps.")).toMatchObject({ ok: false, why: expect.stringContaining("bid on and lost") });
    // higher premium with one loss and calm prices
    expect(judge(lostOne, deep, { ...deep, spreadBps: 170 }, "Raise spreadBps after rescue 12 at 150 bps.")).toMatchObject({ ok: false, why: expect.stringContaining("two recent wins") });
    // thinner margin while prices fall 5 %
    const skipped: GuardInput = { steward: "deep", recent: [{ rescue: 12, outcome: "skipped: margin 0.02 < 0.03" }], prices: falling };
    expect(judge(skipped, deep, { ...deep, minMargin: 0.02 }, "Lower minMargin: skipped rescue 12 for margin.")).toMatchObject({ ok: false, why: expect.stringContaining("calm prices") });
    // a wider margin when prices fell 5 % is fine
    expect(judge(skipped, deep, { ...deep, minMargin: 0.05 }, "Raise minMargin: price fell 5% while skipping rescue 12.").ok).toBe(true);
  });

  it("keeps each steward in its role", () => {
    const swift: GuardInput = { steward: "swift", recent: [{ rescue: 12, outcome: "bid", bps: 400 }], prices: calm };
    expect(judge(swift, DEFAULTS.swift, { ...DEFAULTS.swift, bidDelayS: 8 }, "Bid later: lost rescue 12 at 400 bps.")).toMatchObject({ ok: false, why: expect.stringContaining("bidding first") });
    const pool: GuardInput = { steward: "pool", recent: [{ rescue: 12, outcome: "bid", bps: 300 }], prices: calm };
    expect(judge(pool, DEFAULTS.pool, { ...DEFAULTS.pool, shareFraction: 0.6 }, "Offer more: lost rescue 12 at 300 bps.").ok).toBe(true);
    expect(judge(pool, { ...DEFAULTS.pool, shareFraction: 0.6 }, { ...DEFAULTS.pool, shareFraction: 0.8 }, "Offer more: lost rescue 12 at 300 bps.")).toMatchObject({ ok: false, why: expect.stringContaining("partial") });
  });

  it("evidence counts wins, lost bids, skips and the price move", () => {
    const e = evidence({ steward: "deep", recent: [{ rescue: 1, outcome: "bid" }, { rescue: 1, outcome: "won" }, { rescue: 2, outcome: "bid" }, { rescue: 3, outcome: "skipped: top-up under $500" }], prices: falling });
    expect(e).toMatchObject({ wins: 1, lost: 1, auctions: 3, topupSkips: 1, marginSkips: 0 });
    expect(e.move).toBeCloseTo(-0.05);
  });
});
