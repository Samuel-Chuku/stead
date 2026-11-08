// Thin NEAR helpers over near-api-js 7: views, calls with tx hash + events + return value.
import { Account, JsonRpcProvider } from "near-api-js";
import { cfg, nearKey } from "./config.js";

export const provider = new JsonRpcProvider({ url: cfg.nearRpc });
const txProvider = cfg.nearTxRpc === cfg.nearRpc ? provider : new JsonRpcProvider({ url: cfg.nearTxRpc });
/** Views fail over to these, in order, when the main view RPC keeps failing (comma-separated
 *  NEAR_RPC_FALLBACK). A view is read-only, so asking another node is always safe. */
const fallbacks = cfg.nearFallback.split(",").map((u) => u.trim()).filter((u) => u && u !== cfg.nearRpc).map((url) => new JsonRpcProvider({ url }));
const accounts = new Map<string, Account>();

export function account(id: string): Account {
  let a = accounts.get(id);
  if (!a) {
    a = new Account(id, txProvider, nearKey(id) as any);
    accounts.set(id, a);
  }
  return a;
}

const is429 = (e: unknown) => /-429|Rate limits exceeded|Too Many Requests/i.test(String((e as Error)?.message ?? e));

/** Retry on RPC rate limiting (429), with backoff. A 429 rejects the request before it runs, so
 *  retrying a transaction can't double-apply it. */
const isNetwork = (e: unknown) => /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String((e as Error)?.message ?? e));

export async function withRetry<T>(fn: () => Promise<T>, tries = 8, retryNetwork = false): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      // views also retry network errors; transactions don't (the tx may have gone through)
      if (!(is429(e) || (retryNetwork && isNetwork(e))) || i + 1 >= tries) throw e;
      await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** i) + Math.random() * 300));
    }
  }
}

// Views are shared by the keeper and every in-process steward: one cache with in-flight
// coalescing keeps the public RPC under its rate limit. Live state is cached 1.5 s; values only
// the contract owner changes (parameters, markets, roles, payouts) for minutes, since a 24/7 bot
// would otherwise re-read them every tick. Any call clears the cache.
const VIEW_TTL_MS = 1500;
export const SLOW_VIEWS: Record<string, number> = {
  get_params: 10 * 60_000,
  get_market: 10 * 60_000,
  get_verify_config: 10 * 60_000,
  get_steward_deposit: 10 * 60_000,
  get_roles: 2 * 60_000, // stewards join any time: a new one is seen within 2 min
  get_removed_stewards: 2 * 60_000,
  get_evm_payout: 2 * 60_000,
};
const viewCache = new Map<string, { at: number; ttl: number; p: Promise<unknown> }>();

/** Views sent to the RPC (not served from the cache), by method, since the last report. */
export const viewStats = new Map<string, number>();

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const k = `${method}:${JSON.stringify(args)}`;
  const hit = viewCache.get(k);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.p as Promise<T>;
  viewStats.set(method, (viewStats.get(method) ?? 0) + 1);
  const ask = (pr: JsonRpcProvider) => withRetry(() => pr.callFunction({ contractId: cfg.contract, method, args }), fallbacks.length ? 3 : 8, true);
  const p = fallbacks.reduce<Promise<unknown>>((acc, fb) => acc.catch(() => ask(fb)), ask(provider));
  viewCache.set(k, { at: Date.now(), ttl: SLOW_VIEWS[method] ?? VIEW_TTL_MS, p });
  p.catch(() => viewCache.delete(k));
  return p as Promise<T>;
}

/** One line per period: how many views went to the RPC, busiest methods first. */
export function viewReport(periodMs: number): string {
  const total = [...viewStats.values()].reduce((a, b) => a + b, 0);
  const top = [...viewStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m, n]) => `${m} ${n}`).join(", ");
  viewStats.clear();
  return `${total} NEAR views in ${Math.round(periodMs / 60_000)} min (≈${Math.round((total * 86_400_000) / periodMs)}/day)${top ? `: ${top}` : ""}`;
}

export interface CallResult<T = unknown> {
  hash: string;
  value: T | undefined;
  events: { event: string; data: any }[];
  logs: string[];
}

export const TGAS = 1_000_000_000_000n;
export const NEAR = 10n ** 24n;

/** Call the Stead contract as `signer`. Waits for every receipt (MPC callbacks included). Throws
 *  with the contract's panic message on failure. */
export async function call<T = unknown>(signer: string, method: string, args: Record<string, unknown>, opts: { gas?: bigint; deposit?: bigint } = {}): Promise<CallResult<T>> {
  viewCache.clear();
  const res: any = await withRetry(() => account(signer).callFunctionRaw({
    contractId: cfg.contract,
    methodName: method,
    args,
    gas: opts.gas ?? 100n * TGAS,
    deposit: opts.deposit ?? 0n,
    waitUntil: "FINAL",
  }));
  viewCache.clear();
  const outcomes = [res.transaction_outcome, ...(res.receipts_outcome ?? [])];
  const logs: string[] = outcomes.flatMap((o: any) => o.outcome.logs ?? []);
  const failure = outcomes.map((o: any) => o.outcome.status?.Failure).find(Boolean) ?? res.status?.Failure;
  if (failure) {
    const msg = JSON.stringify(failure).match(/Smart contract panicked: ([^"\\]+)/)?.[1] ?? JSON.stringify(failure);
    const e = new Error(msg) as Error & { hash?: string };
    e.hash = res.transaction.hash;
    throw e;
  }
  const events = logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice(11)))
    .flatMap((e: any) => (Array.isArray(e.data) ? e.data : [e.data]).map((d: any) => ({ event: e.event, data: d })));
  let value: any;
  const sv = res.status?.SuccessValue;
  if (sv) {
    try {
      value = JSON.parse(Buffer.from(sv, "base64").toString());
    } catch {
      value = undefined;
    }
  }
  return { hash: res.transaction.hash, value, events, logs };
}

export const explorer = (hash: string) => `https://${cfg.nearNetwork === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${hash}`;
