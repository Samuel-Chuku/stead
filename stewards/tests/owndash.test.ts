// The mainnet position dashboard's rules (web/src/own/dashlogic.ts): the projected health factor
// of each action against hand-computed Aave values, the warning under the trigger and the block
// under 1.00, the amount helpers, the leftover-gas amount, and which actions are offered in each
// state of the position; with no Ethereum wallet, the pasted payout's checks, what the visitor is
// asked to send to the position's address, and the address's QR code (decoded back here by a small
// decoder written from the QR standard); the health factor's colour bands, the risk details (how far
// the collateral can fall to each line, the loan-to-value, the premium cap), the health bar's zones,
// the live bid ladder's order and stamps, and the borrow kept apart from the move to the wallet. Every expected number below is worked out by hand from Aave's formula
// (HF = collateral × LT ÷ debt, base currency with 8 decimals, LT in bps).
import { describe, expect, it } from "vitest";
import {
  project, hfBps, toBase, depositMax, borrowMax, withdrawMax, repayAllUnits, sweepAmount, sweepSupported, gasTopUp, phaseOf, availability, fallLine,
  hfFromWad, hfText, hfBarPct, NO_DEBT_WAD, HF_BAR,
  checkPayout, gasAsk, arrived, depositPlan, buybackDue, fundPrompt, qrSvg, QR_QUIET, QR_LIGHT, QR_DARK,
  TRIGGER_BPS, UNDER_TRIGGER_WARNING, type Account, type PosFacts,
  hfBand, hfPulses, riskLines, pctText, linePrice, ltvView, premiumCapBase, barZones, BAR_MARKS, EARLY_SETTLE_BPS, CAUTION_BPS,
  ladderStep, bidBarPct, premiumCostBase, stewardIdOf, LATE_MS, type SeenBid,
} from "../../web/src/own/dashlogic.js";
import { readFileSync } from "node:fs";

const E18 = 10n ** 18n;
const B = (usd: number) => BigInt(Math.round(usd * 1e8)); // dollars → Aave base units (8 dp)
// $100 of WETH at LT 83%, $50 of USDC debt; LTV 80.5% leaves $30.50 to borrow → HF 1.66
const A: Account = { collBase: B(100), debtBase: B(50), availBase: B(30.5), ltBps: 8300n };
const P = { coll: B(2500), debt: B(1) }; // WETH $2,500, USDC $1.00
const D = { coll: 18, debt: 6 };
const usdc = (n: number) => BigInt(Math.round(n * 1e6));
const weth = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

describe("health factor", () => {
  it("is collateral × LT ÷ debt in bps, and none without debt", () => {
    expect(hfBps(A.collBase, A.debtBase, A.ltBps)).toBe(16_600n);
    expect(hfBps(B(100), 0n, 8300n)).toBeNull();
    expect(toBase(weth(0.01), P.coll, 18)).toBe(B(25));
    expect(toBase(usdc(10), P.debt, 6)).toBe(B(10));
  });
});

