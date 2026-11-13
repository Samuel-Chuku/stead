// The "Protect a position" page's per-network settings and arithmetic (web/src/own/net.ts): testnet
// keeps exactly the values it was tested end to end with; mainnet points at the verified Ethereum
// addresses and the capped contract; the health-factor arithmetic lands where the steps say.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  NETS, netFromSearch, gasFromMarket, marketMismatch, allowed, capUsd, borrowUnits, withdrawUnits, repayUnits, valueBase, walletNeeds, isShort,
  directLines, ladder, rescueClock, type MarketView, type RescueView, type ClaimView,
} from "../../web/src/own/net.js";

const E18 = 10n ** 18n;
const T = NETS.testnet;
const M = NETS.mainnet;
// app.usestead.near's market 0 as get_market returned it (2026-11-13)
const LIVE_MARKET: MarketView = {
  chain_id: 1, pool: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", collateral: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", debt: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  collateral_decimals: 18, debt_decimals: 6, lt_bps: 8400, liq_bonus_bps: 500, gas_limit_cap: "375332", max_fee_cap: "1000000000",
};
/** Aave's health factor (bps) from base values: collateral × LT ÷ debt. */
const hfBps = (coll: bigint, debt: bigint, lt: bigint) => (coll * lt) / debt;

describe("network selection", () => {
  it("is testnet unless the page address asks for mainnet", () => {
    expect(netFromSearch("")).toBe("testnet");
    expect(netFromSearch("?rescue=3")).toBe("testnet");
    expect(netFromSearch("?net=mainnet")).toBe("mainnet");
    expect(netFromSearch("?x=1&net=mainnet")).toBe("mainnet");
    expect(netFromSearch("?net=MAINNET")).toBe("testnet");
  });
});

