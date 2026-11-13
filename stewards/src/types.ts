// JSON shapes returned by the Stead contract views (numbers > 2^53 arrive as strings).
export type RescueState = "auction" | "top_up_pending" | "open" | "settling" | "bought_back" | "settled" | "failed";

export interface HealthReport {
  hf_wad: string;
  collateral_base: string;
  debt_base: string;
  collateral_price_base: string;
  debt_price_base: string;
  block: number;
}

export interface Position {
  id: number;
  owner: string;
  market_id: number;
  path: string;
  evm_address: string | null;
  payout: string;
  next_nonce: number;
  pending: PendingTx | null;
  health: (HealthReport & { at_ns: string; source: string }) | null;
  active_auction: number | null;
  open_rescues: number[];
  premium_cap_base: string;
  premium_used_base: string;
}

/** What a borrower can ask the contract to sign (`sign_action`). Amounts are decimal strings.
 *  `sweep_eth` sends `amount` wei of the position's own ETH (left over from gas) to its payout. */
export type AmountArg = { exact: string } | "max";
export type Action =
  | { type: "approve"; token: "collateral" | "debt"; amount: AmountArg }
  | { type: "supply"; amount: string }
  | { type: "borrow"; amount: string }
  | { type: "repay"; amount: AmountArg }
  | { type: "withdraw"; amount: AmountArg }
  | { type: "transfer_debt"; amount: string }
  | { type: "sweep_eth"; amount: string };

/** Why a stored tx was signed. Only `sweep_eth` carries a native value (wei, decimal string). */
export type TxKind =
  | { type: "borrower"; action: string }
  | { type: "nonce_burn" }
  | { type: "settlement"; rescue_id: number; leg: number }
  | { type: "outflow" }
  | { type: "sweep_eth"; value: string };

/** The native value a stored tx carries (0 except a sweep). */
export const txValue = (kind: TxKind | unknown): bigint => {
  const k = kind as { type?: string; value?: string } | null;
  return k?.type === "sweep_eth" && k.value !== undefined ? BigInt(k.value) : 0n;
};

export interface PendingTx {
  tx: { chain_id: number; nonce: number; to: string; data: string };
  kind: TxKind;
  signed_at: string;
  signed_raw: string | null;
  signing: boolean;
  ever_signed: boolean;
  replaced: boolean;
}

export interface Member {
  steward: string;
  premium_bps: number;
  share_units: string;
  share_base: string;
  premium_units: string;
  premium_base: string;
  bond: string;
  confirmed: boolean;
  evm_tx: string | null;
  claim_id: string | null;
}

export interface Leg {
  to: string;
  amount: { exact: string } | "max";
  claim_id: string | null;
  done: boolean;
}

export interface Settlement {
  settler: string;
  early: boolean;
  price_base: string;
  owed_units: string;
  repay_units: string;
  repay_collateral_units: string;
  full_close: boolean;
  repay_confirmed: boolean;
  committed: boolean;
  legs: Leg[];
  started_at: string;
}

export interface Rescue {
  id: number;
  position_id: number;
  seq: number;
  state: RescueState;
  opened_at: string;
  closes_at: string;
  topup_deadline: string;
  topup_units: string;
  topup_base: string;
  collateral_price_base: string;
  cap_bps: number;
  bids: { steward: string; premium_bps: number; amount_units: string; bond: string; seq: number }[];
  members: Member[];
  claims_opened_at: string;
  settlement: Settlement | null;
}

export interface Claim {
  token_id: string;
  rescue_id: number;
  position_id: number;
  owner: string;
  asset: string;
  share_units: string;
  premium_bps: number;
  premium_units: string;
  owed_units: string;
  trigger_price_base: string;
  status: "open" | "bought_back" | "settled";
  /** Buy-back deadline (ns), fixed when the claim opened. */
  expires_at: string;
}

export interface Params {
  trigger_hf_bps: number;
  target_hf_bps: number;
  early_settle_hf_bps: number;
  auction_window_ns: string;
  topup_deadline_ns: string;
  buyback_window_ns: string;
  payout_change_delay_ns: string;
  nonce_burn_after_ns: string;
  max_price_age_ns: string;
  bid_bond: string;
}

export const nowNs = () => BigInt(Date.now()) * 1_000_000n;

export interface Outflow {
  to: string;
  action: { transfer: "collateral" | "debt" } | "withdraw";
  amount: string;
  purpose: "buy_back" | "refund" | "reimburse";
  token_id: string | null;
}

/** `get_watch`: the collateral watch, and on a verified market the settlement start, whose
 *  `need` is the scaled debt drop that confirms the repay. */
export interface Watch {
  last: { cs: string; ds: string; ci: string; di: string; block: number } | null;
  hw: string;
  withdrawn: string;
  settle: { rescue_id: number; start: { cs: string; ds: string; ci: string; di: string; block: number }; need: string } | null;
}

export const RAY = 10n ** 27n;

/** The settlement repay in debt units. With a verified start the contract confirms the repay from
 *  the scaled debt drop (`need`), so the repay covers `need` at the debt index it executes at.
 *  The index read now is already stale when the repay lands a block or more later, and a repay
 *  that burns even a few wei short is not confirmed, so the index gets a margin of
 *  INDEX_MARGIN_BPS (at an 80 % borrow rate that is about an hour of interest), plus 2 wei for
 *  Aave's rounding; never less than `repay_units`. The margin pays down the borrower's debt. */
export const INDEX_MARGIN_BPS = 1n;
export function settlementRepayUnits(repayUnits: bigint, need: bigint | undefined, debtIndexNow: bigint): bigint {
  if (need === undefined || need === 0n) return repayUnits;
  const index = debtIndexNow + (debtIndexNow * INDEX_MARGIN_BPS + 9_999n) / 10_000n;
  const v = (need * index + RAY - 1n) / RAY + 2n;
  return v > repayUnits ? v : repayUnits;
}

export interface Books {
  escrow: { collateral_units: string; debt_units: string; block: number; collateral_committed: string; debt_committed: string };
  outflows: Outflow[];
  last_event_block: number;
  stray_repays: { steward: string; units: string; evm_tx: string }[];
}
