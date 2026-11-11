// npx tsx scripts/live-feed.ts [--contract sepolia-demo.steadfi.testnet]... [--serve 8788] [--host 127.0.0.1] [--once]
//
// READ-ONLY live event feed for the board's LIVE mode. Follows the contracts' rescues as they happen:
//  - asks the contracts which rescues are open (`get_rescues`) every 10 s, every 1.5 s while an
//    auction, top-up or settlement runs, every 15 s in a buy-back window;
//  - reads NEAR blocks only when the contract's views changed, and then exactly the blocks in between
//    (neardata: one call per block with every receipt's events, timed by the block that executed it);
//  - reads the position's token transfers on Sepolia (Blockscout);
//  - builds each rescue's log with the same `buildLog` the recorded replays use.
// Contract views and history go to the project's own testnet node (QUICKNODE_NEAR_TESTNET_URL in
// .env) first, public nodes after. Serves GET /live.json and /health (CORS open). No keys used to
// sign anything, no transactions. No URL is ever printed.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { env, hasEnv } from "../src/config.js";
import { buildLog, type ChainLog, type ClaimRecord, type EvmTransfer, type RescueRecord } from "../src/rescuelog.js";
import { buildRecords, fetchContract, linkRecords, type Records } from "../src/records.js";
import { recordRescue, walletsOf, windowEnd } from "../src/recorder.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contractTxs, evmTransfers, NEARDATA, reader, scrub, sleep, tokenSymbol, txLogs } from "../src/chainread.js";
import {
  blockLogs, feedRescue, followable, HOLD_ENDED_MS, isStale, modeFor, nextRead, POLL_MS, publishable, shardOf, TERMINAL, txStatusLogs,
  type FeedRescue, type LiveFeed, type LiveLog, type Mode, type NdBlock, type RescueState,
} from "../src/livefeed.js";

const argv = process.argv;
const args = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));
const contracts = args("--contract").length ? args("--contract") : ["sepolia-demo.steadfi.testnet", "steadfi.testnet"];
const port = args("--serve")[0];
const host = args("--host")[0] ?? "127.0.0.1";
const once = argv.includes("--once");
const SEPOLIA = 11155111;
const TRANSFERS_MS: Record<Mode, number> = { idle: 30_000, dense: 10_000, sparse: 30_000 };
const RECENT_OPEN_MS = 2 * 60_000; // older openings are rebuilt through the recorder path instead
const BLOCK_GAP_MS = 300; // pace between neardata block reads (its free tier allows ~1 per 1.5 s sustained)
const MAX_BLOCKS_PER_CYCLE = 120;
// A proven reading's callback (and an MPC signature's) lands up to ~20 s after its transaction was
// included, and the request itself changes no view. So a change seen now can come from a transaction
// included up to this many blocks earlier: changed ranges are read from this far back.
const LOOKBACK = 60;

const own = hasEnv("QUICKNODE_NEAR_TESTNET_URL") ? [env("QUICKNODE_NEAR_TESTNET_URL")] : [];
const rd = reader("stead-live-feed", { current: own, archival: own });
const view = (c: string, m: string, a: object) => rd.view(c, m, a);
const followed = new Set(contracts);

type Entry = {
  contract: string;
  rebuilding?: boolean; // a history rebuild is under way (opening missed)
  rec: RescueRecord & { state: RescueState };
  position: any;
  market: any;
  params: any;
  symbols: { collateral: string; debt: string };
  claims: Map<string, ClaimRecord | null>;
  transfers: EvmTransfer[];
  transfersAt: number;
  history: ChainLog[]; // from the recorder path, when the feed found the rescue after its opening
};
const entries = new Map<string, Entry>();
const stalled = new Map<string, { key: string; state: RescueState; openedAtMs: number }>();
const fromId = new Map<string, number>(contracts.map((c) => [c, 0]));
const byHeight = new Map<number, LiveLog[]>(); // events of every block read
let cursor: number | null = null; // every block up to here is accounted for
let prevSig: string | undefined;
let lastReadMs: number | null = null;
let watching: number | null = null;
let watchingAt = 0;
let mode: Mode = "idle";
let lastError: string | null = null;
let failures = 0;
let latest: LiveFeed | null = null;
const marketCache = new Map<string, { market: any; symbols: { collateral: string; debt: string } }>();
const paramsCache = new Map<string, any>();

