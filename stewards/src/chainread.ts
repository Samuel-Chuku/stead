// Public, read-only chain readers shared by the rescue recorder and the live feed.
// NEAR: NearBlocks v3 (transaction lists), NEAR RPC (views, tx status, blocks), neardata (whole
// blocks with receipt outcomes). Sepolia: Blockscout (token transfers, token symbols).
// No keys. Every call has a timeout and backs off on 429/5xx. Errors never carry a URL.
import type { ChainLog, EvmSent, EvmTransfer } from "./rescuelog.js";

export const NEARBLOCKS = "https://api-testnet.nearblocks.io/v3";
// public archival nodes, tried in turn (each rate-limits on its own)
export const ARCHIVALS = ["https://archival-rpc.testnet.near.org", "https://archival-rpc.testnet.fastnear.com"];
// regular (recent state) nodes for views of the current state; archival as the last resort
export const RPCS = ["https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com", ...ARCHIVALS];
export const NEARDATA = "https://testnet.neardata.xyz/v0";
export const BLOCKSCOUT = "https://eth-sepolia.blockscout.com/api/v2";
// NEAR mainnet and Ethereum mainnet counterparts, for readers made with `net: "mainnet"` / an
// Ethereum `blockscout` (the testnet ones above stay the default)
export const MAINNET = {
  nearblocks: "https://api.nearblocks.io/v3",
  archivals: ["https://archival-rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.near.org"],
  rpcs: ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"],
};
export const BLOCKSCOUT_ETHEREUM = "https://eth.blockscout.com/api/v2";
const TIMEOUT_MS = 10_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** An error message safe to print or serve: no URLs (keyed or not). */
export const scrub = (e: unknown) => String((e as any)?.message ?? e).replace(/https?:\/\/\S+/g, "<url>");

export type Reader = {
  ua: string;
  get(url: string, tries?: number): Promise<any>;
  rpc(method: string, params: unknown, nodes?: string[], tries?: number): Promise<any>;
  view(contract: string, method: string, args: object, height?: number): Promise<any>;
  /** A current-state view and the final block height it was read at. */
  viewAt(contract: string, method: string, args: object): Promise<{ value: any; height: number }>;
  /** Nodes for current state (views, headers) and for history (old blocks, tx status), own first. */
  nodes: { current: string[]; archival: string[] };
  /** Explorer APIs this reader uses (NearBlocks for its NEAR network, Blockscout for its EVM chain). */
  nearblocks?: string;
  blockscout?: string;
};

/** `own`: the project's own NEAR testnet RPCs from .env (keyed, never printed), tried before the
 *  public ones. `current` serves views of the current state; `archival` serves old blocks and
 *  transactions (an archival own node goes in both). */
