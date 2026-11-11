import { describe, it, expect } from "vitest";
import { deliverViaIntents, dryQuote, liveQuote, payQuote, waitDelivery, USDC_NEAR_CONTRACT, type IntentsDeps } from "../src/intents.js";

// NEAR Intents capital: the 1Click request is always dry, sized in the mainnet token's decimals.
const ok = (seen: any[]) =>
  (async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ quote: { amountInFormatted: "101.5", amountInUsd: "101.5", amountOutUsd: "100", timeEstimate: 19 } }) };
  }) as unknown as typeof fetch;

describe("NEAR Intents dry quote", () => {
  it("is always dry, exact output, delivered to the steward's EVM wallet", async () => {
    const seen: any[] = [];
    const q = await dryQuote("LINK", 10n * 10n ** 18n, 18, "0xABCDEF0000000000000000000000000000000001", ok(seen));
    expect(seen[0].dry).toBe(true);
    expect(seen[0].swapType).toBe("EXACT_OUTPUT");
    expect(seen[0].recipient).toBe("0xabcdef0000000000000000000000000000000001");
    expect(seen[0].amount).toBe((10n * 10n ** 18n).toString());
    expect(q.costBps).toBeCloseTo(150, 6);
  });

  it("converts a test token's decimals to the mainnet token's", async () => {
    const seen: any[] = [];
    await dryQuote("WBTC", 87n * 10n ** 16n, 18, "0x0000000000000000000000000000000000000001", ok(seen)); // 0.87 test WBTC with 18 dp
    expect(seen[0].amount).toBe("87000000"); // 0.87 WBTC at 8 dp
  });

  it("an API refusal throws (the caller logs it and delivery continues)", async () => {
    const bad = (async () => ({ ok: false, status: 400, json: async () => ({ message: "No liquidity available" }) })) as unknown as typeof fetch;
    await expect(dryQuote("LINK", 1n, 18, "0x0000000000000000000000000000000000000001", bad)).rejects.toThrow("No liquidity");
  });
});

// The real path, offline: a fake 1Click and a fake NEAR record every request.
const DEP = "e85e9d4ba4dfd5d6c9e3b088879c199878663c9f78dc2804e010f25ad84d2e91";
const STEWARD = "0x26e2ab6ec0e027f01f41cf65ee5375f0692fd41d";
function world(o: { amountIn?: string; costOut?: string; statuses?: string[]; registered?: boolean } = {}) {
  const calls: { contract: string; method: string; args: any; deposit: bigint }[] = [];
  const posted: any[] = [];
  const statuses = [...(o.statuses ?? ["PENDING_DEPOSIT", "PROCESSING", "SUCCESS"])];
  let t = 0;
  const deps: IntentsDeps = {
    fetch: (async (url: string, init?: any) => {
      if (url.endsWith("/quote")) {
        posted.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ quote: { depositAddress: DEP, amountIn: o.amountIn ?? "6318417", minAmountIn: "6255232", amountInUsd: "6.3", amountOutUsd: o.costOut ?? "6.17", timeEstimate: 27, deadline: "x" } }) };
      }
      if (url.endsWith("/deposit/submit")) return { ok: true, status: 200, json: async () => ({}) };
      const st = statuses.length > 1 ? statuses.shift()! : statuses[0];
      return { ok: true, status: 200, json: async () => ({ status: st, swapDetails: { destinationChainTxHashes: st === "SUCCESS" ? [{ hash: "0xdead" }] : [] } }) };
    }) as unknown as typeof fetch,
    nearView: async () => (o.registered ? { total: "1" } : null) as any,
    nearCall: async (contract, method, args, deposit) => {
      calls.push({ contract, method, args, deposit });
      return `tx-${method}`;
    },
    sleep: async (ms) => void (t += ms),
    now: () => t,
  };
  return { deps, calls, posted };
}

describe("NEAR Intents real path (mainnet)", () => {
  it("asks a real exact-output quote for native ETH, deposited from NEAR, refunded to the steward's NEAR account", async () => {
    const w = world();
    const q = await liveQuote(w.deps, 3n * 10n ** 15n, STEWARD, "deep.usestead.near");
    expect(w.posted[0]).toMatchObject({ dry: false, swapType: "EXACT_OUTPUT", depositType: "ORIGIN_CHAIN", refundTo: "deep.usestead.near", refundType: "ORIGIN_CHAIN", recipient: STEWARD, amount: "3000000000000000", destinationAsset: "nep141:eth.omft.near" });
    expect(q.depositAddress).toBe(DEP);
  });

  it("pays exactly amountIn of USDC to the quote's deposit address, registering storage only when missing", async () => {
    const fresh = world();
    await payQuote(fresh.deps, await liveQuote(fresh.deps, 1n, STEWARD, "deep.usestead.near"));
    expect(fresh.calls.map((c) => c.method)).toEqual(["storage_deposit", "ft_transfer"]);
    expect(fresh.calls.every((c) => c.contract === USDC_NEAR_CONTRACT)).toBe(true);
    expect(fresh.calls[1]).toMatchObject({ args: { receiver_id: DEP, amount: "6318417" }, deposit: 1n });
    const known = world({ registered: true });
    await payQuote(known.deps, await liveQuote(known.deps, 1n, STEWARD, "deep.usestead.near"));
    expect(known.calls.map((c) => c.method)).toEqual(["ft_transfer"]);
  });

  it("refuses a quote above the USDC cap or the cost cap, sending nothing", async () => {
    const big = world({ amountIn: "21000000" }); // 21 USDC, above the 20 USDC cap
    expect((await deliverViaIntents(big.deps, 1n, STEWARD, "d.near", 60_000)).status).toBe("FAILED");
    expect(big.calls).toEqual([]);
    const dear = world({ costOut: "5.0" }); // 6.3 in for 5.0 out: 2,600 bps
    const d = await deliverViaIntents(dear.deps, 1n, STEWARD, "d.near", 60_000);
    expect(d.note).toMatch(/cost/);
    expect(dear.calls).toEqual([]);
  });

  it("returns the solver's delivery on SUCCESS, and stops on REFUNDED or when the budget runs out", async () => {
    const ok = world();
    const d = await deliverViaIntents(ok.deps, 1n, STEWARD, "d.near", 60_000);
    expect([d.status, d.deliveryTxs, d.depositTx]).toEqual(["SUCCESS", ["0xdead"], "tx-ft_transfer"]);
    const back = world({ statuses: ["PROCESSING", "REFUNDED"] });
    expect((await deliverViaIntents(back.deps, 1n, STEWARD, "d.near", 60_000)).status).toBe("REFUNDED");
    const slow = world({ statuses: ["PROCESSING"] });
    const t = await waitDelivery(slow.deps, DEP, "tx", "d.near", 30_000);
    expect(t.status).toBe("TIMEOUT");
  });
});

