// The live board as a pure function of a recorded event log and a time (seconds from the opening).
// Nothing here reads a clock or animates: the view renders whatever this returns.
import type { Evidence, RescueEvent, RescueLog, StewardId } from "../../../stewards/src/rescuelog";

export const STEWARD_ORDER: StewardId[] = ["patient", "hedged", "pool", "deep", "swift"];
export const CODE: Record<StewardId, string> = { patient: "PT", hedged: "HG", pool: "PL", deep: "DP", swift: "SW" };
export const RISK: Record<StewardId, number> = { patient: 1, hedged: 2, pool: 3, deep: 4, swift: 5 };
export const RISK_WORD = ["", "low", "low-medium", "medium", "high", "very high"];
/** What each example strategy does (stewards/src/strategy.ts). */
export const RULE: Record<StewardId, string> = {
  patient: "Bids late, prices thin margins higher",
  hedged: "Hedges the asset it supplies",
  pool: "Joins coalitions with partial amounts",
  deep: "Comfortable margins only, full amount",
  swift: "Bids first, fixed spread",
};
const LATE_S = 5; // a bid in the last 5 s of the window is LATE
const FRESH_S = 0.9; // flash length

export type Phase = "before" | "auction" | "closing" | "topup" | "claim" | "done";
export type LampId = "TRIGGER" | "AUCTION" | "TOP-UP" | "CLAIM OPEN" | "TRIP";
export type Row = {
  steward: StewardId;
  rank: number | null; // 0 = lowest premium; null = no bid yet
  bps: number | null;
  prevBps: number | null;
  bidT: number | null;
  fresh: boolean;
  late: boolean;
  badge: "" | "LEADING" | "WON" | "LATE";
  cost: number | null; // USD at the top-up's opening value
};
export type StewardCard = { steward: StewardId; status: string; bidding: boolean; won: boolean };
export type JournalLine = { t: number; kind: string; tone: "exposure" | "acting" | "safe" | "plain" | StewardId; text: string; evidence?: Evidence };
export type Board = {
  t: number;
  phase: Phase;
  lamps: Record<LampId, boolean>;
  hf: number | null;
  hfEvidence: Evidence | null;
  below: boolean;
  clock: number; // whole seconds left in the window
  title: string;
  subtitle: string;
  rows: Row[];
  stewards: StewardCard[];
  pipe: null | { steward: StewardId; amount: string; asset: string; flowing: boolean; done: boolean };
  claim: null | { id: string; holder: StewardId; owed: string; premium: string; asset: string; windowLeft: number; closed: boolean; closedText: string };
  journal: JournalLine[];
  ended: boolean;
  collateral: string | null; // proven collateral after a top-up
};

const fmtUsd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtBlock = (b?: number) => (b ? b.toLocaleString("en-US") : "");
const short = (tx: string) => (tx.startsWith("0x") ? tx.slice(0, 8) + "…" : tx.slice(0, 6) + "…");

/** The length of the recording in seconds (last event, plus a short tail). */
export const duration = (log: RescueLog) => Math.ceil(Math.max(...log.events.map((e) => e.t)) + 3);

