// Steward risk settings: the knobs each rule-based strategy reads. Defaults are the hand-set
// values; an optional model may propose new ones, but every proposal is clamped to BOUNDS here,
// and the contract still enforces its own limits (premium cap, coverage, bonds) on every bid.
import type { StewardName } from "./config.js";

export interface RiskSettings {
  /** Premium asked, bps of the top-up (also capped by the auction's cap at bid time). */
  spreadBps: number;
  /** Minimum borrower net HF above the early-settle level after this rescue. */
  minMargin: number;
  /** Smallest top-up worth bidding on, USD. */
  minTopupUsd: number;
  /** Fraction of the top-up offered (before the capacity limit). */
  shareFraction: number;
  /** Seconds after the auction opens before bidding. */
  bidDelayS: number;
}

export const BOUNDS: { [K in keyof RiskSettings]: [number, number] } = {
  spreadBps: [50, 1500],
  minMargin: [0.01, 0.2],
  minTopupUsd: [0, 5000],
  shareFraction: [0.1, 1],
  bidDelayS: [0, 40], // auction window 45 s, minus 5 s to land the bid
};

export const DEFAULTS: Record<StewardName, RiskSettings> = {
  swift: { spreadBps: 400, minMargin: 0, minTopupUsd: 0, shareFraction: 1, bidDelayS: 0 },
  patient: { spreadBps: 150, minMargin: 0, minTopupUsd: 0, shareFraction: 1, bidDelayS: 33 },
  deep: { spreadBps: 150, minMargin: 0.03, minTopupUsd: 500, shareFraction: 1, bidDelayS: 15 },
  pool: { spreadBps: 300, minMargin: 0.03, minTopupUsd: 0, shareFraction: 0.4, bidDelayS: 5 },
  // deep's profile; its spread is the floor the hedge is priced from (strategy.ts)
  hedged: { spreadBps: 150, minMargin: 0.03, minTopupUsd: 500, shareFraction: 1, bidDelayS: 15 },
};

/** Clamp any (possibly hostile) proposal into BOUNDS; missing or non-finite fields keep `base`. */
export function clamp(p: Partial<Record<keyof RiskSettings, unknown>>, base: RiskSettings): RiskSettings {
  const out = { ...base };
  for (const k of Object.keys(BOUNDS) as (keyof RiskSettings)[]) {
    const v = typeof p[k] === "number" ? (p[k] as number) : Number.NaN;
    if (!Number.isFinite(v)) continue;
    const [lo, hi] = BOUNDS[k];
    out[k] = Math.min(hi, Math.max(lo, v));
  }
  out.spreadBps = Math.round(out.spreadBps);
  return out;
}
