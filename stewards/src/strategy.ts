// Rule-based steward strategies. Pure functions: no I/O.
// Every steward computes the borrower's own HF net of open claims after its rescue,
// and its distance to the early-settle level (the "margin") drives what it does.
// The knobs each strategy reads are its RiskSettings (defaults in risk.ts).
import type { StewardName } from "./config.js";
import { BOUNDS, DEFAULTS, type RiskSettings } from "./risk.js";
import type { HedgeQuote } from "./hedge.js";

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
  /** Most this steward will put into one rescue (its risk limit), in collateral units. A top-up
   *  above it is bid partially, so a large rescue needs a coalition. Undefined = no limit. */
  capacityUnits?: bigint;
  /** The collateral's decimals (for logs). Default 18. */
  decimals?: number;
  /** The hedged steward only: what the venue can do for this top-up now. */
  hedge?: HedgeQuote;
  /** What winning would cost this steward in gas, in USD (Ethereum mainnet; undefined where gas has no value). */
  gasUsd?: number;
}

export type Decision = { bid: true; bps: number; amountUnits: bigint; why: string } | { bid: false; wait?: boolean; why: string };

/** Borrower's own HF after this rescue lands at premium `bps`: LT·(C − O − p·T)/D. */
export function netHfAfter(a: AuctionView, bps: number): number {
  const pT = (Number(a.topupBase) * bps) / 10_000;
  return a.netHf - (pT * (a.ltBps / 10_000)) / Number(a.debtBase);
}

const clampBps = (bps: number, cap: number) => Math.max(0, Math.min(cap, Math.round(bps)));
const upTo = (a: AuctionView, units: bigint) => (a.capacityUnits !== undefined && a.capacityUnits < units ? a.capacityUnits : units);
const partial = (a: AuctionView, units: bigint) => (upTo(a, units) < units ? ` (capacity-limited to ${(Number(upTo(a, units)) / 10 ** (a.decimals ?? 18)).toFixed(4)})` : "");
const elapsed = (a: AuctionView) => Number(a.nowNs - a.openedAtNs) / 1e9;
const share = (a: AuctionView, s: RiskSettings) =>
  s.shareFraction >= 1 ? a.topupUnits : (a.topupUnits * BigInt(Math.round(s.shareFraction * 10_000))) / 10_000n;
const usd = (x: number) => BigInt(Math.round(x)) * 10n ** 8n;