describe("projected health factor per action", () => {
  it("deposit: 0.01 WETH adds $25 → 125 × 0.83 ÷ 50 = 2.075", () => {
    const p = project(A, P, D, { kind: "deposit", units: weth(0.01) }, 8400n);
    expect(p.collBase).toBe(B(125));
    expect(p.hfBps).toBe(20_750n);
    expect(p.underTrigger).toBe(false);
    expect(p.block).toBeNull();
  });
  it("deposit over the size cap is blocked ($100 + $75 > $150)", () => {
    expect(project(A, P, D, { kind: "deposit", units: weth(0.03) }, 8400n, B(150)).block).toMatch(/cap/);
    expect(project(A, P, D, { kind: "deposit", units: weth(0.02) }, 8400n, B(150)).block).toBeNull(); // exactly $150
  });
  it("the first deposit uses the market's LT (Aave reports 0 before any collateral)", () => {
    const empty: Account = { collBase: 0n, debtBase: 0n, availBase: 0n, ltBps: 0n };
    const p = project(empty, P, D, { kind: "deposit", units: weth(0.04) }, 8400n);
    expect(p.collBase).toBe(B(100));
    expect(p.hfBps).toBeNull(); // no debt yet
    // and a borrow projected from there uses LT 84%
    expect(project({ ...empty, collBase: B(100), availBase: B(80) }, P, D, { kind: "borrow", units: usdc(70) }, 8400n).hfBps).toBe(12_000n);
  });
  it("borrow: 10 USDC → 100 × 0.83 ÷ 60 = 1.3833, under the trigger", () => {
    const p = project(A, P, D, { kind: "borrow", units: usdc(10) }, 8400n);
    expect(p.debtBase).toBe(B(60));
    expect(p.hfBps).toBe(13_833n);
    expect(p.underTrigger).toBe(false);
    const q = project(A, P, D, { kind: "borrow", units: usdc(30) }, 8400n); // 100 × 0.83 ÷ 80 = 1.0375
    expect(q.hfBps).toBe(10_375n);
    expect(q.underTrigger).toBe(true);
    expect(q.block).toBeNull();
  });
  it("borrow beyond the loan-to-value limit is blocked; exactly at it is not", () => {
    expect(project(A, P, D, { kind: "borrow", units: usdc(30.5) }, 8400n).block).toBeNull();
    expect(project(A, P, D, { kind: "borrow", units: usdc(30.51) }, 8400n).block).toMatch(/loan-to-value/);
  });
  it("withdraw: 0.004 WETH ($10) → 90 × 0.83 ÷ 50 = 1.494; 0.008 ($20) → 1.328; 0.014 ($35) → 1.079, under the trigger", () => {
    expect(project(A, P, D, { kind: "withdraw", units: weth(0.004) }, 8400n).hfBps).toBe(14_940n);
    expect(project(A, P, D, { kind: "withdraw", units: weth(0.008) }, 8400n).hfBps).toBe(13_280n);
    const p = project(A, P, D, { kind: "withdraw", units: weth(0.014) }, 8400n);
    expect(p.hfBps).toBe(10_790n);
    expect(p.underTrigger).toBe(true);
    expect(p.block).toBeNull();
  });
  it("withdraw that would leave it under 1.00 is blocked: 0.017 WETH ($42.50) → 57.5 × 0.83 ÷ 50 = 0.9545", () => {
    const p = project(A, P, D, { kind: "withdraw", units: weth(0.017) }, 8400n);
    expect(p.hfBps).toBe(9_545n);
    expect(p.block).toBe("Aave would refuse this: it would be liquidatable.");
    // withdrawing everything with debt left: HF 0, blocked
    expect(project(A, P, D, { kind: "withdraw", units: 0n, all: true }, 8400n).block).toMatch(/liquidatable/);
  });
  it("repay: 20 USDC → 100 × 0.83 ÷ 30 = 2.7666; repay all → no debt", () => {
    expect(project(A, P, D, { kind: "repay", units: usdc(20) }, 8400n).hfBps).toBe(27_666n);
    const all = project(A, P, D, { kind: "repay", units: 0n, all: true }, 8400n);
    expect(all.debtBase).toBe(0n);
    expect(all.hfBps).toBeNull();
    expect(project(A, P, D, { kind: "repay", units: usdc(80) }, 8400n).debtBase).toBe(0n); // more than owed: Aave takes only the debt
  });
  it("warns only on actions that lower the health factor, at exactly the trigger boundary", () => {
    // a position already under the trigger: a partial repay that leaves it under is not warned
    const low: Account = { collBase: B(100), debtBase: B(75), availBase: B(5.5), ltBps: 8300n }; // 1.1066
    expect(project(low, P, D, { kind: "repay", units: usdc(1) }, 8400n).underTrigger).toBe(false);
    // a borrow to exactly 1.15 is not under it; a hair more is
    const at = (debt: bigint) => project({ ...A, availBase: B(80) }, P, D, { kind: "borrow", units: (debt - A.debtBase) / 100n }, 8400n);
    const exact = (B(100) * 8300n) / TRIGGER_BPS; // the debt at which HF = 1.15 (rounded down)
    expect(at(exact).hfBps! >= TRIGGER_BPS).toBe(true);
    expect(at(exact).underTrigger).toBe(false);
    expect(at(exact + 100n).underTrigger).toBe(true);
    expect(UNDER_TRIGGER_WARNING).toMatch(/under 1\.15/);
    expect(UNDER_TRIGGER_WARNING).toMatch(/less than Aave's liquidation penalty/);
  });
  it("refuses a negative amount", () => {
    expect(() => project(A, P, D, { kind: "borrow", units: -1n }, 8400n)).toThrow();
  });
});

describe("amount helpers", () => {
  it("deposit max: what is available, within the cap less 1% (0.02 WETH of room → 0.0198)", () => {
    expect(depositMax(E18, 0n, B(100), B(150), P.coll, 18)).toBe(19_800_000_000_000_000n);
    expect(depositMax(weth(0.005), weth(0.001), B(100), B(150), P.coll, 18)).toBe(weth(0.006));
    expect(depositMax(E18, 0n, B(150), B(150), P.coll, 18)).toBe(0n);
    expect(depositMax(E18, 0n, B(100), 0n, P.coll, 18)).toBe(E18); // no cap
  });
  it("borrow max stops at 1.16: 100 × 0.83 ÷ 1.16 = $71.5517 of debt → 21.551724 USDC, and its projection stays above the trigger", () => {
    const u = borrowMax(A, P.debt, 6);
    expect(u).toBe(21_551_724n);
    const p = project(A, P, D, { kind: "borrow", units: u }, 8400n);
    expect(p.hfBps! >= 11_600n).toBe(true);
    expect(p.underTrigger).toBe(false);
    expect(borrowMax({ ...A, availBase: B(1) }, P.debt, 6)).toBe(1_000_000n); // the loan-to-value limit binds first
    expect(borrowMax({ ...A, debtBase: B(80) }, P.debt, 6)).toBe(0n); // already under 1.16
  });
  it("withdraw max: all of it without debt; else down to 1.16 (keep $69.879518 → 0.012048192768 WETH)", () => {
    expect(withdrawMax({ ...A, debtBase: 0n }, P.coll, 18)).toEqual({ units: weth(0.04), all: true });
    const m = withdrawMax(A, P.coll, 18);
    expect(m).toEqual({ units: 12_048_192_768_000_000n, all: false });
    const p = project(A, P, D, { kind: "withdraw", units: m.units }, 8400n);
    expect(p.hfBps! >= 11_600n).toBe(true);
    expect(withdrawMax({ ...A, debtBase: B(75) }, P.coll, 18).units).toBe(0n);
  });
  it("repay all: the debt plus 0.2% ($50 → 50.1 USDC)", () => {
    expect(repayAllUnits(B(50), P.debt, 6)).toBe(50_100_000n);
    expect(repayAllUnits(0n, P.debt, 6)).toBe(0n);
  });
});

describe("leftover gas", () => {
  it("returns the balance less 21,000 gas at the max fee, never negative", () => {
    expect(sweepAmount(10n ** 15n, 10n ** 9n)).toBe(10n ** 15n - 21_000n * 10n ** 9n);
    expect(sweepAmount(21_000n * 10n ** 9n, 10n ** 9n)).toBe(0n);
    expect(sweepAmount(10n ** 13n, 10n ** 9n)).toBe(0n);
    expect(sweepAmount(0n, 10n ** 9n)).toBe(0n);
  });
  it("is offered only on a contract code hash listed as knowing the action", () => {
    expect(sweepSupported("abc", [])).toBe(false);
    expect(sweepSupported(null, ["abc"])).toBe(false);
    expect(sweepSupported("abc", ["abc"])).toBe(true);
  });
  it("tops up gas only when short, to two transactions' up-front fee", () => {
    const up = 375_332n * 10n ** 9n;
    expect(gasTopUp(up, up)).toBe(0n);
    expect(gasTopUp(0n, up)).toBe(2n * up);
    expect(gasTopUp(up - 1n, up)).toBe(up + 1n);
  });
});

describe("phase", () => {
  it("follows the contract's rescue state, then the health factor", () => {
    expect(phaseOf({ registered: false, rescueState: null, hfBps: null })).toBe("none");
    expect(phaseOf({ registered: true, rescueState: null, hfBps: 16_600n })).toBe("safe");
    expect(phaseOf({ registered: true, rescueState: null, hfBps: null })).toBe("safe");
    expect(phaseOf({ registered: true, rescueState: null, hfBps: 11_499n })).toBe("under_trigger");
    expect(phaseOf({ registered: true, rescueState: "auction", hfBps: 11_400n })).toBe("rescue");
    expect(phaseOf({ registered: true, rescueState: "top_up_pending", hfBps: 11_400n })).toBe("rescue");
    expect(phaseOf({ registered: true, rescueState: "open", hfBps: 15_000n })).toBe("claim_open");
    expect(phaseOf({ registered: true, rescueState: "settling", hfBps: 15_000n })).toBe("settling");
  });
  it("words the consequence of a health factor", () => {
    expect(fallLine(16_600n, "WETH")).toBe("WETH can fall 39.8% before liquidation");
    expect(fallLine(null, "WETH")).toBe("no debt: nothing to liquidate");
    expect(fallLine(9_000n, "WETH")).toMatch(/liquidate it now/);
  });
});

describe("health factor readouts", () => {
  it("no debt reads as none, whatever Aave or the contract reports for it", () => {
    const U256 = 2n ** 256n - 1n;
    const U128 = 2n ** 128n - 1n; // the keeper logged 340282366920938487808 = this ÷ 1e18
    expect(hfFromWad(0n, U256)).toBeNull();
    expect(hfFromWad(B(10), U128)).toBeNull(); // a sentinel is never shown as a number
    expect(hfFromWad(B(10), NO_DEBT_WAD)).toBeNull();
    expect(hfFromWad(0n, 16_600n * 10n ** 14n)).toBeNull(); // no debt wins over any value
    expect(hfFromWad(B(50), 1_660_000_000_000_000_000n)).toBe(16_600n);
  });
  it("text: rounded down, 'no debt' without debt, '100+' for a dust debt", () => {
    expect(hfText(null)).toBe("no debt");
    expect(hfText(9_960n)).toBe("0.99"); // 0.996 never reads 1.00
    expect(hfText(16_600n)).toBe("1.66");
    expect(hfText(999_999n)).toBe("99.99");
    expect(hfText(1_000_000n)).toBe("100+");
    expect(hfText(3_402_823_669_209_384_878n)).toBe("100+");
  });
  it("bar: 0.90 to 2.10, the trigger and liquidation marks inside it, no debt full", () => {
    expect(hfBarPct(null)).toBe(100);
    expect(hfBarPct(HF_BAR.min)).toBe(0);
    expect(hfBarPct(8_000n)).toBe(0);
    expect(hfBarPct(30_000n)).toBe(100);
    expect(hfBarPct(15_000n)).toBe(50);
    expect(hfBarPct(10_000n)).toBeCloseTo(8.33, 2);
    expect(hfBarPct(TRIGGER_BPS)).toBeCloseTo(20.83, 2);
  });
});

describe("which actions the contract would sign", () => {
  const SAFE: PosFacts = {
    registered: true, evmConnected: true, marketOk: true, paused: false, locked: false, claimOpen: false, escrowHeld: false, refundPending: false,
    outflows: 0, pendingTx: false, hasColl: true, hasDebt: true, idleDebtUnits: usdc(3), idleCollUnits: 0n, repayFromWallet: false, sweepSupported: true, sweepUnits: 10n ** 14n,
  };
  it("safe: every action but the buy-back", () => {
    const a = availability(SAFE);
    for (const k of ["deposit", "borrow", "repay", "withdraw", "sweep", "move"] as const) expect(a[k].on, k).toBe(true);
    expect(a.buyback.on).toBe(false);
  });
  it("auction running: only repay; withdraw and borrow refused but can be tried anyway; no deposit transfer", () => {
    const a = availability({ ...SAFE, locked: true });
    expect(a.repay.on).toBe(true);
    expect(a.borrow).toMatchObject({ on: false, tryAnyway: true });
    expect(a.withdraw).toMatchObject({ on: false, tryAnyway: true });
    expect(a.borrow.why).toMatch(/only repays and supplies/);
    expect(a.deposit.on).toBe(false);
    expect(a.sweep.on).toBe(false);
    expect(a.move.on).toBe(false);
    expect(a.buyback.on).toBe(false);
  });
  it("claim open: buy-back offered; repay still signed while nothing is held", () => {
    const a = availability({ ...SAFE, locked: true, claimOpen: true });
    expect(a.buyback.on).toBe(true);
    expect(a.repay.on).toBe(true);
    expect(a.withdraw.tryAnyway).toBe(true);
  });
  it("escrow held: not even a repay", () => {
    const a = availability({ ...SAFE, locked: true, claimOpen: true, escrowHeld: true });
    expect(a.repay.on).toBe(false);
    expect(a.repay.why).toMatch(/held for the buy-back/);
    expect(a.deposit.on).toBe(false);
    expect(a.sweep.on).toBe(false);
    expect(a.buyback.on).toBe(true); // paying in is how it ends
  });
  it("a transaction in flight, queued payouts or a pending refund stop every signed action", () => {
    for (const f of [{ pendingTx: true }, { outflows: 1 }, { refundPending: true }]) {
      const a = availability({ ...SAFE, ...f });
      for (const k of ["deposit", "borrow", "repay", "withdraw", "sweep", "move"] as const) expect(a[k].on, `${k} ${JSON.stringify(f)}`).toBe(false);
    }
  });
  it("paused: only adds (repay, deposit)", () => {
    const a = availability({ ...SAFE, paused: true });
    expect(a.repay.on).toBe(true);
    expect(a.deposit.on).toBe(true);
    expect(a.borrow.on).toBe(false);
    expect(a.withdraw.on).toBe(false);
    expect(a.sweep.on).toBe(false);
  });
  it("sweep waits for the contract update, and for something to return", () => {
    expect(availability({ ...SAFE, sweepSupported: false }).sweep.why).toBe("Available after the contract update.");
    expect(availability({ ...SAFE, sweepUnits: 0n }).sweep.on).toBe(false);
  });
  it("needs the Ethereum wallet for anything paid from it, and a position for anything at all", () => {
    expect(availability({ ...SAFE, evmConnected: false }).deposit.on).toBe(false);
    expect(availability({ ...SAFE, evmConnected: false }).borrow.on).toBe(true);
    const none = availability({ ...SAFE, registered: false });
    for (const k of Object.keys(none) as (keyof typeof none)[]) expect(none[k].on, k).toBe(false);
  });
  it("no debt: nothing to repay; no collateral: nothing to borrow against or withdraw", () => {
    expect(availability({ ...SAFE, hasDebt: false }).repay.on).toBe(false);
    const empty = availability({ ...SAFE, hasColl: false, hasDebt: false });
    expect(empty.borrow.on).toBe(false);
    expect(empty.withdraw.on).toBe(false);
    expect(empty.deposit.on).toBe(true);
  });
  it("repay from the wallet is off while a rescue runs (tokens sent then are held for the buy-back); from the position it is still signed", () => {
    for (const st of [{ locked: true }, { locked: true, claimOpen: true }]) {
      const fromWallet = availability({ ...SAFE, ...st, repayFromWallet: true }).repay;
      expect(fromWallet.on, JSON.stringify(st)).toBe(false);
      expect(fromWallet.why).toMatch(/held for the buy-back/);
      expect(availability({ ...SAFE, ...st, repayFromWallet: false }).repay.on).toBe(true);
    }
    expect(availability({ ...SAFE, repayFromWallet: true }).repay.on).toBe(true); // no rescue: fine
  });
  it("no Ethereum wallet: supply only WETH already at the position; repay only from it; buy back by sending to it", () => {
    const noWallet = { ...SAFE, evmConnected: false };
    expect(availability(noWallet).deposit).toMatchObject({ on: false });
    expect(availability(noWallet).deposit.why).toMatch(/Send WETH to the position's address/);
    expect(availability({ ...noWallet, idleCollUnits: weth(0.01) }).deposit.on).toBe(true);
    const during = availability({ ...noWallet, locked: true, claimOpen: true }).deposit;
    expect(during.on).toBe(false); // during a rescue WETH sent to the position is the buy-back, never "send WETH"
    expect(during.why).toMatch(/counts toward the buy-back/);
    expect(availability({ ...noWallet, idleCollUnits: weth(0.01), locked: true }).deposit.on).toBe(false);
    expect(availability({ ...noWallet, repayFromWallet: true }).repay).toMatchObject({ on: false });
    expect(availability({ ...noWallet, repayFromWallet: true }).repay.why).toMatch(/position's address/);
    expect(availability({ ...noWallet, repayFromWallet: false }).repay.on).toBe(true);
    const claim = availability({ ...noWallet, locked: true, claimOpen: true }).buyback;
    expect(claim.on).toBe(false);
    expect(claim.why).toMatch(/Send exactly the owed WETH to the position's address/);
  });
});

// ── no Ethereum wallet ──

describe("a pasted payout address", () => {
  const POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
  const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const POSITION = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
  const refuse = [
    { address: POOL, name: "the Aave Pool" },
    { address: WETH, name: "the WETH token contract" },
    { address: USDC, name: "the USDC token contract" },
    { address: POSITION, name: "the position's own address" },
  ];
  const GOOD = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // EIP-55's own example
  it("accepts a checksummed address, or one with no checksum (all one case), and returns it checksummed", () => {
    expect(checkPayout(GOOD, refuse)).toEqual({ ok: true, address: GOOD });
    expect(checkPayout(`  ${GOOD.toLowerCase()}\n`, refuse)).toEqual({ ok: true, address: GOOD });
    expect(checkPayout("0x" + GOOD.slice(2).toUpperCase(), refuse)).toEqual({ ok: true, address: GOOD });
  });
  it("refuses a mixed-case address whose checksum is wrong (one letter's case changed)", () => {
    const typo = "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const c = checkPayout(typo, refuse);
    expect(c.ok).toBe(false);
    expect(!c.ok && c.why).toMatch(/checksum/);
  });
  it("refuses what is not an address: empty, too short, too long, not hex, no 0x", () => {
    for (const v of ["", "0x1234", GOOD + "00", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeZ", GOOD.slice(2), "alice.near"]) expect(checkPayout(v, refuse).ok, v).toBe(false);
  });
  it("refuses the zero address", () => {
    const c = checkPayout("0x0000000000000000000000000000000000000000", refuse);
    expect(!c.ok && c.why).toMatch(/zero address/);
  });
  it("refuses the market's Pool, WETH and USDC and the position's own address, in any case", () => {
    for (const r of refuse) {
      for (const v of [r.address, r.address.toLowerCase()]) {
        const c = checkPayout(v, refuse);
        expect(c.ok, v).toBe(false);
        expect(!c.ok && c.why).toContain(r.name);
      }
    }
  });
});

describe("what to send to the position's address", () => {
  const UP = 375_332n * 1_000_000_000n; // the mainnet market's up-front fee of one signed tx (0.000375332 ETH)
  it("gas: nothing while the position can pay its next transaction; else two transactions' fee less what it holds, rounded up to 0.0001 ETH", () => {
    expect(gasAsk(UP, UP)).toBe(0n);
    expect(gasAsk(10n ** 15n, UP)).toBe(0n);
    expect(gasAsk(0n, UP)).toBe(8n * 10n ** 14n); // 0.000750664 → 0.0008
    expect(gasAsk(10n ** 14n, UP)).toBe(7n * 10n ** 14n); // 0.000650664 → 0.0007
    expect(gasAsk(UP - 1n, UP)).toBe(4n * 10n ** 14n); // 0.000375333 → 0.0004: never less than what is missing
    expect(gasAsk(UP - 1n, UP) + UP - 1n).toBeGreaterThanOrEqual(UP);
  });
  it("arrival: only a rise since the last reading of the same position; never on the first reading", () => {
    expect(arrived(null, weth(0.01))).toBe(0n);
    expect(arrived(0n, weth(0.01))).toBe(weth(0.01));
    expect(arrived(weth(0.005), weth(0.012))).toBe(weth(0.007));
    expect(arrived(weth(0.01), weth(0.01))).toBe(0n);
    expect(arrived(weth(0.01), 0n)).toBe(0n); // supplied: it left, nothing arrived
  });
  it("a supply: WETH at the position counts first; the wallet sends only the rest; with no wallet nothing is ever transferred", () => {
    expect(depositPlan(weth(0.01), weth(0.01), true)).toEqual({ kind: "supply" });
    expect(depositPlan(weth(0.01), weth(0.02), false)).toEqual({ kind: "supply" });
    expect(depositPlan(weth(0.01), weth(0.004), true)).toEqual({ kind: "transfer", sendUnits: weth(0.006) });
    expect(depositPlan(weth(0.01), weth(0.004), false)).toEqual({ kind: "short", shortUnits: weth(0.006) });
    expect(depositPlan(weth(0.01), 0n, false).kind).toBe("short");
  });
  it("buy-back: the owed WETH less what is already at the position, never negative", () => {
    expect(buybackDue(weth(0.003), 0n)).toBe(weth(0.003));
    expect(buybackDue(weth(0.003), weth(0.001))).toBe(weth(0.002));
    expect(buybackDue(weth(0.003), weth(0.004))).toBe(0n);
  });
  const BASE = { registered: true, evmConnected: false, locked: false, claimOpen: false, ethWei: 10n ** 15n, upfrontWei: UP, gasWaitWei: 0n, dueUnits: 0n };
  it("the funding card: WETH (and gas only when short) when no wallet is connected and no rescue runs", () => {
    expect(fundPrompt(BASE)).toEqual({ kind: "fund", gasWei: 0n });
    expect(fundPrompt({ ...BASE, ethWei: 0n })).toEqual({ kind: "fund", gasWei: 8n * 10n ** 14n });
  });
  it("nothing to send when a wallet is connected, before registration, or while an auction or top-up runs", () => {
    expect(fundPrompt({ ...BASE, evmConnected: true }).kind).toBe("none");
    expect(fundPrompt({ ...BASE, registered: false }).kind).toBe("none");
    expect(fundPrompt({ ...BASE, locked: true }).kind).toBe("none"); // WETH sent now would be held for the buy-back
  });
  it("claim open: exactly the WETH still due, plus gas for the payouts when short", () => {
    expect(fundPrompt({ ...BASE, locked: true, claimOpen: true, dueUnits: weth(0.0021) })).toEqual({ kind: "buyback", wethUnits: weth(0.0021), gasWei: 0n });
    expect(fundPrompt({ ...BASE, locked: true, claimOpen: true, dueUnits: 1n, ethWei: 0n })).toEqual({ kind: "buyback", wethUnits: 1n, gasWei: 8n * 10n ** 14n });
  });
  it("an action waiting for gas asks for ETH only, whatever else is true", () => {
    for (const x of [{}, { evmConnected: true }, { locked: true }, { locked: true, claimOpen: true }]) expect(fundPrompt({ ...BASE, ...x, gasWaitWei: 7n * 10n ** 14n }), JSON.stringify(x)).toEqual({ kind: "gas", gasWei: 7n * 10n ** 14n });
  });
});

// A QR decoder for a clean module grid, written from the QR standard (ISO/IEC 18004) and not from
// the encoder: unmask, read the codewords in the zig-zag order, check every block with its
// Reed-Solomon syndromes, then read the byte-mode payload. Versions 1 to 5 at level M.
const GF_EXP: number[] = [];
const GF_LOG: number[] = [];
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}
const gfMul = (a: number, b: number) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);
const LEVEL_M: Record<number, { total: number; ec: number; blocks: number }> = {
  1: { total: 26, ec: 10, blocks: 1 }, 2: { total: 44, ec: 16, blocks: 1 }, 3: { total: 70, ec: 26, blocks: 1 }, 4: { total: 100, ec: 18, blocks: 2 }, 5: { total: 134, ec: 24, blocks: 2 },
};
const MASKS: ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (_i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0, (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];
function gridFromSvg(svg: string): boolean[][] {
  const size = Number(svg.match(/viewBox="0 0 (\d+) (\d+)"/)![1]);
  const n = size - 2 * QR_QUIET;
  const g = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  for (const m of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    const x = Number(m[1]) - QR_QUIET;
    const y = Number(m[2]) - QR_QUIET;
    if (x < 0 || y < 0 || x >= n || y >= n) throw new Error(`a dark module in the quiet zone at ${m[1]},${m[2]}`);
    g[y][x] = true;
  }
  return g;
}
function decodeQr(g: boolean[][]): string {
  const n = g.length;
  const v = (n - 17) / 4;
  const spec = LEVEL_M[v];
  if (!spec) throw new Error(`unsupported size ${n}`);
  const fn = (r: number, c: number) =>
    (r < 9 && c < 9) || (r < 9 && c >= n - 8) || (r >= n - 8 && c < 9) || r === 6 || c === 6 || (v >= 2 && Math.abs(r - (n - 7)) <= 2 && Math.abs(c - (n - 7)) <= 2);
  // the finder patterns are where they belong (a 7×7 ring with a 3×3 core, three corners)
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]])
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      if (g[r0 + r][c0 + c] !== (ring || core)) throw new Error("finder pattern broken");
    }
  for (let mask = 0; mask < 8; mask++) {
    const bits: number[] = [];
    let up = true;
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;
      for (let k = 0; k < n; k++) {
        const r = up ? n - 1 - k : k;
        for (const c of [col, col - 1]) if (!fn(r, c)) bits.push(g[r][c] !== MASKS[mask](r, c) ? 1 : 0);
      }
      up = !up;
    }
    const cw: number[] = [];
    for (let i = 0; i < spec.total; i++) cw.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
    const dataPer = spec.total / spec.blocks - spec.ec;
    const blocks = Array.from({ length: spec.blocks }, () => [] as number[]);
    let idx = 0;
    for (let i = 0; i < dataPer; i++) for (const b of blocks) b.push(cw[idx++]);
    const data = blocks.map((b) => [...b]);
    for (let i = 0; i < spec.ec; i++) for (const b of blocks) b.push(cw[idx++]);
    const clean = blocks.every((b) => {
      for (let i = 0; i < spec.ec; i++) if (b.reduce((acc, byte) => gfMul(acc, GF_EXP[i]) ^ byte, 0) !== 0) return false;
      return true;
    });
    if (!clean) continue;
    const payload = data.flat().flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >> (7 - i)) & 1));
    const read = (from: number, len: number) => payload.slice(from, from + len).reduce((a, b) => (a << 1) | b, 0);
    if (read(0, 4) !== 0b0100) throw new Error("not byte mode");
    const count = read(4, 8);
    return String.fromCharCode(...Array.from({ length: count }, (_, i) => read(12 + 8 * i, 8)));
  }
  throw new Error("no mask gives a clean Reed-Solomon check");
}

