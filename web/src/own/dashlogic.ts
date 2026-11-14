// The mainnet position dashboard's arithmetic and rules, with no DOM, wallet or network (tested
// offline): the health factor each action would leave (from Aave's own account data and oracle
// prices), the amount helpers, the leftover-gas amount, and which actions the contract would sign
// in each state of the position; and, for a visitor with no Ethereum wallet connected, the pasted
// payout's checks, what to send to the position's address, and the address as a QR code.

import qrcode from "qrcode-generator";
import { getAddress, isAddress, type Address } from "viem";
import { CODE, STEWARD_ORDER } from "../board/model";
import type { StewardId } from "../../../stewards/src/rescuelog";

// Aave V3 units: getUserAccountData gives collateral, debt and available borrows in the base
// currency (USD, 8 decimals) and the liquidation threshold in bps; the oracle gives prices with 8
// decimals. Health factor = collateral × LT ÷ debt.

export const TRIGGER_BPS = 11_500n; // Stead's trigger: under it, stewards rescue the position
export const LIQUIDATION_BPS = 10_000n; // Aave liquidates under 1.00
/** The amount helpers stop just above the trigger, never at it. */
export const HELPER_HF_BPS = 11_600n;
/** A native ETH transfer to an ordinary wallet costs exactly this much gas. */
export const TRANSFER_GAS = 21_000n;
/** Contract code hashes (`view_account` → code_hash on app.usestead.near) that know the
 *  `sweep_eth` action. Add the new hash here once the contract update is deployed. */
export const SWEEP_CODE_HASHES: string[] = ["HCoEB9cjsybpY22ccH8x1nCykW337x4UGD8qsyPnQnJD"]; // the contract build that knows sweep_eth
/** Whether the keeper sends the position gas when it runs short. It does not (yet): until it does,
 *  the dashboard asks the visitor's Ethereum wallet for a small top-up when one is needed. */
export const KEEPER_TOPS_UP_GAS = false;

export type Account = {
  collBase: bigint; // getUserAccountData[0]
  debtBase: bigint; // [1]
  availBase: bigint; // [2] what Aave still lets it borrow (the loan-to-value limit)
  ltBps: bigint; // [3] 0 while there is no collateral
};
export type Prices = { coll: bigint; debt: bigint }; // oracle, 8 decimals
export type Decimals = { coll: number; debt: number };
export type Op =
  | { kind: "deposit"; units: bigint }
  | { kind: "withdraw"; units: bigint; all?: boolean }
  | { kind: "borrow"; units: bigint }
  | { kind: "repay"; units: bigint; all?: boolean };

/** USD (8 dp) value of token units at an oracle price (8 dp). Rounded down. */
export const toBase = (units: bigint, price: bigint, decimals: number) => (units * price) / 10n ** BigInt(decimals);

/** Aave's health factor in bps; null when there is no debt (nothing to liquidate). */
export function hfBps(collBase: bigint, debtBase: bigint, ltBps: bigint): bigint | null {
  if (debtBase <= 0n) return null;
  return (collBase * ltBps) / debtBase;
}

export type Projection = {
  collBase: bigint;
  debtBase: bigint;
  hfBps: bigint | null; // projected; null = no debt
  /** The action lowers the health factor to under the trigger (a rescue will follow). */
  underTrigger: boolean;
  /** Aave (or the contract) would refuse it: the reason, in plain words. */
  block: string | null;
};

/** What the position looks like after one action, from Aave's current numbers. `fallbackLtBps`
 *  (the market's) is used only before any collateral is supplied, when Aave reports an LT of 0.
 *  `capBase` is the contract's size cap (0 = none). */