export const strategies: Record<StewardName, (a: AuctionView, s?: RiskSettings) => Decision> = {
  /** Swift: bids first, a fixed spread, whatever the margin. */
  swift(a, s = DEFAULTS.swift) {
    if (elapsed(a) < s.bidDelayS) return { bid: false, wait: true, why: `waiting ${s.bidDelayS} s` };
    const bps = clampBps(s.spreadBps, a.capBps);
    const want = share(a, s);
    return { bid: true, bps, amountUnits: upTo(a, want), why: `first in at a fixed ${bps} bps${partial(a, want)}` };
  },

  /** Patient: bids near the end; accepts thin margins the others skip, priced for the risk
   *  (the closer net HF sits to the early level, the likelier an early, shorter claim). */
  patient(a, s = DEFAULTS.patient) {
    if (elapsed(a) < s.bidDelayS) return { bid: false, wait: true, why: `waiting until ${s.bidDelayS} s in` };
    const margin = netHfAfter(a, 200) - a.earlyHf;
    if (margin < s.minMargin) return { bid: false, why: `skips: margin ${margin.toFixed(3)} < ${s.minMargin}` };
    const bps = clampBps(s.spreadBps + 2500 * Math.max(0, 0.08 - margin), a.capBps);
    const want = share(a, s);
    return { bid: true, bps, amountUnits: upTo(a, want), why: `late bid, margin ${margin.toFixed(3)} → ${bps} bps${partial(a, want)}` };
  },

  /** Deep: capital-heavy, low risk. Only comfortable margins and sizeable top-ups; low premium. */
  deep(a, s = DEFAULTS.deep) {
    const margin = netHfAfter(a, s.spreadBps) - a.earlyHf;
    if (margin < s.minMargin) return { bid: false, why: `skips: margin ${margin.toFixed(3)} < ${s.minMargin} above early settlement` };
    if (a.topupBase < usd(s.minTopupUsd)) return { bid: false, why: `skips: top-up under $${s.minTopupUsd}` };
    if (elapsed(a) < s.bidDelayS) return { bid: false, wait: true, why: "waiting for mid-window" };
    const bps = clampBps(s.spreadBps, a.capBps);
    const want = share(a, s);
    return { bid: true, bps, amountUnits: upTo(a, want), why: `margin ${margin.toFixed(3)} ok → ${bps} bps${partial(a, want) || (want === a.topupUnits ? ", full amount" : "")}` };
  },

  /** Pool: joins coalitions with a partial amount; same margin filter as deep. */
  pool(a, s = DEFAULTS.pool) {
    const margin = netHfAfter(a, s.spreadBps) - a.earlyHf;
    if (margin < s.minMargin) return { bid: false, why: `skips: margin ${margin.toFixed(3)} < ${s.minMargin}` };
    if (a.topupBase < usd(s.minTopupUsd)) return { bid: false, why: `skips: top-up under $${s.minTopupUsd}` };
    if (elapsed(a) < s.bidDelayS) return { bid: false, wait: true, why: `waiting ${s.bidDelayS} s` };
    const bps = clampBps(s.spreadBps, a.capBps);
    const want = share(a, s);
    return { bid: true, bps, amountUnits: upTo(a, want), why: `partial ${Math.round(s.shareFraction * 100)} % at ${bps} bps${partial(a, want)}` };
  },

  /** Hedged: deep's filters, priced without the price-risk term it hedges away:
   *  floor − λ·σ₂₄ + funding + fees. If the venue can't take the hedge now, deep's unhedged floor. */
  hedged(a, s = DEFAULTS.hedged) {
    const margin = netHfAfter(a, s.spreadBps) - a.earlyHf;
    if (margin < s.minMargin) return { bid: false, why: `skips: margin ${margin.toFixed(3)} < ${s.minMargin} above early settlement` };
    if (a.topupBase < usd(s.minTopupUsd)) return { bid: false, why: `skips: top-up under $${s.minTopupUsd}` };
    if (elapsed(a) < s.bidDelayS) return { bid: false, wait: true, why: "waiting for mid-window" };
    const want = share(a, s);
    const h = a.hedge;
    if (!h?.ok) {
      const bps = clampBps(s.spreadBps, a.capBps);
      return { bid: true, bps, amountUnits: upTo(a, want), why: `UNHEDGED price ${bps} bps (${h?.why ?? "no venue quote"})${partial(a, want)}` };
    }
    const raw = s.spreadBps - h.priceRiskBps + h.fundingBps + h.feeBps;
    const bps = clampBps(Math.max(BOUNDS.spreadBps[0], raw), a.capBps);
    return {
      bid: true,
      bps,
      amountUnits: upTo(a, want),
      why: `hedged: ${s.spreadBps} − ${h.priceRiskBps.toFixed(1)} risk + ${h.fundingBps.toFixed(1)} funding + ${h.feeBps.toFixed(1)} fees → ${bps} bps; ${h.why}${partial(a, want)}`,
    };
  },
};

// ── gas: a bid must pay for itself ──

/** Gas a won top-up costs on Ethereum (measured on mainnet: supply 143–149k, approve 46,364). */
export const RESCUE_GAS = { supply: 160_000n, approve: 50_000n } as const;
/** NEAR a rescue's calls cost the steward (bid, a re-bid, close, settlement calls; measured ~0.005). */
export const RESCUE_NEAR = 0.006;
/** Profit a bid must clear on top of its gas, as a fraction of that gas. */
export const MIN_GAS_PROFIT = 0.25;

/** What a won rescue costs this steward in gas, in USD: the Ethereum supply (and the approve, the
 *  first time) at the current gas price, plus its NEAR calls. */