describe("the position's address as a QR code", () => {
  const addrs = ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "0x0000000000000000000000000000000000000001"];
  it("decodes to exactly the address, character for character (checksum case kept)", () => {
    for (const a of addrs) expect(decodeQr(gridFromSvg(qrSvg(a, "QR")))).toBe(a);
  });
  it("a different address gives a different code (the decoder is not fooled by a fixed picture)", () => {
    expect(qrSvg(addrs[0], "QR")).not.toBe(qrSvg(addrs[1], "QR"));
    expect(decodeQr(gridFromSvg(qrSvg(addrs[1], "QR")))).not.toBe(addrs[0]);
  });
  it("keeps a 4-module quiet zone and draws dark modules on one light square, the same in both themes", () => {
    const svg = qrSvg(addrs[0], "QR code of the position's address");
    expect(QR_QUIET).toBe(4);
    expect(svg).toMatch(new RegExp(`<rect width="(\\d+)" height="\\1" fill="${QR_LIGHT}"/>`));
    expect(svg).toContain(`<path fill="${QR_DARK}"`);
    expect(svg).not.toMatch(/var\(|currentColor/); // never a theme colour: dark mode must not invert it
    expect(svg).toContain(`aria-label="QR code of the position's address"`);
    // contrast of the modules on the square (WCAG relative luminance), well above what scanners need
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    expect((lum(QR_LIGHT) + 0.05) / (lum(QR_DARK) + 0.05)).toBeGreaterThan(10);
  });
});

