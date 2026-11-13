// The mainnet position dashboard's rules (web/src/own/dashlogic.ts): the projected health factor
// of each action against hand-computed Aave values, the warning under the trigger and the block
// under 1.00, the amount helpers, the leftover-gas amount, and which actions are offered in each
// state of the position. Every expected number below is worked out by hand from Aave's formula
// (HF = collateral × LT ÷ debt, base currency with 8 decimals, LT in bps).
import { describe, expect, it } from "vitest";
import {
  project, hfBps, toBase, depositMax, borrowMax, withdrawMax, repayAllUnits, sweepAmount, sweepSupported, gasTopUp, phaseOf, availability, fallLine,
  TRIGGER_BPS, UNDER_TRIGGER_WARNING, type Account, type PosFacts,
} from "../../web/src/own/dashlogic.js";

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

describe("which actions the contract would sign", () => {
  const SAFE: PosFacts = {
    registered: true, evmConnected: true, marketOk: true, paused: false, locked: false, claimOpen: false, escrowHeld: false, refundPending: false,
    outflows: 0, pendingTx: false, hasColl: true, hasDebt: true, idleDebtUnits: usdc(3), sweepSupported: true, sweepUnits: 10n ** 14n,
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
});
