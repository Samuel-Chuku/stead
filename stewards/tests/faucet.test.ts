// The sponsored faucet's rules. Offline.
import { describe, expect, it } from "vitest";
import { FAUCET, checkFaucet, freshFaucet, recordFaucet } from "../src/faucet.js";

const O = "https://app.usestead.xyz";
const T0 = Date.UTC(2026, 10, 12, 10);
const RICH = { reserveWei: 10n ** 18n, sponsorYocto: 5n * 10n ** 24n };
const body = (near: string, evm: string) => JSON.stringify({ near, evm });
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("faucet", () => {
  it("serves a NEAR testnet account and a Sepolia address once a day each, and once per visitor", () => {
    const st = freshFaucet();
    expect(checkFaucet(st, T0, body("alice.testnet", A), O, [O], "1.1.1.1", RICH)).toEqual({ ok: true, near: "alice.testnet", evm: A });
    recordFaucet(st, T0, "alice.testnet", A, "1.1.1.1");
    expect(checkFaucet(st, T0 + 60_000, body("alice.testnet", B), O, [O], "2.2.2.2", RICH)).toMatchObject({ ok: false, status: 429 }); // same NEAR account
    expect(checkFaucet(st, T0 + 60_000, body("bob.testnet", A), O, [O], "2.2.2.2", RICH)).toMatchObject({ ok: false, status: 429 }); // same address
    expect(checkFaucet(st, T0 + 60_000, body("bob.testnet", B), O, [O], "1.1.1.1", RICH)).toMatchObject({ ok: false, status: 429 }); // same visitor
    expect(checkFaucet(st, T0 + FAUCET.perWalletMs, body("alice.testnet", A), O, [O], "1.1.1.1", RICH).ok).toBe(true); // a day later
  });

  it("stops at the daily cap", () => {
    const st = freshFaucet();
    for (let i = 0; i < FAUCET.perDay; i++) recordFaucet(st, T0, `u${i}.testnet`, `0x${String(i).padStart(40, "0")}`, `10.0.0.${i}`);
    expect(checkFaucet(st, T0, body("late.testnet", A), O, [O], "9.9.9.9", RICH)).toMatchObject({ ok: false, status: 429, error: expect.stringContaining("used up") });
  });

  it("never dips into the demo slots' reserve or the sponsor's floor", () => {
    const st = freshFaucet();
    expect(checkFaucet(st, T0, body("alice.testnet", A), O, [O], "1.1.1.1", { ...RICH, reserveWei: FAUCET.reserveFloorWei })).toMatchObject({ ok: false, status: 503 });
    expect(checkFaucet(st, T0, body("alice.testnet", A), O, [O], "1.1.1.1", { ...RICH, sponsorYocto: FAUCET.sponsorFloorYocto })).toMatchObject({ ok: false, status: 503 });
  });

  it("checks the origin and the request's shape", () => {
    const st = freshFaucet();
    expect(checkFaucet(st, T0, body("alice.testnet", A), "https://evil.example", [O], "1.1.1.1", RICH)).toMatchObject({ status: 403 });
    expect(checkFaucet(st, T0, body("alice.near", A), O, [O], "1.1.1.1", RICH)).toMatchObject({ status: 400 }); // mainnet account
    expect(checkFaucet(st, T0, body("alice.testnet", "0x12"), O, [O], "1.1.1.1", RICH)).toMatchObject({ status: 400 });
    expect(checkFaucet(st, T0, JSON.stringify({ near: "alice.testnet", evm: A, amount: 100 }), O, [O], "1.1.1.1", RICH)).toMatchObject({ status: 400 });
  });

  it("amounts match one own-wallet rescue, not more", () => {
    expect(FAUCET.nearYocto).toBe(4n * 10n ** 22n); // 0.04 NEAR ≈ 13 calls × 0.0018 + key, with margin
    expect(FAUCET.ethWei).toBe(25n * 10n ** 14n); // 0.0025 ETH
  });
});
