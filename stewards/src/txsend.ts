// Sending one signed NEAR transaction through flaky RPC gateways without ever applying it twice.
//
// A keyed RPC sometimes answers a transaction with 502/503/504 or a response near-api-js can't parse
// ("Unknown RPC error"): the node may or may not have forwarded it. Signing again would make a second,
// different transaction (new nonce), so a retry could pay twice. Instead the SAME signed bytes are
// resent, to the transaction RPC and then the fallbacks: the chain applies a given signed
// transaction at most once. If a node reports the nonce as already used on a resend, an earlier
// attempt landed, and its outcome is read by hash.
import { createHash } from "node:crypto";
import { baseEncode, encodeTransaction, type SignedTransaction } from "near-api-js";

export interface TxNode {
  sendTransactionUntil(signed: SignedTransaction, waitUntil: any): Promise<any>;
  viewTransactionStatus(args: { txHash: string; accountId: string; waitUntil: any }): Promise<any>;
}

const text = (e: unknown) => `${(e as Error)?.name ?? ""} ${(e as Error)?.message ?? e}`;
/** The node may not have taken the transaction: worth resending the same bytes. */
export const isTransient = (e: unknown) =>
  /\b50[234]\b|Bad Gateway|Service Unavailable|Gateway Time-?out|Unknown RPC error|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|TIMEOUT_ERROR|timed? ?out|-429|Rate limits exceeded|Too Many Requests/i.test(text(e));
export const isNonceUsed = (e: unknown) => /InvalidNonce|nonce.*(used|too (small|low))|Nonce .* must be larger/i.test(text(e));

/** The transaction's hash: base58 of sha256 over its borsh encoding (what explorers show). */
export const txHashOf = (s: SignedTransaction) => baseEncode(createHash("sha256").update(encodeTransaction(s.transaction)).digest());

/**
 * Send `signed` until a node accepts it. Resends only the same bytes; never re-signs.
 * - a transient error: wait, then resend to the next node (tx RPC first, then the fallbacks);
 * - "nonce already used" on a resend: an earlier attempt landed: return its outcome by hash;
 * - anything else (a refusal, a bad request, a stale nonce on the first try): throw at once.
 */
export async function sendSigned(
  signed: SignedTransaction,
  signerId: string,
  nodes: TxNode[],
  waitUntil: string,
  opts: { tries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<any> {
  const tries = opts.tries ?? 6;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const hash = txHashOf(signed);
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    const node = nodes[i % nodes.length];
    try {
      return await node.sendTransactionUntil(signed, waitUntil);
    } catch (e) {
      last = e;
      if (i > 0 && isNonceUsed(e)) return byHash(nodes, hash, signerId, waitUntil, sleep, e);
      if (!isTransient(e)) throw Object.assign(e as object, { txHash: (e as any)?.txHash ?? (i > 0 ? hash : undefined) });
      await sleep(Math.min(8000, 1000 * 2 ** i));
    }
  }
  // every attempt failed in transit: it may still have landed, so ask by hash before giving up
  try {
    return await byHash(nodes, hash, signerId, waitUntil, sleep, last);
  } catch {
    throw last;
  }
}

async function byHash(nodes: TxNode[], txHash: string, accountId: string, waitUntil: string, sleep: (ms: number) => Promise<void>, cause: unknown): Promise<any> {
  for (let i = 0; i < nodes.length * 2; i++) {
    try {
      return await nodes[i % nodes.length].viewTransactionStatus({ txHash, accountId, waitUntil });
    } catch {
      await sleep(2000);
    }
  }
  throw cause;
}