/** One block's events. A height with no block (confirmed by the RPC below the final head) is empty;
 *  anything else that fails is retried next poll, never skipped. */
async function readBlock(h: number): Promise<LiveLog[]> {
  try {
    // one attempt: a failed block is retried next poll, never inside the cycle
    const b = (await rd.get(`${NEARDATA}/block/${h}`, 0)) as NdBlock | null;
    if (b) return blockLogs(b, followed);
  } catch (e) {
    if (h >= ndFinal) throw e;
  }
  const exists = await rd.rpc("block", { block_id: h }, rd.nodes.current).then(() => true, (e) => (String(e).includes("UNKNOWN_BLOCK") ? false : null));
  if (exists === false) return [];
  throw new Error(`block ${h} not readable yet`);
}

/** neardata's last final height (from its redirect; no block download). A request for a later block
 *  is held open until the block exists, so reads never go past this. */
async function neardataFinal(): Promise<number> {
  const r = await fetch(`${NEARDATA}/last_block/final`, { redirect: "manual", headers: { "user-agent": rd.ua }, signal: AbortSignal.timeout(5000) }).catch(() => null);
  const m = /\/block\/(\d+)/.exec(r?.headers.get("location") ?? "");
  if (!m) throw new Error(`block feed: ${r ? `HTTP ${r.status}` : "unreachable"}`);
  return Number(m[1]);
}
let ndFinal = 0;

/** Reads (from, to] from neardata one block at a time (fallback); returns the last height read. */
async function readBlocks(from: number, to: number): Promise<number> {
  let last = from - 1;
  for (let h = from; h <= Math.min(to, from + MAX_BLOCKS_PER_CYCLE - 1); h++) {
    const logs = await readBlock(h).catch(() => null);
    if (logs === null) break;
    byHeight.set(h, logs);
    last = h;
    if (h < to) await sleep(BLOCK_GAP_MS);
  }
  return last;
}

// ── Main path: the project's own node. A transaction lands in its signer's shard, so one `chunk`
// call per block on the shards of the contracts and of the accounts that act on them lists every
// transaction they send to the contracts; `tx_status` then gives all its events, including callbacks
// that land later (re-read until the transaction is final).
const ACTORS = ["reporter", "borrower", "patient", "hedged", "pool", "deep", "swift", "demo", "demo-2"].map((a) => `${a}.steadfi.testnet`);
let shards: number[] = [];
let shardsAt = 0;
const pending = new Map<string, string>(); // tx hash → signer, until final
const doneTx = new Set<string>(); // final transactions already read
const seenReceipts = new Set<string>();
const blockCache = new Map<string, { height: number; tsNs: string }>();
async function refreshShards() {
  const pc = await rd.rpc("EXPERIMENTAL_protocol_config", { finality: "final" }, rd.nodes.current);
  const layout = Object.values(pc.shard_layout)[0] as { boundary_accounts: string[]; shard_ids: number[] };
  shards = [...new Set([...contracts, ...ACTORS].map((a) => shardOf(a, layout)))];
  shardsAt = Date.now();
}
/** Lists the followed contracts' new transactions in (from, to], 4 heights at a time; returns the
 *  last height done. A failed read stops at the last unbroken height (the rest is read next poll). */
