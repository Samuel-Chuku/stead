// Borrower replay model: one position that touches Stead's trigger, followed along a real price
// path with and without Stead. Pure functions, no I/O (the runner is scripts/evidence.ts).
//
// The position: debt D (USD, a stablecoin), collateral C0 units at price P0, Aave health exactly
// at the trigger: C0·P0·LT / D = trigger.
//
// Without Stead: Aave liquidates the first hour its health is below 1. The borrower's loss is
// Aave's liquidation cost: bonus × close factor (50 %) × debt (the contract's own baseline).
//
// With Stead: an auction at the trigger, the stewards' real strategies bid, the lowest premiums
// fill the top-up (to the target health) under the cap (the same baseline at the trigger price).
// Then the claim, for up to the buy-back window:
//  - Aave's health (with the top-up) below 1 → liquidated: premiums are forfeited, the borrower's
//    loss is the same liquidation baseline;
//  - the borrower's own health net of the claim below the early level → early settlement at the
//    oracle price: the cost is the premium units at that price;
//  - otherwise buy-back (or settlement) at the end of the window: the premium units at that price.
// Both sides are compared over the same window. Selling collateral at the oracle price is not a
// loss, so a settlement costs the borrower the premium only.
import { strategies, type AuctionView } from "./strategy.js";

export interface Reserve {
  lt: number; // liquidation threshold, e.g. 0.83
  bonus: number; // liquidation bonus, e.g. 0.05
}
export interface SteadParams {
  trigger: number;
  target: number;
  early: number;
  windowH: number; // buy-back window, hours
  /** How long both sides are followed (≥ the window). After the claim ends the rescued position
   *  keeps its top-up (bought back) or sits at the target HF (settled) and is followed on. */
  horizonH: number;
}
export const STEAD_PARAMS: SteadParams = { trigger: 1.15, target: 1.5, early: 1.1, windowH: 24, horizonH: 24 };
export const CLOSE_FACTOR = 0.5;

export interface Fill {
  steward: string;
  bps: number;
  share: number; // fraction of the top-up
}
export interface PathResult {
  start: number; // ms
  exit: "buy-back" | "early" | "liquidated";
  exitHours: number;
  move: number; // P_exit / P0 − 1
  topupUsd: number;
  capBps: number;
  fills: Fill[];
  premiumBps: number; // weighted
  baselineUsd: number; // Aave's liquidation cost (the cap)
  premiumAtTriggerUsd: number;
  withoutLiquidated: boolean;
  /** With Stead: liquidated after the claim ended, within the horizon. */
  laterLiquidated: boolean;
  costWithoutUsd: number;
  costWithUsd: number;
  /** Rules on this path: I1 premium at the trigger price ≤ the baseline; I2 owed units = supplied + premium units. */
  i1: boolean;
  i2: boolean;
}

/** The lowest premiums fill the top-up (partial bids take their share). */
export function auction(topupUsd: number, capBps: number, debtUsd: number, lt: number, p: SteadParams): Fill[] {
  const a: AuctionView = {
    capBps,
    topupUnits: BigInt(Math.round(topupUsd * 1e6)) * 10n ** 12n,
    topupBase: BigInt(Math.round(topupUsd * 1e8)),
    openedAtNs: 0n,
    closesAtNs: 45n * 10n ** 9n,
    nowNs: 40n * 10n ** 9n, // late in the window: every strategy has decided
    netHf: p.trigger,
    ltBps: Math.round(lt * 10_000),
    debtBase: BigInt(Math.round(debtUsd * 1e8)),
    earlyHf: p.early,
  };
  const bids = (["deep", "patient", "swift", "pool"] as const)
    .map((s) => ({ s, d: strategies[s](a) }))
    .filter((b) => b.d.bid)
    .map((b) => ({ steward: b.s, bps: (b.d as { bps: number }).bps, share: Number((b.d as { amountUnits: bigint }).amountUnits) / Number(a.topupUnits) }))
    .filter((b) => b.bps <= capBps)
    .sort((x, y) => x.bps - y.bps);
  const out: Fill[] = [];
  let left = 1;
  for (const b of bids) {
    if (left <= 1e-12) break;
    const take = Math.min(left, b.share);
    out.push({ steward: b.steward, bps: b.bps, share: take });
    left -= take;
  }
  return left > 1e-9 ? [] : out; // not filled: no rescue
}

