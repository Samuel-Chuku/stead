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
  pool: Pool | null; // only for a pooled rescue (several winners, or bids smaller than the top-up)
  /** While a settlement runs: a repay made directly on Aave would be counted toward the settler's repay. */
  warning: string | null;
};
/** Shown while a rescue settles (the README's honest limits promise it). */
export const SETTLING_WARNING = "Settlement running: don't repay this position on Aave directly until it ends. The settlement's repay is proven from the drop in the position's debt, so a direct repay would be counted toward the settler's.";

/** Display amounts: two decimals from 1 up, otherwise up to 8 decimals (0.00865215). Exact values stay in the log. */
export const fmtAmt = (v: string | number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n >= 1 ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
};
const fmtUsd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtBlock = (b?: number) => (b ? b.toLocaleString("en-US") : "");
const short = (tx: string) => (tx.startsWith("0x") ? tx.slice(0, 8) + "…" : tx.slice(0, 6) + "…");

/** The length of the recording in seconds (last event, plus a short tail). */
export const duration = (log: RescueLog) => {
  const acts = log.events.filter((e) => e.kind !== "READING");
  return Math.ceil(Math.max(...(acts.length ? acts : log.events).map((e) => e.t)) + 5);
};

export function boardAt(log: RescueLog, t: number): Board {
  const seen = log.events.filter((e) => e.t <= t);
  const has = (k: RescueEvent["kind"]) => seen.some((e) => e.kind === k);
  const last = <K extends RescueEvent["kind"]>(k: K) => [...seen].reverse().find((e) => e.kind === k) as Extract<RescueEvent, { kind: K }> | undefined;
  const open = log.events.find((e) => e.kind === "AUCTION_OPEN") as Extract<RescueEvent, { kind: "AUCTION_OPEN" }>;
  const dur = open.durationS;
  const topUsd = open.topUp.usd;
  const topAmt = Number(open.topUp.amount);

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

  // an auction nobody covered, or a top-up nobody made in time, ends the rescue without a claim
  const uncovered = !!close && !winners.length;
  const expired = !claimEv && has("TOPUP_EXPIRED");
  const phase: Phase = !has("AUCTION_OPEN") ? "before" : t < dur && !close ? "auction" : !close ? "closing" : uncovered || expired ? "done" : !claimEv ? "topup" : !(boughtBack || settled || liquidated) ? "claim" : "done";

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
    return { steward: s, rank, bps: cur?.bps ?? null, prevBps: prev?.bps ?? null, bidT: cur?.t ?? null, fresh: !!cur && t - cur.t < FRESH_S, late, badge, cost: cur ? (topUsd * (Number(cur.amount) / topAmt) * cur.bps) / 10_000 : null };
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
    title = `${fmtAmt(open.topUp.amount)} ${open.topUp.asset} needed · ${fmtUsd(topUsd)}`;
    subtitle = thinking.size ? `${[...thinking].join(", ")} bidding…` : `${nBid} of 5 stewards have bid`;
  } else if (phase === "closing") {
    title = "Window closed · closing the auction";
    subtitle = `${nBid} stewards bid`;
  } else if (phase !== "before") {
    const bpsLo = Math.min(...winners.map((w) => w.bps));
    const bpsHi = Math.max(...winners.map((w) => w.bps));
    const who = winners.length > 1 ? `${winners.length} stewards won` : `${winnerName} won`;
    title = uncovered ? `No steward covered the top-up · position ${log.positionId} is left to Aave`
      : expired ? `Top-up not made in time · ${winnerName}'s bond slashed`
      : phase === "topup" ? `${who} · topping up` : winners.length > 1 ? `${who} · ${bpsLo === bpsHi ? bpsLo : `${bpsLo}–${bpsHi}`} bps` : `${who} at ${winners[0]?.bps} bps`;
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

  const claimCount = seen.filter((e) => e.kind === "CLAIM_MINTED").length;
  const claim = claimEv && claimCount === 1
    ? {
        id: claimEv.claim,
        holder: claimEv.holder,
        owed: fmtAmt(claimEv.owed),
        premium: fmtAmt(claimEv.premium),
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
    pool: poolAt(log, seen, t, phase),
    warning: has("SETTLE_START") && !(settled || liquidated) ? SETTLING_WARNING : null,
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
        at("TRIGGER", "exposure", `Position ${pos} health ${e.hf.toFixed(3)}, below ${log.params.triggerHf.toFixed(2)} · ${e.evidence.mark === "proven" ? `proven at block ${fmtBlock(e.evidence.block)}, ${e.evidence.rpcs} RPCs agree` : `reported by ${e.evidence.reporter ?? "the keeper"}`}`, e.evidence);
        break;
      case "AUCTION_OPEN":
        at("AUCTION", "acting", `Auction opens: ${fmtAmt(e.topUp.amount)} ${e.topUp.asset} (${fmtUsd(e.topUp.usd)}) for ${e.durationS} s, premium cap ${e.capBps.toLocaleString("en-US")} bps`, e.evidence);
        break;
      case "BID":
        at("BID", e.steward, `${e.steward} bids ${e.bps} bps for ${fmtAmt(e.amount)} ${log.market.collateral}`, e.evidence);
        break;
      case "AUCTION_CLOSE":
        at("WON", "acting", e.winners.map((w) => `${w.steward} wins at ${w.bps} bps`).join(", ") || "No bid covered the top-up", e.evidence);
        break;
      case "TOPUP_SENT":
        at("TOP-UP", "safe", `${e.steward} supplies ${fmtAmt(e.amount)} ${e.asset} to the position · Sepolia block ${fmtBlock(e.evidence.block)}`, e.evidence);
        break;
      case "TOPUP_CONFIRMED":
        at("TOP-UP", "safe", `Top-up proven at block ${fmtBlock(e.evidence.block)}`, e.evidence);
        break;
      case "TOPUP_EXPIRED":
        at("TOP-UP", "plain", `Top-up deadline passed · ${e.slashed} bond${e.slashed === 1 ? "" : "s"} slashed`, e.evidence);
        break;
      case "READING":
        at("READING", "plain", `Health ${e.hf.toFixed(3)} proven at block ${fmtBlock(e.evidence.block)}`, e.evidence);
        break;
      case "CLAIM_MINTED":
        at("CLAIM", "exposure", `Claim ${e.claim} to ${e.holder}: ${fmtAmt(e.owed)} + ${fmtAmt(e.premium)} ${e.asset} premium`, e.evidence);
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


// ───────────── pooled rescue (components.md §15, option B "fill the gap") ─────────────
// Bids are offers: a premium and an amount up to the steward's limit. At the close the contract
// fills the top-up from the lowest premium up (ties: earlier bid) and trims the last offer to fit.
// Before the close, the column shows the coalition that rule would form from the bids so far.

export type PoolBlock = { steward: StewardId; amount: number; amountText: string; share: number; bottom: number; bps: number; since: number };
export type PoolCard = { steward: StewardId; status: string; state: "watching" | "bidding" | "offered" | "joined" | "unused" | "nobid" };
export type PoolTag = { claim: string; holder: StewardId; owed: string; premium: string; asset: string; share: number; paid: string | null; buyback: string | null };
export type Pool = {
  gap: number;
  gapText: string;
  asset: string;
  committed: number;
  final: boolean;
  funded: boolean;
  draining: boolean;
  sentT: number | null; // when the first supply landed (so a jump past it shows the column already drained)
  flowing: boolean;
  confirmed: boolean;
  blocks: PoolBlock[];
  cards: PoolCard[];
  tags: PoolTag[];
  claimsOpen: boolean;
  closedText: string;
};

export function isPooled(log: RescueLog): boolean {
  const open = log.events.find((e) => e.kind === "AUCTION_OPEN") as Extract<RescueEvent, { kind: "AUCTION_OPEN" }> | undefined;
  const close = log.events.find((e) => e.kind === "AUCTION_CLOSE") as Extract<RescueEvent, { kind: "AUCTION_CLOSE" }> | undefined;
  if (!open) return false;
  return (close?.winners.length ?? 0) > 1 || log.events.some((e) => e.kind === "BID" && Number(e.amount) < Number(open.topUp.amount));
}

function poolAt(log: RescueLog, seen: RescueEvent[], t: number, phase: Phase): Pool | null {
  if (!isPooled(log)) return null;
  const open = log.events.find((e) => e.kind === "AUCTION_OPEN") as Extract<RescueEvent, { kind: "AUCTION_OPEN" }>;
  const gap = Number(open.topUp.amount);
  const close = seen.find((e) => e.kind === "AUCTION_CLOSE") as Extract<RescueEvent, { kind: "AUCTION_CLOSE" }> | undefined;
  const bids = seen.filter((e) => e.kind === "BID") as Extract<RescueEvent, { kind: "BID" }>[];
  const latest = new Map<StewardId, (typeof bids)[number]>();
  for (const b of bids) latest.set(b.steward, b);
  // the coalition: the real winners after the close; before it, the same rule over the bids so far
  let members: { steward: StewardId; bps: number; amount: number; since: number }[];
  if (close) {
    members = close.winners.map((w) => ({ steward: w.steward, bps: w.bps, amount: Number(w.amount), since: close.t }));
  } else {
    let left = gap;
    members = [];
    for (const b of [...latest.values()].sort((x, y) => x.bps - y.bps || x.t - y.t)) {
      if (left <= 1e-12) break;
      const take = Math.min(Number(b.amount), left);
      members.push({ steward: b.steward, bps: b.bps, amount: take, since: b.t });
      left -= take;
    }
  }
  let cum = 0;
  const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const blocks: PoolBlock[] = members.map((m) => {
    const share = (m.amount / gap) * 100;
    const b = { steward: m.steward, amount: m.amount, amountText: `${fmt(m.amount)} ${open.topUp.asset}`, share, bottom: cum, bps: m.bps, since: m.since };
    cum += share;
    return b;
  });
  const committed = Math.min(gap, members.reduce((a, m) => a + m.amount, 0));
  const sent = seen.some((e) => e.kind === "TOPUP_SENT");
  const confirmed = seen.some((e) => e.kind === "TOPUP_CONFIRMED");
  const thinking = new Set<StewardId>();
  for (const e of seen) {
    if (e.kind === "BIDDING") thinking.add(e.steward);
    if (e.kind === "BID") thinking.delete(e.steward);
  }
  const memberSet = new Set(members.map((m) => m.steward));
  const cards: PoolCard[] = STEWARD_ORDER.map((s) => {
    const b = latest.get(s);
    const m = blocks.find((x) => x.steward === s);
    if (close) {
      if (m) return { steward: s, state: "joined", status: `joined · ${Math.round(m.share)}% · ${m.amountText}` };
      if (b) return { steward: s, state: "unused", status: `not needed · offered ${fmtAmt(b.amount)} ${open.topUp.asset} at ${b.bps} bps` };
      return { steward: s, state: "nobid", status: "no bid" };
    }
    if (phase === "auction" && thinking.has(s)) return { steward: s, state: "bidding", status: "bidding…" };
    if (b) return { steward: s, state: memberSet.has(s) ? "offered" : "unused", status: `offers ${fmt(Number(b.amount))} ${open.topUp.asset} at ${b.bps} bps` };
    return { steward: s, state: phase === "auction" || phase === "before" ? "watching" : "nobid", status: phase === "auction" || phase === "before" ? "watching" : "no bid" };
  });
  const mints = seen.filter((e) => e.kind === "CLAIM_MINTED") as Extract<RescueEvent, { kind: "CLAIM_MINTED" }>[];
  const buybacks = seen.filter((e) => e.kind === "BUYBACK") as Extract<RescueEvent, { kind: "BUYBACK" }>[];
  const payouts = seen.filter((e) => e.kind === "PAYOUT") as Extract<RescueEvent, { kind: "PAYOUT" }>[];
  const tags: PoolTag[] = mints.map((c) => {
    const blk = blocks.find((x) => x.steward === c.holder);
    const bb = buybacks.find((x) => x.claim === c.claim);
    const paid = payouts.find((x) => x.claim === c.claim);
    return { claim: c.claim, holder: c.holder, owed: fmtAmt(c.owed), premium: fmtAmt(c.premium), asset: c.asset, share: blk ? blk.share : 0, buyback: bb ? `${fmtAmt(bb.amount)} ${bb.asset}` : null, paid: paid ? `${fmtAmt(paid.amount)} ${paid.asset}` : null };
  });
  const ended = seen.find((e) => e.kind === "BOUGHT_BACK" || e.kind === "SETTLED" || e.kind === "LIQUIDATED");
  return {
    gap,
    gapText: `${fmt(gap)} ${open.topUp.asset}`,
    asset: open.topUp.asset,
    committed,
    final: !!close,
    funded: committed >= gap - 1e-9,
    draining: sent,
    sentT: (seen.find((e) => e.kind === "TOPUP_SENT")?.t ?? null) as number | null,
    flowing: sent && !confirmed,
    confirmed,
    blocks,
    cards,
    tags,
    claimsOpen: mints.length > 0 && !ended,
    closedText: ended ? (ended.kind === "BOUGHT_BACK" ? "bought back" : ended.kind === "SETTLED" ? "settled" : "liquidated") : "",
  };
}