async function readChunks(from: number, to: number): Promise<number> {
  if (Date.now() - shardsAt > 10 * 60_000) await refreshShards();
  const end = Math.min(to, from + MAX_BLOCKS_PER_CYCLE - 1);
  let last = from - 1;
  for (let start = from; start <= end; start += 4) {
    const heights = Array.from({ length: Math.min(4, end - start + 1) }, (_, i) => start + i);
    const got = await Promise.all(heights.map(async (h) => {
      const txs: [string, string][] = [];
      for (const shard_id of shards) {
        const c = await rd.rpc("chunk", { block_id: h, shard_id }, rd.nodes.current, 1).catch((e) => (String(e).includes("UNKNOWN_BLOCK") ? "skip" : null));
        if (c === null) return null;
        if (c === "skip" || c.header.height_included !== h) continue; // no block, or no new chunk at h
        for (const t of c.transactions ?? []) if (followed.has(t.receiver_id) && !doneTx.has(t.hash)) txs.push([t.hash, t.signer_id]);
      }
      return txs;
    }));
    for (const txs of got) {
      if (txs === null) return last;
      for (const [hash, signer] of txs) pending.set(hash, signer);
      last++;
    }
  }
  return last;
}
/** Re-reads every pending transaction; adds the events not seen yet; drops the final ones. */
async function resolvePending(): Promise<number> {
  let added = 0;
  for (const [hash, signer] of pending) {
    const st = await rd.rpc("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" }, rd.nodes.current, 1).catch(() => null);
    if (!st) continue;
    for (const x of txStatusLogs(st, followed)) {
      if (seenReceipts.has(x.receiptId)) continue;
      if (!blockCache.has(x.blockHash)) {
        const b = await rd.rpc("block", { block_id: x.blockHash }, rd.nodes.current);
        blockCache.set(x.blockHash, { height: b.header.height, tsNs: b.header.timestamp_nanosec });
      }
      const blk = blockCache.get(x.blockHash)!;
      const arr = byHeight.get(blk.height) ?? [];
      arr.push({ ...x.log, tsNs: blk.tsNs, height: blk.height });
      byHeight.set(blk.height, arr);
      seenReceipts.add(x.receiptId);
      added++;
    }
    if (st.final_execution_status === "FINAL") {
      pending.delete(hash);
      doneTx.add(hash);
    }
  }
  return added;
}

async function headerAt(h: number): Promise<bigint | null> {
  const b = await rd.rpc("block", { block_id: h }, rd.nodes.current).catch(() => null);
  return b ? BigInt(b.header.timestamp_nanosec) : null;
}
/** The height of the block that executed the opening (its timestamp is the rescue's `opened_at`). */
async function openingHeight(openedNs: bigint, near: number): Promise<number> {
  let h = near;
  let t = await headerAt(h);
  for (let i = 0; i < 12 && t !== null && t > openedNs; i++) {
    // step back by the time difference at ~1 block/s
    h -= Math.max(1, Math.round(Number(t - openedNs) / 1e9));
    t = await headerAt(h);
  }
  while (t !== null && t < openedNs) t = await headerAt(++h);
  return h;
}

async function track(contract: string, rec: RescueRecord & { state: RescueState }, viewHeight: number) {
  const key = `${contract}#${rec.id}`;
  const position = await view(contract, "get_position", { position_id: rec.position_id });
  const mk = `${contract}#${position.market_id}`;
  if (!marketCache.has(mk)) {
    const market = await view(contract, "get_market", { market_id: position.market_id });
    marketCache.set(mk, { market, symbols: { collateral: await tokenSymbol(rd, market.collateral), debt: await tokenSymbol(rd, market.debt) } });
  }
  if (!paramsCache.has(contract)) paramsCache.set(contract, await view(contract, "get_params", {}));
  const { market, symbols } = marketCache.get(mk)!;
  const e: Entry = { contract, rec, position, market, params: paramsCache.get(contract), symbols, claims: new Map(), transfers: [], transfersAt: 0, history: [] };
  const openedNs = BigInt(rec.opened_at);
  if (Date.now() - Number(openedNs / 1_000_000n) < RECENT_OPEN_MS) {
    // just opened: read from the opening block on (a handful of blocks)
    const h0 = await openingHeight(openedNs, viewHeight);
    cursor = Math.min(cursor ?? Infinity, h0 - LOOKBACK - 1);
    prevSig = undefined;
  } else {
    // found after the opening (feed started mid-rescue): rebuild what happened through the recorder
    // path (transaction list + their receipts), then follow from here
    const txs = await contractTxs(rd, contract, openedNs - 120_000_000_000n, BigInt(Date.now()) * 1_000_000n);
    e.history = await txLogs(rd, contract, txs);
    cursor ??= viewHeight;
  }
  entries.set(key, e);
  console.log(`${new Date().toISOString()} following ${key} (${rec.state})`);
}

