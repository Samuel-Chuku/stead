import { describe, it, expect } from "vitest";
import { settlementRepayUnits, RAY } from "../src/types.js";

// What Aave burns for a repay of `amount` at debt index `di`: rayDiv, rounded half up.
const burned = (amount: bigint, di: bigint) => (amount * RAY + di / 2n) / di;

describe("settlement repay on a verified start", () => {
  it("covers the proven scaled drop at today's index, whatever the interest since the start", () => {
    const repay = 1_922_916_200_000_000_000_000n;
    for (const [di0, diNow] of [[RAY, RAY], [RAY, RAY + RAY / 1000n], [5_750_484_138_257_992_983_807_473_381n, 5_750_600_000_000_000_000_000_000_000n]]) {
      const need = (repay * RAY) / di0 + 1n; // what the contract stores
      const units = settlementRepayUnits(repay, need, diNow);
      expect(burned(units, diNow) >= need).toBe(true);
      expect(units - repay < repay / 500n + 10n).toBe(true); // only the interest slice and a few wei more
    }
  });

  it("repaying only repay_units after the index rose would fall short (why the formula exists)", () => {
    const repay = 1_000n * 10n ** 18n;
    const need = repay + 1n; // started at index 1.0
    expect(burned(repay, RAY + RAY / 1000n) < need).toBe(true);
    expect(burned(settlementRepayUnits(repay, need, RAY + RAY / 1000n), RAY + RAY / 1000n) >= need).toBe(true);
  });

  it("still covers need when the repay executes blocks after the index was read (live Sepolia, rescue 4)", () => {
    // sepolia-demo position 3: start index and need as stored; Sepolia DAI's index grew ~3.06e-7 per block
    const di0 = 5_782_284_888_393_695_402_679_140_205n;
    const need = 224_421_410_799_855_823_760n;
    const diRead = di0 + (di0 * 11n * 306n) / 1_000_000_000n; // read 11 blocks after the start
    const perBlock = (diRead * 306n) / 1_000_000_000n;
    const units = settlementRepayUnits(1_297_668_532_300_000_000_000n, need, diRead);
    expect(burned(units, diRead + perBlock) >= need).toBe(true); // the repay landed one block later
    expect(burned(units, diRead + perBlock * 300n) >= need).toBe(true); // or an hour later
    // without the margin, one block of interest left it short (what happened live)
    const bare = (need * diRead + RAY - 1n) / RAY + 2n;
    expect(burned(bare, diRead + perBlock) < need).toBe(true);
  });

  it("without a verified start it repays exactly repay_units", () => {
    expect(settlementRepayUnits(123n, undefined, RAY)).toBe(123n);
  });
});
