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

export interface PendingTx {
  tx: { chain_id: number; nonce: number; to: string; data: string };
  kind: unknown;
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

export interface Books {
  escrow: { collateral_units: string; debt_units: string; block: number; collateral_committed: string; debt_committed: string };
  outflows: Outflow[];
  last_event_block: number;
  stray_repays: { steward: string; units: string; evm_tx: string }[];
}