describe("the health factor's colour", () => {
  it("is danger under 1.10, exposure under 1.15, caution under 1.50, else safe (and safe with no debt)", () => {
    expect(EARLY_SETTLE_BPS).toBe(11_000n);
    expect(CAUTION_BPS).toBe(15_000n);
    expect(hfBand(9_500n)).toBe("danger");
    expect(hfBand(10_999n)).toBe("danger");
    expect(hfBand(11_000n)).toBe("exposure");
    expect(hfBand(11_499n)).toBe("exposure");
    expect(hfBand(TRIGGER_BPS)).toBe("caution");
    expect(hfBand(14_999n)).toBe("caution");
    expect(hfBand(15_000n)).toBe("safe");
    expect(hfBand(null)).toBe("safe");
  });
  it("the current-reading marker pulses only under 1.50 with debt", () => {
    expect(hfPulses(14_999n)).toBe(true);
    expect(hfPulses(10_500n)).toBe(true);
    expect(hfPulses(15_000n)).toBe(false);
    expect(hfPulses(null)).toBe(false);
  });
});

describe("risk details", () => {
  it("how far the collateral can fall to each line is 1 − line ÷ HF, rounded down", () => {
    // HF 1.30: liquidation 1 − 1/1.3 = 23.08% → 2307 bps; early 1 − 1.1/1.3 = 15.38% → 1538; trigger 1 − 1.15/1.3 = 11.54% → 1153
    const l = riskLines(13_000n);
    expect(l.map((x) => x.key)).toEqual(["liquidation", "early", "trigger"]);
    expect(l.map((x) => x.bps)).toEqual([10_000n, 11_000n, 11_500n]);
    expect(l.map((x) => x.fallBps)).toEqual([2307n, 1538n, 1153n]);
    expect(l.every((x) => !x.reached)).toBe(true);
    // rounded down: a fall of exactly 1/3 (HF 1.5 to 1.0) reads 3333, never 3334
    expect(riskLines(15_000n)[0].fallBps).toBe(3333n);
    expect(pctText(2307n)).toBe("23.0%");
    expect(pctText(3333n)).toBe("33.3%");
  });
  it("a line at or above the health factor is reached (no fall left); no debt has no lines", () => {
    const l = riskLines(11_200n);
    expect(l[0]).toMatchObject({ reached: false, fallBps: 1071n }); // 1 − 1/1.12 = 10.71%
    expect(l[1]).toMatchObject({ reached: false });
    expect(l[2]).toMatchObject({ reached: true, fallBps: 0n });
    expect(riskLines(11_000n)[1]).toMatchObject({ reached: true, fallBps: 0n });
    expect(riskLines(null).every((x) => x.fallBps === null && !x.reached)).toBe(true);
  });
  it("the price at each line is price × line ÷ HF, rounded up", () => {
    // WETH $3,100, HF 1.05: liquidation at 3100 / 1.05 = $2,952.380952… → rounded up in 8 dp
    expect(linePrice(B(3100), 10_000n, 10_500n)).toBe(295_238_095_239n);
    expect(linePrice(B(2500), 11_500n, 16_600n)).toBe((B(2500) * 11_500n + 16_599n) / 16_600n);
    expect(linePrice(B(2500), 10_000n, null)).toBeNull();
  });
  it("current LTV is debt ÷ collateral (rounded up), beside Aave's max LTV and threshold", () => {
    expect(ltvView(A, 8050n)).toEqual({ currentBps: 5000n, maxBps: 8050n, ltBps: 8300n });
    expect(ltvView({ ...A, debtBase: B(33.333333) }, 8050n)!.currentBps).toBe(3334n);
    expect(ltvView({ ...A, collBase: 0n }, 8050n)).toBeNull();
    // HF = LT ÷ LTV: 0.83 / 0.50 = 1.66, the HF of A
    expect((8300n * 10_000n) / ltvView(A, 8050n)!.currentBps).toBe(hfBps(A.collBase, A.debtBase, A.ltBps));
  });
  it("the premium cap is the contract's: half the debt × the liquidation bonus", () => {
    // $50 debt, 5% bonus: 50 × 0.05 / 2 = $1.25
    expect(premiumCapBase(B(50), 500n)).toBe(B(1.25));
    // always below what an Aave liquidation of half the debt costs (bonus × 50% × debt), never above
    for (const d of [B(9.99), B(79.17), B(1234.56)]) expect(premiumCapBase(d, 500n)).toBeLessThanOrEqual((d * 500n) / 10_000n / 2n);
    expect(premiumCapBase(0n, 500n)).toBe(0n);
  });
});