export function boardAt(log: RescueLog, t: number): Board {
  const seen = log.events.filter((e) => e.t <= t);
  const has = (k: RescueEvent["kind"]) => seen.some((e) => e.kind === k);
  const last = <K extends RescueEvent["kind"]>(k: K) => [...seen].reverse().find((e) => e.kind === k) as Extract<RescueEvent, { kind: K }> | undefined;
  const open = log.events.find((e) => e.kind === "AUCTION_OPEN") as Extract<RescueEvent, { kind: "AUCTION_OPEN" }>;
  const dur = open.durationS;
  const topUsd = open.topUp.usd;

  // health factor: the latest reading the board holds (trigger or a later proven reading)
  const readings = seen.filter((e) => e.kind === "TRIGGER" || e.kind === "READING") as Extract<RescueEvent, { kind: "TRIGGER" | "READING" }>[];
  const r = readings[readings.length - 1];
  const hf = r ? r.hf : null;
  const below = hf !== null && hf < log.params.triggerHf;

  const close = last("AUCTION_CLOSE");
  const winners = close?.winners ?? [];
  const sent = last("TOPUP_SENT");
  const confirmed = last("TOPUP_CONFIRMED");
  const claimEv = last("CLAIM_MINTED");
  const boughtBack = last("BOUGHT_BACK");
  const settled = last("SETTLED");
  const liquidated = last("LIQUIDATED");

  const phase: Phase = !has("AUCTION_OPEN") ? "before" : t < dur && !close ? "auction" : !close ? "closing" : !claimEv ? "topup" : !(boughtBack || settled || liquidated) ? "claim" : "done";

  // ladder: each steward's bids so far
  const bids = seen.filter((e) => e.kind === "BID") as Extract<RescueEvent, { kind: "BID" }>[];
  const per = new Map<StewardId, typeof bids>();
  for (const b of bids) per.set(b.steward, [...(per.get(b.steward) ?? []), b]);
  const ranked = [...per.entries()]
    .map(([s, bs]) => ({ s, cur: bs[bs.length - 1] }))
    .sort((a, b) => a.cur.bps - b.cur.bps || a.cur.t - b.cur.t)
    .map((x) => x.s);
  const winnerSet = new Set(winners.map((w) => w.steward));
  const rows: Row[] = STEWARD_ORDER.map((s) => {
    const bs = per.get(s) ?? [];
    const cur = bs[bs.length - 1];
    const prev = bs.length > 1 ? bs[bs.length - 2] : null;
    const rank = cur ? ranked.indexOf(s) : null;
    const late = !!cur && cur.t >= dur - LATE_S && cur.t <= dur;
    const won = winnerSet.has(s);
    const badge: Row["badge"] = won ? "WON" : phase === "auction" && rank === 0 ? "LEADING" : late ? "LATE" : "";
    return { steward: s, rank, bps: cur?.bps ?? null, prevBps: prev?.bps ?? null, bidT: cur?.t ?? null, fresh: !!cur && t - cur.t < FRESH_S, late, badge, cost: cur ? (topUsd * cur.bps) / 10_000 : null };
  });

  // "bidding…" cues: a BIDDING event whose BID has not arrived yet
  const thinking = new Set<StewardId>();
  for (const e of seen) {
    if (e.kind === "BIDDING") thinking.add(e.steward);
    if (e.kind === "BID") thinking.delete(e.steward);
  }
  if (phase !== "auction") thinking.clear();

  const nBid = per.size;
  const winnerName = winners.map((w) => w.steward).join(" + ");
  let title = "Waiting for the trigger";
  let subtitle = "";
  if (phase === "auction") {
    title = `${open.topUp.amount} ${open.topUp.asset} needed · ${fmtUsd(topUsd)}`;
    subtitle = thinking.size ? `${[...thinking].join(", ")} bidding…` : `${nBid} of 5 stewards have bid`;
  } else if (phase === "closing") {
    title = "Window closed · closing the auction";
    subtitle = `${nBid} stewards bid`;
  } else if (phase !== "before") {
    title = phase === "topup" ? `${winnerName} won · topping up` : `${winnerName} won at ${winners[0]?.bps} bps`;
    subtitle = `Auction closed · ${nBid} stewards bid`;
  }

  const stewards: StewardCard[] = STEWARD_ORDER.map((s) => {
    const row = rows.find((x) => x.steward === s)!;
    const won = winnerSet.has(s);
    const status = won ? `won · ${row.bps} bps` : thinking.has(s) ? "bidding…" : row.bps !== null ? `${row.bps} bps` : phase === "auction" ? "watching" : phase === "before" ? "watching" : "no bid";
    return { steward: s, status, bidding: thinking.has(s), won };
  });

  const pipe = close && winners.length === 1
    ? { steward: winners[0].steward, amount: winners[0].amount, asset: open.topUp.asset, flowing: !!sent && !confirmed, done: !!confirmed }
    : null;

  const claim = claimEv
    ? {
        id: claimEv.claim,
        holder: claimEv.holder,
        owed: claimEv.owed,
        premium: claimEv.premium,
        asset: claimEv.asset,
        windowLeft: Math.max(0, Math.ceil(claimEv.windowEndsT - t)),
        closed: !!(boughtBack || settled || liquidated),
        closedText: boughtBack ? "bought back" : settled ? "settled" : liquidated ? "liquidated" : "",
      }
    : null;

  const lamps: Record<LampId, boolean> = {
    TRIGGER: below,
    AUCTION: phase === "auction" || phase === "closing",
    "TOP-UP": phase === "topup",
    "CLAIM OPEN": phase === "claim",
    TRIP: !!liquidated,
  };

  const clock = phase === "auction" ? Math.max(0, Math.ceil(dur - t)) : 0;
  return {
    t,
    phase,
    lamps,
    hf,
    hfEvidence: r?.evidence ?? null,
    below,
    clock,
    title,
    subtitle,
    rows,
    stewards,
    pipe,
    claim,
    journal: journal(log, seen),
    collateral: confirmed?.collateral || null,
    ended: t >= duration(log),
  };
}

