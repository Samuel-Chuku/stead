// The live feed's pure parts: turning whole NEAR blocks into the contract's event logs, deciding how
// closely to follow the chain, and what the feed publishes. No network here (scripts/live-feed.ts
// does the reading). The feed is a cache of what the chains say; it never invents an event.
import type { ChainLog, RescueLog } from "./rescuelog.js";

/** The contract's rescue states, as its views write them (snake_case). */
export type RescueState = "auction" | "top_up_pending" | "open" | "settling" | "bought_back" | "settled" | "failed";
export const TERMINAL: RescueState[] = ["bought_back", "settled", "failed"];
/** States where every block matters (bids, top-ups and settlement legs land seconds apart). */
export const DENSE: RescueState[] = ["auction", "top_up_pending", "settling"];
/** An unfinished rescue opened longer ago than this (the 24 h buy-back window plus a day) is not
 *  followed: it is listed as stalled in the feed, never shown as LIVE. */
export const FOLLOW_WITHIN_MS = 48 * 3600_000;
export const followable = (r: { state: RescueState; openedAtMs: number }, nowMs: number) => !TERMINAL.includes(r.state) && nowMs - r.openedAtMs < FOLLOW_WITHIN_MS;
/** A rescue stays followed block by block for this long after it opens, whatever its state. */
export const DENSE_AFTER_OPEN_MS = 10 * 60_000;
/** A rescue that ended stays on the board this long, then the board returns to its empty state. */
export const HOLD_ENDED_MS = 2 * 60_000;

export type LiveLog = ChainLog & { contract: string; height: number };

/** One neardata block (`/v0/block/{height}`), only the fields we read. */
export type NdBlock = {
  block: { header: { height: number; timestamp_nanosec: string } };
  shards: {
    receipt_execution_outcomes?: {
      tx_hash: string;
      receipt: { predecessor_id: string; receiver_id: string; receipt: { Action?: { signer_id: string; actions: any[] } } };
      execution_outcome: { outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> } };
    }[];
  }[];
};

/** The followed contracts' events in one block, in execution order, each timed by this block (the
 *  block that executed the receipt, not the one that included the transaction). Failed receipts are
 *  skipped. A successful `start_settlement` call emits nothing itself; it is kept as event "" like the
 *  recorder does, because the board shows settlement starting from the call. */
export function blockLogs(b: NdBlock, contracts: Set<string>): LiveLog[] {
  const out: LiveLog[] = [];
  const height = b.block.header.height;
  const tsNs = b.block.header.timestamp_nanosec;
  for (const sh of b.shards) {
    for (const r of sh.receipt_execution_outcomes ?? []) {
      const o = r.execution_outcome.outcome;
      if (!contracts.has(o.executor_id) || "Failure" in (o.status ?? {})) continue;
      const act = r.receipt.receipt.Action;
      const method = act?.actions?.find((a) => a?.FunctionCall)?.FunctionCall?.method_name ?? "";
      const signer = act?.signer_id ?? r.receipt.predecessor_id;
      const base = { tsNs, tx: r.tx_hash, signer, method, contract: o.executor_id, height };
      let any = false;
      for (const line of o.logs) {
        if (!line.startsWith("EVENT_JSON:")) continue;
        let e: any;
        try { e = JSON.parse(line.slice(11)); } catch { continue; }
        if (e.standard !== "stead" && e.standard !== "nep171") continue;
        for (const data of e.data ?? [{}]) {
          out.push({ ...base, event: e.event, data });
          any = true;
        }
      }
      if (!any && method === "start_settlement") out.push({ ...base, event: "", data: {} });
    }
  }
  return out;
}

/** Applies blocks in height order whatever order they were fetched in; returns the logs of the
 *  blocks that are now contiguous from `cursor + 1`, and the new cursor. */
export function drain(cursor: number, fetched: Map<number, LiveLog[]>): { cursor: number; logs: LiveLog[] } {
  const logs: LiveLog[] = [];
  while (fetched.has(cursor + 1)) {
    cursor++;
    logs.push(...fetched.get(cursor)!);
    fetched.delete(cursor);
  }
  return { cursor, logs };
}

export type Mode = "idle" | "dense" | "sparse";
/** How often to ask the contract: idle when nothing is open; every 1.5 s while an auction, top-up or
 *  settlement runs (or in the first minutes); every 15 s in a buy-back window. */
export function modeFor(rescues: { state: RescueState; openedAtMs: number }[], nowMs: number): Mode {
  const live = rescues.filter((r) => !TERMINAL.includes(r.state));
  if (!live.length) return "idle";
  return live.some((r) => DENSE.includes(r.state) || nowMs - r.openedAtMs < DENSE_AFTER_OPEN_MS) ? "dense" : "sparse";
}
export const POLL_MS: Record<Mode, number> = { idle: 10_000, dense: 1500, sparse: 15_000 };

