// The mainnet position dashboard's arithmetic and rules, with no DOM, wallet or network (tested
// offline): the health factor each action would leave (from Aave's own account data and oracle
// prices), the amount helpers, the leftover-gas amount, and which actions the contract would sign
// in each state of the position.
//
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
    if (!f.evmConnected) return off("Connect your Ethereum wallet: the WETH comes from it.");
    // the WETH is sent to the position first: during a rescue it would count as a buy-back payment
    if (f.locked) return off("While a rescue runs, WETH sent to the position counts toward the buy-back: deposit after it ends.");
    return on;
  };
  const repay = (): Avail => {
    const c = common();
    if (c) return c;
    if (!f.hasDebt) return off("No debt to repay.");
    if (f.locked && f.escrowHeld) return off(HELD);
    return on;
  };
  const buyback = (): Avail => {
    if (!f.registered) return off("Protect a position first.");
    if (!f.claimOpen) return off("Only while a claim is open.");
    if (!f.evmConnected) return off("Connect your Ethereum wallet: the WETH comes from it.");
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