export function rescueGasUsd(x: { gasPriceWei: bigint; ethUsd: number; needsApprove: boolean; nearUsd: number }): number {
  const gas = RESCUE_GAS.supply + (x.needsApprove ? RESCUE_GAS.approve : 0n);
  return (Number(gas * x.gasPriceWei) / 1e18) * x.ethUsd + RESCUE_NEAR * x.nearUsd;
}

/** The lowest premium (bps) at which `amountUnits` of this top-up pays `gasUsd` plus the margin. */
export function gasFloorBps(a: AuctionView, amountUnits: bigint, gasUsd: number, minProfit = MIN_GAS_PROFIT): number {
  if (a.topupUnits === 0n || amountUnits === 0n) return Infinity;
  const shareUsd = (Number(a.topupBase) / 1e8) * (Number(amountUnits) / Number(a.topupUnits));
  return Math.ceil(((gasUsd * (1 + minProfit)) / shareUsd) * 10_000);
}

/** Applied to every strategy's bid: under the gas floor it is raised to the floor while that stays
 *  within the cap (the borrower's bound is the cap, not the steward's spread); above the cap the
 *  rescue is too small to pay its gas and the steward skips it. No gas figure: unchanged. */
export function payItsWay(d: Decision, a: AuctionView): Decision {
  if (!d.bid || a.gasUsd === undefined) return d;
  const floor = gasFloorBps(a, d.amountUnits, a.gasUsd);
  if (d.bps >= floor) return d;
  if (floor > a.capBps) return { bid: false, why: `skips: gas ~$${a.gasUsd.toFixed(2)} needs ${floor} bps on this share, above the ${a.capBps} bps cap (too small to pay its gas)` };
  return { ...d, bps: floor, why: `${d.why}; raised ${d.bps} → ${floor} bps to cover gas ~$${a.gasUsd.toFixed(2)}` };
}

// ── undercutting: re-bidding lower inside an auction (only some stewards) ──

/** Stewards that re-bid when outbid. patient prices late, hedged at its hedge cost, pool joins
 *  coalitions: they keep one bid. */
export const UNDERCUTTERS: ReadonlySet<StewardName> = new Set<StewardName>(["deep", "swift"]);
export const UNDERCUT = {
  /** How far below the best bid a re-bid goes. */
  stepBps: 5,
  /** Never below this share of the steward's own spread (deep 150 → 105, swift 400 → 280). */
  floorFraction: 0.7,
  /** Re-bids per auction, at most. */
  maxRebids: 3,
  /** No re-bid this close to the close: a bid must land before the auction ends. */
  cutoffS: 5,
} as const;

export interface StandingBid {
  steward: string;
  premium_bps: number;
  seq: number;
}

/** A lower premium to re-bid at, or null to stay. Re-bids only when another standing bid ranks
 *  ahead of this steward's (lower premium, or the same premium placed earlier). */
export function undercut(name: StewardName, me: string, bids: StandingBid[], a: { capBps: number; closesAtNs: bigint; nowNs: bigint }, s: RiskSettings, rebids: number): { bps: number; why: string } | null {
  if (!UNDERCUTTERS.has(name)) return null;
  if (rebids >= UNDERCUT.maxRebids) return null;
  if (Number(a.closesAtNs - a.nowNs) / 1e9 < UNDERCUT.cutoffS) return null;
  const mine = bids.find((b) => b.steward === me);
  if (!mine) return null;
  const ahead = bids.filter((b) => b.steward !== me && (b.premium_bps < mine.premium_bps || (b.premium_bps === mine.premium_bps && b.seq < mine.seq)));
  if (!ahead.length) return null;
  const best = Math.min(...ahead.map((b) => b.premium_bps));
  const floor = Math.max(BOUNDS.spreadBps[0], Math.ceil(s.spreadBps * UNDERCUT.floorFraction));
  if (floor > a.capBps) return null; // the cap is under its floor: it never prices below its floor
  const bps = Math.max(floor, best - UNDERCUT.stepBps); // ≤ the cap: the best standing bid is under it
  if (bps >= mine.premium_bps) return null; // at its floor already: stays where it is
  return { bps, why: `outbid at ${best} bps: re-bids ${bps} bps (floor ${floor}, re-bid ${rebids + 1} of ${UNDERCUT.maxRebids})` };
}
