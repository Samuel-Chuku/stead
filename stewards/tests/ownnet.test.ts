// The "Protect a position" page's per-network settings and arithmetic (web/src/own/net.ts): testnet
// keeps exactly the values it was tested end to end with; mainnet points at the verified Ethereum
// addresses and the capped contract; the health-factor arithmetic lands where the steps say.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  NETS, netFromSearch, gasFromMarket, marketMismatch, allowed, capUsd, borrowUnits, withdrawUnits, repayUnits, valueBase, walletNeeds, isShort,
  directLines, ladder, rescueClock, rescueFlow, evmRef, rescueOutcome, protectionRows, rescueFinished, OUTCOME_WORD, type MarketView, type RescueView, type ClaimView,
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
    expect(M.nearRpcs).toEqual(["https://rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"]);
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
    // bids carry no time on chain: each sorts by its place in the flow, just after the step before it
    expect(l[1].atMs).toBe(1763000000001);
    expect(l[1].exact).toBe(false);
    expect(l[1].afterMs).toBe(1763000000000);
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

// rescue 78 on app.usestead.near (position 0), as get_rescue and get_claim returned it: deep won at
// 150 bps, its top-up was proven by a verified read, the buy-back lapsed, and deep settled it
// (repaid 30.46 USDC for the position, then two legs of WETH withdrawn from Aave to its payout)
const F78 = JSON.parse(readFileSync(new URL("./fixtures/mainnet-rescue-78.json", import.meta.url), "utf8")) as { rescue: RescueView; claims: ClaimView[] };
const R78 = F78.rescue;
const C78 = F78.claims;
const ms = (ns: string) => Number(BigInt(ns) / 1_000_000n);

describe("a rescue's whole flow, from the contract's own records (rescue 78)", () => {
  const O = { coll: M.collateral, evmName: "Ethereum", debt: M.debt, evmTx: M.evmTx, evmBlock: M.evmBlock, evmAddress: M.evmAddress };
  it("every step in the order the rescue ran: auction, each bid by sequence, close, top-up, proof, claim, lapse, settlement, repay, legs, settled", () => {
    const f = rescueFlow(R78, C78, O);
    expect(f.map((x) => x.kind)).toEqual(["open", "bid", "bid", "bid", "close", "topup", "proven", "claim", "lapsed", "settle", "repay", "leg", "leg", "settled"]);
    expect(f.filter((x) => x.kind === "bid").map((x) => x.actor)).toEqual(["deep", "swift", "patient"]);
    expect(f.map((x) => x.order)).toEqual(f.map((_, i) => i));
  });
  it("a step's time is the contract's own; an untimed one sorts just after the step before it, never by when a page saw it", () => {
    const f = rescueFlow(R78, C78, O);
    const k = (kind: string) => f.find((x) => x.kind === kind)!;
    expect(k("open").exactMs).toBe(ms(R78.opened_at));
    expect(k("close").exactMs).toBe(ms(R78.closes_at));
    expect(k("claim").exactMs).toBe(ms(C78[0].opened_at!));
    expect(k("lapsed").exactMs).toBe(ms(C78[0].expires_at!));
    expect(k("settle").exactMs).toBe(ms(R78.settlement!.started_at));
    for (const x of ["topup", "repay", "leg", "settled"]) expect(k(x).exactMs, x).toBeNull();
    // the top-up has no time on chain: it sits after the close and before the claim
    expect(k("topup").atMs).toBe(ms(R78.closes_at) + 1);
    expect(k("topup").afterMs).toBe(ms(R78.closes_at));
    expect(k("topup").atMs).toBeLessThan(k("claim").atMs);
    // the settlement's steps follow its start, in order
    expect(k("repay").afterMs).toBe(ms(R78.settlement!.started_at));
    expect(f.at(-1)!.atMs).toBe(ms(R78.settlement!.started_at) + 4);
    // strictly increasing: sorting by time is sorting by the flow
    for (let i = 1; i < f.length; i++) expect(f[i].atMs).toBeGreaterThan(f[i - 1].atMs);
  });
  it("the proof's Ethereum block gives the proven step its time, once the page has read it", () => {
    const blockMs = (n: number) => (n === 26411620 ? ms(R78.claims_opened_at) - 9000 : null);
    const p = rescueFlow(R78, C78, { ...O, blockMs }).find((x) => x.kind === "proven")!;
    expect(p.exactMs).toBe(ms(R78.claims_opened_at) - 9000);
    expect(p.link).toEqual({ href: "https://etherscan.io/block/26411620", ref: "block 26411620", kind: "block" });
    expect(rescueFlow(R78, C78, O).find((x) => x.kind === "proven")!.exactMs).toBeNull();
  });
  it("the settlement's amounts: the settler's repay in USDC, each leg's WETH to its payout, the total paid", () => {
    const f = rescueFlow(R78, C78, O);
    expect(f.find((x) => x.kind === "repay")!.html).toBe("<strong>deep</strong> repaid 30.46 USDC of the position's debt on Aave");
    const legs = f.filter((x) => x.kind === "leg");
    expect(legs.map((x) => x.html)).toEqual([
      "0.028383 WETH withdrawn from Aave and paid to <strong>deep</strong>'s payout (the supplied amount and the repay, at the oracle price)",
      "0.000186 WETH withdrawn from Aave and paid to <strong>deep</strong>'s payout (the premium)",
    ]);
    expect(legs[0].link).toEqual({ href: "https://etherscan.io/address/0x26e2ab6ec0e027f01f41cf65ee5375f0692fd41d#tokentxns", ref: "0x26e2ab6ec0e027f01f41cf65ee5375f0692fd41d", kind: "address" });
    expect(f.at(-1)!.html).toBe("Settled: <strong>deep</strong> paid 0.028569 WETH");
    expect(f.find((x) => x.kind === "settle")!.html).toBe("Settlement started at the oracle price by <strong>deep</strong>");
  });
  it("a leg still in flight reads as being sent; a dropped premium leg is not shown", () => {
    const st = R78.settlement!;
    const r = { ...R78, state: "settling", settlement: { ...st, legs: [{ ...st.legs![0], done: false }, { ...st.legs![1], amount: { exact: "0" } }] } };
    const legs = rescueFlow(r, C78, O).filter((x) => x.kind === "leg");
    expect(legs).toHaveLength(1);
    expect(legs[0].pending).toBe(true);
    expect(legs[0].html).toContain("being withdrawn from Aave");
    expect(rescueFlow(r, C78, O).some((x) => x.kind === "settled")).toBe(false);
  });
  it("a buy-back: the payment into the position (proven at its block), the exact owed amount paid, bought back", () => {
    const c = [{ ...C78[0], status: "bought_back", paid_by_tx: "escrow@26411700" }];
    const f = rescueFlow({ ...R78, state: "bought_back", settlement: null }, c, { ...O, blockMs: (n) => (n === 26411700 ? 1794640100000 : null) });
    expect(f.slice(-3).map((x) => x.kind)).toEqual(["escrow", "payout", "bought"]);
    expect(f.at(-3)!.exactMs).toBe(1794640100000);
    expect(f.at(-2)!.html).toBe("<strong>deep</strong> paid 0.01257 WETH: claim 0-78-0 closed");
    expect(f.some((x) => x.kind === "lapsed")).toBe(false);
  });
  it("names what the contract records on Ethereum: a transaction, or the block a proof read", () => {
    expect(evmRef("verified@26411620")).toEqual({ block: 26411620 });
    expect(evmRef("escrow@5")).toEqual({ block: 5 });
    expect(evmRef("0xabc")).toEqual({ tx: "0xabc" });
    expect(evmRef(null)).toBeNull();
    expect(evmRef("nonsense")).toBeNull();
  });
  it("a failed rescue: no bids ends at the close; covering bids with no proven top-up end after it, untimed", () => {
    const none = { ...R78, state: "failed", bids: [], members: [], settlement: null };
    expect(rescueFlow(none, [], O).map((x) => x.kind)).toEqual(["open", "close"]);
    expect(rescueOutcome(none)).toBe("no_bids");
    // rescue 0 on position 0: two bids for the whole top-up, no member kept (the contract drops a winner that never tops up)
    const missed = { ...R78, id: 0, state: "failed", bids: [{ steward: "swift.usestead.near", premium_bps: 316, amount_units: R78.topup_units, seq: 2 }, { steward: "patient.usestead.near", premium_bps: 321, amount_units: R78.topup_units, seq: 1 }], members: [], settlement: null };
    const f = rescueFlow(missed, [], O);
    expect(f.map((x) => x.kind)).toEqual(["open", "bid", "bid", "close", "failed"]);
    expect(f[3].html).toBe("Auction closed: lowest bid <strong>swift</strong> at 316 bps");
    expect(f[4].exactMs).toBeNull();
    expect(f[4].afterMs).toBe(ms(R78.closes_at));
    expect(rescueOutcome(missed)).toBe("failed");
    expect(protectionRows([missed]).rows[0]).toMatchObject({ outcome: "failed", covered: true, bids: 2 });
    // bids short of the top-up: nobody wins
    const short = { ...missed, bids: [{ ...missed.bids[0], amount_units: "1" }] };
    expect(rescueFlow(short, [], O).at(-1)!.html).toBe("Auction closed: the bids did not cover the top-up");
    expect(protectionRows([short]).rows[0].covered).toBe(false);
  });
});

