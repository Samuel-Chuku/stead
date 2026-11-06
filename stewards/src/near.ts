// Thin NEAR helpers over near-api-js 7: views, calls with tx hash + events + return value.
import { Account, JsonRpcProvider } from "near-api-js";
import { cfg, nearKey } from "./config.js";

export const provider = new JsonRpcProvider({ url: cfg.nearRpc });
const txProvider = cfg.nearTxRpc === cfg.nearRpc ? provider : new JsonRpcProvider({ url: cfg.nearTxRpc });
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

// Views are shared by the keeper and every in-process steward: one cache (1.5 s) with in-flight
// coalescing keeps the public RPC under its rate limit. Any call clears it.
const VIEW_TTL_MS = 1500;
const viewCache = new Map<string, { at: number; p: Promise<unknown> }>();

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const k = `${method}:${JSON.stringify(args)}`;
  const hit = viewCache.get(k);
  if (hit && Date.now() - hit.at < VIEW_TTL_MS) return hit.p as Promise<T>;
  const p = withRetry(() => provider.callFunction({ contractId: cfg.contract, method, args }), 8, true);
  viewCache.set(k, { at: Date.now(), p });
  p.catch(() => viewCache.delete(k));
  return p as Promise<T>;
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

export const explorer = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