export function project(a: Account, p: Prices, d: Decimals, op: Op, fallbackLtBps: bigint, capBase = 0n): Projection {
  const lt = a.ltBps > 0n ? a.ltBps : fallbackLtBps;
  let coll = a.collBase;
  let debt = a.debtBase;
  let block: string | null = null;
  const lowers = op.kind === "borrow" || op.kind === "withdraw";
  if (op.units < 0n) throw new Error("negative amount");
  switch (op.kind) {
    case "deposit": {
      coll += toBase(op.units, p.coll, d.coll);
      if (capBase > 0n && coll > capBase) block = `This takes the collateral over the contract's $${(capBase / 10n ** 8n).toString()} cap: it would refuse the supply.`;
      break;
    }
    case "withdraw": {
      const out = op.all ? coll : toBase(op.units, p.coll, d.coll);
      coll = out >= coll ? 0n : coll - out;
      break;
    }
    case "borrow": {
      const add = (op.units * p.debt + 10n ** BigInt(d.debt) - 1n) / 10n ** BigInt(d.debt); // round up: never flatter the result
      if (add > a.availBase) block = "Aave would refuse this: it is more than the position may borrow against its collateral (the loan-to-value limit).";
      debt += add;
      break;
    }
    case "repay": {
      const sub = op.all ? debt : toBase(op.units, p.debt, d.debt);
      debt = sub >= debt ? 0n : debt - sub;
      break;
    }
  }
  const hf = hfBps(coll, debt, lt);
  if (lowers && hf !== null && hf < LIQUIDATION_BPS) block = "Aave would refuse this: it would be liquidatable.";
  return { collBase: coll, debtBase: debt, hfBps: hf, underTrigger: lowers && hf !== null && hf < TRIGGER_BPS, block };
}

/** The sentence shown before signing when the projection is under the trigger. */
export const UNDER_TRIGGER_WARNING =
  "This takes your loan under 1.15: stewards will rescue it and you'll owe the winning steward's premium (at most the cap, always less than Aave's liquidation penalty).";

// ── amount helpers ──

/** Collateral units the position can still take: what is available (wallet + already at the
 *  position), and no more than the size cap leaves, less 1% because the contract checks the cap
 *  against its last price reading, which may differ a little from the oracle now. */
export function depositMax(walletUnits: bigint, idleUnits: bigint, collBase: bigint, capBase: bigint, price: bigint, decimals: number): bigint {
  const have = walletUnits + idleUnits;
  if (capBase <= 0n || price <= 0n) return have;
  if (collBase >= capBase) return 0n;
  const room = (((capBase - collBase) * 10n ** BigInt(decimals)) / price) * 99n / 100n;
  return have < room ? have : room;
}

/** Debt units that take the health factor down to `hfBps` (just above the trigger), within
 *  Aave's loan-to-value limit. */
export function borrowMax(a: Account, debtPrice: bigint, debtDecimals: number, hfTargetBps = HELPER_HF_BPS): bigint {
  if (a.ltBps <= 0n || debtPrice <= 0n) return 0n;
  const target = (a.collBase * a.ltBps) / hfTargetBps;
  if (target <= a.debtBase) return 0n;
  const roomBase = target - a.debtBase < a.availBase ? target - a.debtBase : a.availBase;
  return (roomBase * 10n ** BigInt(debtDecimals)) / debtPrice;
}

/** Collateral units that can leave: all of it when there is no debt (`all`), else down to
 *  `hfBps` (just above the trigger). */
export function withdrawMax(a: Account, collPrice: bigint, collDecimals: number, hfTargetBps = HELPER_HF_BPS): { units: bigint; all: boolean } {
  if (collPrice <= 0n || a.collBase <= 0n) return { units: 0n, all: false };
  if (a.debtBase <= 0n) return { units: (a.collBase * 10n ** BigInt(collDecimals)) / collPrice, all: true };
  const keep = (a.debtBase * hfTargetBps + a.ltBps - 1n) / a.ltBps; // round up: never below the target
  if (keep >= a.collBase) return { units: 0n, all: false };
  return { units: ((a.collBase - keep) * 10n ** BigInt(collDecimals)) / collPrice, all: false };
}

