import { describe, it, expect } from "vitest";
import { dryQuote } from "../src/intents.js";

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
