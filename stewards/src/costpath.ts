// The rescue page's cost chart: one real rescue's position, run along one real price path.
// Testnet oracle prices don't move, so the path comes from real hourly closes (the evidence
// harness's Binance data). The window is chosen by a fixed rule, never by eye: among every hour
// where the price then fell far enough within the horizon to liquidate this position as it stood
// at the trigger, take the fastest liquidation (ties: the earliest hour).
// Health factor scales linearly with the collateral price for a single-collateral position with
// a stable debt, so HF(t) = HF(0) × price(t) / price(0) on both lines.

export type Hourly = [number, number][]; // [ms, close]
export type CostPath = {
  source: string;
  startMs: number; // the real hour mapped to the trigger (t = 0)
  hours: number[]; // −before … +horizon
  ratio: number[]; // price / price at t = 0
  without: (number | null)[]; // HF of the original position; null after the liquidation point
  with: number[]; // HF with Stead: same before 0, the post-rescue HF × ratio from 0
  liqHour: number; // first hour the original position is below 1.00
  hfAtLiq: number;
  lowestWith: number; // lowest HF with Stead over the horizon
  penaltyUsd: { low: number; high: number }; // Aave bonus on a 50 % close … on a 100 % close
  premiumUsd: number;
  savedUsd: { low: number; high: number };
};

export function pickWindow(series: Hourly, hfTrigger: number, horizon: number): { i: number; k: number } | null {
  const need = 1 / hfTrigger;
  let best: { i: number; k: number } | null = null;
  for (let i = 0; i + horizon < series.length; i++) {
    const p0 = series[i][1];
    for (let k = 1; k <= horizon; k++) {
      if (series[i + k][1] / p0 < need) {
        if (!best || k < best.k) best = { i, k };
        break;
      }
    }
  }
  return best;
}

export function costPath(
  series: Hourly,
  o: { source: string; hfTrigger: number; hfAfter: number; debtUsd: number; liqBonusBps: number; premiumUsd: number; before?: number; horizon?: number },
): CostPath | null {
  const before = o.before ?? 6;
  const horizon = o.horizon ?? 24;
  const w = pickWindow(series.slice(before), o.hfTrigger, horizon);
  if (!w) return null;
  const i0 = w.i + before;
  const p0 = series[i0][1];
  const hours: number[] = [];
  const ratio: number[] = [];
  for (let h = -before; h <= horizon; h++) {
    hours.push(h);
    ratio.push(series[i0 + h][1] / p0);
  }
  let liqIdx = -1;
  const without = ratio.map((r, j) => {
    if (liqIdx >= 0) return null;
    const hf = o.hfTrigger * r;
    if (hours[j] > 0 && hf < 1) liqIdx = j;
    return hf;
  });
  const withS = ratio.map((r, j) => (hours[j] < 0 ? o.hfTrigger * r : o.hfAfter * r));
  const bonus = o.liqBonusBps / 10_000;
  const penalty = { low: 0.5 * o.debtUsd * bonus, high: 1.0 * o.debtUsd * bonus };
  return {
    source: o.source,
    startMs: series[i0][0],
    hours,
    ratio,
    without,
    with: withS,
    liqHour: hours[liqIdx],
    hfAtLiq: without[liqIdx]!,
    lowestWith: Math.min(...withS.filter((_, j) => hours[j] >= 0)),
    penaltyUsd: penalty,
    premiumUsd: o.premiumUsd,
    savedUsd: { low: penalty.low - o.premiumUsd, high: penalty.high - o.premiumUsd },
  };
}