describe("the position's protections", () => {
  const noBid = (id: number, pos = 0): RescueView => ({ ...R78, id, position_id: pos, state: "failed", bids: [], members: [], settlement: null, opened_at: String(BigInt(R78.opened_at) - BigInt(78 - id) * 3_600_000_000_000n) });
  const live: RescueView = { ...R78, id: 80, state: "open", settlement: null };
  it("one row per rescue on the position, newest first, with the no-bid ones apart", () => {
    const { rows, noBids } = protectionRows([noBid(1), R78, noBid(77), live, noBid(79, 3), R78]);
    expect(rows.map((x) => [x.id, x.outcome, x.stage])).toEqual([[80, "running", "claim open"], [78, "settled", ""]]);
    expect(noBids.map((x) => x.id)).toEqual([79, 77, 1]); // without a position filter every rescue counts
    expect(protectionRows([noBid(1), R78, noBid(79, 3)], 0).noBids.map((x) => x.id)).toEqual([1]);
  });
  it("each row: winners and premiums, the top-up filled, when it opened", () => {
    const r = protectionRows([R78], 0).rows[0];
    expect(r.winners).toEqual([{ steward: "deep.usestead.near", name: "deep", bps: 150, units: "12384387129772345" }]);
    expect(r.topupUnits).toBe("12384387129772345");
    expect(r.openedMs).toBe(ms(R78.opened_at));
    expect(r.bids).toBe(3);
    expect(OUTCOME_WORD[r.outcome]).toBe("Settled");
  });
  it("a finished rescue is never read again; a running one is", () => {
    for (const st of ["bought_back", "settled", "failed"]) expect(rescueFinished({ state: st })).toBe(true);
    for (const st of ["auction", "top_up_pending", "open", "settling"]) expect(rescueFinished({ state: st })).toBe(false);
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