function logsOf(e: Entry): ChainLog[] {
  const seen = new Set<string>();
  const out: ChainLog[] = [];
  const live = [...byHeight.keys()].sort((a, b) => a - b).flatMap((h) => byHeight.get(h)!).filter((l) => l.contract === e.contract);
  for (const l of [...e.history, ...live]) {
    const k = `${l.tx}|${l.event}|${JSON.stringify(l.data)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

async function refreshClaims(e: Entry, logs: ChainLog[]) {
  const rid = e.rec.id;
  let closed = false;
  for (const l of logs) {
    if (l.event === "auction_closed" && l.data.rescue_id === rid) closed = true;
    if (l.event !== "nft_mint" || !closed) continue;
    for (const id of l.data.token_ids as string[]) {
      if (e.claims.has(id)) continue;
      const c = await view(e.contract, "get_claim", { token_id: id }).catch(() => null);
      e.claims.set(id, c && c.rescue_id === rid ? c : null);
    }
  }
}

async function countWatching() {
  const t0 = Date.now();
  let n = 0;
  for (const c of contracts) {
    for (let id = 0, misses = 0; misses < 3; id++) {
      const p = await view(c, "get_position", { position_id: id }).catch(() => null);
      if (!p) { if (id > 0) misses++; continue; }
      misses = 0;
      const mk = `${c}#${p.market_id}#chain`;
      if (!marketCache.has(mk)) marketCache.set(mk, { market: await view(c, "get_market", { market_id: p.market_id }), symbols: { collateral: "", debt: "" } });
      if (marketCache.get(mk)!.market?.chain_id === SEPOLIA && p.evm_address) n++;
    }
  }
  watching = n;
  watchingAt = Date.now();
  console.log(`${new Date().toISOString()} ${n} Sepolia positions registered (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

async function cycle() {
  if (Date.now() - watchingAt > 10 * 60_000) await countWatching();

  // 1. which rescues are open (and the latest record of each followed one), with the block heights
  const heights: number[] = [];
  for (const c of contracts) {
    let from = fromId.get(c)!;
    let lowestOpen: number | null = null;
    let maxId = from - 1;
    for (;;) {
      const { value: page, height } = (await rd.viewAt(c, "get_rescues", { from, limit: 50 })) as { value: (RescueRecord & { state: RescueState })[]; height: number };
      heights.push(height);
      for (const r of page) {
        maxId = Math.max(maxId, r.id);
        const key = `${c}#${r.id}`;
        const follow = followable({ state: r.state, openedAtMs: Number(BigInt(r.opened_at) / 1_000_000n) }, Date.now());
        if (!TERMINAL.includes(r.state) && !follow) stalled.set(key, { key, state: r.state, openedAtMs: Number(BigInt(r.opened_at) / 1_000_000n) });
        else stalled.delete(key);
        if (follow && lowestOpen === null) lowestOpen = r.id;
        if (entries.has(key)) entries.get(key)!.rec = r;
        else if (follow) await track(c, r, height);
      }
      if (page.length < 50) break;
      from = page[page.length - 1].id + 1;
    }
    fromId.set(c, lowestOpen ?? maxId + 1);
  }

  // 2. the views every rescue event changes; read blocks only when they changed
  const list = [...entries.values()];
  const open = list.filter((e) => !TERMINAL.includes(e.rec.state));
  const parts: unknown[] = list.map((e) => [e.contract, e.rec]);
  for (const e of open) {
    const pos = await rd.viewAt(e.contract, "get_position", { position_id: e.rec.position_id });
    const books = await rd.viewAt(e.contract, "get_books", { position_id: e.rec.position_id });
    heights.push(pos.height, books.height);
    parts.push([pos.value?.health ?? null, books.value]);
  }
  const lo = Math.min(...heights);
  const hi = Math.max(...heights);
  lastReadMs = Date.now();
  mode = modeFor(list.map((e) => ({ state: e.rec.state, openedAtMs: Number(BigInt(e.rec.opened_at) / 1_000_000n) })), Date.now());
  if (!list.length) {
    cursor = null;
    prevSig = undefined;
    byHeight.clear();
    pending.clear();
    doneTx.clear();
    seenReceipts.clear();
    blockCache.clear();
  } else if (cursor !== null) {
    const sig = JSON.stringify(parts);
    if (mode === "dense") {
      // auction, top-up or settlement: every block (one chunk call per block on our shard)
      cursor = await readChunks(cursor + 1, hi);
      prevSig = sig;
    } else {
      // buy-back window: only when a view changed, from LOOKBACK blocks back
      const n = nextRead(prevSig, sig, cursor, lo, hi);
      cursor = n.cursor;
      if (n.read) {
        const before = pending.size;
        const last = await readChunks(Math.max(n.read.from - LOOKBACK, 1), n.read.to);
        // views changed but no transaction from the known actors' shards: someone else acted (another
        // shard); fall back to the public block feed for that range (best effort, never fatal)
        if (pending.size === before && !pending.size && last >= n.read.to) {
          ndFinal = await neardataFinal().catch(() => 0);
          if (ndFinal >= n.read.from) await readBlocks(n.read.from, Math.min(n.read.to, ndFinal)).catch(() => 0);
        }
        cursor = Math.max(cursor, last);
        prevSig = last >= n.read.to ? sig : undefined;
      } else prevSig = sig;
    }
  }
  await resolvePending();

  // 3. Sepolia transfers, claims, and the logs
  const out: FeedRescue[] = [];
  for (const [key, e] of entries) {
    const openedMs = Number(BigInt(e.rec.opened_at) / 1_000_000n);
    if (e.position.evm_address && Date.now() - e.transfersAt > TRANSFERS_MS[mode]) {
      e.transfers = await evmTransfers(rd, e.position.evm_address, openedMs - 5 * 60_000, 3).catch(() => e.transfers);
      e.transfersAt = Date.now();
    }
    const logs = logsOf(e);
    await refreshClaims(e, logs);
    const log = buildLog({
      contract: e.contract, nearNetwork: "testnet", evmChain: "sepolia",
      rescue: e.rec, position: e.position, market: e.market, params: e.params, symbols: e.symbols,
      claims: [...e.claims.values()].filter((c): c is ClaimRecord => !!c), logs, transfers: e.transfers,
      stewardWallets: await walletsCached(e.contract, e.rec.members.map((m) => m.steward)),
    });
    if (!log.events.some((x) => x.kind === "AUCTION_OPEN")) {
      // The opening block not read yet. A proven reading's callback can open the auction a few blocks
      // after the request, past the look-back: after 30 s, rebuild from the contract's transactions
      // (the recorder path) instead of waiting for a block that was already passed.
      if (!e.history.length && Date.now() - openedMs > 30_000 && !e.rebuilding) {
        e.rebuilding = true;
        try {
          const txs = await contractTxs(rd, e.contract, BigInt(e.rec.opened_at) - 120_000_000_000n, BigInt(Date.now()) * 1_000_000n);
          e.history = await txLogs(rd, e.contract, txs);
          console.log(`${new Date().toISOString()} ${key}: opening not seen in the blocks read; rebuilt from ${txs.length} transactions`);
        } catch (err) {
          console.log(`${new Date().toISOString()} ${key}: rebuild failed (${(err as Error).message.slice(0, 80)}); retrying`);
        } finally {
          e.rebuilding = false;
        }
      }
      continue;
    }
    log.label = "NEAR testnet and Sepolia";
    const fr = feedRescue(e.contract, log, e.rec.state);
    if (fr.endedAtMs !== null && Date.now() - fr.endedAtMs > HOLD_ENDED_MS) { entries.delete(key); continue; }
    out.push(fr);
  }

  latest = {
    version: 1,
    generated: new Date().toISOString(),
    nowMs: Date.now(),
    contracts,
    head: { height: hi, tsMs: lastReadMs },
    mode,
    watching,
    rescues: publishable(out, Date.now()),
    stalled: [...stalled.values()],
    stale: false,
    lastError: null,
  };
}

