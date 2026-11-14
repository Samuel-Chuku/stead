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
  KEPT_DEBT, KEPT_RESCUE, LOW_GAS_WEI, gasLow, fundAsk, liveStewardView,
  positionEmpty, type EmptyFacts,
  flowActivity, sortActivity, clockText, flowMoves, type ActRow,
  nearGate, ACTIVATION_MS, windowRefused, parkedView, repayPlan, defaultRepaySrc, positionRepayOffer, payoutLine, payoutChangeState, durationText,
  doneView, DONE_KINDS, relayedHash, lastProtection, protectionTally, wethOutAvail, wethOutNext, wethOutArg, commonBlock,
} from "../../web/src/own/dashlogic.js";
import { NETS, rescueFlow, type RescueView, type ClaimView } from "../../web/src/own/net.js";
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
  it("safe: every action but the buy-back (and the leftover ETH, kept for gas while there is debt)", () => {
    const a = availability(SAFE);
    for (const k of ["deposit", "borrow", "repay", "withdraw", "move"] as const) expect(a[k].on, k).toBe(true);
    expect(a.buyback.on).toBe(false);
    expect(a.sweep).toMatchObject({ on: false, why: KEPT_DEBT });
  });
  it("the leftover ETH is offered back only with no debt and no rescue: otherwise it pays the position's gas", () => {
    const free = { ...SAFE, hasDebt: false };
    expect(availability(free).sweep.on).toBe(true);
    expect(availability({ ...free, locked: true }).sweep).toMatchObject({ on: false, why: KEPT_RESCUE });
    expect(availability({ ...free, locked: true, claimOpen: true }).sweep).toMatchObject({ on: false, why: KEPT_RESCUE });
    expect(availability({ ...free, escrowHeld: true }).sweep).toMatchObject({ on: false, why: KEPT_RESCUE });
    expect(availability({ ...free, hasDebt: true }).sweep).toMatchObject({ on: false, why: KEPT_DEBT });
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

describe("the position's gas", () => {
  const CAP = 375_332n * 10n ** 9n; // the signing cap: 375,332 gas at 1 gwei
  it("is low under 0.0004 ETH while the position has debt or a rescue runs, never without either", () => {
    expect(LOW_GAS_WEI).toBe(4n * 10n ** 14n);
    expect(gasLow({ ethWei: LOW_GAS_WEI - 1n, hasDebt: true, locked: false, upfrontWei: CAP })).toBe(true);
    expect(gasLow({ ethWei: LOW_GAS_WEI, hasDebt: true, locked: false, upfrontWei: CAP })).toBe(false);
    expect(gasLow({ ethWei: 0n, hasDebt: false, locked: true, upfrontWei: CAP })).toBe(true);
    expect(gasLow({ ethWei: 0n, hasDebt: false, locked: false, upfrontWei: CAP })).toBe(false);
  });
  it("never counts as enough below one transaction at the caps", () => {
    const big = 10n ** 15n;
    expect(gasLow({ ethWei: big - 1n, hasDebt: true, locked: false, upfrontWei: big })).toBe(true);
  });
  it("the Fund dialog: WETH plus missing gas normally, only ETH while an auction or top-up runs, the exact buy-back while a claim is open", () => {
    const F = { registered: true, locked: false, claimOpen: false, ethWei: 10n ** 15n, upfrontWei: 4n * 10n ** 14n, gasWaitWei: 0n, dueUnits: 0n };
    expect(fundAsk(F)).toEqual({ kind: "fund", gasWei: 0n });
    expect(fundAsk({ ...F, ethWei: 0n })).toEqual({ kind: "fund", gasWei: 8n * 10n ** 14n });
    expect(fundAsk({ ...F, locked: true })).toEqual({ kind: "gas", gasWei: 0n });
    expect(fundAsk({ ...F, locked: true, ethWei: 0n })).toEqual({ kind: "gas", gasWei: 8n * 10n ** 14n });
    expect(fundAsk({ ...F, locked: true, claimOpen: true, dueUnits: 5n })).toEqual({ kind: "buyback", wethUnits: 5n, gasWei: 0n });
    expect(fundAsk({ ...F, gasWaitWei: 7n })).toEqual({ kind: "gas", gasWei: 7n });
    expect(fundAsk({ ...F, registered: false }).kind).toBe("none");
  });
});

describe("the steward's view of a live rescue", () => {
  const coll = { symbol: "WETH", decimals: 18 };
  const base = { id: 3, opened_at: "1000000000000", closes_at: "0", claims_opened_at: "0", settlement: null };
  const bids = [
    { steward: "swift.usestead.near", premium_bps: 210, amount_units: "16000000000000000", seq: 0 },
    { steward: "deep.usestead.near", premium_bps: 140, amount_units: "16000000000000000", seq: 1 },
    { steward: "swift.usestead.near", premium_bps: 120, amount_units: "16000000000000000", seq: 2 },
  ];
  const o = { posId: 0, coll, seenMs: (k: string) => (k === "topup:3:deep.usestead.near" ? 2_000_000 : null), evmTxUrl: (h: string) => `https://etherscan.io/tx/${h}` };
  it("while the auction runs: the leading bidder only, its latest bid and how often it bid", () => {
    const v = liveStewardView({ ...base, state: "auction", bids, members: [] }, [], o)!;
    expect(v.stewards.map((x) => x.steward)).toEqual(["swift"]);
    expect(v.stewards[0].premiumBps).toBe(120);
    expect(v.stewards[0].moves).toHaveLength(1);
    expect(v.stewards[0].moves[0]).toMatchObject({ kind: "bid", title: "Leading bid" });
    expect(v.stewards[0].moves[0].detail).toContain("bid 2 times");
    expect(v.stewards[0].share).toBeUndefined();
    expect(liveStewardView({ ...base, state: "auction", bids: [], members: [] }, [], o)).toBeNull();
  });
  it("after it closes: the winner's supply (its Ethereum transaction), the confirmation and the claim, from the contract's records", () => {
    const m = { steward: "deep.usestead.near", premium_bps: 140, share_units: "16000000000000000", confirmed: true, evm_tx: "0xabc", claim_id: "0-0-0" };
    const v = liveStewardView({ ...base, state: "open", claims_opened_at: "3000000000000", bids, members: [m] }, [{ token_id: "0-0-0", owner: m.steward, owed_units: "16224000000000000", status: "open" }], o)!;
    expect(v.pooled).toBe(false);
    const d = v.stewards[0];
    expect(d.steward).toBe("deep");
    expect(d.share).toEqual({ amount: "0.016", asset: "WETH" });
    expect(d.moves.map((x) => x.kind)).toEqual(["bid", "supply", "verified", "claim"]);
    expect(d.moves[1]).toMatchObject({ tx: "0xabc", link: "https://etherscan.io/tx/0xabc", confirmed: true, at: new Date(2_000_000).toISOString() });
    expect(d.moves[3].figure).toEqual({ value: "0.016224", unit: "WETH" });
    expect(d.moves[3].at).toBe(new Date(3_000_000).toISOString());
    expect(d.capital).toBeUndefined(); // not known from the contract: the view leaves it out
  });
  it("a top-up proven by a verified read names the block it read, never a made-up transaction link", () => {
    const m = { steward: "deep.usestead.near", premium_bps: 140, share_units: "16000000000000000", confirmed: true, evm_tx: "verified@26411620", claim_id: null };
    const v = liveStewardView({ ...base, state: "open", bids, members: [m] }, [], { ...o, evmBlockUrl: (n: number) => `https://etherscan.io/block/${n}` })!;
    expect(v.stewards[0].moves[1]).toMatchObject({ kind: "supply", tx: "block 26411620", link: "https://etherscan.io/block/26411620" });
  });
  it("a pooled rescue shows each winner; a top-up still under way has no transaction yet", () => {
    const ms = [
      { steward: "deep.usestead.near", premium_bps: 140, share_units: "8000000000000000", confirmed: false, evm_tx: null, claim_id: null },
      { steward: "swift.usestead.near", premium_bps: 120, share_units: "8000000000000000", confirmed: false, evm_tx: null, claim_id: null },
    ];
    const v = liveStewardView({ ...base, state: "top_up_pending", bids, members: ms }, [], o)!;
    expect(v.pooled).toBe(true);
    expect(v.stewards.map((x) => x.steward)).toEqual(["deep", "swift"]);
    expect(v.stewards[0].moves[0].title).toBe("Bid filled");
    expect(v.stewards[0].moves[1]).toMatchObject({ kind: "supply", title: "Topping up" });
    expect(v.stewards[0].moves[1].tx).toBeUndefined();
  });
});

describe("the dashboard page", () => {
  const src = readFileSync(new URL("../../web/src/own/dashboard.ts", import.meta.url), "utf8");
  it("the gas ETH's return is offered only when the contract would sign it, and asks for the destination first", () => {
    expect(src).toContain('tileBtn("minus", "eth", `Return ETH${av.sweep.on ? ` (${fmt(f.sweepUnits, 18, 6)})` : ""} to your payout`, av.sweep.on, av.sweep.why)');
    expect(src).toContain('btn(`Return ${fmt(f.sweepUnits, 18, 6)} ETH to ${short(payout)}`, "data-confirm", true, !av.sweep.on)');
    // the tile's − opens the confirm (where it goes), never the signing itself
    expect(src).toContain('ask(tok === "coll" ? "wethout" : tok === "debt" ? "move" : "sweep", b)');
  });
  it("the funding block is a dialog, not a section of the page", () => {
    expect(src).not.toContain('<section class="st-dash-fund"');
    expect(src).toMatch(/modal\("fund"/);
  });
  it("the activity orders by the contract's records, never by when the page first saw a step", () => {
    const act = src.slice(src.indexOf("function activityHtml("), src.indexOf("function protRowHtml("));
    expect(act).toContain("sortActivity([...own, ...steps])");
    expect(act).not.toContain("seenAt");
    expect(act).not.toMatch(/Date\.now\(\)\s*\)/);
  });
  it("the protections are read once per page load, 50 rescues a page, and a finished rescue is not read again", () => {
    const load = src.slice(src.indexOf("async function loadHist("), src.indexOf("async function rereadOne("));
    expect(load).toContain('nearView<RescueView[]>("get_rescues", { from, limit: 50 })');
    expect(load).toContain("if (hist.has(r.id)) continue");
    const again = src.slice(src.indexOf("async function rereadOne("), src.indexOf("// the position's last rescue id"));
    expect(again).toContain("!rescueFinished(h.rescue)");
  });
  it("the empty position's button reads Open a new position", () => {
    expect(src).toContain("data-fresh>Open a new position</button>");
    expect(src).not.toMatch(/Start a new position/i);
  });
  it("the health bar sweeps now and then in hard steps, its phase kept across redraws, inside the bar", () => {
    const css = readFileSync(new URL("../../web/src/styles/own.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.st-dash-bar-sweep \{[^}]*animation: st-dash-sweep 9s steps\(\d+, end\) infinite/);
    expect(css).toMatch(/\.st-dash-bar-fill \{[^}]*overflow: hidden/);
    expect(src).toContain('<span class="st-dash-bar-sweep" style="animation-delay:-${Date.now() % SWEEP_MS}ms"></span>');
    // reduced motion stops every animation (tokens.css), and the band rests out of view
    expect(css).toMatch(/\.st-dash-bar-sweep \{[^}]*transform: translateX\(-100%\)/);
    const tokens = readFileSync(new URL("../../web/src/styles/tokens.css", import.meta.url), "utf8");
    expect(tokens).toMatch(/prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important/);
  });
});

describe("the activity and the protections, from the contract's own records", () => {
  const M = NETS.mainnet;
  const F = JSON.parse(readFileSync(new URL("./fixtures/mainnet-rescue-78.json", import.meta.url), "utf8")) as { rescue: RescueView; claims: ClaimView[] };
  const R = F.rescue;
  const ms = (ns: string) => Number(BigInt(ns) / 1_000_000n);
  const more = { debt: M.debt, evmTx: M.evmTx, evmBlock: M.evmBlock, evmAddress: M.evmAddress };
  const tx = (at: number, html: string): ActRow => ({ at, ord: -1, exact: true, afterMs: at, html });
  it("LAST ACTION after a settled rescue is the settlement's end, not the top-up", () => {
    const rows = sortActivity(flowActivity([F], M.collateral, "Ethereum", more));
    expect(rows[0].html).toBe("Settled: <strong>deep</strong> paid 0.028569 WETH");
    expect(rows[0].exact).toBe(false);
    expect(rows[0].afterMs).toBe(ms(R.settlement!.started_at));
    // newest first: the settlement's steps, then its start, the lapse, the claim, the proof, the top-up, the close, the opening
    const order = rows.map((r) => r.html.replace(/<[^>]+>/g, "").split(/[ :(]/)[0]);
    expect(order).toEqual(["Settled", "0.000186", "0.028383", "deep", "Settlement", "Buy-back", "Claim", "Top-up", "deep", "Auction", "Auction"]);
  });
  it("a top-up the page saw late still sorts before the claim and the settlement", () => {
    const rows = sortActivity(flowActivity([F], M.collateral, "Ethereum", more));
    const at = (needle: string) => rows.findIndex((r) => r.html.includes(needle));
    expect(at("tops up")).toBeGreaterThan(at("Claim 0-78-0 minted"));
    expect(at("tops up")).toBeGreaterThan(at("Settlement started"));
    expect(at("tops up")).toBeGreaterThan(at("Settled"));
  });
  it("the visitor's own transactions interleave with the rescue by real time", () => {
    const supply = tx(ms(R.opened_at) - 60_000, "Supply 0.04 WETH on Aave");
    const during = tx(ms(R.claims_opened_at) + 30_000, "Deposit refused");
    const after = tx(ms(R.settlement!.started_at) + 3_600_000, "Withdraw 0.01 WETH");
    const rows = sortActivity([supply, during, after, ...flowActivity([F], M.collateral, "Ethereum", more)]);
    expect(rows[0].html).toBe("Withdraw 0.01 WETH");
    expect(rows[1].html).toContain("Settled");
    const i = rows.findIndex((r) => r === during);
    expect(rows[i - 1].html).toContain("Buy-back window closed");
    expect(rows[i + 1].html).toContain("Claim 0-78-0 minted");
    expect(rows.at(-1)).toBe(supply);
  });
  it("leaves the bids to the ladder, and the rescues that ended with no bids out (unless it is the newest)", () => {
    const noBid = (id: number): { rescue: RescueView; claims: ClaimView[] } => ({ rescue: { ...R, id, state: "failed", bids: [], members: [], settlement: null, opened_at: String(BigInt(R.opened_at) - BigInt(100 - id) * 60_000_000_000n), closes_at: String(BigInt(R.opened_at) - BigInt(100 - id) * 60_000_000_000n + 120_000_000_000n) }, claims: [] });
    const rows = flowActivity([noBid(5), F, noBid(77)], M.collateral, "Ethereum", more);
    expect(rows.some((r) => r.html.includes(" bids "))).toBe(false);
    expect(rows.filter((r) => r.html === "Auction closed: no winner")).toHaveLength(0);
    const newest = flowActivity([F, noBid(90)], M.collateral, "Ethereum", more);
    expect(newest.filter((r) => r.html === "Auction closed: no winner")).toHaveLength(1);
  });
  it("draws each step's explorer link when asked", () => {
    const rows = flowActivity([F], M.collateral, "Ethereum", { ...more, linkHtml: (h, l) => `[${l}](${h})` });
    expect(rows.find((r) => r.html.startsWith("Top-up proven"))!.html).toBe("Top-up proven on Ethereum[Etherscan](https://etherscan.io/block/26411620)");
    expect(rows.find((r) => r.html.startsWith("0.000186"))!.html).toContain("[Payout](https://etherscan.io/address/0x26e2ab6ec0e027f01f41cf65ee5375f0692fd41d#tokentxns)");
  });
  it("the full-flow timeline: each step's time or the time it follows, where to see it, its figure", () => {
    const mv = flowMoves(rescueFlow(R, F.claims, { coll: M.collateral, evmName: "Ethereum", ...more }));
    expect(mv[0]).toMatchObject({ title: "Auction opened", at: new Date(ms(R.opened_at)).toISOString(), actor: "contract" });
    const proven = mv.find((m) => m.title === "Top-up proven")!;
    expect(proven).toMatchObject({ chain: "ethereum", tx: "block 26411620", link: "https://etherscan.io/block/26411620", confirmed: true });
    expect(proven.at).toBeUndefined();
    expect(proven.after).toBe(new Date(ms(R.closes_at)).toISOString());
    const leg = mv.find((m) => m.kind === "settle-leg" && m.figure?.value === "0.028383")!;
    expect(leg.tx).toBeUndefined();
    expect(leg.link).toContain("/address/0x26e2");
    expect(leg.note).toBe("contract record");
    expect(mv.find((m) => m.kind === "settle-repay")).toMatchObject({ actor: "deep", figure: { value: "30.46", unit: "USDC" } });
  });
  it("journal times: the time alone today, the date on another day", () => {
    const t = Date.UTC(2026, 10, 14, 8, 24, 16);
    expect(clockText(t, t + 3_600_000)).toBe("08:24:16");
    expect(clockText(t, t + 86_400_000)).toBe("Nov 14 08:24");
  });
});

describe("starting a new position beside an empty one", () => {
  const EMPTY: EmptyFacts = { acctKnown: true, collBase: 0n, debtBase: 0n, activeAuction: false, openRescues: 0, escrowHeld: false, refundPending: false, outflows: 0, pendingTx: false, idleCollUnits: 0n, idleDebtUnits: 0n };
  it("a position with nothing on Aave, no rescue and nothing held is empty", () => {
    expect(positionEmpty(EMPTY)).toBe(true);
  });
  it("is not decided before Aave's account data is read", () => {
    expect(positionEmpty({ ...EMPTY, acctKnown: false })).toBe(false);
  });
  it("any debt, collateral, rescue, held balance or transaction in flight keeps it in use", () => {
    const busy: Partial<EmptyFacts>[] = [
      { debtBase: 1n },
      { collBase: 1n },
      { activeAuction: true },
      { openRescues: 1 },
      { escrowHeld: true },
      { refundPending: true },
      { outflows: 1 },
      { pendingTx: true },
      { idleCollUnits: 1n },
      { idleDebtUnits: 1n },
    ];
    for (const b of busy) expect(positionEmpty({ ...EMPTY, ...b }), JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(false);
  });
  it("the page registers the new position with the same call as the first one", () => {
    const src = readFileSync(new URL("../../web/src/own/dashboard.ts", import.meta.url), "utf8");
    expect(src.match(/stead\("register_position"/g)?.length).toBe(1);
    expect(src).toContain('stead("register_position", { market_id: net.market, payout }');
  });
});

describe("two wallets in one action: each NEAR signature after a wait is its own click", () => {
  it("signs while the click's activation lasts, waits for a click once it has expired", () => {
    expect(nearGate(true, 60_000)).toBe("sign"); // the browser's own answer wins
    expect(nearGate(false, 100)).toBe("click");
    expect(nearGate(null, 0)).toBe("sign");
    expect(nearGate(null, ACTIVATION_MS)).toBe("sign");
    expect(nearGate(null, ACTIVATION_MS + 1)).toBe("click");
    expect(nearGate(null, 30_000)).toBe("click"); // e.g. after an Ethereum transfer was waited for
  });
  it("a blocked or shut wallet window reads as a pause, not a failure", () => {
    expect(windowRefused("User closed the window")).toBe(true);
    expect(windowRefused("Popup blocked")).toBe(true);
    expect(windowRefused("Smart contract panicked: a claim is open")).toBe(false);
  });
  it("the paused step says what is at the position and names the step its button goes on with", () => {
    expect(parkedView({ held: "25.4 USDC", done: ["Send 25.4 USDC to the position to repay"], next: "Repay 25.4 USDC" })).toEqual({ head: "25.4 USDC is at the position.", button: "Repay 25.4 USDC now" });
    expect(parkedView({ held: null, done: ["Supply the position's 0.01 WETH on Aave (to withdraw it)"], next: "Withdraw 0.01 WETH to your payout" }).head).toBe("Done: Supply the position's 0.01 WETH on Aave (to withdraw it).");
    expect(parkedView({ held: null, done: [], next: "Borrow 5 USDC" }).head).toBe("The next step is ready.");
  });
  const U = (n: number) => BigInt(Math.round(n * 1e6));
  it("from the wallet, the typed repay sends all of it; ALL sends only what the position lacks", () => {
    expect(repayPlan({ src: "wallet", all: false, typedUnits: U(10), allUnits: U(30), idleUnits: U(4) })).toEqual({ needUnits: U(10), sendUnits: U(10), shortUnits: 0n, arg: { exact: U(10).toString() } });
    expect(repayPlan({ src: "wallet", all: true, typedUnits: 0n, allUnits: U(30), idleUnits: U(4) })).toMatchObject({ sendUnits: U(26), arg: "max" });
    expect(repayPlan({ src: "wallet", all: true, typedUnits: 0n, allUnits: U(30), idleUnits: U(31) }).sendUnits).toBe(0n);
  });
  it("from the position nothing is sent; a shortfall is reported", () => {
    expect(repayPlan({ src: "position", all: false, typedUnits: U(10), allUnits: U(30), idleUnits: U(4) })).toMatchObject({ sendUnits: 0n, shortUnits: U(6) });
    expect(repayPlan({ src: "position", all: true, typedUnits: 0n, allUnits: U(30), idleUnits: U(30) })).toMatchObject({ sendUnits: 0n, shortUnits: 0n, arg: "max" });
  });
  it("going on after the wallet's transfer never sends the USDC twice (the repay continues from the position)", () => {
    // MY WALLET + ALL: the transfer lands, the NEAR wallet's window was blocked; the visitor clicks on
    const first = repayPlan({ src: "wallet", all: true, typedUnits: 0n, allUnits: U(30.06), idleUnits: 0n });
    expect(first.sendUnits).toBe(U(30.06));
    const src = defaultRepaySrc({ evmConnected: true, picked: "position", idleUnits: U(30.06) });
    const again = repayPlan({ src, all: true, typedUnits: 0n, allUnits: U(30.06), idleUnits: U(30.06) });
    expect(again).toMatchObject({ sendUnits: 0n, shortUnits: 0n, arg: "max" });
    // the page switches the source once the transfer has landed, and before the next signature
    const page = readFileSync(new URL("../../web/src/own/dashboard.ts", import.meta.url), "utf8");
    const r = page.slice(page.indexOf("const repay = () => {"), page.indexOf("const withdraw = () => {"));
    expect(r.indexOf('repayPicked = "position"')).toBeGreaterThan(r.indexOf("await evmSend("));
    expect(r.indexOf('repayPicked = "position"')).toBeLessThan(r.indexOf("await signAction("));
  });
  it("the NEAR call is held back for a click before the wallet is asked, and a blocked window pauses too", () => {
    const page = readFileSync(new URL("../../web/src/own/dashboard.ts", import.meta.url), "utf8");
    const st = page.slice(page.indexOf("async function stead("), page.indexOf("/** Each contract-signed transaction needs"));
    expect(st.indexOf("nearGate(activation(), Date.now() - clickAt)")).toBeGreaterThan(-1);
    expect(st.indexOf("nearGate(")).toBeLessThan(st.indexOf("await steadCall("));
    expect(st).toContain("if (!panic && windowRefused(m)) throw parkErr(label)");
  });
  it("repay's source: the position when it holds USDC or there is no wallet, else the wallet, unless picked", () => {
    expect(defaultRepaySrc({ evmConnected: false, picked: "wallet", idleUnits: 0n })).toBe("position");
    expect(defaultRepaySrc({ evmConnected: true, picked: null, idleUnits: 0n })).toBe("wallet");
    expect(defaultRepaySrc({ evmConnected: true, picked: null, idleUnits: 1n })).toBe("position");
    expect(defaultRepaySrc({ evmConnected: true, picked: "wallet", idleUnits: 1n })).toBe("wallet");
  });
  it("USDC at the position with debt is offered as the repay: all of the debt when it covers it", () => {
    expect(positionRepayOffer({ repayOn: true, debtBase: B(30), allUnits: U(30.06), idleUnits: U(31) })).toEqual({ all: true, units: U(30.06) });
    expect(positionRepayOffer({ repayOn: true, debtBase: B(30), allUnits: U(30.06), idleUnits: U(10) })).toEqual({ all: false, units: U(10) });
    expect(positionRepayOffer({ repayOn: true, debtBase: 0n, allUnits: 0n, idleUnits: U(10) })).toBeNull();
    expect(positionRepayOffer({ repayOn: false, debtBase: B(30), allUnits: U(30.06), idleUnits: U(10) })).toBeNull();
    expect(positionRepayOffer({ repayOn: true, debtBase: B(30), allUnits: U(30.06), idleUnits: 0n })).toBeNull();
  });
});

describe("withdrawals go only to the payout", () => {
  const PAY = "0x81f5321e62660e4802e306b02447682ef3742c11";
  it("the confirm names the payout and whether it is the connected wallet", () => {
    expect(payoutLine(PAY, "0x81F5321e62660E4802e306b02447682Ef3742C11")).toBe("Sends to your payout 0x81F5…2C11 (your connected wallet)");
    expect(payoutLine(PAY, "0x7a3B1c9E0d2F4a5B6c7D8e9F0a1B2c3D4e5F6a7B")).toBe("Sends to your payout 0x81F5…2C11 (not your connected wallet)");
    expect(payoutLine(PAY, null)).toBe("Sends to your payout 0x81F5…2C11");
  });
  it("a payout change waits out the delay, then is ready to apply", () => {
    const at = 1_000_000n * 1_000_000n; // 1,000,000 ms in ns
    expect(payoutChangeState(null, 0, false)).toEqual({ kind: "none", locked: false });
    expect(payoutChangeState({ to: PAY, effective_at: at.toString() }, 400_000, true)).toEqual({ kind: "waiting", to: PAY, atMs: 1_000_000, leftMs: 600_000, locked: true });
    expect(payoutChangeState({ to: PAY, effective_at: at.toString() }, 1_000_000, false).kind).toBe("ready");
    expect(durationText(86_400_000)).toBe("24 h");
    expect(durationText(83_520_000)).toBe("23 h 12 min");
    expect(durationText(12 * 60_000 + 59_000)).toBe("12 min");
    expect(durationText(30_000)).toBe("under a minute");
  });
  it("the page asks for the change with the contract's own method and only for the shown position", () => {
    const page = readFileSync(new URL("../../web/src/own/dashboard.ts", import.meta.url), "utf8");
    expect(page).toContain('stead("request_payout_change", { position_id: pid(), payout: to }');
    expect(page).toContain('stead("apply_payout_change", { position_id: pid() }');
    // every withdrawal is confirmed in the dialog before it is signed
    expect(page).toContain(`'data-ask="withdraw" aria-haspopup="dialog"'`);
    expect(page).not.toMatch(/data-go=withdraw|data-go=move|data-go=sweep/);
  });
});

describe("WETH out of the position's address: supplied, then withdrawn to the payout", () => {
  const F: PosFacts = { registered: true, evmConnected: false, marketOk: true, paused: false, locked: false, claimOpen: false, escrowHeld: false, refundPending: false, outflows: 0, pendingTx: false, hasColl: false, hasDebt: false, idleDebtUnits: 0n, idleCollUnits: 10n ** 16n, repayFromWallet: false, sweepSupported: true, sweepUnits: 0n };
  const UP = 375_332n * 10n ** 9n;
  const ok = { ...F, idleUnits: 10n ** 16n, overCap: false, gasWei: 3n * UP, upfrontWei: UP, needsApprove: false };
  it("works with no Ethereum wallet and no collateral yet", () => {
    expect(wethOutAvail(ok)).toMatchObject({ on: true, txs: 2 });
  });
  it("is refused while a rescue runs or the contract is paused, like the Aave withdraw", () => {
    expect(wethOutAvail({ ...ok, locked: true }).why).toMatch(/only repays and supplies/);
    expect(wethOutAvail({ ...ok, paused: true }).why).toMatch(/paused/);
    expect(wethOutAvail({ ...ok, pendingTx: true }).why).toBe(commonBlock({ ...F, pendingTx: true }));
  });
  it("needs gas at the position for each transaction (three with Aave's first approval) and points to adding ETH", () => {
    expect(wethOutAvail({ ...ok, gasWei: 2n * UP - 1n }).why).toMatch(/gas for 2 transactions.*add ETH/);
    expect(wethOutAvail({ ...ok, gasWei: 2n * UP, needsApprove: true })).toMatchObject({ on: false, txs: 3 });
    expect(wethOutAvail({ ...ok, gasWei: 3n * UP, needsApprove: true }).on).toBe(true);
  });
  it("is off with nothing there, or when supplying it would pass the size cap", () => {
    expect(wethOutAvail({ ...ok, idleUnits: 0n }).on).toBe(false);
    expect(wethOutAvail({ ...ok, overCap: true }).why).toMatch(/size cap/);
  });
  it("steps: approve once, supply, then withdraw; after the supply landed it only withdraws", () => {
    expect(wethOutNext({ supplied: false, allowanceUnits: 0n, units: 5n })).toBe("approve");
    expect(wethOutNext({ supplied: false, allowanceUnits: 5n, units: 5n })).toBe("supply");
    expect(wethOutNext({ supplied: true, allowanceUnits: 0n, units: 5n })).toBe("withdraw");
  });
  it("withdraws exactly what it supplied, or all of it when that was the only collateral", () => {
    expect(wethOutArg(5n, B(100))).toEqual({ exact: "5" });
    expect(wethOutArg(5n, 0n)).toBe("max");
  });
  it("signs only the contract's supply, approve and withdraw for it (no new signing path)", () => {
    const page = readFileSync(new URL("../../web/src/own/dashboard.ts", import.meta.url), "utf8");
    const w = page.slice(page.indexOf("const wethOut = () => {"), page.indexOf("const delayText = "));
    const types = [...w.matchAll(/type: "([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(types).toEqual(["approve", "supply", "withdraw"]);
  });
});

describe("results and the protections line", () => {
  it("key actions end with a result; approvals, gas, moves and returns don't", () => {
    expect(DONE_KINDS).toEqual(["register", "deposit", "borrow", "repay", "withdraw", "buyback", "payout"]);
    const page = readFileSync(new URL("../../web/src/own/dashboard.ts", import.meta.url), "utf8");
    for (const a of ["sweep", "move", "send", "payoutApply"]) expect(page).toContain(`{ act: "${a}" }`);
  });
  it("each result has its title, line and key figure", () => {
    const d = doneView("repay", { what: "30 USDC", hfText: "no debt", posId: 3 });
    expect(d).toEqual({ title: "Repaid 30 USDC", line: "Aave took 30 USDC from the position.", figure: { label: "HEALTH FACTOR NOW", value: "no debt" } });
    expect(doneView("withdraw", { what: "0.01 WETH", hfText: "2.10", posId: 3, payout: "0x81f5321e62660e4802e306b02447682ef3742c11" }).line).toBe("Aave sent 0.01 WETH to your payout 0x81F5…2C11.");
    expect(doneView("register", { what: "", hfText: "", posId: 4 }).figure).toEqual({ label: "POSITION", value: "4" });
    expect(doneView("payout", { what: "", hfText: "", posId: 4, atText: "Nov 15 · 07:04 UTC" }).figure.value).toBe("Nov 15 · 07:04 UTC");
  });
  it("the Ethereum hash of a contract-signed transaction is the hash of its signed bytes", () => {
    // keccak256 of the empty byte string, with and without 0x
    expect(relayedHash("0x")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(relayedHash("")).toBe(relayedHash("0x"));
  });
  it("the protections figure counts the rescues that ran (had bids) and says how they ended", () => {
    const o = (outcome: "running" | "bought_back" | "settled" | "failed" | "no_bids") => ({ outcome });
    expect(protectionTally([])).toEqual({ count: 0, line: "none yet" });
    // a rescue no steward bid on protected nothing: not counted
    expect(protectionTally([o("no_bids"), o("no_bids")])).toEqual({ count: 0, line: "none yet" });
    expect(protectionTally([o("settled"), o("bought_back"), o("no_bids")])).toEqual({ count: 2, line: "1 bought back · 1 settled" });
    expect(protectionTally([o("bought_back"), o("failed"), o("bought_back"), o("running")])).toEqual({ count: 4, line: "1 running · 2 bought back · 1 failed" });
  });
  it("the last protection sits under the position card with the last action; the address section has no protections line", () => {
    const page = readFileSync(new URL("../../web/src/own/dashboard.ts", import.meta.url), "utf8");
    expect(page).toContain('? `${statusHtml()}<div class="st-dash-recent">${lastProtHtml()}${activityHtml(true)}</div>`');
    const pw = page.slice(page.indexOf("function positionWalletHtml"), page.indexOf("const wethOutState"));
    expect(pw).not.toContain("lastProtection");
    expect(pw).not.toContain("data-prots");
    expect(page).toContain("${protKpi}");
  });
  it("the line under the address shows the newest rescue with bids, else the newest without", () => {
    expect(lastProtection([{ id: 78 }, { id: 60 }], [{ id: 90 }])).toEqual({ id: 78 });
    expect(lastProtection([], [{ id: 90 }, { id: 80 }])).toEqual({ id: 90 });
    expect(lastProtection([], [])).toBeNull();
  });
  it("the protections live in a dialog off the position section, not under the last action", () => {
    const page = readFileSync(new URL("../../web/src/own/dashboard.ts", import.meta.url), "utf8");
    expect(page).not.toContain("protHtml()");
    expect(page).toMatch(/modal\("prot", `POSITION \$\{s\.pos\.id\} · PROTECTIONS`, "Protections", protListHtml/);
  });
});

describe("opening a new position from the positions list", () => {
  it("waits for a position the account did not own before, never an old one", () => {
    const src = readFileSync(new URL("../../web/src/own/dashboard.ts", import.meta.url), "utf8");
    const reg = src.slice(src.indexOf("const register = () =>"), src.indexOf("/** The size cap is checked"));
    expect(reg).toMatch(/const before = new Set<number>\(\[\.\.\.\(owned \?\? \[\]\)\.map/);
    expect(reg).toMatch(/!before\.has\(p\.id\)\) break/);
    expect(reg).not.toMatch(/p\.id !== oldId/);
  });
});