/** Debt units that repay all of `debtBase` with a 0.2% margin (interest keeps accruing; Aave's
 *  "max" repay takes only what is owed and the rest stays at the position). */
export function repayAllUnits(debtBase: bigint, debtPrice: bigint, debtDecimals: number): bigint {
  if (debtBase <= 0n || debtPrice <= 0n) return 0n;
  return (debtBase * 10n ** BigInt(debtDecimals) * 1002n) / 1000n / debtPrice;
}

// ── gas ──

/** The ETH the position can return: everything but the fee of the transfer itself (21,000 gas at
 *  the max fee it is signed with, which Ethereum wants available up front). Never negative. */
export function sweepAmount(balanceWei: bigint, maxFeePerGas: bigint, gasLimit = TRANSFER_GAS): bigint {
  const fee = gasLimit * maxFeePerGas;
  return balanceWei > fee ? balanceWei - fee : 0n;
}
/** Does the deployed contract know `sweep_eth`? */
export const sweepSupported = (codeHash: string | null, known: string[] = SWEEP_CODE_HASHES) => !!codeHash && known.includes(codeHash);
/** ETH the visitor's wallet sends when the position can't pay its next transaction up front:
 *  enough for two transactions at the caps, less what it holds. 0 when it has enough. */
export function gasTopUp(balanceWei: bigint, upfrontWei: bigint): bigint {
  if (balanceWei >= upfrontWei) return 0n;
  return 2n * upfrontWei - balanceWei;
}

// ── state ──

export type Phase = "none" | "safe" | "under_trigger" | "rescue" | "claim_open" | "settling";
/** The position's phase, from the contract's rescue state and Aave's health factor. */
export function phaseOf(x: { registered: boolean; rescueState: string | null; hfBps: bigint | null }): Phase {
  if (!x.registered) return "none";
  const s = x.rescueState;
  if (s === "auction" || s === "top_up_pending") return "rescue";
  if (s === "open") return "claim_open";
  if (s === "settling") return "settling";
  if (x.hfBps !== null && x.hfBps < TRIGGER_BPS) return "under_trigger";
  return "safe";
}

export type PosFacts = {
  registered: boolean;
  evmConnected: boolean;
  marketOk: boolean;
  paused: boolean;
  /** An auction is open or a rescue is running/open/settling (the contract's `locked`). */
  locked: boolean;
  /** A claim is open (rescue state "open"): the buy-back window. */
  claimOpen: boolean;
  /** The position's own balances are held for a buy-back (proven escrow). */
  escrowHeld: boolean;
  /** No rescue open, but a held balance still waits for its refund. */
  refundPending: boolean;
  outflows: number;
  pendingTx: boolean;
  hasColl: boolean;
  hasDebt: boolean;
  idleDebtUnits: bigint;
  /** WETH sitting at the position's address (sent there, not supplied yet). */
  idleCollUnits: bigint;
  /** The repay is paid from the visitor's wallet (else from the position's own USDC). */
  repayFromWallet: boolean;
  sweepSupported: boolean;
  sweepUnits: bigint;
};
export type ActionId = "deposit" | "borrow" | "repay" | "withdraw" | "buyback" | "sweep" | "move";
export type Avail = { on: boolean; why: string; tryAnyway: boolean };

/** Which actions the contract would sign now, each with the reason when not. Mirrors the
 *  contract's signing rules: while a rescue runs it signs only repay and supply, and not even those
 *  while the position's balance is held for a buy-back. */
