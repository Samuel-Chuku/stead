// Borrower replay model: one position at Stead's trigger, followed along a real price path with
// and without Stead. Pure functions, no I/O (the runner is scripts/evidence.ts).
//
// The position: debt D (USD, a stablecoin), collateral C0 units, Aave health exactly at the
// trigger at the trigger price P0: C0·P0·LT / D = trigger.
//
// Aave liquidation (both sides): every hour the health is below 1, a liquidator repays part of
// the debt and seizes collateral worth that much plus the bonus. Close factor: 50 % of the debt,
// or 100 % when the health is below 0.95 or the debt is under $2,000 (Aave V3.3). The borrower's
// loss is the bonus part: repaid × bonus. Repeat liquidations within the horizon are counted.
//
// With Stead: an auction at the trigger, the stewards' real strategies bid, the lowest premiums
// fill the top-up (to the target health) under the cap. Then the claim, for up to the buy-back window:
//  - Aave's health (with the top-up) below 1 → liquidated: premiums are forfeited, the borrower
//    loses Aave's bonus on what is liquidated;
//  - the borrower's own health net of the claim below the early level → early settlement at the
//    oracle price: the cost is the premium units at that price; the position is left at the target
//    health (the settler buys collateral at the oracle price to repay debt);
//  - otherwise buy-back at the end of the window: the premium units at that price; the position
//    keeps the top-up on the same debt.
// After the claim the position is followed to the horizon like any other.
// Selling collateral at the oracle price is not a loss, so a settlement costs the premium only.
import { strategies, type AuctionView } from "./strategy.js";
import { LAMBDA, SLIPPAGE_BPS, type HedgeQuote } from "./hedge.js";

export interface Reserve {
  lt: number; // liquidation threshold, e.g. 0.83
  bonus: number; // liquidation bonus, e.g. 0.05
  vol?: number; // 24 h volatility, for the hedged steward's quote
}
export interface SteadParams {
  trigger: number;
  target: number;
  early: number;
  windowH: number; // buy-back window, hours
  horizonH: number; // how long both sides are followed (≥ the window)
}
export const STEAD_PARAMS: SteadParams = { trigger: 1.15, target: 1.5, early: 1.1, windowH: 24, horizonH: 168 };
/** Aave V3.3: full close below this health, or below this debt. */
export const FULL_CLOSE_HF = 0.95;
export const FULL_CLOSE_DEBT_USD = 2_000;
export const TAKER_BPS = 10;

export interface Fill {
  steward: string;
  bps: number;
  share: number; // fraction of the top-up
}
export interface Liquidations {
  loss: number; // USD the borrower lost to liquidation bonuses
  count: number;
  firstHour: number; // index, −1 if none
  c: number; // collateral units left
  d: number; // debt left
}
export interface PathResult {
  start: number; // ms, the trigger hour
  exit: "buy-back" | "early" | "liquidated";
  exitHours: number;
  move: number; // P_exit / P0 − 1
  topupUsd: number;
  capBps: number;
  fills: Fill[];
  premiumBps: number; // weighted
  premiumUsd: number; // paid (at the exit price), 0 if forfeited
  premiumAtTriggerUsd: number;
  baselineUsd: number; // the contract's cap: bonus × 50 % × debt
  liqWithout: Liquidations;
  liqWith: Liquidations;
  lossWithoutUsd: number;
  lossWithUsd: number;
  i1: boolean; // premium at the trigger price ≤ the baseline
  i2: boolean; // owed units = supplied + premium units
}

/** Aave liquidations on (c, d) over hours [from, to] of `px`. */
export function liquidate(px: [number, number][], from: number, to: number, c: number, d: number, r: Reserve): Liquidations {
  const out: Liquidations = { loss: 0, count: 0, firstHour: -1, c, d };
  for (let i = from; i <= to; i++) {
    const p = px[i][1];
    if (out.d <= 1e-9) break;
    const hf = (out.c * p * r.lt) / out.d;
    if (hf >= 1) continue;
    const close = hf < FULL_CLOSE_HF || out.d < FULL_CLOSE_DEBT_USD ? 1 : 0.5;
    let repaid = close * out.d;
    let seized = (repaid * (1 + r.bonus)) / p;
    if (seized > out.c) {
      seized = out.c;
      repaid = (out.c * p) / (1 + r.bonus);
    }
    out.loss += seized * p - repaid;
    out.c -= seized;
    out.d -= repaid;
    out.count++;
    if (out.firstHour < 0) out.firstHour = i;
  }
  return out;
}

