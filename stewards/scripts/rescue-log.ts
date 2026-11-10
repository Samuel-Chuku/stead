// npx tsx scripts/rescue-log.ts --rescue 8 [--contract sepolia-demo.steadfi.testnet] [--minutes 20] [--out file] [--raw file]
//
// READ-ONLY. Rebuilds one real rescue's event log from the chains, for the front end's replay:
//  - the contract's transactions in the rescue's time window (NearBlocks API, public),
//  - each transaction's EVENT_JSON logs and the contract's own records at the right blocks
//    (NEAR archival RPC, public),
//  - the position address's token transfers on Sepolia (Blockscout API, public).
// Every event in the output carries the transaction it came from. No keys, no transactions sent.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildLog, STEWARDS, type ChainLog, type ClaimRecord, type EvmTransfer, type Inputs } from "../src/rescuelog.js";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const rid = Number(arg("--rescue"));
if (!Number.isInteger(rid)) throw new Error("usage: --rescue <id>");
const contract = arg("--contract") ?? "sepolia-demo.steadfi.testnet";
const minutes = Number(arg("--minutes") ?? 20);
const out = resolve(arg("--out") ?? join(REPO, "web", "public", "replays", `${contract.split(".")[0]}-rescue-${rid}.json`));
const rawOut = arg("--raw");
const NEARBLOCKS = "https://api-testnet.nearblocks.io/v3";
// public archival nodes, tried in turn (each rate-limits on its own)
const ARCHIVALS = ["https://archival-rpc.testnet.near.org", "https://archival-rpc.testnet.fastnear.com"];
const BLOCKSCOUT = "https://eth-sepolia.blockscout.com/api/v2";
const UA = { "user-agent": "stead-rescue-log", accept: "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, tries = 8): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers: UA }).catch(() => null);
    if (!r) { if (i >= tries) throw new Error(`${new URL(url).host}: unreachable`); await sleep(3000 * (i + 1)); continue; }
    if (r.ok) return r.json();
    if (i >= tries || (r.status !== 429 && r.status < 500)) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
    await sleep(3000 * (i + 1));
  }
}
async function rpc(method: string, params: unknown): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(ARCHIVALS[i % ARCHIVALS.length], { method: "POST", headers: { ...UA, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).catch(() => null);
    const j: any = !r ? { error: { message: "unreachable" } } : r.ok ? await r.json() : { error: { message: `HTTP ${r.status}` } };
    if (!j.error) return j.result;
    if (i >= 4) throw new Error(`${method}: ${j.error.cause?.name ?? j.error.message ?? "error"}`);
    await sleep(1500 * (i + 1));
  }
}
async function view(method: string, args: object, height?: number): Promise<any> {
  const r = await rpc("query", {
    request_type: "call_function",
    ...(height ? { block_id: height } : { finality: "final" }),
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString());
}

type Tx = { tsNs: string; tx: string; signer: string; method: string };
/** The contract's transactions in [fromNs, toNs], newest page first (cursor walk). */
async function contractTxs(fromNs: bigint, toNs: bigint, signer?: string): Promise<Tx[]> {
  const rows: Tx[] = [];
  let next: string | undefined;
  for (;;) {
    const q = new URLSearchParams({ limit: "100", before_ts: toNs.toString(), ...(signer ? { signer } : {}), ...(next ? { next } : {}) });
    const d = await get(`${NEARBLOCKS}/accounts/${contract}/txns?${q}`);
    let stop = false;
    for (const t of d.data ?? []) {
      if (BigInt(t.block_timestamp) < fromNs) { stop = true; break; }
      if (t.outcomes?.status) rows.push({ tsNs: t.block_timestamp, tx: t.transaction_hash, signer: t.signer_account_id, method: t.actions?.[0]?.method ?? "" });
    }
    next = d.meta?.next_page;
    if (stop || !next) break;
    await sleep(1200);
  }
  return rows.reverse();
}

async function main() {
  // 1. The bids for this rescue give its time window (stewards' own transactions are few).
  let bidTimes: bigint[] = [];
  const now = BigInt(Date.now()) * 1_000_000n;
  for (const s of STEWARDS) {
    const txs = await contractTxs(0n, now, `${s}.steadfi.testnet`);
    await sleep(1200);
    for (const t of txs.filter((x) => x.method === "bid")) {
      const st = await rpc("EXPERIMENTAL_tx_status", { tx_hash: t.tx, sender_account_id: t.signer, wait_until: "NONE" });
      const fc = st.transaction.actions?.[0]?.FunctionCall;
      const a = fc ? JSON.parse(Buffer.from(fc.args, "base64").toString()) : null;
      if (a?.rescue_id === rid) bidTimes.push(BigInt(t.tsNs));
    }
  }
  if (!bidTimes.length) throw new Error(`no bids found for rescue ${rid} on ${contract}`);
  bidTimes.sort((a, b) => (a < b ? -1 : 1));
  const fromNs = bidTimes[0] - 120_000_000_000n;
  const toNs = bidTimes[bidTimes.length - 1] + BigInt(minutes * 60) * 1_000_000_000n;
  console.log(`rescue ${rid}: ${bidTimes.length} bids; window ${new Date(Number(fromNs / 1_000_000n)).toISOString()} + ${minutes} min`);

  // 2. Every contract transaction in the window, with its EVENT_JSON logs.
  const txs = await contractTxs(fromNs, toNs);
  const logs: ChainLog[] = [];
  const blocks = new Map<string, { height: number; tsNs: string }>();
  const blockOf = async (hash: string) => {
    if (!blocks.has(hash)) {
      const b = await rpc("block", { block_id: hash });
      blocks.set(hash, { height: b.header.height, tsNs: b.header.timestamp_nanosec });
    }
    return blocks.get(hash)!;
  };
  let openAt: { height: number } | undefined;
  let mintAt: { height: number; tx: string } | undefined;
  for (const t of txs) {
    const s = await rpc("EXPERIMENTAL_tx_status", { tx_hash: t.tx, sender_account_id: t.signer, wait_until: "NONE" });
    let any = false;
    for (const ro of s.receipts_outcome) {
      if (ro.outcome.executor_id !== contract) continue;
      const evs = (ro.outcome.logs as string[]).filter((x) => x.startsWith("EVENT_JSON:")).map((x) => JSON.parse(x.slice(11))).filter((e) => e.standard === "stead" || e.standard === "nep171");
      if (!evs.length) continue;
      // events are timed by the block that executed the receipt (a verified read's callback lands
      // several blocks after the transaction that asked for it)
      const b = await blockOf(ro.block_hash);
      for (const e of evs) {
        for (const data of e.data ?? [{}]) {
          logs.push({ tsNs: b.tsNs, tx: t.tx, signer: t.signer, method: t.method, event: e.event, data });
          any = true;
          if (e.event === "auction_opened" && data.rescue_id === rid) openAt = b;
          if (e.event === "nft_mint" && !mintAt && logs.some((l) => l.event === "auction_closed" && l.data.rescue_id === rid)) mintAt = { height: b.height, tx: t.tx };
        }
      }
    }
    if (!any && t.method === "start_settlement") logs.push({ ...t, event: "", data: {} });
    await sleep(150);
  }
  if (!openAt) throw new Error(`auction_opened for rescue ${rid} not in the window; widen it`);
  console.log(`${txs.length} transactions, ${logs.length} events`);

  // 3. The contract's own records at the right heights.
  const hOpen = openAt.height;
  const params = await view("get_params", {}, hOpen);
  const rescue = await view("get_rescue", { rescue_id: rid });
  const position = await view("get_position", { position_id: rescue.position_id }, hOpen);
  const market = await view("get_market", { market_id: position.market_id }, hOpen);
  const claims: ClaimRecord[] = [];
  if (mintAt) {
    const ids = logs.filter((l) => l.tx === mintAt!.tx && l.event === "nft_mint").flatMap((l) => l.data.token_ids as string[]);
    for (const id of ids) {
      for (let dh = 0; dh <= 4; dh++) {
        const c = await view("get_claim", { token_id: id }, mintAt.height + dh).catch(() => null);
        if (c && c.rescue_id === rid) { claims.push(c); break; }
      }
    }
  }

  // 4. The position address's token transfers on Sepolia (supply, payments in, payouts out).
  const transfers: EvmTransfer[] = [];
  const symbols = { collateral: "", debt: "" };
  let page: any = undefined;
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ type: "ERC-20", ...(page ?? {}) });
    const d = await get(`${BLOCKSCOUT}/addresses/${position.evm_address}/token-transfers?${q}`);
    for (const x of d.items ?? []) {
      const ts = Math.floor(Date.parse(x.timestamp) / 1000);
      transfers.push({ block: Number(x.block_number), ts, tx: x.transaction_hash, token: x.token.address_hash ?? x.token.address, from: x.from.hash, to: x.to.hash, value: x.total.value, decimals: Number(x.token.decimals) });
    }
    const oldest = Math.min(...(d.items ?? []).map((x: any) => Date.parse(x.timestamp)));
    if (!d.next_page_params || oldest < Number(fromNs / 1_000_000n)) break;
    page = d.next_page_params;
    await sleep(400);
  }
  for (const [k, addr] of [["collateral", market.collateral], ["debt", market.debt]] as const) {
    const t = await get(`${BLOCKSCOUT}/tokens/${addr}`);
    symbols[k] = t.symbol;
  }

  const inputs: Inputs = { contract, nearNetwork: "testnet", evmChain: "sepolia", rescue, position, market, params, symbols, claims, logs, transfers };
  if (rawOut) writeFileSync(resolve(rawOut), JSON.stringify(inputs, null, 1));
  const log = buildLog(inputs);
  log.label = `Recorded on NEAR testnet and Sepolia, ${new Date(log.openedAtMs).toISOString().slice(0, 10)}`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(log, null, 1));
  console.log(`${log.events.length} events, outcome ${log.outcome} → ${out}`);
}

main().catch((e) => {
  console.error(String(e?.message ?? e).replace(/https?:\/\/\S+/g, "<url>"));
  process.exit(1);
});