export function reader(ua: string, own: { current?: string[]; archival?: string[] } = {}, opts: { net?: "testnet" | "mainnet"; blockscout?: string } = {}): Reader {
  // a mainnet reader never falls back to testnet nodes (or the reverse)
  const main = opts.net === "mainnet";
  const nodes = { current: [...(own.current ?? []), ...(main ? [...MAINNET.rpcs, ...MAINNET.archivals] : RPCS)], archival: [...(own.archival ?? []), ...(main ? MAINNET.archivals : ARCHIVALS)] };
  const H = { "user-agent": ua, accept: "application/json" };
  const timed = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  async function get(url: string, tries = 8): Promise<any> {
    for (let i = 0; ; i++) {
      const r = await timed(url, { headers: H });
      if (!r) { if (i >= tries) throw new Error(`${new URL(url).host}: unreachable`); await sleep(3000 * (i + 1)); continue; }
      if (r.ok) return r.json();
      if (i >= tries || (r.status !== 429 && r.status < 500)) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
      await sleep(3000 * (i + 1));
    }
  }
  async function rpc(method: string, params: unknown, list = nodes.archival, tries = 4): Promise<any> {
    for (let i = 0; ; i++) {
      const r = await timed(list[i % list.length], { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      // some providers answer a JSON-RPC error (e.g. UNKNOWN_BLOCK) with a 4xx status: read the body either way
      const j: any = !r ? { error: { message: "unreachable" } } : await r.json().then((x: any) => (r.ok || x?.error ? x : { error: { message: `HTTP ${r.status}` } }), () => ({ error: { message: `HTTP ${r.status}` } }));
      if (!j.error) return j.result;
      // a block that doesn't exist won't appear on another node or a retry
      if (j.error.cause?.name === "UNKNOWN_BLOCK" && i >= 1) throw new Error(`${method}: UNKNOWN_BLOCK`);
      if (i >= tries) throw new Error(`${method}: ${j.error.cause?.name ?? j.error.message ?? "error"}`);
      await sleep(i < list.length ? 200 : 1500 * (i + 1));
    }
  }
  const callArgs = (contract: string, method: string, args: object, height?: number) => ({
    request_type: "call_function",
    ...(height ? { block_id: height } : { finality: "final" }),
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  async function view(contract: string, method: string, args: object, height?: number): Promise<any> {
    const r = await rpc("query", callArgs(contract, method, args, height), height ? nodes.archival : nodes.current);
    return JSON.parse(Buffer.from(r.result).toString());
  }
  async function viewAt(contract: string, method: string, args: object) {
    const r = await rpc("query", callArgs(contract, method, args), nodes.current);
    return { value: JSON.parse(Buffer.from(r.result).toString()), height: Number(r.block_height) };
  }
  return { ua, get, rpc, view, viewAt, nodes, nearblocks: main ? MAINNET.nearblocks : NEARBLOCKS, blockscout: opts.blockscout ?? BLOCKSCOUT };
}

export type Tx = { tsNs: string; tx: string; signer: string; method: string };
/** A contract's successful transactions in [fromNs, toNs], oldest first (NearBlocks cursor walk). */
export async function contractTxs(rd: Reader, contract: string, fromNs: bigint, toNs: bigint, signer?: string): Promise<Tx[]> {
  const rows: Tx[] = [];
  let next: string | undefined;
  for (;;) {
    const q = new URLSearchParams({ limit: "100", before_ts: toNs.toString(), ...(signer ? { signer } : {}), ...(next ? { next } : {}) });
    const d = await rd.get(`${rd.nearblocks ?? NEARBLOCKS}/accounts/${contract}/txns?${q}`);
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

/** The contract's EVENT_JSON logs (standard `stead`/`nep171`) of the given transactions, each timed
 *  by the block that executed its receipt (a verified read's callback lands several blocks after the
 *  transaction that asked for it). A method call with no event (start_settlement) is kept as event "". */
export async function txLogs(rd: Reader, contract: string, txs: Tx[], onEvent?: (l: ChainLog, height: number) => void): Promise<ChainLog[]> {
  const logs: ChainLog[] = [];
  const blocks = new Map<string, { height: number; tsNs: string }>();
  const blockOf = async (hash: string) => {
    if (!blocks.has(hash)) {
      const b = await rd.rpc("block", { block_id: hash }, rd.nodes.archival, 10);
      blocks.set(hash, { height: b.header.height, tsNs: b.header.timestamp_nanosec });
    }
    return blocks.get(hash)!;
  };
  for (const t of txs) {
    const s = await rd.rpc("EXPERIMENTAL_tx_status", { tx_hash: t.tx, sender_account_id: t.signer, wait_until: "NONE" }, rd.nodes.archival, 10);
    let any = false;
    for (const ro of s.receipts_outcome) {
      if (ro.outcome.executor_id !== contract) continue;
      const evs = (ro.outcome.logs as string[]).filter((x) => x.startsWith("EVENT_JSON:")).map((x) => JSON.parse(x.slice(11))).filter((e) => e.standard === "stead" || e.standard === "nep171");
      if (!evs.length) continue;
      const b = await blockOf(ro.block_hash);
      for (const e of evs) {
        for (const data of e.data ?? [{}]) {
          const l = { tsNs: b.tsNs, tx: t.tx, signer: t.signer, method: t.method, event: e.event, data };
          logs.push(l);
          any = true;
          onEvent?.(l, b.height);
        }
      }
    }
    if (!any && t.method === "start_settlement") logs.push({ ...t, event: "", data: {} });
    await sleep(150);
  }
  return logs;
}

/** ERC-20 transfers of an EVM address (Sepolia unless the reader names another Blockscout), newest pages first, back to `sinceMs`. */
const senders = new Map<string, string>();
/** Who sent a Sepolia transaction (Blockscout), cached. */
export async function txSender(rd: Reader, tx: string): Promise<string | undefined> {
  if (!senders.has(tx)) {
    const d = await rd.get(`${rd.blockscout ?? BLOCKSCOUT}/transactions/${tx}`).catch(() => null);
    if (d?.from?.hash) senders.set(tx, String(d.from.hash).toLowerCase());
  }
  return senders.get(tx);
}

/** The address's ERC-20 transfers since `sinceMs`; supplies into it (mints from address zero) carry
 *  their transaction's sender, so a top-up is tied to the wallet that made it. */
export async function evmTransfers(rd: Reader, address: string, sinceMs: number, maxPages = 20): Promise<EvmTransfer[]> {
  const out: EvmTransfer[] = [];
  let page: any = undefined;
  for (let i = 0; i < maxPages; i++) {
    const q = new URLSearchParams({ type: "ERC-20", ...(page ?? {}) });
    const d = await rd.get(`${rd.blockscout ?? BLOCKSCOUT}/addresses/${address}/token-transfers?${q}`);
    for (const x of d.items ?? []) {
      const ts = Math.floor(Date.parse(x.timestamp) / 1000);
      out.push({ block: Number(x.block_number), ts, tx: x.transaction_hash, token: x.token.address_hash ?? x.token.address, from: x.from.hash, to: x.to.hash, value: x.total.value, decimals: Number(x.token.decimals) });
    }
    const oldest = Math.min(...(d.items ?? []).map((x: any) => Date.parse(x.timestamp)));
    if (!d.next_page_params || oldest < sinceMs) break;
    page = d.next_page_params;
    await sleep(400);
  }
  for (const x of out) if (/^0x0{40}$/i.test(x.from) && x.to.toLowerCase() === address.toLowerCase() && Date.parse(new Date(x.ts * 1000).toISOString()) >= sinceMs) x.sender = await txSender(rd, x.tx);
  return out;
}

/** The transactions the address itself sent since `sinceMs` (newest pages first): a position's
 *  contract-signed steps (settlement withdraws and payout transfers), with their raw input. */
export async function evmSentTxs(rd: Reader, address: string, sinceMs: number, maxPages = 10): Promise<EvmSent[]> {
  const out: EvmSent[] = [];
  let page: any = undefined;
  for (let i = 0; i < maxPages; i++) {
    const q = new URLSearchParams({ filter: "from", ...(page ?? {}) });
    const d = await rd.get(`${rd.blockscout ?? BLOCKSCOUT}/addresses/${address}/transactions?${q}`);
    for (const x of d.items ?? []) {
      if (String(x.from?.hash ?? "").toLowerCase() !== address.toLowerCase()) continue;
      out.push({ block: Number(x.block_number ?? x.block), ts: Math.floor(Date.parse(x.timestamp) / 1000), tx: x.hash, nonce: Number(x.nonce), to: String(x.to?.hash ?? ""), input: String(x.raw_input ?? ""), ok: x.status === "ok" || x.result === "success" });
    }
    const oldest = Math.min(...(d.items ?? []).map((x: any) => Date.parse(x.timestamp)));
    if (!d.next_page_params || oldest < sinceMs) break;
    page = d.next_page_params;
    await sleep(400);
  }
  return out.filter((x) => x.ts * 1000 >= sinceMs);
}

export async function tokenSymbol(rd: Reader, address: string): Promise<string> {
  return (await rd.get(`${rd.blockscout ?? BLOCKSCOUT}/tokens/${address}`)).symbol;
}