/** The hedged steward's venue quote, modelled: depth assumed available, funding 0 at bid time. */
export function modelledHedge(vol: number): HedgeQuote {
  return { ok: true, priceRiskBps: LAMBDA * vol * 10_000, fundingBps: 0, feeBps: 2 * TAKER_BPS + SLIPPAGE_BPS, why: "MODELLED venue" };
}

/** The lowest premiums fill the top-up (partial bids take their share). */
export function auction(topupUsd: number, capBps: number, debtUsd: number, lt: number, p: SteadParams, hedge?: HedgeQuote): Fill[] {
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
    hedge,
  };
  const names = hedge ? (["deep", "patient", "swift", "pool", "hedged"] as const) : (["deep", "patient", "swift", "pool"] as const);
  const bids = names
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

export interface PathOpts {
  p?: SteadParams;
  debtUsd?: number;
  /** The trigger price (default: the close at i0). When set, the close at i0 is the first reading after the trigger. */
  p0?: number;
  /** Include the hedged steward (modelled venue). */
  hedged?: boolean;
}

/** One rescue event at hour i0 of hourly closes `px` [time, price]. */
export function replayPath(px: [number, number][], i0: number, r: Reserve, o: PathOpts = {}): PathResult {
  const p = o.p ?? STEAD_PARAMS;
  const debtUsd = o.debtUsd ?? 10_000;
  const p0 = o.p0 ?? px[i0][1];
  const first = o.p0 !== undefined ? i0 : i0 + 1;
  const c0 = (p.trigger * debtUsd) / (r.lt * p0);
  const t = c0 * (p.target / p.trigger - 1);
  const topupUsd = t * p0;
  const baselineUsd = r.bonus * 0.5 * debtUsd;
  const capBps = Math.floor((baselineUsd * 10_000) / topupUsd);
  const fills = auction(topupUsd, capBps, debtUsd, r.lt, p, o.hedged ? modelledHedge(r.vol ?? 0.05) : undefined);
  const premiumBps = fills.reduce((s, f) => s + f.bps * f.share, 0);
  const premUnits = (t * premiumBps) / 10_000;
  const end = Math.min(px.length - 1, i0 + p.windowH);
  const horizon = Math.min(px.length - 1, i0 + Math.max(p.windowH, p.horizonH));

  const liqWithout = liquidate(px, first, horizon, c0, debtUsd, r);
  const base = { start: px[i0][0], topupUsd, capBps, fills, premiumBps, baselineUsd, liqWithout, lossWithoutUsd: liqWithout.loss };
  if (!fills.length) {
    // no rescue: the borrower is where they'd be without Stead
    return { ...base, exit: liqWithout.count ? "liquidated" : "buy-back", exitHours: horizon - i0, move: px[horizon][1] / p0 - 1, premiumUsd: 0, premiumAtTriggerUsd: 0, liqWith: liqWithout, lossWithUsd: liqWithout.loss, i1: true, i2: true };
  }

  let exit: PathResult["exit"] = "buy-back";
  let iE = end;
  for (let i = first; i <= end; i++) {
    const pr = px[i][1];
    if (((c0 + t) * pr * r.lt) / debtUsd < 1) { exit = "liquidated"; iE = i; break; }
    if (((c0 - premUnits) * pr * r.lt) / debtUsd < p.early) { exit = "early"; iE = i; break; }
  }
  const pE = px[iE][1];
  let liqWith: Liquidations;
  let premiumUsd = 0;
  if (exit === "liquidated") {
    // premiums forfeited; the larger position is liquidated from here
    liqWith = liquidate(px, iE, horizon, c0 + t, debtUsd, r);
  } else {
    premiumUsd = premUnits * pE;
    let c = c0 + t;
    let d = debtUsd;
    if (exit === "early") {
      // the claim takes its units; the settler buys x units at pE to repay debt, leaving HF = target
      const own = c0 - premUnits;
      const x = Math.max(0, (p.target * debtUsd - own * pE * r.lt) / (pE * (p.target - r.lt)));
      c = own - x;
      d = debtUsd - x * pE;
    }
    liqWith = liquidate(px, iE + 1, horizon, c, d, r);
  }
  const premiumAtTriggerUsd = premUnits * p0;
  const owed = t + premUnits;
  return {
    ...base,
    exit,
    exitHours: iE - i0,
    move: pE / p0 - 1,
    premiumUsd,
    premiumAtTriggerUsd,
    liqWith,
    lossWithUsd: premiumUsd + liqWith.loss,
    i1: premiumAtTriggerUsd <= baselineUsd + 1e-9,
    i2: Math.abs(owed - fills.reduce((s, f) => s + t * f.share * (1 + f.bps / 10_000), 0)) < 1e-9 * owed,
  };
}