export function availability(f: PosFacts): Record<ActionId, Avail> {
  const on: Avail = { on: true, why: "", tryAnyway: false };
  const off = (why: string, tryAnyway = false): Avail => ({ on: false, why, tryAnyway });
  // what stops every request the borrower makes
  const common = (): Avail | null =>
    !f.registered ? off("Protect a position first.")
    : !f.marketOk ? off("The contract's market does not match this page.")
    : f.pendingTx ? off("A transaction is on its way to Ethereum: wait for it to land.")
    : f.outflows > 0 ? off("The contract is paying out queued transfers from this position: wait for them.")
    : f.refundPending ? off("The position's held balance is being refunded to your wallet: wait for the next reading.")
    : null;
  const LOCKED = "While a rescue runs, the contract signs only repays and supplies.";
  const HELD = "The position's balance is held for the buy-back: the contract signs nothing else until the claim ends.";
  const lowering = (kind: "borrow" | "withdraw"): Avail => {
    const c = common();
    if (c) return c;
    if (f.locked) return off(LOCKED, true);
    if (f.paused) return off("The contract is paused: it signs only repays and supplies.");
    if (!f.hasColl) return off(kind === "borrow" ? "Deposit collateral first." : "No collateral to withdraw.");
    return on;
  };
  const deposit = (): Avail => {
    const c = common();
    if (c) return c;
    // the WETH is sent to the position first: during a rescue it would count as a buy-back payment
    if (f.locked) return off("While a rescue runs, WETH sent to the position counts toward the buy-back: deposit after it ends.");
    // without a wallet, only WETH already sent to the position's address can be supplied
    if (!f.evmConnected && f.idleCollUnits <= 0n) return off("Send WETH to the position's address, or connect your Ethereum wallet.");
    return on;
  };
  const repay = (): Avail => {
    const c = common();
    if (c) return c;
    if (!f.hasDebt) return off("No debt to repay.");
    if (f.locked && f.escrowHeld) return off(HELD);
    if (f.repayFromWallet) {
      // during a rescue, tokens sent to the position are held for the buy-back, not repaid
      if (f.locked) return off("While a rescue runs, tokens sent to the position are held for the buy-back: repay from the position's USDC, or after the rescue.");
      if (!f.evmConnected) return off("Send the USDC to the position's address, then repay from the position.");
    }
    return on;
  };
  const buyback = (): Avail => {
    if (!f.registered) return off("Protect a position first.");
    if (!f.claimOpen) return off("Only while a claim is open.");
    if (!f.evmConnected) return off("Send exactly the owed WETH to the position's address, or connect your Ethereum wallet.");
    return on;
  };
  const sweep = (): Avail => {
    const c = common();
    if (c) return c;
    if (!f.sweepSupported) return off("Available after the contract update.");
    if (f.locked || f.escrowHeld) return off("Not while a rescue runs or a balance is held for a buy-back.");
    if (f.paused) return off("The contract is paused.");
    if (f.sweepUnits <= 0n) return off("Nothing to return: the position holds no more than the transfer's own fee.");
    return on;
  };
  const move = (): Avail => {
    const c = common();
    if (c) return c;
    if (f.locked) return off(LOCKED);
    if (f.paused) return off("The contract is paused.");
    if (f.idleDebtUnits <= 0n) return off("The position holds no USDC.");
    return on;
  };
  return { deposit: deposit(), borrow: lowering("borrow"), repay: repay(), withdraw: lowering("withdraw"), buyback: buyback(), sweep: sweep(), move: move() };
}

/** "WETH can fall X% before liquidation" (one collateral, stable debt: HF scales with its price). */
export function fallLine(hf: bigint | null, collSym: string): string {
  if (hf === null) return "no debt: nothing to liquidate";
  if (hf < LIQUIDATION_BPS) return "under 1.00: Aave can liquidate it now";
  const pct = (1 - 10_000 / Number(hf)) * 100;
  return `${collSym} can fall ${pct.toFixed(1)}% before liquidation`;
}

// ── health factor readouts ──

/** At or above this (18 decimals), a health reading means "no debt": Aave reports uint256 max and
 *  the contract's own reading u128 max when nothing is borrowed. No real position gets near it. */
