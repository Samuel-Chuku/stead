import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildLog, type ChainLog, type Inputs, type RescueLog } from "../src/rescuelog.js";
import { blockLogs, drain, endedAt, feedRescue, followable, HOLD_ENDED_MS, isStale, modeFor, nextRead, publishable, shardOf, txStatusLogs, type LiveLog, type NdBlock } from "../src/livefeed.js";
import { scrub } from "../src/chainread.js";
import { boardAt } from "../../web/src/board/model.js";

const C = "sepolia-demo.steadfi.testnet";
const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const replay = (n: number): RescueLog => JSON.parse(readFileSync(new URL(`../../web/public/replays/sepolia-demo-rescue-${n}.json`, import.meta.url), "utf8"));
const recorded10 = replay(10);
// rescues whose raw chain inputs are saved as fixtures (the recorder's --raw output)
const RAW: [number, string][] = [[8, "rescue-8-chain.json"], [10, "rescue-10-chain.json"]];

type Outcome = NonNullable<NdBlock["shards"][0]["receipt_execution_outcomes"]>[0];
const receipt = (l: Omit<ChainLog, "tsNs">, opts: { executor?: string; failed?: boolean; standard?: string } = {}): Outcome => ({
  tx_hash: l.tx,
  receipt: { predecessor_id: l.signer, receiver_id: opts.executor ?? C, receipt: { Action: { signer_id: l.signer, actions: [{ FunctionCall: { method_name: l.method } }] } } },
  execution_outcome: {
    outcome: {
      executor_id: opts.executor ?? C,
      logs: l.event ? [`EVENT_JSON:${JSON.stringify({ standard: opts.standard ?? (l.event.startsWith("nft_") ? "nep171" : "stead"), version: "1.0.0", event: l.event, data: [l.data] })}`] : [],
      status: opts.failed ? { Failure: {} } : { SuccessValue: "" },
    },
  },
});
const block = (height: number, tsNs: string, outs: Outcome[]): NdBlock => ({ block: { header: { height, timestamp_nanosec: tsNs } }, shards: [{ receipt_execution_outcomes: outs }] });

/** The recorder's chain logs regrouped into blocks, one block per distinct execution time. */
function asBlocks(logs: ChainLog[]): NdBlock[] {
  const groups: { tsNs: string; logs: ChainLog[] }[] = [];
  for (const l of logs) {
    const g = groups.find((x) => x.tsNs === l.tsNs);
    if (g) g.logs.push(l);
    else groups.push({ tsNs: l.tsNs, logs: [l] });
  }
  groups.sort((a, b) => (BigInt(a.tsNs) < BigInt(b.tsNs) ? -1 : 1));
  return groups.map((g, i) => block(1000 + i, g.tsNs, g.logs.map((l) => receipt(l))));
}