/** One path from index i0 of hourly closes `px` [time, price]. */
export function replayPath(px: [number, number][], i0: number, r: Reserve, p: SteadParams = STEAD_PARAMS, debtUsd = 10_000): PathResult {
  const [t0, p0] = px[i0];
  const c0 = (p.trigger * debtUsd) / (r.lt * p0); // collateral units at the trigger
  const t = c0 * (p.target / p.trigger - 1); // top-up units
  const topupUsd = t * p0;
  const baselineUsd = r.bonus * CLOSE_FACTOR * debtUsd;
  const capBps = Math.floor((baselineUsd * 10_000) / topupUsd);
  const fills = auction(topupUsd, capBps, debtUsd, r.lt, p);
  const premiumBps = fills.reduce((s, f) => s + f.bps * f.share, 0);
  const premUnits = (t * premiumBps) / 10_000;
  const end = Math.min(px.length - 1, i0 + p.windowH);
  const horizon = Math.min(px.length - 1, i0 + Math.max(p.windowH, p.horizonH));

  // without Stead
  let withoutLiquidated = false;
  for (let i = i0 + 1; i <= horizon; i++) if ((c0 * px[i][1] * r.lt) / debtUsd < 1) { withoutLiquidated = true; break; }
  const costWithoutUsd = withoutLiquidated ? baselineUsd : 0;

  // with Stead
  let exit: PathResult["exit"] = "buy-back";
  let iE = end;
  if (!fills.length) {
    // no rescue: the borrower is where they'd be without Stead
    return { start: t0, exit: withoutLiquidated ? "liquidated" : "buy-back", exitHours: horizon - i0, move: px[horizon][1] / p0 - 1, laterLiquidated: false, topupUsd, capBps, fills, premiumBps: 0, baselineUsd, premiumAtTriggerUsd: 0, withoutLiquidated, costWithoutUsd, costWithUsd: costWithoutUsd, i1: true, i2: true };
  }
  for (let i = i0 + 1; i <= end; i++) {
    const pr = px[i][1];
    if (((c0 + t) * pr * r.lt) / debtUsd < 1) { exit = "liquidated"; iE = i; break; }
    if (((c0 - premUnits) * pr * r.lt) / debtUsd < p.early) { exit = "early"; iE = i; break; }
  }
  const pE = px[iE][1];
  // after the claim: bought back → collateral c0 + t on the same debt; settled → HF at the target at pE
  // (its smaller debt is not modelled: a later liquidation is charged on the full debt, against Stead)
  let laterLiquidated = false;
  if (exit !== "liquidated") {
    const hfAt = (pr: number) => (exit === "early" ? (p.target * pr) / pE : ((c0 + t) * pr * r.lt) / debtUsd);
    for (let i = iE + 1; i <= horizon; i++) if (hfAt(px[i][1]) < 1) { laterLiquidated = true; break; }
  }
  const costWithUsd = exit === "liquidated" ? baselineUsd : premUnits * pE + (laterLiquidated ? baselineUsd : 0);
  const premiumAtTriggerUsd = premUnits * p0;
  const owed = t + premUnits;
  return {
    start: t0,
    exit,
    exitHours: iE - i0,
    laterLiquidated,
    move: pE / p0 - 1,
    topupUsd,
    capBps,
    fills,
    premiumBps,
    baselineUsd,
    premiumAtTriggerUsd,
    withoutLiquidated,
    costWithoutUsd,
    costWithUsd,
    i1: premiumAtTriggerUsd <= baselineUsd + 1e-9,
    i2: Math.abs(owed - fills.reduce((s, f) => s + t * f.share * (1 + f.bps / 10_000), 0)) < 1e-9 * owed,
  };
}

export interface Summary {
  paths: number;
  rescued: number;
  liquidatedWithout: number;
  liquidatedWith: number;
  early: number;
  meanCostWithout: number;
  meanCostWith: number;
  worstWith: number;
  worstWithout: number;
  /** Paths where the borrower paid more with Stead (the price recovered: the rescue wasn't needed). */
  costMore: number;
  meanExtraWhenMore: number;
  /** Paths where Stead saved a liquidation. */
  saved: number;
  meanSavedWhenSaved: number;
  meanPremiumBps: number;
  violations: number;
}

export function summarize(rows: PathResult[]): Summary {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const rescued = rows.filter((r) => r.fills.length);
  const more = rows.filter((r) => r.costWithUsd > r.costWithoutUsd + 1e-9);
  const saved = rows.filter((r) => r.withoutLiquidated && r.exit !== "liquidated" && !r.laterLiquidated);
  return {
    paths: rows.length,
    rescued: rescued.length,
    liquidatedWithout: rows.filter((r) => r.withoutLiquidated).length,
    liquidatedWith: rows.filter((r) => r.exit === "liquidated" || r.laterLiquidated).length,
    early: rows.filter((r) => r.exit === "early").length,
    meanCostWithout: mean(rows.map((r) => r.costWithoutUsd)),
    meanCostWith: mean(rows.map((r) => r.costWithUsd)),
    worstWith: Math.max(0, ...rows.map((r) => r.costWithUsd)),
    worstWithout: Math.max(0, ...rows.map((r) => r.costWithoutUsd)),
    costMore: more.length,
    meanExtraWhenMore: mean(more.map((r) => r.costWithUsd - r.costWithoutUsd)),
    saved: saved.length,
    meanSavedWhenSaved: mean(saved.map((r) => r.costWithoutUsd - r.costWithUsd)),
    meanPremiumBps: mean(rescued.map((r) => r.premiumBps)),
    violations: rows.filter((r) => !r.i1 || !r.i2).length,
  };
}