export const NO_DEBT_WAD = 2n ** 100n;
/** Aave's getUserAccountData health factor (18 decimals) → bps; null when there is no debt. */
export function hfFromWad(debtBase: bigint, hfWad: bigint): bigint | null {
  if (debtBase <= 0n || hfWad >= NO_DEBT_WAD) return null;
  return hfWad / 10n ** 14n;
}
/** Over this, the readout says "100+" instead of a long number (a tiny debt against the collateral). */
export const HF_TEXT_MAX_BPS = 1_000_000n;
/** A health factor as text: rounded down (0.996 never reads 1.00), "no debt" without debt, "100+" above 100. */
export function hfText(h: bigint | null): string {
  if (h === null) return "no debt";
  if (h >= HF_TEXT_MAX_BPS) return "100+";
  return (Number(h / 100n) / 100).toFixed(2);
}
/** The health bar's scale: 0.90 at the left edge, 2.10 at the right (1.00 and 1.15 sit near the left). */
export const HF_BAR = { min: 9_000n, max: 21_000n };
/** Where a health factor sits on the bar, 0–100 (no debt fills it). */
export function hfBarPct(h: bigint | null): number {
  if (h === null || h >= HF_BAR.max) return 100;
  if (h <= HF_BAR.min) return 0;
  return Number(((h - HF_BAR.min) * 10_000n) / (HF_BAR.max - HF_BAR.min)) / 100;
}

// ── no Ethereum wallet connected: a pasted payout, funds sent straight to the position ──

export type PayoutCheck = { ok: true; address: Address } | { ok: false; why: string };
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** A pasted payout address: 0x and 40 hex characters; a mixed-case address must match its
 *  checksum (all lower or all upper case carries none); never the zero address or one of the
 *  addresses in `refuse` (the market's contracts, the position itself), which could never pay
 *  anything back. Returns the checksummed address. */
export function checkPayout(input: string, refuse: { address: string; name: string }[] = []): PayoutCheck {
  const v = input.trim();
  if (!v) return { ok: false, why: "Paste an Ethereum address." };
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return { ok: false, why: "Not an Ethereum address: it is 0x followed by 40 characters 0-9 and a-f." };
  const body = v.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && !isAddress(v, { strict: true })) return { ok: false, why: "The checksum does not match: a character is wrong. Copy the address again." };
  const address = getAddress(v);
  if (address === ZERO_ADDRESS) return { ok: false, why: "That is the zero address: nothing sent there can be spent." };
  const hit = refuse.find((r) => r.address.toLowerCase() === address.toLowerCase());
  if (hit) return { ok: false, why: `That is ${hit.name}, not a wallet: payouts sent there would be lost.` };
  return { ok: true, address };
}

/** ETH to ask for when no wallet can top the position's gas up: two transactions' up-front fee
 *  less what it holds (as `gasTopUp`), rounded up to 0.0001 ETH so the sentence reads plainly.
 *  0 when the position can already pay its next transaction. */
export function gasAsk(balanceWei: bigint, upfrontWei: bigint): bigint {
  const top = gasTopUp(balanceWei, upfrontWei);
  const step = 10n ** 14n;
  return top === 0n ? 0n : ((top + step - 1n) / step) * step;
}

/** WETH newly at the position since the last reading (0 on the first reading, or when it fell). */
export function arrived(prevUnits: bigint | null, nowUnits: bigint): bigint {
  return prevUnits !== null && nowUnits > prevUnits ? nowUnits - prevUnits : 0n;
}

/** How a supply of `typed` units goes ahead. WETH already at the position counts first; only the
 *  rest is sent from the visitor's wallet, and without one it has to be sent to the address. */
export type DepositPlan = { kind: "supply" } | { kind: "transfer"; sendUnits: bigint } | { kind: "short"; shortUnits: bigint };
export function depositPlan(typed: bigint, idleUnits: bigint, evmConnected: boolean): DepositPlan {
  if (idleUnits >= typed) return { kind: "supply" };
  return evmConnected ? { kind: "transfer", sendUnits: typed - idleUnits } : { kind: "short", shortUnits: typed - idleUnits };
}