describe("live feed: blocks to events", () => {
  it("keeps only the followed contracts' stead/nep171 events of successful receipts, timed by the executing block", () => {
    const bid = { tx: "TXBID", signer: "deep.steadfi.testnet", method: "bid", event: "bid_placed", data: { rescue_id: 7, steward: "deep.steadfi.testnet", premium_bps: 150, amount_units: "1" } };
    const b = block(500, "1700000000000000000", [
      receipt(bid),
      receipt({ ...bid, tx: "TXOTHER" }, { executor: "someone-else.testnet" }),
      receipt({ ...bid, tx: "TXFAIL" }, { failed: true }),
      receipt({ ...bid, tx: "TXSTD" }, { standard: "nep141" }),
      receipt({ tx: "TXSET", signer: "reporter.steadfi.testnet", method: "start_settlement", event: "", data: {} }),
    ]);
    const logs = blockLogs(b, new Set([C]));
    expect(logs.map((l) => [l.tx, l.event])).toEqual([["TXBID", "bid_placed"], ["TXSET", ""]]);
    expect(logs[0]).toMatchObject({ tsNs: "1700000000000000000", height: 500, signer: "deep.steadfi.testnet", method: "bid", contract: C });
    // a verified read's callback: the transaction was earlier, the event belongs to this block
    const cb = blockLogs(block(512, "1700000000012000000", [receipt({ tx: "TXBID", signer: "reporter.steadfi.testnet", method: "on_verified", event: "health_verified", data: {} })]), new Set([C]));
    expect(cb[0]).toMatchObject({ tx: "TXBID", height: 512, tsNs: "1700000000012000000" });
  });

  it("applies blocks in height order whatever order they were fetched in", () => {
    const mk = (h: number, n: number): LiveLog[] => Array.from({ length: n }, (_, i) => ({ tsNs: String(h), tx: `${h}-${i}`, signer: "", method: "", event: "e", data: {}, contract: C, height: h }));
    const fetched = new Map<number, LiveLog[]>([[13, mk(13, 1)], [11, mk(11, 2)], [12, []]]);
    const d = drain(10, fetched);
    expect(d.cursor).toBe(13);
    expect(d.logs.map((l) => l.tx)).toEqual(["11-0", "11-1", "13-0"]);
    // a gap stops the cursor: nothing after a missing block is applied yet
    const g = drain(10, new Map([[12, mk(12, 1)]]));
    expect(g).toEqual({ cursor: 10, logs: [] });
  });

  for (const [n, file] of RAW) {
    it(`live = recorded: rescue ${n} followed block by block ends with exactly the recorded replay`, () => {
      const raw: Inputs = fixture(file);
      const final = replay(n);
      const blocks = asBlocks(raw.logs);
      const live: LiveLog[] = [];
      const stable = (e: any) => !["BIDDING", "TOPUP_SENT", "TOPUP_CONFIRMED", "PAYOUT"].includes(e.kind);
      const finalSet = new Set(final.events.filter(stable).map((e) => JSON.stringify(e)));
      for (const b of blocks) {
        live.push(...blockLogs(b, new Set([C])));
        // Sepolia transfers arrive as they happen too
        const tNow = Number(BigInt(b.block.header.timestamp_nanosec) / 1_000_000_000n);
        const log = buildLog({ ...raw, logs: live, transfers: raw.transfers.filter((x) => x.ts <= tNow) });
        // an event, once shown, is never rewritten (attribution of supplies and payout transfers wait for later data)
        for (const e of log.events.filter(stable)) expect(finalSet.has(JSON.stringify(e)), `${e.kind} at ${e.t} changed later`).toBe(true);
      }
      expect(blocks.length).toBeGreaterThan(5);
      const end = buildLog({ ...raw, logs: live });
      end.label = final.label;
      expect(JSON.stringify(end)).toBe(JSON.stringify(final));
    });
  }
});

describe("live feed: how closely to follow", () => {
  const now = 10_000_000;
  it("idle with nothing open, dense in an auction/top-up/settlement or the first minutes, sparse in a buy-back window", () => {
    expect(modeFor([], now)).toBe("idle");
    expect(modeFor([{ state: "bought_back", openedAtMs: now - 1000 }], now)).toBe("idle");
    expect(modeFor([{ state: "auction", openedAtMs: now - 3600_000 }], now)).toBe("dense");
    expect(modeFor([{ state: "settling", openedAtMs: now - 3600_000 }], now)).toBe("dense");
    expect(modeFor([{ state: "open", openedAtMs: now - 60_000 }], now)).toBe("dense");
    expect(modeFor([{ state: "open", openedAtMs: now - 3600_000 }], now)).toBe("sparse");
  });
  it("follows the contract's own state names, and never an unfinished rescue opened more than 48 h ago", () => {
    expect(followable({ state: "settling", openedAtMs: now - 47 * 3600_000 }, now)).toBe(true);
    expect(followable({ state: "settling", openedAtMs: now - 49 * 3600_000 }, now)).toBe(false);
    expect(followable({ state: "bought_back", openedAtMs: now - 1000 }, now)).toBe(false);
    expect(followable({ state: "top_up_pending", openedAtMs: now - 1000 }, now)).toBe(true);
  });
  it("reads blocks only when a view changed, and then exactly the blocks since the cursor", () => {
    // unchanged: no read, the cursor moves to the lowest height this poll was answered at
    expect(nextRead("a", "a", 100, 112, 115)).toEqual({ read: null, cursor: 112 });
    // changed: (cursor, hi]
    expect(nextRead("a", "b", 100, 112, 115)).toEqual({ read: { from: 101, to: 115 }, cursor: 100 });
    // first poll (or after a failed read): read everything since the cursor
    expect(nextRead(undefined, "a", 100, 112, 115)).toEqual({ read: { from: 101, to: 115 }, cursor: 100 });
    // the cursor never moves back
    expect(nextRead("a", "a", 120, 112, 115)).toEqual({ read: null, cursor: 120 });
    expect(nextRead("a", "b", 120, 112, 115)).toEqual({ read: null, cursor: 120 });
  });
});

