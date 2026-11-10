// The guard on AI risk tuning: a model's proposal is applied only if its reasoning holds up against
// the steward's own data. Pure (tested offline). Rejected proposals keep the current settings and
// are logged with the reason they failed.
//
// A proposal passes when:
//  1. at most two settings change, each by at most one small step;
//  2. the reason cites a fact present in the input: a rescue id, a premium seen, a collateral
//     price, or the measured price move;
//  3. each change goes the way the evidence points (e.g. a lower premium only after being outbid,
//     a thinner margin only when prices are calm);
//  4. the steward keeps its role (swift still bids first, patient late, deep in full, pool partial).
import type { StewardName } from "./config.js";
import type { RiskSettings } from "./risk.js";

export interface GuardInput {
  steward: StewardName;
  recent: { rescue: number; outcome: string; bps?: number; margin?: number }[];
  prices: { at: string; collateralUsd: number }[];
}
export type Verdict = { ok: true; why: string } | { ok: false; why: string };

/** Largest change a single proposal may make to each setting. */
export const STEP: { [K in keyof RiskSettings]: (from: number) => number } = {
  spreadBps: (from) => Math.max(10, Math.round(from * 0.25)),
  minMargin: () => 0.02,
  minTopupUsd: (from) => Math.max(100, from * 0.5),
  shareFraction: () => 0.2,
  bidDelayS: () => 10,
};
export const MAX_CHANGED = 2;
/** Price moves (fraction of the first price in the window) that count as calm / moving. */
const CALM = 0.02;
const MOVING = 0.03;

/** What the steward's own data shows: wins, bids it lost, why it skipped, how prices moved. */
export function evidence(g: GuardInput) {
  const won = new Set(g.recent.filter((r) => r.outcome === "won").map((r) => r.rescue));
  const bid = new Set(g.recent.filter((r) => r.outcome === "bid").map((r) => r.rescue));
  const lost = [...bid].filter((r) => !won.has(r)).length;
  const marginSkips = g.recent.filter((r) => r.outcome.startsWith("skipped") && /margin/.test(r.outcome)).length;
  const topupSkips = g.recent.filter((r) => r.outcome.startsWith("skipped") && /top-up under/.test(r.outcome)).length;
  const p = g.prices.map((x) => x.collateralUsd).filter((x) => x > 0);
  const move = p.length >= 2 ? (p[p.length - 1] - p[0]) / p[0] : 0;
  return { wins: won.size, lost, auctions: new Set(g.recent.map((r) => r.rescue)).size, marginSkips, topupSkips, move, prices: p };
}

/** The reason names something real: a rescue id, a premium, a price, or the price move in %. */
export function grounded(reason: string, g: GuardInput): boolean {
  const e = evidence(g);
  const nums = [...reason.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const rescues = new Set(g.recent.map((r) => r.rescue));
  const bps = new Set(g.recent.map((r) => r.bps).filter((x): x is number => x !== undefined));
  const movePct = Math.abs(e.move * 100);
  return nums.some(
    (n) =>
      rescues.has(n) ||
      bps.has(n) ||
      e.prices.some((p) => Math.abs(n - p) <= p * 0.01) ||
      (movePct >= 0.5 && Math.abs(Math.abs(n) - movePct) <= 0.5),
  );
}

/** Role limits: what makes each steward itself. */
function roleBreak(s: StewardName, after: RiskSettings): string | null {
  if (s === "swift" && after.bidDelayS > 5) return "swift must keep bidding first (delay ≤ 5 s)";
  if (s === "patient" && after.bidDelayS < 20) return "patient must keep bidding late (delay ≥ 20 s)";
  if ((s === "deep" || s === "hedged") && after.shareFraction < 0.8) return `${s} must keep offering (nearly) the full amount`;
  if (s === "pool" && after.shareFraction > 0.6) return "pool must keep offering a partial amount";
  return null;
}

export function judge(g: GuardInput, before: RiskSettings, after: RiskSettings, reason: string): Verdict {
  const keys = (Object.keys(before) as (keyof RiskSettings)[]).filter((k) => before[k] !== after[k]);
  if (!keys.length) return { ok: true, why: "no change" };
  const r = reason.trim();
  if (r.length < 20 || r.length > 400) return { ok: false, why: "reason missing or not one sentence" };
  if (keys.length > MAX_CHANGED) return { ok: false, why: `changes ${keys.length} settings (at most ${MAX_CHANGED})` };
  for (const k of keys) {
    const step = STEP[k](before[k]);
    if (Math.abs(after[k] - before[k]) > step + 1e-9) return { ok: false, why: `${k} moves ${before[k]} → ${after[k]}, more than one step (${step})` };
  }
  if (!grounded(r, g)) return { ok: false, why: "the reason cites no rescue, premium or price from the steward's own data" };
  const e = evidence(g);
  if (e.auctions === 0) return { ok: false, why: "no recent auction to learn from" };
  for (const k of keys) {
    const up = after[k] > before[k];
    const bad =
      k === "spreadBps"
        ? up
          ? e.wins < 2 && Math.abs(e.move) < MOVING && "a higher premium needs two recent wins or a price move of 3 % or more"
          : e.lost < 1 && "a lower premium needs a recent auction it bid on and lost"
        : k === "minMargin"
          ? up
            ? Math.abs(e.move) < CALM && "a wider margin needs a price move of 2 % or more"
            : (e.marginSkips < 1 || Math.abs(e.move) >= CALM) && "a thinner margin needs a recent skip for margin and calm prices"
          : k === "minTopupUsd"
            ? !up && e.topupSkips < 1 && "a lower minimum top-up needs a recent skip for size"
            : false;
    if (bad) return { ok: false, why: `${k} ${up ? "up" : "down"}: ${bad}` };
  }
  const role = roleBreak(g.steward, after);
  if (role) return { ok: false, why: role };
  return { ok: true, why: `${keys.join(", ")} changed with grounded reasoning` };
}