function snapshot(): LiveFeed | null {
  if (!latest) return null;
  return { ...latest, nowMs: Date.now(), stale: isStale(lastReadMs, Date.now()), lastError };
}

let last = "";
async function loop() {
  for (;;) {
    const t0 = Date.now();
    try {
      await cycle();
      lastError = null;
      failures = 0;
      const s = `${mode} · ${latest!.rescues.map((r) => `${r.key} ${r.contractState} ${r.events.length} events`).join(", ") || "no rescue open"} · watching ${watching}${stalled.size ? ` · stalled ${[...stalled.keys()].join(", ")}` : ""}`;
      if (s !== last) console.log(`${new Date().toISOString()} ${s}`);
      last = s;
    } catch (e) {
      lastError = scrub(e);
      failures++;
      console.error(`${new Date().toISOString()} cycle failed (${failures}): ${lastError}`);
    }
    if (once) return;
    // after five failures in a row, back off for a minute (the feed reports itself stale meanwhile)
    await sleep(failures >= 5 ? 60_000 : Math.max(0, POLL_MS[mode] - (Date.now() - t0)));
  }
}

/** The demo runner's address inside the stack (not public). Only the /demo/ endpoints below
 *  go through, with the request's origin and the visitor's Cloudflare IP; bodies ≤ 1 KB. */
