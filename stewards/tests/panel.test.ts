import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compareLiquidation, crossings, KEEP, scrub, summarize, toPanelPosition, trim, usdOf, type Liquidation, type PanelPosition, type TriggerEvent } from "../src/panel.js";
import { STEAD, type MainnetPosition } from "../src/mainnet.js";

const E18 = 10n ** 18n;
const NOW = Date.parse("2026-11-09T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("mainnet panel feed", () => {
  it("never lets an RPC URL (which may carry a key) into a message", () => {
    const e = new Error("HTTP request failed.\n\nURL: https://abc.quiknode.pro/0123456789abcdef/ Status: 429\nwss://x.example/key also");
    const s = scrub(e);
    expect(s).not.toMatch(/quiknode|0123456789abcdef|https?:|wss?:/);
    expect(s).not.toContain("\n");
    expect(scrub("failed at https://eth-mainnet.g.alchemy.com/v2/SECRET)")).not.toContain("SECRET");
  });

  it("counts a crossing only from at/above the trigger to below it, and never on the first reading", () => {
    const now = {
      "0xa": { hf: 1.12, debtUsd: 10_000, collateralUsd: 14_000, ltBps: 8000 }, // crossed
      "0xb": { hf: 1.1, debtUsd: 10_000, collateralUsd: 14_000, ltBps: 8000 }, // was already below
      "0xc": { hf: 1.12, debtUsd: 10_000, collateralUsd: 14_000, ltBps: 8000 }, // first reading
      "0xd": { hf: 1.2, debtUsd: 10_000, collateralUsd: 14_000, ltBps: 8000 }, // still above
      "0xe": { hf: 1.12, debtUsd: 500, collateralUsd: 700, ltBps: 8000 }, // too small to show
      "0xf": { hf: 1.149, debtUsd: 10_000, collateralUsd: 14_000, ltBps: 8000 }, // exactly from the trigger
    };
    const prev = { "0xa": 1.18, "0xb": 1.14, "0xd": 1.3, "0xe": 1.2, "0xf": STEAD.trigger };
    const ev = crossings(prev, now, ago(0), 100);
    expect(ev.map((x) => x.address).sort()).toEqual(["0xa", "0xf"]);
    const a = ev.find((x) => x.address === "0xa")!;
    expect(a.hfBefore).toBe(1.18);
    // valued at the trigger: top-up to 1.50 = (1.50 − 1.15) × debt / LT; cap = 50 % × bonus (5 % default) × debt
    expect(a.stead.topupUsd).toBeCloseTo(((1.5 - 1.15) * 10_000) / 0.8, 6);
    expect(a.stead.capUsd).toBeCloseTo(250, 6);
    if (a.stead.winner) expect(a.stead.winner.premiumUsd).toBeLessThanOrEqual(a.stead.capUsd);
  });

  it("prices a real liquidation and compares it with a Stead rescue of the same position", () => {
    // 1 WETH seized at $3,000 for 2,700 USDC repaid: the borrower lost $300 beyond the debt
    const r = compareLiquidation(
      { debtToCover: 2_700_000_000n, liquidatedCollateralAmount: E18 },
      { decimals: 18, price: 3_000n * 10n ** 8n, bonusBps: 500 },
      { decimals: 6, price: 10n ** 8n },
      { debtUsd: 5_400, ltBps: 8250 },
    );
    expect(r.collateralUsd).toBeCloseTo(3_000, 6);
    expect(r.debtUsd).toBeCloseTo(2_700, 6);
    expect(r.bonusPaidUsd).toBeCloseTo(300, 6);
    expect(r.stead).not.toBeNull();
    expect(r.stead!.capUsd).toBeCloseTo(135, 6); // 5,400 × 5 % × 50 %
    expect(r.stead!.premiumUsd).toBeLessThanOrEqual(r.stead!.capUsd);
    expect(r.stead!.savedUsd).toBeCloseTo(300 - r.stead!.premiumUsd, 6);
    // eMode positions and positions under $1,000 of debt get no comparison (Stead doesn't take them)
    const ev = { debtToCover: 2_700_000_000n, liquidatedCollateralAmount: E18 };
    const weth = { decimals: 18, price: 3_000n * 10n ** 8n, bonusBps: 500 };
    const usdc = { decimals: 6, price: 10n ** 8n };
    expect(compareLiquidation(ev, weth, usdc, { debtUsd: 5_400, ltBps: 9300, emode: true }).stead).toBeNull();
    expect(compareLiquidation(ev, weth, usdc, { debtUsd: 999, ltBps: 8250 }).stead).toBeNull();
    expect(compareLiquidation(ev, weth, usdc, { debtUsd: 0, ltBps: 8250 }).stead).toBeNull();
    // without the position just before (no archive read) there is no comparison, never a guess
    expect(compareLiquidation({ debtToCover: 1n, liquidatedCollateralAmount: 1n }, { decimals: 18, price: 1n, bonusBps: 500 }, { decimals: 6, price: 1n }).stead).toBeNull();
    expect(usdOf(1_500_000n, 6, 10n ** 8n)).toBeCloseTo(1.5, 9);
  });

  it("keeps only the newest history within the window, newest first", () => {
    const xs = [{ at: ago(1) }, { at: ago(24 * KEEP.days + 1) }, { at: ago(3) }, { at: ago(2) }];
    expect(trim(xs, NOW, 10).map((x) => x.at)).toEqual([ago(1), ago(2), ago(3)]);
    expect(trim(xs, NOW, 2)).toHaveLength(2);
  });

  it("summarises the last 24 h, with Stead totals only over liquidations it could price", () => {
    const pos = (hf: number, debtUsd: number) => ({ hf, debtUsd }) as PanelPosition;
    const liq = (h: number, bonus: number, premium?: number, debtUsd = 1_000) =>
      ({ at: ago(h), bonusPaidUsd: bonus, debt: { usd: debtUsd }, stead: premium === undefined ? null : { premiumUsd: premium, savedUsd: bonus - premium } }) as Liquidation;
    const s = summarize([pos(1.1, 100), pos(1.2, 50)], [{ at: ago(2) } as TriggerEvent, { at: ago(30) } as TriggerEvent], [liq(1, 300, 120), liq(5, 200), liq(30, 999, 1), liq(2, 0, 0, 0.2)], NOW, 3);
    expect(s).toEqual({
      nearTrigger: 2,
      belowTrigger: 1,
      debtNearTriggerUsd: 150,
      triggers24h: 1,
      liquidations24h: 2,
      dust24h: 1,
      unpriced: 3,
      bonusPaid24hUsd: 500,
      compared24h: 1,
      steadPremium24hUsd: 120,
      saved24hUsd: 180,
    });
  });

  it("states how far prices can fall before the trigger and before Aave's line", () => {
    const p = { address: "0x1", hf: 1.3, debtUsd: 1, collateralUsd: 2, ltBps: 8000, bonusBps: 500, collateral: [{ asset: "0xAbC", usd: 2, bonusBps: 500 }], atTrigger: {} } as unknown as MainnetPosition;
    const v = toPanelPosition(p, new Map([["0xabc", "WETH"]]));
    expect(v.dropToTrigger).toBeCloseTo(1 - 1.15 / 1.3, 9);
    expect(v.dropToLiquidation).toBeCloseTo(1 - 1 / 1.3, 9);
    expect(v.collateral).toEqual([{ symbol: "WETH", usd: 2 }]);
    expect(toPanelPosition({ ...p, hf: 1.1 }, new Map()).dropToTrigger).toBe(0);
  });

  it("is read-only: the feed and its scanner hold no wallet and send nothing", () => {
    for (const f of ["src/panel.ts", "src/mainnet.ts", "scripts/mainnet-panel.ts"]) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/createWalletClient|privateKeyToAccount|sendRawTransaction|sendTransaction|writeContract|EVM_KEY|from "\.\.?\/(src\/)?(near|fork)\.js"/);
    }
  });
});
