import { describe, it, expect } from "vitest";
import { payoutGas, nextIsPayoutTransfer, PAYOUT_TRANSFER_GAS } from "../src/keeper.js";

const gwei = 10n ** 9n;
const POS = "0x49dcae8c18a4f3d3e902f52f14b23f8f49654937";

describe("gas for a batched settlement's payout transfer (its recipient pays gas limit x max fee)", () => {
  it("is tight: a transfer's gas with margin, twice the base fee plus the tip", () => {
    const g = payoutGas(gwei / 4n, gwei / 100n, gwei);
    expect(BigInt(g.gas_limit)).toBe(PAYOUT_TRANSFER_GAS);
    expect(BigInt(g.max_fee_per_gas)).toBe(gwei / 2n + gwei / 100n);
    // what the recipient is charged at 0.25 gwei: 70k x 0.51 gwei = 0.0000357 ETH, not 375k x 1 gwei
    expect(BigInt(g.gas_limit) * BigInt(g.max_fee_per_gas)).toBeLessThan(375_332n * gwei / 10n);
  });
  it("never goes above the market's fee cap", () => {
    const g = payoutGas(3n * gwei, gwei / 100n, gwei);
    expect(BigInt(g.max_fee_per_gas)).toBe(gwei);
    expect(BigInt(g.max_priority_fee_per_gas)).toBeLessThanOrEqual(gwei);
  });
});

describe("which settlement step is a payout transfer", () => {
  const batch = (done: boolean) => [{ to: POS, claim_id: null, done }, { to: "0xc0", claim_id: "3-0-0", done: false }];
  it("after the batch withdraw to the position is done", () => {
    expect(nextIsPayoutTransfer(batch(true), POS.toUpperCase().replace("0X", "0x"))).toBe(true);
  });
  it("not the batch withdraw itself (the borrower's gas: the usual settings)", () => {
    expect(nextIsPayoutTransfer(batch(false), POS)).toBe(false);
  });
  it("not a per-leg settlement (no batch leg)", () => {
    expect(nextIsPayoutTransfer([{ to: "0xc0", claim_id: "3-0-0", done: true }], POS)).toBe(false);
  });
});