/** The buy-back payment still due: what the open claims are owed less what is already at the position. */
export const buybackDue = (owedUnits: bigint, heldUnits: bigint) => (owedUnits > heldUnits ? owedUnits - heldUnits : 0n);

/** What the funding card asks the visitor to send to the position's address, when no Ethereum
 *  wallet is connected (or an action is waiting for gas):
 *  - "gas": an action is waiting for the position's gas: ETH only;
 *  - "buyback": a claim is open: exactly the WETH still due (WETH arriving now is the buy-back
 *    payment), plus gas for the contract's payouts when the position is short;
 *  - "fund": no rescue: WETH to supply, plus gas when it can't pay one signed transaction;
 *  - "none": a wallet does the funding, or an auction or top-up is running (WETH sent then would
 *    be held for the buy-back, so nothing is asked for). */
export type FundPrompt =
  | { kind: "none" }
  | { kind: "gas"; gasWei: bigint }
  | { kind: "buyback"; wethUnits: bigint; gasWei: bigint }
  | { kind: "fund"; gasWei: bigint };
export function fundPrompt(f: { registered: boolean; evmConnected: boolean; locked: boolean; claimOpen: boolean; ethWei: bigint; upfrontWei: bigint; gasWaitWei: bigint; dueUnits: bigint }): FundPrompt {
  if (!f.registered) return { kind: "none" };
  if (f.gasWaitWei > 0n) return { kind: "gas", gasWei: f.gasWaitWei };
  if (f.evmConnected) return { kind: "none" };
  const gasWei = gasAsk(f.ethWei, f.upfrontWei);
  if (f.claimOpen) return { kind: "buyback", wethUnits: f.dueUnits, gasWei };
  if (f.locked) return { kind: "none" };
  return { kind: "fund", gasWei };
}

// ── the address as a QR code (SVG, no DOM) ──

/** Light modules around the code, as the QR standard asks (4 modules). */
export const QR_QUIET = 4;
/** The code's two colours: the light theme's panel and ink, in both themes (a camera needs dark
 *  modules on a light square; the dark theme's light-on-black would be an inverted code). */
export const QR_LIGHT = "#D8DDD2";
export const QR_DARK = "#1D1F1C";
/** The QR code of `text` as an SVG string: one light square (quiet zone included) and one path of
 *  dark unit squares, error correction level M. */
export function qrSvg(text: string, label: string): string {
  const q = qrcode(0, "M");
  q.addData(text, "Byte");
  q.make();
  const n = q.getModuleCount();
  const size = n + 2 * QR_QUIET;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + QR_QUIET} ${r + QR_QUIET}h1v1h-1z`;
  const esc = label.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${QR_LIGHT}"/><path fill="${QR_DARK}" d="${d}"/></svg>`;
}

// ── the health factor's colour, the risk details, the health bar's zones ──

/** Under this, a claim on the position settles early (the contract's early-settlement level). */
export const EARLY_SETTLE_BPS = 11_000n;
/** At and above this, the health factor reads in plain ink; under it, in the caution tone. */
export const CAUTION_BPS = 15_000n;
/** What a health factor's colour says: "danger" under 1.10 (early settlement, then liquidation),
 *  "exposure" 1.10 to 1.15 (under the trigger: a rescue opens), "caution" 1.15 to 1.50, "safe" at
 *  1.50 and above or with no debt. */
export type HfBand = "danger" | "exposure" | "caution" | "safe";
export function hfBand(h: bigint | null): HfBand {
  if (h === null) return "safe";
  if (h < EARLY_SETTLE_BPS) return "danger";
  if (h < TRIGGER_BPS) return "exposure";
  if (h < CAUTION_BPS) return "caution";
  return "safe";
}
/** The current-HF marker on the bar draws attention now and then only under 1.50. */
export const hfPulses = (h: bigint | null) => h !== null && h < CAUTION_BPS;

