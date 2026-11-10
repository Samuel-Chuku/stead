// The list pages' data, built from the contracts' own records. Offline.
import { describe, expect, it } from "vitest";
import { buildRecords, units, type RawContract } from "../src/records.js";

const E18 = 10n ** 18n;
const pos = (id: number, over: Record<string, unknown> = {}) => ({
  id, owner: "borrower.steadfi.testnet", market_id: 1, path: "", evm_address: "0x1", payout: "0x2", next_nonce: 3, pending: null,
  health: { hf_wad: String(1_500_000_000_000_000_000n), collateral_base: String(1800n * 10n ** 8n), debt_base: String(900n * 10n ** 8n), collateral_price_base: "3000000000", debt_price_base: "100000000", block: 12_100_000, at_ns: "1794000000000000000", source: "verified" },
  active_auction: null, open_rescues: [], premium_cap_base: "0", premium_used_base: "0", ...over,
});
const raw = (): RawContract => ({
  contract: "sepolia-demo.steadfi.testnet",
  markets: [{ id: 1, chainId: 11155111, collateral: "0xc", debt: "0xd", cDec: 18, dDec: 18, cSym: "LINK", dSym: "DAI" }],
  stewards: ["deep.steadfi.testnet", "swift.steadfi.testnet", "pool.steadfi.testnet"],
  positions: [pos(4), pos(5, { open_rescues: [12] }), pos(6, { health: null })] as any,
  rescues: [
    {
      id: 12, position_id: 5, seq: 1, state: "open", opened_at: "1794300000000000000", closes_at: "0", topup_deadline: "0", topup_units: String(19n * E18), topup_base: String(570n * 10n ** 8n), collateral_price_base: "3000000000", cap_bps: 1041,
      bids: [{ steward: "deep.steadfi.testnet", premium_bps: 150, amount_units: "1", bond: "0", seq: 1 }, { steward: "swift.steadfi.testnet", premium_bps: 400, amount_units: "1", bond: "0", seq: 0 }],
      members: [{ steward: "deep.steadfi.testnet", premium_bps: 150, share_units: String(19n * E18), share_base: "0", premium_units: String(285n * 10n ** 15n), premium_base: String(855n * 10n ** 6n), bond: "0", confirmed: true, evm_tx: null, claim_id: "5-1-0" }],
      claims_opened_at: "0", settlement: null,
    },
  ] as any,
  claims: [{ token_id: "5-1-0", rescue_id: 12, position_id: 5, owner: "deep.steadfi.testnet", asset: "0xc", share_units: String(19n * E18), premium_bps: 150, premium_units: String(285n * 10n ** 15n), owed_units: String(19_285n * 10n ** 15n), trigger_price_base: "0", status: "open", expires_at: "1794300300000000000" }] as any,
});

describe("list pages' records", () => {
  it("token units are exact decimals, never floats", () => {
    expect(units("19285000000000000000", 18)).toBe("19.285");
    expect(units("110843362359000000000", 18)).toBe("110.843362359");
    expect(units("865215", 8)).toBe("0.00865215");
    expect(units("0", 18)).toBe("0");
  });

  it("positions carry their pair, chain, proven HF and status", () => {
    const r = buildRecords([raw()]);
    const by = Object.fromEntries(r.positions.map((p) => [p.id, p]));
    expect(by[4]).toMatchObject({ pair: "LINK/DAI", chain: "Sepolia", hf: 1.5, hfSource: "verified", status: "protected", collateralUsd: 1800 });
    expect(by[5].status).toBe("in rescue");
    expect(by[5].openRescues).toEqual([12]);
    expect(by[6]).toMatchObject({ status: "no reading", hf: null });
  });

  it("rescues, claims and stewards agree with the contract's own numbers", () => {
    const r = buildRecords([raw()]);
    expect(r.rescues[0]).toMatchObject({ id: 12, topUp: "19", asset: "LINK", topUpUsd: 570, bids: 2, winners: [{ steward: "deep", bps: 150, share: "19" }], premiumUsd: 8.55, claims: ["5-1-0"] });
    expect(r.claims[0]).toMatchObject({ token: "5-1-0", owner: "deep", owed: "19.285", premium: "0.285", asset: "LINK", status: "open" });
    const s = Object.fromEntries(r.stewards.map((x) => [x.name, x]));
    expect(s.deep).toMatchObject({ bids: 1, wins: 1, claimsOpen: 1, claimsTotal: 1 });
    expect(s.swift).toMatchObject({ bids: 1, wins: 0 });
    expect(s.pool).toMatchObject({ bids: 0, wins: 0 }); // registered, never bid: still listed
    expect(r.stewards[0].name).toBe("deep"); // most wins first
  });
});
