import { describe, it, expect } from "vitest";
import { expectedRepayUnits, settleDecision } from "../src/steward.js";

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
  it("an unfunded steward does not start on a plain expiry (the run where one stalled and lost its premium)", () => {
    expect(settleDecision({ have: 0n, need, canSource: false, early: false }).go).toBe(false);
  });
  it("a funded steward starts", () => {
    expect(settleDecision({ have: need, need, canSource: false, early: false }).go).toBe(true);
  });
  it("one short by a single unit does not", () => {
    expect(settleDecision({ have: need - 1n, need, canSource: false, early: false }).go).toBe(false);
  });
  it("starts unfunded only for an early settlement, where the claims are at risk", () => {
    expect(settleDecision({ have: 0n, need, canSource: false, early: true }).go).toBe(true);
  });
  it("a steward that can mint test tokens always goes", () => {
    expect(settleDecision({ have: 0n, need, canSource: true, early: false }).go).toBe(true);
  });
});