describe("testnet keeps the values it was tested with", () => {
  it("contract, market, addresses, size and gas", () => {
    expect(T.contract).toBe("sepolia-demo.steadfi.testnet");
    expect(T.market).toBe(1);
    expect(T.pool).toBe("0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951");
    expect(T.oracle).toBe("0x2da88497588bf89281816106C7259e31AF45a663");
    expect(T.collateral).toEqual({ address: "0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5", symbol: "LINK", decimals: 18 });
    expect(T.debt).toEqual({ address: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357", symbol: "DAI", decimals: 18 });
    expect(T.collateralUnits).toBe(60n * E18);
    expect(T.evmGas).toEqual({ gas_limit: "600000", max_fee_per_gas: "2000000000", max_priority_fee_per_gas: "100000000" });
    expect(T.txUpfrontWei).toBe(600_000n * 2_000_000_000n);
    expect(T.positionGasWei).toBe(1_500_000_000_000_000n);
    expect(T.gasTopupWei).toBe(2_000_000_000_000_000n);
    expect([T.openHfBps, T.pushHfBps, T.pushBy]).toEqual([11_400n, 11_400n, "borrow"]);
    expect([T.faucet, T.sponsor, T.liveFeed, T.realFunds, T.readingBeforeSupply]).toEqual([true, true, true, false, false]);
    expect(T.nearRpcs).toEqual(["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"]);
    expect(T.nearTx("abc")).toBe("https://testnet.nearblocks.io/txns/abc");
    expect(T.evmTx("0x1")).toBe("https://sepolia.etherscan.io/tx/0x1");
  });
});

describe("mainnet", () => {
  it("points at the capped contract and the verified Aave V3 Ethereum addresses", () => {
    expect(M.contract).toBe("app.usestead.near");
    expect(M.market).toBe(0);
    expect(M.evmChainId).toBe(1);
    expect(M.pool).toBe("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2");
    // AaveV3Ethereum.ORACLE in bgd-labs' address book = PoolAddressesProvider.getPriceOracle()
    expect(M.oracle).toBe("0x54586bE62E3c3580375aE3723C145253060Ca0C2");
    expect(M.collateral).toEqual({ address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 });
    expect(M.debt).toEqual({ address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 });
    expect(marketMismatch(M, LIVE_MARKET)).toEqual([]);
  });
  it("has no faucet, no sponsor and no NEAR-only path; reads the contract itself", () => {
    expect([M.faucet, M.sponsor, M.liveFeed, M.realFunds, M.readingBeforeSupply, M.storyContract]).toEqual([false, false, false, true, true, null]);
  });
  it("opens 0.04 WETH at 1.20 and pushes to 1.14 by a withdraw", () => {
    expect(M.collateralUnits).toBe(4n * 10n ** 16n);
    expect([M.openHfBps, M.pushHfBps, M.pushBy]).toEqual([12_000n, 11_400n, "withdraw"]);
  });
  it("uses mainnet explorers and browser-reachable RPCs", () => {
    expect(M.nearTx("h")).toBe("https://nearblocks.io/txns/h");
    expect(M.evmTx("0x2")).toBe("https://etherscan.io/tx/0x2");
    expect(M.evmRpcs[0]).toBe("https://ethereum-rpc.publicnode.com");
    expect(M.nearRpcs).toEqual(["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"]);
  });
});

describe("gas from the market's caps", () => {
  it("signs at the caps the contract enforces; the up-front fee is limit × max fee", () => {
    const g = gasFromMarket(M, LIVE_MARKET);
    expect(g.evmGas).toEqual({ gas_limit: "375332", max_fee_per_gas: "1000000000", max_priority_fee_per_gas: "10000000" });
    expect(g.txUpfrontWei).toBe(375_332n * 10n ** 9n);
    expect(M.positionGasWei).toBeGreaterThan(g.txUpfrontWei); // the first send covers a signed tx
  });
  it("never sets a priority fee above the max fee", () => {
    const g = gasFromMarket(M, { gas_limit_cap: "300000", max_fee_cap: "5000000" });
    expect(g.evmGas.max_priority_fee_per_gas).toBe("5000000");
  });
});

describe("market check, allow-list, cap", () => {
  it("names each mismatch", () => {
    expect(marketMismatch(M, null)).toEqual(["market 0 does not exist on app.usestead.near"]);
    expect(marketMismatch(M, { ...LIVE_MARKET, pool: "0x0000000000000000000000000000000000000001" })).toEqual(["pool 0x0000000000000000000000000000000000000001"]);
    expect(marketMismatch(M, { ...LIVE_MARKET, chain_id: 11155111, debt_decimals: 18 })).toEqual(["chain id 11155111, expected 1", "token decimals"]);
  });
  it("lets only the listed borrower register (an empty list lets anyone)", () => {
    const limits = { max_collateral_base: "15000000000", borrowers: ["borrower.usestead.near"] };
    expect(allowed(limits, "borrower.usestead.near")).toBe("yes");
    expect(allowed(limits, "someone.near")).toBe("no");
    expect(allowed({ ...limits, borrowers: [] }, "someone.near")).toBe("yes");
    expect(allowed(null, "x.near")).toBe("unknown");
    expect(allowed(limits, null)).toBe("unknown");
    expect(capUsd(limits)).toBe(150);
  });
  it("0.04 WETH stays under the $150 cap up to ETH at $3,750", () => {
    expect(valueBase(M.collateralUnits, 1950n * 10n ** 8n, 18)).toBe(78n * 10n ** 8n);
    expect(valueBase(M.collateralUnits, 3750n * 10n ** 8n, 18) <= 150n * 10n ** 8n).toBe(true);
    expect(valueBase(M.collateralUnits, 3751n * 10n ** 8n, 18) <= 150n * 10n ** 8n).toBe(false);
  });
});

describe("health-factor arithmetic", () => {
  it("testnet: same borrow amount as the page computed before (18-decimal DAI)", () => {
    const coll = 900n * 10n ** 8n, debt = 0n, lt = 7800n, pd = 100_000_000n;
    const old = (((coll * lt) / 11_400n - debt) * E18) / pd;
    expect(borrowUnits(coll, debt, lt, 11_400n, pd, 18)).toBe(old);
    expect(borrowUnits(coll, 616n * 10n ** 8n, lt, 11_400n, pd, 18)).toBe(0n); // already at or past the target
    expect(repayUnits(616n * 10n ** 8n, pd, 18)).toBe((616n * 10n ** 8n * E18 * 1002n) / 1000n / pd);
  });
  it("mainnet: opening borrows USDC (6 dp) to 1.20, the push withdraws WETH to just under the trigger", () => {
    const ethPx = 1949_25000000n, usdcPx = 99_990000n, lt = 8300n; // Aave's own LT for the account (may differ from the market config)
    const coll = valueBase(M.collateralUnits, ethPx, 18);
    const usdc = borrowUnits(coll, 0n, lt, M.openHfBps, usdcPx, 6);
    const debt = (usdc * usdcPx) / 10n ** 6n;
    expect(usdc).toBeGreaterThan(50n * 10n ** 6n);
    expect(usdc).toBeLessThan(60n * 10n ** 6n);
    const h1 = hfBps(coll, debt, lt);
    expect(h1).toBeGreaterThanOrEqual(12_000n);
    expect(h1).toBeLessThan(12_010n);
    const w = withdrawUnits(coll, debt, lt, M.pushHfBps, ethPx, 18);
    expect(w).toBeGreaterThan(10n ** 15n); // about 5 % of 0.04 WETH
    expect(w).toBeLessThan(3n * 10n ** 15n);
    const h2 = hfBps(coll - valueBase(w, ethPx, 18), debt, lt);
    expect(h2).toBeGreaterThanOrEqual(11_400n);
    expect(h2).toBeLessThan(11_500n); // under the 1.15 trigger: the auction opens
    expect(withdrawUnits(coll, 0n, lt, M.pushHfBps, ethPx, 18)).toBe(0n); // no debt: nothing to push
  });
  it("lists what the visitor's wallet needs and flags what is short", () => {
    const n = walletNeeds(M, { eth: 10n ** 15n, coll: 5n * 10n ** 16n, debt: 0n }, { buyBackUnits: 12n * 10n ** 15n, ownGasWei: 10n ** 15n, repayMarginUnits: 2n * 10n ** 6n });
    expect(n.map((x) => [x.symbol, x.need])).toEqual([["WETH", 4n * 10n ** 16n], ["ETH", 2n * 10n ** 15n], ["USDC", 2n * 10n ** 6n]]);
    expect(n.map(isShort)).toEqual([false, true, true]);
    expect(n[0].note).toContain("0.012 more to buy the rescue back");
  });
});

describe("the rescue read straight from the contract", () => {
  const r: RescueView = {
    id: 4, state: "open", opened_at: "1763000000000000000", closes_at: "1763000120000000000", topup_units: "11520000000000000", cap_bps: 333,
    bids: [
      { steward: "patient.usestead.near", premium_bps: 300, amount_units: "11520000000000000", seq: 1 },
      { steward: "deep.usestead.near", premium_bps: 200, amount_units: "11520000000000000", seq: 2 },
      { steward: "patient.usestead.near", premium_bps: 150, amount_units: "11520000000000000", seq: 3 },
      { steward: "<b>x</b>.near", premium_bps: 320, amount_units: "1", seq: 4 },
    ],
    members: [{ steward: "patient.usestead.near", premium_bps: 150, share_units: "11520000000000000", confirmed: true, evm_tx: "0xabc", claim_id: "4-0" }],
    claims_opened_at: "1763000150000000000",
    settlement: null,
  };
  const claims: ClaimView[] = [{ token_id: "4-0", owner: "patient.usestead.near", owed_units: "11692800000000000", status: "open", expires_at: "1763000330000000000" }];
  it("tells the story in plain lines, contract times where it keeps them", () => {
    const l = directLines(r, claims, M.collateral, "Ethereum");
    expect(l.map((x) => x.html)).toEqual([
      "Auction open: 0.01152 WETH needed, premium cap 333 bps",
      "<strong>patient</strong> bids 300 bps for 0.01152",
      "<strong>deep</strong> bids 200 bps for 0.01152",
      "<strong>patient</strong> bids 150 bps for 0.01152",
      "<strong>&lt;b&gt;x&lt;/b&gt;</strong> bids 320 bps for 0",
      "Auction closed: <strong>patient</strong> at 150 bps",
      "<strong>patient</strong> tops up 0.01152 WETH on Aave",
      "Top-up proven on Ethereum",
      "Claim 4-0 minted to <strong>patient</strong>: owed 0.011693 WETH",
    ]);
    expect(l[0].atMs).toBe(1763000000000);
    expect(l[1].atMs).toBeNull(); // bids carry no time: the page uses when it first saw them
    expect(new Set(l.map((x) => x.key)).size).toBe(l.length);
  });
  it("orders the ladder lowest premium first, each steward's latest bid only", () => {
    expect(ladder(r).map((b) => [b.steward.split(".")[0], b.premium_bps])).toEqual([["patient", 150], ["deep", 200], ["<b>x</b>", 320]]);
  });
  it("reads the auction close and the buy-back window from the contract", () => {
    expect(rescueClock({ ...r, state: "auction" }, [])).toEqual({ closesAtMs: 1763000120000, windowEndMs: null });
    expect(rescueClock(r, claims)).toEqual({ closesAtMs: null, windowEndMs: 1763000330000 });
    expect(rescueClock(null, [])).toEqual({ closesAtMs: null, windowEndMs: null });
  });
  it("ends with the settlement or the buy-back", () => {
    expect(directLines({ ...r, state: "bought_back" }, [], M.collateral, "Ethereum").at(-1)!.html).toBe("Bought back");
    const s = directLines({ ...r, state: "settled", settlement: { started_at: "1763000400000000000" } }, [], M.collateral, "Ethereum");
    expect(s.slice(-2).map((x) => x.html)).toEqual(["Settlement started at the oracle price", "Settled"]);
  });
});

describe("copy", () => {
  it("no emoji-capable glyphs in the network module or its styles", () => {
    for (const f of ["../../web/src/own/net.ts", "../../web/src/styles/own.css"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src).not.toMatch(/[←-⇿☀-➿\u{1F000}-\u{1FFFF}]/u);
    }
  });
});