export type RiskLineKey = "liquidation" | "early" | "trigger";
/** One line the health factor can fall to, and how far the collateral price can fall before it
 *  gets there, in bps of today's price (rounded down: never overstates the room). With one
 *  collateral and a stable debt the health factor moves with the collateral's price, so the fall
 *  is 1 − line ÷ HF. `reached`: the health factor is already at or under the line. */
export type RiskLine = { key: RiskLineKey; bps: bigint; fallBps: bigint | null; reached: boolean };
export function riskLines(h: bigint | null, early = EARLY_SETTLE_BPS, trigger = TRIGGER_BPS): RiskLine[] {
  const one = (key: RiskLineKey, bps: bigint): RiskLine => {
    if (h === null) return { key, bps, fallBps: null, reached: false };
    if (h <= bps) return { key, bps, fallBps: 0n, reached: true };
    const ratio = (bps * 10_000n + h - 1n) / h; // line ÷ HF, rounded up
    return { key, bps, fallBps: 10_000n - ratio, reached: false };
  };
  return [one("liquidation", LIQUIDATION_BPS), one("early", early), one("trigger", trigger)];
}
/** The collateral's oracle price (8 dp) at which the health factor reaches `lineBps`: price × line
 *  ÷ HF, rounded up (the line is reached no later than this). Null without debt. */
export const linePrice = (price: bigint, lineBps: bigint, h: bigint | null) => (h === null || h <= 0n ? null : (price * lineBps + h - 1n) / h);
/** bps as a percentage with one decimal, rounded down ("12.3%"). */
export const pctText = (bps: bigint) => `${(Number(bps / 10n) / 10).toFixed(1)}%`;

/** The loan-to-value now (debt ÷ collateral, rounded up), beside Aave's maximum and its
 *  liquidation threshold (all bps, from getUserAccountData). Null without collateral. */
export type LtvView = { currentBps: bigint; maxBps: bigint; ltBps: bigint };
export function ltvView(a: Account, maxLtvBps: bigint): LtvView | null {
  if (a.collBase <= 0n) return null;
  return { currentBps: (a.debtBase * 10_000n + a.collBase - 1n) / a.collBase, maxBps: maxLtvBps, ltBps: a.ltBps };
}

/** The most a rescue can cost this position in total (base units, 8 dp), as the contract sets it
 *  when the first rescue opens: half the debt (Aave's close factor) × the liquidation bonus. Every
 *  premium on the position counts against it, so a stack of rescues shares one cap. */
export const premiumCapBase = (debtBase: bigint, liqBonusBps: bigint) => (debtBase * liqBonusBps) / 10_000n / 2n;

/** The health bar's coloured zones, left to right on the bar's scale (percent): under 1.00
 *  liquidation, 1.00 to 1.10 early settlement, 1.10 to 1.15 under the trigger, 1.15 to 1.50
 *  caution, over 1.50 safe. Flat colours, no gradient. */
export type BarZone = { band: "trip" | "settle" | "exposure" | "caution" | "safe"; left: number; width: number };
export function barZones(): BarZone[] {
  const edges = [HF_BAR.min, LIQUIDATION_BPS, EARLY_SETTLE_BPS, TRIGGER_BPS, CAUTION_BPS, HF_BAR.max];
  const bands: BarZone["band"][] = ["trip", "settle", "exposure", "caution", "safe"];
  return bands.map((band, i) => {
    const left = hfBarPct(edges[i]);
    return { band, left, width: hfBarPct(edges[i + 1]) - left };
  });
}
/** The marks on the bar: liquidation, early settlement, and the rescue trigger (where stewards act). */
export const BAR_MARKS: { bps: bigint; label: string; rescue: boolean }[] = [
  { bps: LIQUIDATION_BPS, label: "1.00", rescue: false },
  { bps: EARLY_SETTLE_BPS, label: "1.10", rescue: false },
  { bps: TRIGGER_BPS, label: "1.15", rescue: true },
];