/**
 * Rescue events where the real price pushes a position down through the trigger: positions opened
 * at 00:00 UTC each day at each health in `openHf`, the first hour within `searchH` whose close is at
 * or below the trigger price. One event per trigger hour (positions crossing in the same hour count once).
 */
export function fallThroughEvents(px: [number, number][], from: number, to: number, trigger: number, openHf = [1.25, 1.35, 1.5], searchH = 30 * 24): { i: number; p0: number }[] {
  const seen = new Map<number, number>();
  for (let i = 0; i < px.length; i++) {
    const [t, pOpen] = px[i];
    if (t < from || t >= to || new Date(t).getUTCHours() !== 0) continue;
    for (const h of openHf) {
      const pTrig = (pOpen * trigger) / h;
      for (let j = i + 1; j <= Math.min(px.length - 1, i + searchH); j++) {
        if (px[j][1] <= pTrig) {
          if (!seen.has(j)) seen.set(j, pTrig);
          break;
        }
      }
    }
  }
  return [...seen].sort((a, b) => a[0] - b[0]).map(([i, p0]) => ({ i, p0 }));
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface Summary {
  events: number;
  rescued: number;
  /** P(liquidated within the horizon | trigger), without Stead. */
  pLiqWithout: number;
  pLiqWith: number;
  liquidationsWithout: number; // all liquidation calls, repeats included
  liquidationsWith: number;
  meanLiqLossWhenLiquidated: number; // without Stead, per liquidated event
  meanPremiumBps: number;
  meanPremiumUsd: number;
  meanLossWithout: number;
  meanLossWith: number;
  p95Without: number;
  p95With: number;
  worstWithout: number;
  worstWith: number;
  worstAvoided: number; // largest (without − with) on one event
  /** The premium at which the mean loss with Stead equals the mean loss without (analysis only). */
  breakEvenBps: number;
  costMore: number; // events where the borrower paid more with Stead
  saved: number; // events where Stead's borrower lost less
  early: number;
  violations: number;
}

export function summarize(rows: PathResult[]): Summary {
  const rescued = rows.filter((r) => r.fills.length);
  const liq = rows.filter((r) => r.liqWithout.count > 0);
  // mean premium per bps paid, in USD (the premium scales linearly with the bps)
  const usdPerBps = mean(rescued.map((r) => (r.premiumBps > 0 ? r.premiumUsd / r.premiumBps : 0)));
  const liqLossWith = mean(rows.map((r) => r.liqWith.loss));
  return {
    events: rows.length,
    rescued: rescued.length,
    pLiqWithout: rows.length ? liq.length / rows.length : 0,
    pLiqWith: rows.length ? rows.filter((r) => r.liqWith.count > 0).length / rows.length : 0,
    liquidationsWithout: rows.reduce((s, r) => s + r.liqWithout.count, 0),
    liquidationsWith: rows.reduce((s, r) => s + r.liqWith.count, 0),
    meanLiqLossWhenLiquidated: mean(liq.map((r) => r.liqWithout.loss)),
    meanPremiumBps: mean(rescued.map((r) => r.premiumBps)),
    meanPremiumUsd: mean(rescued.map((r) => r.premiumUsd)),
    meanLossWithout: mean(rows.map((r) => r.lossWithoutUsd)),
    meanLossWith: mean(rows.map((r) => r.lossWithUsd)),
    p95Without: quantile(rows.map((r) => r.lossWithoutUsd), 0.95),
    p95With: quantile(rows.map((r) => r.lossWithUsd), 0.95),
    worstWithout: Math.max(0, ...rows.map((r) => r.lossWithoutUsd)),
    worstWith: Math.max(0, ...rows.map((r) => r.lossWithUsd)),
    worstAvoided: Math.max(0, ...rows.map((r) => r.lossWithoutUsd - r.lossWithUsd)),
    breakEvenBps: usdPerBps > 0 ? Math.max(0, (mean(rows.map((r) => r.lossWithoutUsd)) - liqLossWith) / usdPerBps) * (rows.length / Math.max(1, rescued.length)) : 0,
    costMore: rows.filter((r) => r.lossWithUsd > r.lossWithoutUsd + 1e-9).length,
    saved: rows.filter((r) => r.lossWithUsd < r.lossWithoutUsd - 1e-9).length,
    early: rows.filter((r) => r.exit === "early").length,
    violations: rows.filter((r) => !r.i1 || !r.i2).length,
  };
}
