// Rule-based steward strategies. Pure functions: no I/O.
// Every steward computes the borrower's own HF net of open claims after its rescue,
// and its distance to the early-settle level (the "margin") drives what it does.
import type { StewardName } from "./config.js";

export interface AuctionView {
  capBps: number;
  topupUnits: bigint;
  topupBase: bigint; // USD, 8 dp
  openedAtNs: bigint;
  closesAtNs: bigint;
  nowNs: bigint;
  netHf: number; // borrower's own HF now, net of open claims (from get_net_health)
  ltBps: number;
  debtBase: bigint;
  earlyHf: number; // early_settle_hf
}

export type Decision = { bid: true; bps: number; amountUnits: bigint; why: string } | { bid: false; wait?: boolean; why: string };

/** Borrower's own HF after this rescue lands at premium `bps`: LT·(C − O − p·T)/D. */
export function netHfAfter(a: AuctionView, bps: number): number {
  const pT = (Number(a.topupBase) * bps) / 10_000;
  return a.netHf - (pT * (a.ltBps / 10_000)) / Number(a.debtBase);
}

const clampBps = (bps: number, cap: number) => Math.max(0, Math.min(cap, Math.round(bps)));
const elapsed = (a: AuctionView) => Number(a.nowNs - a.openedAtNs) / 1e9;
const left = (a: AuctionView) => Number(a.closesAtNs - a.nowNs) / 1e9;

export const strategies: Record<StewardName, (a: AuctionView) => Decision> = {
  /** Swift: bids first, a fixed spread, whatever the margin. */
  swift(a) {
    const bps = clampBps(400, a.capBps);
    return { bid: true, bps, amountUnits: a.topupUnits, why: `first in at a fixed ${bps} bps` };
  },

  /** Patient: bids near the end; accepts thin margins the others skip, priced for the risk
   *  (the closer net HF sits to the early level, the likelier an early, shorter claim). */
  patient(a) {
    if (left(a) > 12) return { bid: false, wait: true, why: "waiting for the last 12 s" };
    const margin = netHfAfter(a, 200) - a.earlyHf;
    const bps = clampBps(150 + 2500 * Math.max(0, 0.08 - margin), a.capBps);
    return { bid: true, bps, amountUnits: a.topupUnits, why: `late bid, margin ${margin.toFixed(3)} → ${bps} bps` };
  },

  /** Deep: capital-heavy, low risk. Only comfortable margins and sizeable top-ups; low premium. */
  deep(a) {
    const margin = netHfAfter(a, 150) - a.earlyHf;
    if (margin < 0.03) return { bid: false, why: `skips: margin ${margin.toFixed(3)} < 0.03 above early settlement` };
    if (a.topupBase < 500n * 10n ** 8n) return { bid: false, why: "skips: top-up under $500" };
    if (elapsed(a) < 15) return { bid: false, wait: true, why: "waiting for mid-window" };
    const bps = clampBps(150, a.capBps);
    return { bid: true, bps, amountUnits: a.topupUnits, why: `margin ${margin.toFixed(3)} ok → ${bps} bps, full amount` };
  },

  /** Pool: joins coalitions with a partial amount; same margin filter as deep. */
  pool(a) {
    const margin = netHfAfter(a, 300) - a.earlyHf;
    if (margin < 0.03) return { bid: false, why: `skips: margin ${margin.toFixed(3)} < 0.03` };
    if (elapsed(a) < 5) return { bid: false, wait: true, why: "waiting 5 s" };
    const bps = clampBps(300, a.capBps);
    return { bid: true, bps, amountUnits: (a.topupUnits * 40n) / 100n, why: `partial 40 % at ${bps} bps` };
  },
};