/** Change-driven reads. Each poll reads the followed rescues, their positions and books, each view
 *  answered at a final block height (lo = lowest, hi = highest of this poll). Every rescue event
 *  changes one of those views, so:
 *  - unchanged since the last poll: nothing happened up to `lo`; move the cursor there, read nothing;
 *  - changed (or no previous poll to compare with): read exactly the blocks (cursor, hi]. */
export function nextRead(prevSig: string | undefined, sig: string, cursor: number, lo: number, hi: number): { read: { from: number; to: number } | null; cursor: number } {
  if (prevSig !== undefined && prevSig === sig) return { read: null, cursor: Math.max(cursor, lo) };
  if (hi <= cursor) return { read: null, cursor };
  return { read: { from: cursor + 1, to: hi }, cursor };
}

export type FeedRescue = RescueLog & { key: string; contractState: RescueState; endedAtMs: number | null };
export type LiveFeed = {
  version: 1;
  generated: string;
  nowMs: number;
  contracts: string[];
  head: { height: number; tsMs: number } | null;
  mode: Mode;
  watching: number | null;
  rescues: FeedRescue[];
  /** unfinished on the contract but opened more than 48 h ago: not followed, listed for honesty */
  stalled: { key: string; state: RescueState; openedAtMs: number }[];
  stale: boolean;
  lastError: string | null;
};

/** When a finished rescue ended: its last event other than a reading. */
export function endedAt(log: RescueLog, state: RescueState): number | null {
  if (!TERMINAL.includes(state)) return null;
  const acts = log.events.filter((e) => e.kind !== "READING" && e.kind !== "BIDDING");
  return log.openedAtMs + Math.round(Math.max(0, ...acts.map((e) => e.t)) * 1000);
}

/** The log as the feed publishes it: the contract's state decides a failure the events can't show. */
export function feedRescue(contract: string, log: RescueLog, state: RescueState): FeedRescue {
  const outcome = state === "failed" && log.outcome === "open" ? "failed" : log.outcome;
  return { ...log, outcome, key: `${contract}#${log.rescueId}`, contractState: state, endedAtMs: endedAt(log, state) };
}

/** What the board may show: open rescues and ones that ended in the last two minutes, newest first. */
export function publishable(rs: FeedRescue[], nowMs: number): FeedRescue[] {
  return rs.filter((r) => r.endedAtMs === null || nowMs - r.endedAtMs < HOLD_ENDED_MS).sort((a, b) => b.openedAtMs - a.openedAtMs);
}

/** The feed is stale when it hasn't read a final block for this long. */
export const STALE_MS = 20_000;
export const isStale = (lastHeadReadMs: number | null, nowMs: number) => lastHeadReadMs === null || nowMs - lastHeadReadMs > STALE_MS;

/** The shard an account lives on (NEAR shard layout: boundary accounts, sorted; an account belongs
 *  to the shard after the last boundary that is ≤ it). A transaction lands in its signer's shard. */
export function shardOf(account: string, layout: { boundary_accounts: string[]; shard_ids: number[] }): number {
  return layout.shard_ids[layout.boundary_accounts.filter((b) => b <= account).length];
}

/** The followed contracts' events in one `EXPERIMENTAL_tx_status` answer: per successful receipt
 *  executed on a followed contract, its `stead`/`nep171` events with the hash of the block that
 *  executed it (callbacks land blocks after the transaction). `start_settlement` with no event at
 *  all is kept as event "" once the transaction is final, like the recorder does. */
export function txStatusLogs(st: any, contracts: Set<string>): { receiptId: string; blockHash: string; log: Omit<LiveLog, "tsNs" | "height"> }[] {
  const tx = st.transaction;
  const method = tx.actions?.[0]?.FunctionCall?.method_name ?? "";
  const base = { tx: tx.hash as string, signer: tx.signer_id as string, method };
  const out: { receiptId: string; blockHash: string; log: Omit<LiveLog, "tsNs" | "height"> }[] = [];
  for (const ro of st.receipts_outcome ?? []) {
    const o = ro.outcome;
    if (!contracts.has(o.executor_id) || "Failure" in (o.status ?? {})) continue;
    let i = 0;
    for (const line of o.logs as string[]) {
      if (!line.startsWith("EVENT_JSON:")) continue;
      let e: any;
      try { e = JSON.parse(line.slice(11)); } catch { continue; }
      if (e.standard !== "stead" && e.standard !== "nep171") continue;
      for (const data of e.data ?? [{}]) out.push({ receiptId: `${ro.id}#${i++}`, blockHash: ro.block_hash, log: { ...base, contract: o.executor_id, event: e.event, data } });
    }
  }
  const final = st.final_execution_status === "FINAL" || st.status?.SuccessValue !== undefined;
  if (!out.length && final && method === "start_settlement" && contracts.has(tx.receiver_id)) {
    const first = (st.receipts_outcome ?? []).find((ro: any) => ro.outcome.executor_id === tx.receiver_id);
    if (first) out.push({ receiptId: `${first.id}#call`, blockHash: first.block_hash, log: { ...base, contract: tx.receiver_id, event: "", data: {} } });
  }
  return out;
}