// ── the live bid ladder, fed from the contract's own rescue record ──

export type LadderBid = { steward: string; premium_bps: number; amount_units: string; seq: number };
/** What the page has seen of each steward's bid: bids carry no time on chain, so each is stamped
 *  when the page first sees it, and a rebid (a new `seq`) keeps the premium it replaced. */
export type SeenBid = { seq: number; bps: number; prevBps: number | null; seenMs: number };
export type LadderRow = {
  steward: string;
  name: string;
  /** One of the known stewards (its colour and tile), or null for any other account. */
  id: StewardId | null;
  code: string;
  bps: number;
  prevBps: number | null;
  amountUnits: bigint;
  rank: number;
  seenMs: number;
  /** A new bid or a rebid since the last reading (never on the page's first reading). */
  fresh: boolean;
  /** A fresh bid in the auction's last 10 seconds. */
  late: boolean;
  won: boolean;
};
export const LATE_MS = 10_000;
export function stewardIdOf(account: string): StewardId | null {
  const n = account.split(".")[0] as StewardId;
  return STEWARD_ORDER.includes(n) ? n : null;
}
/** One reading of the rescue → the ladder: each steward's bid, lowest premium first and, at equal
 *  premiums, the earlier bid first (the order the contract awards them in), with when each was
 *  first seen and what changed. `prev` is null on the page's first reading of this rescue. */
export function ladderStep(
  prev: Map<string, SeenBid> | null,
  r: { state: string; bids: LadderBid[]; members: { steward: string }[] },
  nowMs: number,
  closesAtMs: number,
): { seen: Map<string, SeenBid>; rows: LadderRow[] } {
  const seen = new Map<string, SeenBid>();
  const fresh = new Set<string>();
  for (const b of r.bids) {
    const was = prev?.get(b.steward);
    if (!was) {
      seen.set(b.steward, { seq: b.seq, bps: b.premium_bps, prevBps: null, seenMs: nowMs });
      if (prev) fresh.add(b.steward);
    } else if (was.seq !== b.seq) {
      seen.set(b.steward, { seq: b.seq, bps: b.premium_bps, prevBps: was.bps !== b.premium_bps ? was.bps : was.prevBps, seenMs: was.seenMs });
      fresh.add(b.steward);
    } else seen.set(b.steward, was);
  }
  const won = new Set(r.state === "auction" ? [] : r.members.map((m) => m.steward));
  const late = r.state === "auction" && closesAtMs - nowMs <= LATE_MS;
  const rows = [...r.bids]
    .sort((a, b) => a.premium_bps - b.premium_bps || a.seq - b.seq)
    .map((b, rank): LadderRow => {
      const id = stewardIdOf(b.steward);
      const name = b.steward.split(".")[0];
      const f = fresh.has(b.steward);
      return { steward: b.steward, name, id, code: id ? CODE[id] : name.slice(0, 2).toUpperCase(), bps: b.premium_bps, prevBps: seen.get(b.steward)!.prevBps, amountUnits: BigInt(b.amount_units), rank, seenMs: seen.get(b.steward)!.seenMs, fresh: f, late: f && late, won: won.has(b.steward) };
    });
  return { seen, rows };
}
/** A bid's bar on the ladder: its premium as a share of the auction's cap (0–100). */
export const bidBarPct = (bps: number, capBps: number) => (capBps > 0 ? Math.min(100, (bps / capBps) * 100) : 0);
/** What a bid's premium costs the borrower (base units, 8 dp): the premium in the supplied asset's
 *  units (rounded down, as the contract fixes it) at the oracle price. */
export function premiumCostBase(amountUnits: bigint, bps: number, price: bigint, decimals: number): bigint {
  return toBase((amountUnits * BigInt(bps)) / 10_000n, price, decimals);
}
