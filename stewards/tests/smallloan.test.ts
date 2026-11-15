import { describe, it, expect } from "vitest";
import { smallRescueNote, RESCUE_ETH_GAS } from "../../web/src/own/dashlogic.js";

const eth = 177_809_246_706n; // $1,778.09, 8 decimals
const gwei = 10n ** 9n;

describe("small-loan gas warning on the position dashboard", () => {
  it("warns on the mainnet run's loan: $39.49 debt, 0.25 gwei (cap $0.99, gas about $0.71)", () => {
    const n = smallRescueNote({ debtBase: 3_949_064_924n, liqBonusBps: 500n, gasWei: gwei / 4n, ethBase: eth });
    expect(n).not.toBeNull();
    expect(n).toContain("$0.99");
    expect(n).toContain("0.25 gwei");
  });
  it("stays quiet on a $250 loan at the same gas (gas is a small share of the $6.25 cap)", () => {
    expect(smallRescueNote({ debtBase: 25_000_000_000n, liqBonusBps: 500n, gasWei: gwei / 4n, ethBase: eth })).toBeNull();
  });
  it("warns on the same $250 loan when gas spikes to 10 gwei", () => {
    expect(smallRescueNote({ debtBase: 25_000_000_000n, liqBonusBps: 500n, gasWei: 10n * gwei, ethBase: eth })).not.toBeNull();
  });
  it("says nothing without debt or without a gas reading", () => {
    expect(smallRescueNote({ debtBase: 0n, liqBonusBps: 500n, gasWei: gwei, ethBase: eth })).toBeNull();
    expect(smallRescueNote({ debtBase: 3_949_064_924n, liqBonusBps: 500n, gasWei: 0n, ethBase: eth })).toBeNull();
  });
  it("uses the gas measured on the pooled mainnet rescue", () => {
    expect(RESCUE_ETH_GAS).toBe(1_600_000n);
  });
});
