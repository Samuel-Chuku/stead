import { describe, it, expect } from "vitest";
import { expectedRepayUnits, settleDecision, takeoverDecision, settleGraceS } from "../src/steward.js";

// A real settlement on Ethereum mainnet (WETH collateral, USDC debt): the contract's reading at the
// start and the repay it computed (repay_base 2247446048, repay_units 22479786).
const mainnetSettlement = {
  collBase: 7_051_902_146n,
  debtBase: 3_949_067_224n,
  owedUnits: 9_931_130_620_409_776n,
  collPriceBase: 177_809_246_706n,
  debtPriceBase: 99_976_312n,
  collDec: 18,
  debtDec: 6,
  ltBps: 8400n,
  targetBps: 15000n,
};

describe("expected settlement repay", () => {
  it("matches the contract's repay exactly without headroom", () => {
    expect(expectedRepayUnits(mainnetSettlement, 0n)).toBe(22_479_786n);
  });
  it("adds the headroom on top", () => {
    expect(expectedRepayUnits(mainnetSettlement)).toBe(22_479_786n + 449_596n);
  });
  it("is the whole debt when the claims are worth more than the collateral", () => {
    const r = expectedRepayUnits({ ...mainnetSettlement, owedUnits: 10n ** 20n }, 0n);
    expect(r).toBe((mainnetSettlement.debtBase * 10n ** 6n + mainnetSettlement.debtPriceBase - 1n) / mainnetSettlement.debtPriceBase);
  });
  it("is zero when the position is already at the target net of the claims", () => {
    expect(expectedRepayUnits({ ...mainnetSettlement, debtBase: 1_000_000n }, 0n)).toBe(0n);
  });
});

describe("whether to start a settlement", () => {
  const need = 22_929_382n;
  const base = { need, canSource: false, early: false };
  it("waits out the late buy-back grace, funded or not (a late buy-back still commits)", () => {
    expect(settleDecision({ ...base, have: need, graceLeftS: 30 }).go).toBe(false);
    expect(settleDecision({ ...base, have: 0n, graceLeftS: 30 }).go).toBe(false);
  });
  it("after the grace a funded steward starts", () => {
    expect(settleDecision({ ...base, have: need, graceLeftS: 0 })).toEqual({ go: true, why: "grace over, repay funded" });
  });
  it("after the grace an unfunded steward still starts, handing the repay to a funded steward's takeover", () => {
    const d = settleDecision({ ...base, have: 0n, graceLeftS: 0 });
    expect(d.go).toBe(true);
    expect(d.why).toContain("take over");
  });
  it("an early settlement starts at once, inside the grace and unfunded", () => {
    expect(settleDecision({ ...base, have: 0n, early: true, graceLeftS: 1800 }).go).toBe(true);
  });
});

describe("whether to take over a stalled settlement", () => {
  const need = 22_479_786n;
  it("only with the repay amount in hand", () => {
    expect(takeoverDecision({ have: 0n, need, canSource: false }).go).toBe(false);
    expect(takeoverDecision({ have: need - 1n, need, canSource: false }).go).toBe(false);
    expect(takeoverDecision({ have: need, need, canSource: false }).go).toBe(true);
  });
  it("a steward that can mint test tokens always can", () => {
    expect(takeoverDecision({ have: 0n, need, canSource: true }).go).toBe(true);
  });
});

describe("the late buy-back grace setting", () => {
  it("defaults to 30 min on Ethereum mainnet and none on testnets", () => {
    expect(settleGraceS(undefined, "ethereum")).toBe(1800);
    expect(settleGraceS(undefined, "sepolia")).toBe(0);
    expect(settleGraceS(undefined, "fork")).toBe(0);
  });
  it("takes the configured seconds (the 90 s demo setting), never more than a day", () => {
    expect(settleGraceS("90", "ethereum")).toBe(90);
    expect(settleGraceS("0", "ethereum")).toBe(0);
    expect(settleGraceS("999999", "ethereum")).toBe(86_400);
    expect(settleGraceS("nonsense", "ethereum")).toBe(1800);
  });
});