describe("live feed: endings the recordings never had", () => {
  const raw8: Inputs = fixture("rescue-8-chain.json");
  const upTo = (ev: string) => raw8.logs.slice(0, raw8.logs.findIndex((l) => l.event === ev && l.data.rescue_id === raw8.rescue.id));
  const closeLog = raw8.logs.find((l) => l.event === "auction_closed")!;

  it("an auction nobody covered ends the rescue: no claim, outcome uncovered, the board says so", () => {
    const logs = [...upTo("auction_closed"), { ...closeLog, data: { rescue_id: raw8.rescue.id, result: "uncovered" } }];
    const log = buildLog({ ...raw8, rescue: { ...raw8.rescue, members: [] }, claims: [], logs, transfers: [] });
    expect(log.outcome).toBe("uncovered");
    const b = boardAt(log, 1e6);
    expect(b.title).toMatch(/No steward covered the top-up/);
    expect(b.lamps["TOP-UP"]).toBe(false);
    expect(b.lamps["CLAIM OPEN"]).toBe(false);
  });

  it("a top-up nobody made in time: TOPUP_EXPIRED, outcome failed, contract state Failed wins", () => {
    const logs = [...upTo("topup_verified"), { ...closeLog, tsNs: String(BigInt(closeLog.tsNs) + 300_000_000_000n), tx: "TXEXP", event: "topup_expired", data: { rescue_id: raw8.rescue.id, slashed: 1 } }];
    const log = buildLog({ ...raw8, claims: [], logs, transfers: [] });
    expect(log.events.some((e) => e.kind === "TOPUP_EXPIRED")).toBe(true);
    expect(log.outcome).toBe("failed");
    const b = boardAt(log, 1e6);
    expect(b.title).toMatch(/Top-up not made in time/);
    expect(b.lamps["TOP-UP"]).toBe(false);
    expect(feedRescue(C, { ...log, outcome: "open" }, "failed").outcome).toBe("failed");
  });

  it("the recorded replays are unchanged by the new events", () => {
    const r8: RescueLog = JSON.parse(readFileSync(new URL("../../web/public/replays/sepolia-demo-rescue-8.json", import.meta.url), "utf8"));
    const again = buildLog(raw8);
    again.label = r8.label;
    expect(JSON.stringify(again)).toBe(JSON.stringify(r8));
  });
});

describe("live feed: what it publishes", () => {
  it("every published event except the derived bidding cue carries the transaction it came from", () => {
    for (const e of recorded10.events) if (e.kind !== "BIDDING") expect((e as any).evidence?.tx, e.kind).toBeTruthy();
  });
  it("open rescues and ones ended in the last two minutes, newest first; ended = last non-reading event", () => {
    const r = feedRescue(C, recorded10, "bought_back");
    expect(r.key).toBe(`${C}#10`);
    expect(r.endedAtMs).toBe(endedAt(recorded10, "bought_back"));
    expect(endedAt(recorded10, "open")).toBeNull();
    const open = { ...feedRescue(C, { ...recorded10, rescueId: 11, openedAtMs: recorded10.openedAtMs + 5 }, "open") };
    expect(publishable([r, open], r.endedAtMs! + 1000).map((x) => x.rescueId)).toEqual([11, 10]);
    expect(publishable([r, open], r.endedAtMs! + HOLD_ENDED_MS + 1).map((x) => x.rescueId)).toEqual([11]);
  });
  it("stale without a final block for 20 s; errors never carry a URL", () => {
    expect(isStale(null, 0)).toBe(true);
    expect(isStale(1000, 15_000)).toBe(false);
    expect(isStale(1000, 25_000)).toBe(true);
    expect(scrub(new Error("query: HTTP 429 at https://rpc.example.org/key=abc"))).toBe("query: HTTP 429 at <url>");
  });
});