describe("the health bar", () => {
  it("has five flat zones that tile the bar exactly, in order, with edges at 1.00, 1.10, 1.15 and 1.50", () => {
    const z = barZones();
    expect(z.map((x) => x.band)).toEqual(["trip", "settle", "exposure", "caution", "safe"]);
    expect(z[0].left).toBe(0);
    for (let i = 1; i < z.length; i++) expect(z[i].left).toBeCloseTo(z[i - 1].left + z[i - 1].width, 9);
    expect(z[4].left + z[4].width).toBeCloseTo(100, 9);
    expect(z.map((x) => x.left).slice(1)).toEqual([hfBarPct(10_000n), hfBarPct(EARLY_SETTLE_BPS), hfBarPct(TRIGGER_BPS), hfBarPct(CAUTION_BPS)]);
    expect(z.every((x) => x.width > 0)).toBe(true);
  });
  it("marks 1.00, 1.10 and 1.15, and only 1.15 carries the stewards' rescue chip", () => {
    expect(BAR_MARKS.map((m) => [m.bps, m.label, m.rescue])).toEqual([[10_000n, "1.00", false], [11_000n, "1.10", false], [11_500n, "1.15", true]]);
  });
});

describe("the live bid ladder", () => {
  const bid = (steward: string, premium_bps: number, seq: number, amount = "16000000000000000") => ({ steward, premium_bps, amount_units: amount, seq });
  const auction = (bids: ReturnType<typeof bid>[], members: { steward: string }[] = [], state = "auction") => ({ state, bids, members });
  it("orders lowest premium first and, at equal premiums, the earlier bid first (as the contract awards)", () => {
    const { rows } = ladderStep(null, auction([bid("swift.x.near", 210, 0), bid("deep.x.near", 140, 3), bid("patient.x.near", 140, 1), bid("pool.x.near", 175, 2)]), 1000, 100_000);
    expect(rows.map((r) => r.name)).toEqual(["patient", "deep", "pool", "swift"]);
    expect(rows.map((r) => r.rank)).toEqual([0, 1, 2, 3]);
  });
  it("stamps each bid when first seen; the first reading flashes nothing, later new bids and rebids flash", () => {
    const a = ladderStep(null, auction([bid("swift.x.near", 210, 0)]), 1000, 100_000);
    expect(a.rows[0]).toMatchObject({ seenMs: 1000, fresh: false, prevBps: null });
    const b = ladderStep(a.seen, auction([bid("swift.x.near", 210, 0), bid("deep.x.near", 150, 1)]), 5000, 100_000);
    expect(b.rows.find((r) => r.name === "deep")).toMatchObject({ seenMs: 5000, fresh: true });
    expect(b.rows.find((r) => r.name === "swift")).toMatchObject({ seenMs: 1000, fresh: false });
    // swift rebids lower (a new seq): fresh, keeps its first-seen time, remembers the premium it replaced
    const c = ladderStep(b.seen, auction([bid("swift.x.near", 120, 2), bid("deep.x.near", 150, 1)]), 9000, 100_000);
    const sw = c.rows.find((r) => r.name === "swift")!;
    expect(sw).toMatchObject({ bps: 120, prevBps: 210, seenMs: 1000, fresh: true, rank: 0 });
    // an unchanged reading flashes nothing
    expect(ladderStep(c.seen, auction([bid("swift.x.near", 120, 2), bid("deep.x.near", 150, 1)]), 13_000, 100_000).rows.some((r) => r.fresh)).toBe(false);
  });
  it("a fresh bid in the last 10 s is late; winners are marked only once the auction has closed", () => {
    const seen = new Map<string, SeenBid>();
    const late = ladderStep(seen, auction([bid("swift.x.near", 200, 0)]), 100_000 - LATE_MS + 1, 100_000);
    expect(late.rows[0]).toMatchObject({ fresh: true, late: true });
    expect(ladderStep(new Map(), auction([bid("swift.x.near", 200, 0)]), 50_000, 100_000).rows[0].late).toBe(false);
    expect(ladderStep(null, auction([bid("deep.x.near", 140, 0)], [{ steward: "deep.x.near" }]), 0, 0).rows[0].won).toBe(false);
    expect(ladderStep(null, auction([bid("deep.x.near", 140, 0), bid("swift.x.near", 200, 1)], [{ steward: "deep.x.near" }], "top_up_pending"), 0, 0).rows.map((r) => r.won)).toEqual([true, false]);
  });
  it("known stewards get their own tile and colour; any other account a neutral two-letter tile", () => {
    expect(stewardIdOf("patient.usestead.near")).toBe("patient");
    expect(stewardIdOf("mallory.near")).toBeNull();
    const { rows } = ladderStep(null, auction([bid("deep.usestead.near", 140, 0), bid("mallory.near", 150, 1)]), 0, 0);
    expect(rows.map((r) => [r.id, r.code])).toEqual([["deep", "DP"], [null, "MA"]]);
  });
  it("a bar is the premium's share of the auction's cap; the cost is the premium in the supplied asset at the oracle price", () => {
    expect(bidBarPct(156, 312)).toBe(50);
    expect(bidBarPct(400, 312)).toBe(100);
    expect(bidBarPct(100, 0)).toBe(0);
    // 0.016 WETH × 1.20% = 0.000192 WETH at $3,100 = $0.5952
    expect(premiumCostBase(weth(0.016), 120, B(3100), 18)).toBe(B(0.5952));
  });
});

describe("the borrow and the move to the wallet are separate", () => {
  const src = readFileSync(new URL("../../web/src/own/dashboard.ts", import.meta.url), "utf8");
  const body = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  it("the borrow signs only Aave's borrow: the USDC stays at the position", () => {
    const b = body("const borrow = () => {", "const repay = () => {");
    expect(b).toContain('type: "borrow"');
    expect(b).not.toContain("transfer_debt");
    expect((b.match(/signAction\(/g) ?? []).length).toBe(1);
  });
  it("the move signs one transfer of the typed amount (all of it when empty), never more than the position holds", () => {
    const m = body("const move = () => {", "// ── the page ──");
    expect(m).toContain('type: "transfer_debt", amount: units.toString()');
    expect(m).toContain("typed && typed > 0n ? typed : idle");
    expect(m).toMatch(/if \(units > idle\) throw/);
    expect((m.match(/signAction\(/g) ?? []).length).toBe(1);
  });
});
