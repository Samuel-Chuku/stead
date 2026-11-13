import { describe, it, expect } from "vitest";
import { KeyPair, KeyPairSigner, actions, createTransaction } from "near-api-js";
import { sendSigned, txHashOf, isTransient, type TxNode } from "../src/txsend.js";

// One signed NEAR transaction sent through flaky gateways: retried with the SAME bytes only, so it
// can never apply twice; a refusal is never retried; an earlier landing is read back by hash.
async function signed() {
  const kp = KeyPair.fromRandom("ed25519");
  const tx = createTransaction("a.near", kp.getPublicKey(), "usdc.near", 7n, [actions.functionCall("ft_transfer", { amount: "1" }, 30n * 10n ** 12n, 1n)], new Uint8Array(32));
  return (await new KeyPairSigner(kp).signTransaction(tx)).signedTransaction;
}
const noWait = async () => {};
const ok = { status: { SuccessValue: "" }, transaction: { hash: "h" } };
function node(script: (string | object)[], seen: unknown[], byHash?: string[]): TxNode {
  return {
    async sendTransactionUntil(s) {
      seen.push(s);
      const next = script.shift() ?? ok;
      if (typeof next === "string") throw new Error(next);
      return next;
    },
    async viewTransactionStatus({ txHash }) {
      byHash?.push(txHash);
      return { ...ok, viaHash: txHash };
    },
  };
}

describe("sending a signed NEAR transaction through flaky RPCs", () => {
  it("resends the identical signed transaction after a 502, moving to the next node", async () => {
    const s = await signed();
    const seenA: unknown[] = [], seenB: unknown[] = [];
    const r = await sendSigned(s, "a.near", [node(["Bad Gateway"], seenA), node([], seenB)], "FINAL", { sleep: noWait });
    expect(r).toEqual(ok);
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
    expect(seenB[0]).toBe(seenA[0]); // the same bytes, never a second signature
  });

  it("treats 'nonce already used' on a resend as an earlier attempt landing, and reads it by hash", async () => {
    const s = await signed();
    const looked: string[] = [];
    const r = await sendSigned(s, "a.near", [node(["Unknown RPC error", "InvalidNonceError: nonce 7 already used"], [], looked)], "FINAL", { sleep: noWait });
    expect(looked).toEqual([txHashOf(s)]);
    expect(r.viaHash).toBe(txHashOf(s));
  });

  it("never retries a refusal", async () => {
    const s = await signed();
    const seen: unknown[] = [];
    await expect(sendSigned(s, "a.near", [node(["Smart contract panicked: not allowed"], seen)], "FINAL", { sleep: noWait })).rejects.toThrow(/not allowed/);
    expect(seen).toHaveLength(1);
  });

  it("leaves a stale nonce on the first send to the caller (it re-signs; nothing was applied)", async () => {
    const s = await signed();
    const seen: unknown[] = [];
    const e = await sendSigned(s, "a.near", [node(["InvalidNonceError: nonce too small"], seen)], "FINAL", { sleep: noWait }).catch((x) => x);
    expect(String(e)).toMatch(/InvalidNonce/);
    expect((e as { txHash?: string }).txHash).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("asks by hash before giving up when every send failed in transit", async () => {
    const s = await signed();
    const looked: string[] = [];
    const r = await sendSigned(s, "a.near", [node(Array(6).fill("502 Bad Gateway"), [], looked)], "FINAL", { tries: 6, sleep: noWait });
    expect(looked[0]).toBe(txHashOf(s));
    expect(r.viaHash).toBe(txHashOf(s));
  });

  it("knows a gateway error from a refusal", () => {
    for (const m of ["Bad Gateway", "Error 502", "503 Service Unavailable", "Unknown RPC error", "fetch failed", "Too Many Requests"]) expect(isTransient(new Error(m))).toBe(true);
    for (const m of ["Smart contract panicked: x", "InvalidNonceError", "Exceeded the prepaid gas"]) expect(isTransient(new Error(m))).toBe(false);
  });
});
