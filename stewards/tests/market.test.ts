import { describe, it, expect } from "vitest";
import { units } from "../src/market.js";

describe("whole-token amounts in the market's decimals", () => {
  it("handles 8-decimal WBTC and fractional amounts exactly", () => {
    expect(units(0.5, 8)).toBe(50_000_000n);
    expect(units(20, 8)).toBe(2_000_000_000n);
    expect(units(20_000, 18)).toBe(20_000n * 10n ** 18n);
    expect(units(1.23456789, 8)).toBe(123_456_789n);
    expect(units(0.000000019, 8)).toBe(1n); // beyond the token's precision: truncated, never rounded up
  });
});