const DEMO_RUNNER = process.env.DEMO_RUNNER_URL ?? "";
function passToRunner(req: IncomingMessage, res: ServerResponse, path: string) {
  const fail = (code: number, error: string) => void res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ error }));
  if (path !== "/demo/start" && path !== "/demo/status" && path !== "/demo/try" && path !== "/demo/faucet" && path !== "/demo/sponsor" && path !== "/demo/receipts") return fail(404, "not found");
  // only the receipts lookup takes a query (near, evm, position); the runner checks each id's form
  const query = path === "/demo/receipts" ? (req.url ?? "").replace(/^[^?]*/, "").slice(0, 200) : "";
  if (!["GET", "POST", "OPTIONS"].includes(req.method ?? "")) return fail(405, "method not allowed");
  let body = "";
  req.on("data", (c: Buffer) => {
    body += c.toString();
    if (body.length > 1024) req.destroy();
  });
  req.on("end", async () => {
    try {
      const fwd: Record<string, string> = { "content-type": "application/json" };
      for (const h of ["origin", "cf-connecting-ip"]) {
        const v = req.headers[h];
        if (typeof v === "string") fwd[h] = v;
      }
      const r = await fetch(`${DEMO_RUNNER}${path}${query}`, { method: req.method, headers: fwd, body: req.method === "POST" ? body : undefined, signal: AbortSignal.timeout(path === "/demo/try" || path === "/demo/faucet" || path === "/demo/sponsor" ? 60_000 : 10_000) });
      const out: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        if (k.startsWith("access-control-") || k === "content-type" || k === "cache-control" || k === "vary") out[k] = v;
      });
      res.writeHead(r.status, out).end(await r.text());
    } catch {
      fail(502, "demo runner not answering");
    }
  });
}