function journal(log: RescueLog, seen: RescueEvent[]): JournalLine[] {
  const L: JournalLine[] = [];
  const pos = log.positionId;
  for (const e of seen) {
    const at = (kind: string, tone: JournalLine["tone"], text: string, evidence?: Evidence) => L.push({ t: e.t, kind, tone, text, evidence });
    switch (e.kind) {
      case "TRIGGER":
        at("TRIGGER", "exposure", `Position ${pos} health ${e.hf.toFixed(3)}, below ${log.params.triggerHf.toFixed(2)} · proven at block ${fmtBlock(e.evidence.block)}, ${e.evidence.rpcs} RPCs agree`, e.evidence);
        break;
      case "AUCTION_OPEN":
        at("AUCTION", "acting", `Auction opens: ${e.topUp.amount} ${e.topUp.asset} (${fmtUsd(e.topUp.usd)}) for ${e.durationS} s, premium cap ${e.capBps.toLocaleString("en-US")} bps`, e.evidence);
        break;
      case "BID":
        at("BID", e.steward, `${e.steward} bids ${e.bps} bps for ${e.amount} ${log.market.collateral}`, e.evidence);
        break;
      case "AUCTION_CLOSE":
        at("WON", "acting", e.winners.map((w) => `${w.steward} wins at ${w.bps} bps`).join(", ") || "No bid covered the top-up", e.evidence);
        break;
      case "TOPUP_SENT":
        at("TOP-UP", "safe", `${e.steward} supplies ${e.amount} ${e.asset} to the position · Sepolia block ${fmtBlock(e.evidence.block)}`, e.evidence);
        break;
      case "TOPUP_CONFIRMED":
        at("TOP-UP", "safe", `Top-up proven at block ${fmtBlock(e.evidence.block)}`, e.evidence);
        break;
      case "READING":
        at("READING", "plain", `Health ${e.hf.toFixed(3)} proven at block ${fmtBlock(e.evidence.block)}`, e.evidence);
        break;
      case "CLAIM_MINTED":
        at("CLAIM", "exposure", `Claim ${e.claim} to ${e.holder}: ${e.owed} + ${e.premium} ${e.asset} premium`, e.evidence);
        break;
      case "PAYMENT_IN":
        at("BUY-BACK", "plain", `Borrower pays ${e.amount} ${e.asset} into the position`, e.evidence);
        break;
      case "ESCROW_PROVEN":
        at("BUY-BACK", "plain", `Payment proven in the position at block ${fmtBlock(e.evidence.block)}`, e.evidence);
        break;
      case "BUYBACK":
        at("BUY-BACK", "plain", `Buy-back committed: ${e.amount} ${e.asset} owed to the claim owner`, e.evidence);
        break;
      case "BOUGHT_BACK":
        at("CLAIM", "plain", `Claim closed · withdrawals unlocked`, e.evidence);
        break;
      case "PAYOUT": {
        const tx = (e as any).transfer as Evidence | undefined;
        const who = e.purpose === "buyback" ? "the claim owner, exactly the claim" : e.purpose === "refund" ? "the borrower (overpayment refunded)" : "the steward";
        at("PAYOUT", "plain", `${e.amount} ${e.asset} paid to ${who}${tx ? ` · ${short(tx.tx)}` : ""}`, tx ?? e.evidence);
        break;
      }
      case "SETTLE_START":
        at("SETTLE", "plain", "Settlement started", e.evidence);
        break;
      case "SETTLED":
        at("SETTLE", "plain", "Settled", e.evidence);
        break;
      case "LIQUIDATED":
        at("TRIP", "plain", "Position liquidated", e.evidence);
        break;
    }
  }
  return L.reverse();
}

/** "WBTC can fall X% before liquidation": X = (1 − 1/HF) × 100, one decimal. */
export const consequence = (hf: number) => Math.max(0, (1 - 1 / hf) * 100).toFixed(1);