describe("live feed: the project's own node (chunks + transaction status)", () => {
  // NEAR testnet's shard layout as QuickNode returned it on 2026-11-10
  const layout = { boundary_accounts: ["650", "aurora", "aurora-0", "dev-1662050149030-28642112951491-0", "earn.kaiching", "game.hot.tg", "game.hot.tg-0", "kkuuue2akv_1630967379.near", "tge-lockup.sweat"], shard_ids: [10, 11, 1, 12, 13, 9, 6, 7, 4, 5] };
  it("finds an account's shard from the layout (a transaction lands in its signer's shard)", () => {
    expect(shardOf("sepolia-demo.steadfi.testnet", layout)).toBe(4);
    expect(shardOf("reporter.steadfi.testnet", layout)).toBe(4);
    expect(shardOf("aurora", layout)).toBe(1); // a boundary account starts its shard
    expect(shardOf("0abc", layout)).toBe(10);
    expect(shardOf("zzz.testnet", layout)).toBe(5);
  });
  const ev = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: "stead", version: "1.0.0", event, data: [data] })}`;
  const st = (method: string, outcomes: any[], final = true) => ({
    final_execution_status: final ? "FINAL" : "EXECUTED_OPTIMISTIC",
    transaction: { hash: "TX1", signer_id: "reporter.steadfi.testnet", receiver_id: C, actions: [{ FunctionCall: { method_name: method } }] },
    receipts_outcome: outcomes.map(([id, block, executor, logs, failed]) => ({ id, block_hash: block, outcome: { executor_id: executor, logs, status: failed ? { Failure: {} } : { SuccessValue: "" } } })),
  });
  it("keeps each event with the block that executed its receipt; skips failed receipts and other contracts", () => {
    const x = txStatusLogs(st("request_verified", [
      ["R1", "B1", C, [], false],
      ["R2", "B1", "outlayer.testnet", [ev("auction_opened", {})], false],
      ["R3", "B9", C, [ev("health_verified", { position_id: 4 }), ev("auction_opened", { rescue_id: 11 })], false],
      ["R4", "B9", C, [ev("bid_placed", {})], true],
    ]), new Set([C]));
    expect(x.map((e) => [e.receiptId, e.blockHash, e.log.event])).toEqual([["R3#0", "B9", "health_verified"], ["R3#1", "B9", "auction_opened"]]);
    expect(x[0].log).toMatchObject({ tx: "TX1", signer: "reporter.steadfi.testnet", method: "request_verified", contract: C });
  });
  it("a start_settlement call with no event is kept as the call itself, once final", () => {
    expect(txStatusLogs(st("start_settlement", [["R1", "B5", C, [], false]], false), new Set([C]))).toEqual([]);
    const x = txStatusLogs(st("start_settlement", [["R1", "B5", C, [], false]]), new Set([C]));
    expect(x.map((e) => [e.receiptId, e.blockHash, e.log.event])).toEqual([["R1#call", "B5", ""]]);
  });
});

describe("the recordings archive", async () => {
  const { allPages, archivable, RESCUES_PAGE } = await import("../src/livefeed.js");
  it("reads every rescue, past the contract's 50 per call", async () => {
    const all = Array.from({ length: 133 }, (_, i) => i);
    const asked: number[] = [];
    const got = await allPages((from, limit) => {
      asked.push(from);
      return Promise.resolve(all.slice(from, from + Math.min(limit, RESCUES_PAGE)));
    });
    expect(got).toEqual(all);
    expect(asked).toEqual([0, 50, 100]);
  });
  it("records every ended testnet rescue, and mainnet ones only when they got a bid", () => {
    expect(archivable("sepolia-demo.steadfi.testnet", { state: "failed", bids: [] })).toBe(true);
    expect(archivable("app.usestead.near", { state: "failed", bids: [], members: [] })).toBe(false);
    expect(archivable("app.usestead.near", { state: "failed", bids: [{}], members: [] })).toBe(true);
    expect(archivable("app.usestead.near", { state: "settled", bids: [{}], members: [{}] })).toBe(true);
    expect(archivable("app.usestead.near", { state: "open", bids: [{}], members: [{}] })).toBe(false);
  });
});