/** The mainnet panel feed's address inside the stack (stewards/scripts/mainnet-panel.ts --serve). */
const MAINNET_PANEL = process.env.MAINNET_PANEL_URL ?? "";
async function passMainnet(res: ServerResponse, headers: Record<string, string>) {
  try {
    const r = await fetch(`${MAINNET_PANEL}/mainnet.json`, { signal: AbortSignal.timeout(10_000) });
    res.writeHead(r.status, { ...headers, "cache-control": "public, max-age=60" }).end(await r.text());
  } catch {
    res.writeHead(502, headers).end('{"error":"mainnet panel not answering"}');
  }
}

/** Every finished rescue, recorded once from the chains and kept on disk (ARCHIVE_DIR), newest
 *  first, one at a time; a failed recording is retried on a later round. */
const ARCHIVE = process.env.ARCHIVE_DIR ?? "";
const archiveFile = (contract: string, id: number) => join(ARCHIVE, `${contract}--${id}.json`);
let archiveIndex = new Map<string, { events: any[] }>();
function archived() {
  return archiveIndex;
}
function loadArchive() {
  if (!ARCHIVE || !existsSync(ARCHIVE)) return;
  const m = new Map<string, { events: any[] }>();
  for (const f of readdirSync(ARCHIVE).filter((x) => x.endsWith(".json"))) {
    const [contract, id] = f.replace(/\.json$/, "").split("--");
    try {
      m.set(`${contract}#${id}`, JSON.parse(readFileSync(join(ARCHIVE, f), "utf8")));
    } catch {
      /* a half-written file is rewritten next round */
    }
  }
  archiveIndex = m;
}
const ENDED = new Set(["bought_back", "settled", "failed"]);
async function archiveLoop() {
  if (!ARCHIVE) return;
  mkdirSync(ARCHIVE, { recursive: true });
  loadArchive();
  for (;;) {
    try {
      const nowNs = BigInt(Date.now()) * 1_000_000n;
      for (const c of contracts) {
        const params = await rd.view(c, "get_params", {});
        const list: any[] = await rd.view(c, "get_rescues", { from: 0, limit: 500 });
        for (const r of list.sort((a, b) => b.id - a.id)) {
          if (!ENDED.has(r.state) || existsSync(archiveFile(c, r.id))) continue;
          if (windowEnd(r, params.buyback_window_ns, nowNs) >= nowNs) continue; // its last events may still come
          try {
            const log = await recordRescue(rd, c, r.id, nowNs);
            const f = archiveFile(c, r.id);
            writeFileSync(`${f}.tmp`, JSON.stringify(log));
            renameSync(`${f}.tmp`, f);
            archiveIndex.set(`${c}#${r.id}`, log as any);
            console.log(`${new Date().toISOString()} recorded ${c}#${r.id}: ${log.events.length} events, ${log.outcome}`);
          } catch (e) {
            console.error(`${new Date().toISOString()} recording ${c}#${r.id} failed: ${scrub((e as Error).message)}`);
          }
        }
      }
    } catch (e) {
      console.error(`${new Date().toISOString()} archive round failed: ${scrub((e as Error).message)}`);
    }
    await sleep(120_000);
  }
}
if (port && !once) void archiveLoop();

/** Winners' wallets, read once per contract and steward (payouts change rarely). */
const walletCache = new Map<string, Record<string, string>>();
async function walletsCached(contract: string, stewards: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of stewards) {
    const k = `${contract}|${s}`;
    if (!walletCache.has(k)) walletCache.set(k, await walletsOf(rd, contract, [s]).catch(() => ({})));
    Object.assign(out, walletCache.get(k));
  }
  return out;
}

/** The list pages' data (positions, rescues, claims, stewards), re-read every 2 minutes; the last
 *  good copy keeps being served if a read fails. */
let records: string | null = null;
const symbols = new Map<string, Promise<string>>(); // token symbols never change: read once
const symbolOf = (a: string) => {
  if (!symbols.has(a)) symbols.set(a, tokenSymbol(rd, a).catch((e) => (symbols.delete(a), Promise.reject(e))));
  return symbols.get(a)!;
};
async function recordsLoop() {
  for (;;) {
    try {
      const all = [];
      for (const c of contracts) all.push(await fetchContract(c, (ct, m, a) => rd.view(ct, m, a as Record<string, unknown>), symbolOf));
      const r: Records = linkRecords(buildRecords(all), archived());
      records = JSON.stringify(r);
    } catch (e) {
      console.error(`${new Date().toISOString()} records read failed: ${scrub((e as Error).message)}`);
    }
    await sleep(120_000);
  }
}
if (port && !once) void recordsLoop();

console.log(`READ-ONLY · live feed · ${contracts.join(", ")} · ${own.length ? "own testnet node first" : "public nodes only"}${port ? ` · serving http://${host}:${port}/live.json` : ""}`);
if (port) {
  createServer((req, res) => {
    const headers = { "access-control-allow-origin": "*", "content-type": "application/json", "cache-control": "public, max-age=1" };
    const path = req.url?.split("?")[0];
    // the demo runner sits behind this one public address: /demo/* is passed through unchanged
    if (path?.startsWith("/demo/") && DEMO_RUNNER) return void passToRunner(req, res, path);
    if (req.method !== "GET") return void res.writeHead(405, headers).end('{"error":"read-only"}');
    if (path === "/live.json") {
      const s = snapshot();
      if (!s) return void res.writeHead(503, headers).end(JSON.stringify({ error: "first cycle still running", lastError }));
      return void res.writeHead(200, headers).end(JSON.stringify(s));
    }
    // the read-only mainnet panel feed sits behind this address too (GET only)
    if (path === "/mainnet.json" && MAINNET_PANEL) return void passMainnet(res, headers);
    // any rescue's own page: the recording when it exists, else the live follow of a running one
    const m = path?.match(/^\/rescue\/([a-z0-9._-]+)\/(\d+)\.json$/);
    if (m) {
      const key = `${m[1]}#${m[2]}`;
      const f = archiveFile(m[1], Number(m[2]));
      if (existsSync(f)) return void res.writeHead(200, { ...headers, "cache-control": "public, max-age=300" }).end(readFileSync(f, "utf8"));
      const live = snapshot()?.rescues.find((x) => x.key === key);
      if (live) return void res.writeHead(200, headers).end(JSON.stringify(live));
      return void res.writeHead(404, headers).end(JSON.stringify({ error: "not recorded yet", pending: true }));
    }
    if (path === "/records.json") {
      if (!records) return void res.writeHead(503, headers).end(JSON.stringify({ error: "first read still running" }));
      return void res.writeHead(200, { ...headers, "cache-control": "public, max-age=30" }).end(records);
    }
    if (path === "/health") {
      const s = snapshot();
      return void res.writeHead(200, headers).end(JSON.stringify({ ok: !!s && !s.stale && !lastError, generated: s?.generated ?? null, head: s?.head ?? null, mode, lastError }));
    }
    res.writeHead(404, headers).end('{"error":"not found"}');
  }).listen(Number(port), host);
}
await loop();
if (once) {
  console.log(JSON.stringify(snapshot(), (k, v) => (k === "events" ? `${v.length} events` : v), 1));
  process.exit(lastError ? 1 : 0);
}
