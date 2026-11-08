//! The Stead state machine. Every public method takes the caller and the block time
//! explicitly and either changes state and returns what the wrapper must do next
//! (sign a tx, send NEAR), or refuses with a message and changes nothing.

use crate::evm::{self, Action, AmountArg, EvmAddr, GasArgs, TokenSide, TxFields};
use crate::math::{self, BPS};
use crate::{ensure, R};
use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

pub const SEC: u64 = 1_000_000_000;
/// Hard limits on the owner's settings, written into the code: the owner can tune within them,
/// never beyond (a stolen owner key can't, say, make the buy-back window one second).
pub const BUYBACK_WINDOW_RANGE_NS: (u64, u64) = (180 * SEC, 7 * 24 * 3600 * SEC);
pub const AUCTION_WINDOW_RANGE_NS: (u64, u64) = (15 * SEC, 600 * SEC);
pub const TOPUP_DEADLINE_RANGE_NS: (u64, u64) = (60 * SEC, 3600 * SEC);
/// The most a position's collateral may be worth when a size cap is set (USD, 8 dp): $1,000.
pub const MAX_COLLATERAL_CEILING_BASE: u128 = 1_000 * 100_000_000;
/// Plain ETH transfer gas; the floor for a nonce-burn.
pub const TRANSFER_GAS: u128 = 21_000;
/// If the settler hasn't supplied the deleverage repayment within this time, anyone may
/// switch the settlement to the fallback (withdraw the owed units only). A constant, not a
/// `Params` field, so the storage layout stays unchanged.
pub const SETTLE_FALLBACK_NS: u64 = 15 * 60 * SEC;
/// After this long without the repayment, any registered steward may take the repay step over.
pub const TAKEOVER_AFTER_NS: u64 = 3 * 60 * SEC;
/// On a verified market a missed top-up is decided by the first verified reading from after the
/// deadline (the top-up may have landed but not been proven yet). Only if no such reading arrives
/// within this long may anyone expire it directly (a proof outage can't lock the position).
pub const VERIFIED_EXPIRY_GRACE_NS: u64 = 15 * 60 * SEC;
/// The taker's fee, as a share of the R leg it takes on (covers oracle lag in a fall). Paid
/// from the stalled settler's own leg, capped at that claim's premium: never from the borrower.
pub const TAKEOVER_FEE_BPS: u128 = 100;
/// Paid once by `register_steward`, kept as the storage it uses. Measured worst case (a 64-byte
/// account id in the steward set and a payout entry) is about 156 bytes = 0.00156 NEAR; this is
/// about 3x that (a test pins the margin).
pub const STEWARD_DEPOSIT: u128 = 5_000_000_000_000_000_000_000; // 0.005 NEAR
/// Aave's index unit (ray).
pub const RAY: u128 = 1_000_000_000_000_000_000_000_000_000;
/// The allowance for a Stead-signed `withdraw(max)` leg: the whole remaining collateral.
const ALL: u128 = u128::MAX / 4;

// ───────────────────────────── config ─────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Params {
    pub trigger_hf_bps: u32,
    pub target_hf_bps: u32,
    /// A claim may be settled early when the latest HF is below this.
    pub early_settle_hf_bps: u32,
    #[serde(with = "crate::as_str")]
    pub auction_window_ns: u64,
    #[serde(with = "crate::as_str")]
    pub topup_deadline_ns: u64,
    #[serde(with = "crate::as_str")]
    pub buyback_window_ns: u64,
    /// A payout-address change takes effect this long after it's requested.
    #[serde(with = "crate::as_str")]
    pub payout_change_delay_ns: u64,
    /// A signed tx left unconfirmed this long may be replaced by a nonce-burn.
    #[serde(with = "crate::as_str")]
    pub nonce_burn_after_ns: u64,
    /// Settlement needs a reading at most this old.
    #[serde(with = "crate::as_str")]
    pub max_price_age_ns: u64,
    /// Bid bond in yoctoNEAR.
    #[serde(with = "crate::as_str")]
    pub bid_bond: u128,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            trigger_hf_bps: 11_500,
            target_hf_bps: 15_000,
            early_settle_hf_bps: 11_000,
            auction_window_ns: 45 * SEC,
            topup_deadline_ns: 120 * SEC,
            buyback_window_ns: 24 * 3600 * SEC,
            payout_change_delay_ns: 24 * 3600 * SEC,
            nonce_burn_after_ns: 600 * SEC,
            max_price_age_ns: 120 * SEC,
            bid_bond: 100_000_000_000_000_000_000_000, // 0.1 NEAR
        }
    }
}

impl Params {
    fn validate(&self) -> R<()> {
        ensure!(self.early_settle_hf_bps > BPS as u32, "early_settle_hf must be > 1.0");
        ensure!(self.early_settle_hf_bps < self.trigger_hf_bps, "early_settle_hf must be < trigger_hf");
        ensure!(self.trigger_hf_bps < self.target_hf_bps, "trigger_hf must be < target_hf");
        in_range(self.auction_window_ns, AUCTION_WINDOW_RANGE_NS, "auction_window")?;
        in_range(self.topup_deadline_ns, TOPUP_DEADLINE_RANGE_NS, "topup_deadline")?;
        in_range(self.buyback_window_ns, BUYBACK_WINDOW_RANGE_NS, "buyback_window")?;
        ensure!(self.max_price_age_ns > 0, "max_price_age must be > 0");
        Ok(())
    }
}

fn in_range(v: u64, (lo, hi): (u64, u64), name: &str) -> R<()> {
    ensure!(v >= lo && v <= hi, "{name} out of range [{} s, {} s]", lo / SEC, hi / SEC);
    Ok(())
}

/// Owner-set limits for a deployment that holds real funds. Defaults (0, empty) = no limit.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Limits {
    /// No auction opens, and no borrower `supply` is signed, that would take the position's
    /// collateral above this (USD, 8 dp). 0 = no cap. At most `MAX_COLLATERAL_CEILING_BASE`.
    #[serde(with = "crate::as_str")]
    pub max_collateral_base: u128,
    /// Non-empty: only these accounts may register a position. Removing one later doesn't touch
    /// positions it already has.
    pub borrowers: BTreeSet<String>,
}

/// One Aave market pair (collateral, debt) on one chain. Values read from the reserve config.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Market {
    pub chain_id: u64,
    pub pool: EvmAddr,
    pub collateral: EvmAddr,
    pub debt: EvmAddr,
    pub collateral_decimals: u8,
    pub debt_decimals: u8,
    pub lt_bps: u32,
    /// Bonus above 100 %, e.g. 1000 for Aave's 11000.
    pub liq_bonus_bps: u32,
    #[serde(with = "crate::as_str")]
    pub gas_limit_cap: u128,
    #[serde(with = "crate::as_str")]
    pub max_fee_cap: u128,
}

impl Market {
    fn validate(&self, p: &Params) -> R<()> {
        ensure!(self.lt_bps > 0 && (self.lt_bps as u128) < BPS, "lt_bps out of range");
        ensure!(self.lt_bps < p.target_hf_bps, "lt must be < target_hf");
        ensure!(self.liq_bonus_bps <= 5_000, "liq_bonus_bps out of range");
        ensure!(self.gas_limit_cap >= TRANSFER_GAS && self.max_fee_cap > 0, "gas caps too low");
        ensure!(self.collateral != self.debt, "collateral == debt");
        Ok(())
    }
    /// The most ETH one signed tx can cost the position address.
    pub fn max_tx_cost_wei(&self) -> u128 {
        self.gas_limit_cap * self.max_fee_cap
    }
}

// ───────────────────────────── records ─────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct HealthReport {
    #[serde(with = "crate::as_str")]
    pub hf_wad: u128,
    #[serde(with = "crate::as_str")]
    pub collateral_base: u128,
    #[serde(with = "crate::as_str")]
    pub debt_base: u128,
    #[serde(with = "crate::as_str")]
    pub collateral_price_base: u128,
    #[serde(with = "crate::as_str")]
    pub debt_price_base: u128,
    pub block: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Health {
    #[serde(flatten)]
    pub r: HealthReport,
    #[serde(with = "crate::as_str")]
    pub at_ns: u64,
    /// TEMPORARY trusted reporter: who reported it. Verified OutLayer reads replace this with an OutLayer proof.
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TxKind {
    Borrower { action: String },
    NonceBurn,
    Settlement { rescue_id: u64, leg: u32 },
    /// A queued payout from the position (buy-back escrow, refund, reimbursement). Appended last
    /// so stored values of the other variants keep their borsh index.
    Outflow,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct PendingTx {
    pub tx: TxFields,
    pub kind: TxKind,
    #[serde(with = "crate::as_str")]
    pub signed_at: u64,
    /// The full signed raw tx, public so anyone can broadcast it.
    #[serde(with = "opt_hex")]
    pub signed_raw: Option<Vec<u8>>,
    /// An MPC request is outstanding.
    pub signing: bool,
    /// At least one signature for this nonce exists.
    pub ever_signed: bool,
    /// One fee-bump replacement per tx.
    pub replaced: bool,
}

mod opt_hex {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(b) => s.serialize_str(&format!("0x{}", hex::encode(b))),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        Option::<String>::deserialize(d)?
            .map(|s| hex::decode(s.trim_start_matches("0x")).map_err(serde::de::Error::custom))
            .transpose()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct PayoutChange {
    pub to: EvmAddr,
    #[serde(with = "crate::as_str")]
    pub effective_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Position {
    pub id: u64,
    pub owner: String,
    pub market_id: u32,
    pub path: String,
    /// Derived on-chain from the MPC key at registration; None until the callback lands.
    pub evm_address: Option<EvmAddr>,
    pub payout: EvmAddr,
    pub payout_change: Option<PayoutChange>,
    pub next_nonce: u64,
    pub pending: Option<PendingTx>,
    pub health: Option<Health>,
    /// Auction or TopUpPending rescue, at most one.
    pub active_auction: Option<u64>,
    /// Open or Settling rescues, oldest first.
    pub open_rescues: Vec<u64>,
    /// Cumulative cap set when the first of the current stack triggered.
    #[serde(with = "crate::as_str")]
    pub premium_cap_base: u128,
    #[serde(with = "crate::as_str")]
    pub premium_used_base: u128,
}

impl Position {
    /// Rule 3's "claim open": from auction open until the last rescue is bought back or settled.
    pub fn locked(&self) -> bool {
        self.active_auction.is_some() || !self.open_rescues.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "snake_case")]
pub enum RescueState {
    Auction,
    TopUpPending,
    Open,
    Settling,
    BoughtBack,
    Settled,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Bid {
    pub steward: String,
    pub premium_bps: u32,
    #[serde(with = "crate::as_str")]
    pub amount_units: u128,
    #[serde(with = "crate::as_str")]
    pub bond: u128,
    pub seq: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Member {
    pub steward: String,
    pub premium_bps: u32,
    #[serde(with = "crate::as_str")]
    pub share_units: u128,
    #[serde(with = "crate::as_str")]
    pub share_base: u128,
    /// The premium is fixed in units of the supplied asset.
    #[serde(with = "crate::as_str")]
    pub premium_units: u128,
    /// The premium valued at this rescue's trigger price (what the cumulative cap counts).
    #[serde(with = "crate::as_str")]
    pub premium_base: u128,
    #[serde(with = "crate::as_str")]
    pub bond: u128,
    pub confirmed: bool,
    pub evm_tx: Option<String>,
    pub claim_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Leg {
    pub to: EvmAddr,
    pub amount: AmountArg,
    pub claim_id: Option<String>,
    pub done: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Settlement {
    pub settler: String,
    pub early: bool,
    #[serde(with = "crate::as_str")]
    pub price_base: u128,
    #[serde(with = "crate::as_str")]
    pub collateral_base: u128,
    #[serde(with = "crate::as_str")]
    pub debt_base: u128,
    /// Σ owed units of the open claims, and their value at the settlement price.
    #[serde(with = "crate::as_str")]
    pub owed_units: u128,
    #[serde(with = "crate::as_str")]
    pub owed_base: u128,
    #[serde(with = "crate::as_str")]
    pub repay_base: u128,
    /// What the settler must repay, in debt-token units (0 → no repay step).
    #[serde(with = "crate::as_str")]
    pub repay_units: u128,
    /// Collateral the settler gets back for R, at the settlement price (rounded down).
    #[serde(with = "crate::as_str")]
    pub repay_collateral_units: u128,
    pub full_close: bool,
    pub repay_confirmed: bool,
    /// Set when the settlement starts: from then on buy-back is refused (and a committed buy-back refuses settlement).
    pub committed: bool,
    pub legs: Vec<Leg>,
    #[serde(with = "crate::as_str")]
    pub started_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Rescue {
    pub id: u64,
    pub position_id: u64,
    pub seq: u32,
    pub state: RescueState,
    #[serde(with = "crate::as_str")]
    pub opened_at: u64,
    #[serde(with = "crate::as_str")]
    pub closes_at: u64,
    #[serde(with = "crate::as_str")]
    pub topup_deadline: u64,
    #[serde(with = "crate::as_str")]
    pub topup_units: u128,
    #[serde(with = "crate::as_str")]
    pub topup_base: u128,
    #[serde(with = "crate::as_str")]
    pub collateral_price_base: u128,
    #[serde(with = "crate::as_str")]
    pub debt_price_base: u128,
    /// Highest premium a bid may carry (cumulative cap remaining / T).
    pub cap_bps: u32,
    pub bids: Vec<Bid>,
    pub members: Vec<Member>,
    #[serde(with = "crate::as_str")]
    pub claims_opened_at: u64,
    pub settlement: Option<Settlement>,
    pub next_bid_seq: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStatus {
    Open,
    BoughtBack,
    Settled,
}

/// A claim NFT (NEP-171 token). Burned = status no longer Open.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
/// What's owed is fixed in units of the asset the steward supplied, never in USD:
/// `owed_units = share_units + premium_units`. Buy-back and settlement pay that asset, or its
/// value at the current price. The `_base` fields are values at the trigger price, for the cap.
pub struct Claim {
    pub token_id: String,
    pub rescue_id: u64,
    pub position_id: u64,
    pub owner: String,
    /// The asset the steward supplied (the market's collateral in the LINK/DAI demo).
    pub asset: EvmAddr,
    #[serde(with = "crate::as_str")]
    pub share_units: u128,
    pub premium_bps: u32,
    #[serde(with = "crate::as_str")]
    pub premium_units: u128,
    #[serde(with = "crate::as_str")]
    pub owed_units: u128,
    #[serde(with = "crate::as_str")]
    pub trigger_price_base: u128,
    #[serde(with = "crate::as_str")]
    pub share_base: u128,
    #[serde(with = "crate::as_str")]
    pub premium_base: u128,
    #[serde(with = "crate::as_str")]
    pub opened_at: u64,
    #[serde(with = "crate::as_str")]
    pub expires_at: u64,
    pub status: ClaimStatus,
    pub evm_topup_tx: Option<String>,
    pub paid_by_tx: Option<String>,
}

/// What the wrapper must ask the MPC signer for.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SignPlan {
    pub position_id: u64,
    pub path: String,
    pub tx: TxFields,
}

/// A NEAR transfer the wrapper must make (bond refunds and slashes).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Transfer {
    pub to: String,
    #[serde(with = "crate::as_str")]
    pub amount: u128,
}

/// Buy-back escrow: the position address's own (not supplied) balances of the claim asset and
/// the debt asset, as last proven, while a claim is open. Payments are made to the position, held
/// here, and paid on from here, so a payment can never be stranded with a steward.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Escrow {
    #[serde(with = "crate::as_str")]
    pub collateral_units: u128,
    #[serde(with = "crate::as_str")]
    pub debt_units: u128,
    /// EVM block of the balance proof.
    pub block: u64,
    /// Already promised to queued outflows (not yet sent).
    #[serde(with = "crate::as_str")]
    pub collateral_committed: u128,
    #[serde(with = "crate::as_str")]
    pub debt_committed: u128,
}

impl Escrow {
    pub fn free(&self, side: TokenSide) -> u128 {
        match side {
            TokenSide::Collateral => self.collateral_units.saturating_sub(self.collateral_committed),
            TokenSide::Debt => self.debt_units.saturating_sub(self.debt_committed),
        }
    }
    fn commit(&mut self, side: TokenSide, amount: u128) {
        match side {
            TokenSide::Collateral => self.collateral_committed += amount,
            TokenSide::Debt => self.debt_committed += amount,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutAction {
    /// `token.transfer(to, amount)` from the position's own balance (escrow).
    Transfer(TokenSide),
    /// `Pool.withdraw(collateral, amount, to)`: reimbursement at par from collateral.
    Withdraw,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutPurpose {
    /// The exact owed amount to the claim owner's payout, after the buy-back committed.
    BuyBack,
    /// Escrow left over (under- or overpayment) back to the borrower's payout.
    Refund,
    /// A steward's uncommitted repay, at par, to its payout.
    Reimburse,
}

/// A payout the contract itself queued. Recipients are only ever registered payouts: the claim
/// owner's (buy-back), the repaying steward's (reimbursement) or the borrower's (refund).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Outflow {
    pub to: EvmAddr,
    pub action: OutAction,
    #[serde(with = "crate::as_str")]
    pub amount: u128,
    pub purpose: OutPurpose,
    pub token_id: Option<String>,
}

/// Per-position books for buy-backs and payouts (one map, so the wasm carries one copy of the
/// collection code).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Books {
    pub escrow: Escrow,
    /// Queued payouts, paid in order by `pay_next`.
    pub outflows: Vec<Outflow>,
    /// EVM block of the last confirmed event (top-up, repay, payment, signed tx). Every decision
    /// needs a reading at least this new.
    pub last_event_block: u64,
    /// Uncommitted steward repays awaiting reimbursement.
    pub stray_repays: Vec<StrayRepay>,
}

/// Verified reads (OutLayer TEE running the pinned proof program). Set by the owner.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct VerifyConfig {
    /// The OutLayer contract (e.g. `outlayer.testnet`).
    pub outlayer: String,
    /// The proof program, pinned by URL and sha256.
    pub wasm_url: String,
    pub wasm_hash: String,
    /// Markets whose readings and top-up/escrow evidence come only from verified proofs.
    pub markets: BTreeSet<u32>,
    /// Optional OutLayer secret (the keyed RPC) as (owner account, profile).
    pub secrets: Option<(String, String)>,
}

/// Per position: the last verified block, and the collateral snapshot taken when a verified
/// auction opened (to prove the top-up landed).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct VerifiedState {
    pub last_block: u64,
    /// (rescue id, collateral units at auction open)
    pub snapshot: Option<(u64, u128)>,
}

/// The proof program's result (subset the contract uses). Amounts are decimal strings.
#[derive(Clone, Debug, Deserialize)]
pub struct VerifiedOutput {
    pub v: u8,
    pub pos: String,
    pub chain: u64,
    pub block: u64,
    /// The block's timestamp (seconds). 0 if absent: such a proof never expires a top-up.
    #[serde(default)]
    pub ts: u64,
    pub hf: String,
    pub cb: String,
    pub db: String,
    pub res: Vec<VerifiedReserve>,
    pub bal: Vec<(String, String)>,
    pub agree: usize,
}

#[derive(Clone, Debug, Deserialize)]
pub struct VerifiedReserve {
    pub a: String,
    pub p: String,
    /// Scaled aToken balance and scaled variable debt (exact, no interest rounding).
    #[serde(default)]
    pub cs: Option<String>,
    #[serde(default)]
    pub ds: Option<String>,
    /// Liquidity and variable-debt indexes (ray), from the program version that outputs them.
    #[serde(default)]
    pub ci: Option<String>,
    #[serde(default)]
    pub di: Option<String>,
}

/// Exact Aave values from a verified proof: the collateral reserve's scaled aToken balance and
/// liquidity index, the debt reserve's scaled variable debt and debt index (indexes are 0 when
/// the pinned program doesn't output them).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Scaled {
    #[serde(with = "crate::as_str")]
    pub cs: u128,
    #[serde(with = "crate::as_str")]
    pub ds: u128,
    #[serde(with = "crate::as_str")]
    pub ci: u128,
    #[serde(with = "crate::as_str")]
    pub di: u128,
    pub block: u64,
}

/// A verified settlement's start: the repay is confirmed once the position's scaled variable
/// debt is at least `need` below `start.ds` at a later block.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct SettleStart {
    pub rescue_id: u64,
    pub start: Scaled,
    #[serde(with = "crate::as_str")]
    pub need: u128,
}

/// Per position while claims are open: the collateral watch (liquidation evidence) and the
/// verified settlement start.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Watch {
    /// The last verified exact reading.
    pub last: Option<Scaled>,
    /// The highest collateral seen while claims are open, counting the Stead-signed withdraws
    /// confirmed since as still there (scaled units on a verified market, token units
    /// otherwise). 0: not tracking.
    #[serde(with = "crate::as_str")]
    pub hw: u128,
    /// Stead-signed collateral withdraws confirmed since tracking started, in the same unit.
    #[serde(with = "crate::as_str")]
    pub withdrawn: u128,
    pub settle: Option<SettleStart>,
}

/// A repay a steward made on the position without having committed a settlement.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct StrayRepay {
    pub steward: String,
    #[serde(with = "crate::as_str")]
    pub units: u128,
    pub evm_tx: String,
}

// ───────────────────────────── the contract core ─────────────────────────────

#[derive(BorshSerialize, BorshDeserialize)]
pub struct Stead {
    pub owner: String,
    pub reporters: BTreeSet<String>,
    pub stewards: BTreeSet<String>,
    pub paused: bool,
    pub params: Params,
    pub markets: BTreeMap<u32, Market>,
    pub positions: BTreeMap<u64, Position>,
    pub rescues: BTreeMap<u64, Rescue>,
    pub claims: BTreeMap<String, Claim>,
    /// EVM address each NEAR account (steward or claim buyer) is paid at in settlement.
    pub evm_payouts: BTreeMap<String, EvmAddr>,
    /// Idempotency keys for reporter confirms.
    pub used_keys: BTreeSet<String>,
    pub next_market_id: u32,
    pub next_position_id: u64,
    pub next_rescue_id: u64,
    /// Bonds currently held (conservation check).
    pub bonds_held: u128,
    /// Buy-back escrow, payout queue, last event block and stray repays, per position.
    pub books: BTreeMap<u64, Books>,
    pub verify_cfg: Option<VerifyConfig>,
    pub verified: BTreeMap<u64, VerifiedState>,
    /// Stewards the owner removed: they can't bid or re-register. Their open claims, bonds and
    /// payouts are untouched.
    pub removed_stewards: BTreeSet<String>,
    /// Collateral watch and verified settlement start, per position.
    pub watch: BTreeMap<u64, Watch>,
    /// Size cap and borrower allow-list (owner-set, bounded).
    pub limits: Limits,
    /// NEP-297 events produced by the last call; the wrapper drains and logs them.
    #[borsh(skip)]
    pub events: Vec<String>,
    /// NEAR transfers produced by a call whose return type has no room for them (liquidation refunds
    /// from `report_health`); the wrapper drains and pays them. Not stored.
    #[borsh(skip)]
    pub payouts: Vec<Transfer>,
}

/// The stored layout before the owner-set limits (for `migrate`). Field order must match it.
#[derive(BorshSerialize, BorshDeserialize)]
pub struct SteadV5 {
    pub owner: String,
    pub reporters: BTreeSet<String>,
    pub stewards: BTreeSet<String>,
    pub paused: bool,
    pub params: Params,
    pub markets: BTreeMap<u32, Market>,
    pub positions: BTreeMap<u64, Position>,
    pub rescues: BTreeMap<u64, Rescue>,
    pub claims: BTreeMap<String, Claim>,
    pub evm_payouts: BTreeMap<String, EvmAddr>,
    pub used_keys: BTreeSet<String>,
    pub next_market_id: u32,
    pub next_position_id: u64,
    pub next_rescue_id: u64,
    pub bonds_held: u128,
    pub books: BTreeMap<u64, Books>,
    pub verify_cfg: Option<VerifyConfig>,
    pub verified: BTreeMap<u64, VerifiedState>,
    pub removed_stewards: BTreeSet<String>,
    pub watch: BTreeMap<u64, Watch>,
}

impl From<SteadV5> for Stead {
    fn from(o: SteadV5) -> Self {
        Stead {
            owner: o.owner,
            reporters: o.reporters,
            stewards: o.stewards,
            paused: o.paused,
            params: o.params,
            markets: o.markets,
            positions: o.positions,
            rescues: o.rescues,
            claims: o.claims,
            evm_payouts: o.evm_payouts,
            used_keys: o.used_keys,
            next_market_id: o.next_market_id,
            next_position_id: o.next_position_id,
            next_rescue_id: o.next_rescue_id,
            bonds_held: o.bonds_held,
            books: o.books,
            verify_cfg: o.verify_cfg,
            verified: o.verified,
            removed_stewards: o.removed_stewards,
            watch: o.watch,
            limits: Limits::default(),
            events: vec![],
            payouts: vec![],
        }
    }
}

impl Stead {
    pub fn new(owner: &str, reporter: &str) -> Self {
        Self {
            owner: owner.into(),
            reporters: [reporter.to_string()].into(),
            stewards: BTreeSet::new(),
            paused: false,
            params: Params::default(),
            markets: BTreeMap::new(),
            positions: BTreeMap::new(),
            rescues: BTreeMap::new(),
            claims: BTreeMap::new(),
            evm_payouts: BTreeMap::new(),
            used_keys: BTreeSet::new(),
            next_market_id: 0,
            next_position_id: 0,
            next_rescue_id: 0,
            bonds_held: 0,
            books: BTreeMap::new(),
            verify_cfg: None,
            verified: BTreeMap::new(),
            removed_stewards: BTreeSet::new(),
            watch: BTreeMap::new(),
            limits: Limits::default(),
            events: vec![],
            payouts: vec![],
        }
    }

    /// Init only: a contract deployed for a demo sets a shorter buy-back window here.
    pub fn init_buyback_window(&mut self, window_ns: u64) -> R<()> {
        in_range(window_ns, BUYBACK_WINDOW_RANGE_NS, "buyback_window")?;
        self.params.buyback_window_ns = window_ns;
        self.emit("buyback_window_set", json!({"buyback_window_s": window_ns / SEC, "demo_setting": window_ns < 24 * 3600 * SEC}));
        Ok(())
    }

    fn emit(&mut self, event: &str, data: serde_json::Value) {
        // NFT lifecycle events use the NEP-171 standard so wallets and indexers see them
        let (standard, version) = if event.starts_with("nft_") { ("nep171", "1.2.0") } else { ("stead", "1.0.0") };
        self.events.push(
            json!({"standard": standard, "version": version, "event": event, "data": [data]}).to_string(),
        );
    }

    // ── access ──
    fn only_owner(&self, c: &str) -> R<()> {
        ensure!(c == self.owner, "only owner");
        Ok(())
    }
    fn only_reporter(&self, c: &str) -> R<()> {
        ensure!(self.reporters.contains(c), "only reporter (TEMPORARY trusted role)");
        Ok(())
    }
    fn only_steward(&self, c: &str) -> R<()> {
        ensure!(self.stewards.contains(c), "only registered steward");
        Ok(())
    }
    fn not_paused(&self) -> R<()> {
        ensure!(!self.paused, "paused");
        Ok(())
    }

    pub fn position(&self, id: u64) -> R<&Position> {
        self.positions.get(&id).ok_or_else(|| format!("no position {id}"))
    }
    fn position_mut(&mut self, id: u64) -> R<&mut Position> {
        self.positions.get_mut(&id).ok_or_else(|| format!("no position {id}"))
    }
    pub fn rescue(&self, id: u64) -> R<&Rescue> {
        self.rescues.get(&id).ok_or_else(|| format!("no rescue {id}"))
    }
    fn rescue_mut(&mut self, id: u64) -> R<&mut Rescue> {
        self.rescues.get_mut(&id).ok_or_else(|| format!("no rescue {id}"))
    }
    fn market_of(&self, p: &Position) -> &Market {
        &self.markets[&p.market_id]
    }
    fn use_key(&mut self, key: String) -> bool {
        self.used_keys.insert(key)
    }

    // ── owner ──
    pub fn add_market(&mut self, c: &str, m: Market) -> R<u32> {
        self.only_owner(c)?;
        m.validate(&self.params)?;
        let id = self.next_market_id;
        self.next_market_id += 1;
        self.markets.insert(id, m);
        Ok(id)
    }
    pub fn set_params(&mut self, c: &str, p: Params) -> R<()> {
        self.only_owner(c)?;
        p.validate()?;
        for m in self.markets.values() {
            ensure!(m.lt_bps < p.target_hf_bps, "lt must be < target_hf");
        }
        // Claims keep the buy-back deadline they opened with (`Claim.expires_at`); auctions keep
        // their close time and cap. A change applies to rescues that start after it.
        let old = std::mem::replace(&mut self.params, p);
        self.emit("params_set", json!({"old": old, "new": self.params}));
        Ok(())
    }
    pub fn set_limits(&mut self, c: &str, l: Limits) -> R<()> {
        self.only_owner(c)?;
        ensure!(l.max_collateral_base <= MAX_COLLATERAL_CEILING_BASE, "max_collateral_base above the ceiling ({} USD)", MAX_COLLATERAL_CEILING_BASE / 100_000_000);
        let old = std::mem::replace(&mut self.limits, l);
        self.emit("limits_set", json!({"old": old, "new": self.limits}));
        Ok(())
    }
    pub fn set_role(&mut self, c: &str, role: &str, account: &str, on: bool) -> R<()> {
        self.only_owner(c)?;
        let set = match role {
            "reporter" => &mut self.reporters,
            "steward" => &mut self.stewards,
            _ => return Err(format!("unknown role {role}")),
        };
        if on {
            set.insert(account.into());
        } else {
            set.remove(account);
        }
        if role == "steward" {
            // Removal only stops new bids (and re-registration). Open claims, bonds and payouts
            // are never touched.
            if on {
                self.removed_stewards.remove(account);
            } else {
                self.removed_stewards.insert(account.into());
                self.emit("steward_removed", json!({"steward": account}));
            }
        }
        Ok(())
    }
    // ── anyone: become a steward ──
    /// Open registration: pays `STEWARD_DEPOSIT` once (the storage it uses; the rest is refunded)
    /// and sets the payout address. The bid bond still applies to every bid.
    pub fn register_steward(&mut self, c: &str, payout: EvmAddr, deposit: u128) -> R<Vec<Transfer>> {
        self.not_paused()?;
        ensure!(!self.removed_stewards.contains(c), "removed by the owner: can't re-register");
        ensure!(!self.stewards.contains(c), "already a steward");
        ensure!(payout != EvmAddr::default(), "zero payout address");
        ensure!(deposit >= STEWARD_DEPOSIT, "deposit of {STEWARD_DEPOSIT} yocto required");
        self.stewards.insert(c.into());
        self.evm_payouts.insert(c.into(), payout);
        self.emit("steward_registered", json!({"steward": c, "payout": payout.to_hex()}));
        Ok(if deposit > STEWARD_DEPOSIT { vec![Transfer { to: c.into(), amount: deposit - STEWARD_DEPOSIT }] } else { vec![] })
    }

    pub fn set_paused(&mut self, c: &str, paused: bool) -> R<()> {
        self.only_owner(c)?;
        self.paused = paused;
        Ok(())
    }

    // ── anyone with an EVM wallet ──
    /// Where settlement pays this account (stewards and anyone who buys a claim NFT).
    pub fn set_evm_payout(&mut self, c: &str, addr: EvmAddr) -> R<()> {
        ensure!(addr != EvmAddr::default(), "zero address");
        self.evm_payouts.insert(c.into(), addr);
        Ok(())
    }

    // ── borrower ──
    pub fn register_position(&mut self, c: &str, market_id: u32, payout: EvmAddr) -> R<u64> {
        self.not_paused()?;
        ensure!(self.markets.contains_key(&market_id), "no market {market_id}");
        ensure!(payout != EvmAddr::default(), "zero payout address");
        ensure!(self.limits.borrowers.is_empty() || self.limits.borrowers.contains(c), "not on the borrower allow-list");
        let id = self.next_position_id;
        self.next_position_id += 1;
        self.positions.insert(
            id,
            Position {
                id,
                owner: c.into(),
                market_id,
                path: format!("pos-{id}"),
                evm_address: None,
                payout,
                payout_change: None,
                next_nonce: 0,
                pending: None,
                health: None,
                active_auction: None,
                open_rescues: vec![],
                premium_cap_base: 0,
                premium_used_base: 0,
            },
        );
        self.emit("position_registered", json!({"position_id": id, "owner": c, "payout": payout}));
        Ok(id)
    }

    /// Only the wrapper's own MPC-derivation callback calls this.
    pub fn set_position_address(&mut self, id: u64, addr: EvmAddr) -> R<()> {
        let p = self.position_mut(id)?;
        ensure!(p.evm_address.is_none(), "address already set");
        p.evm_address = Some(addr);
        self.emit("position_address", json!({"position_id": id, "evm_address": addr}));
        Ok(())
    }

    fn check_gas(m: &Market, g: &GasArgs, min_gas: u128) -> R<()> {
        ensure!(g.gas_limit >= min_gas && g.gas_limit <= m.gas_limit_cap, "gas_limit out of range");
        ensure!(g.max_fee_per_gas <= m.max_fee_cap, "max_fee_per_gas above cap");
        ensure!(g.max_priority_fee_per_gas <= g.max_fee_per_gas, "priority fee above max fee");
        Ok(())
    }

    /// The signing allow-list: build an allow-listed tx at the next nonce, or refuse.
    pub fn sign_action(&mut self, c: &str, id: u64, action: Action, gas: GasArgs, now: u64) -> R<SignPlan> {
        let p = self.position(id)?;
        ensure!(p.owner == c, "only the position owner");
        let addr = p.evm_address.ok_or("position address not derived yet")?;
        let adds_only = matches!(action, Action::Supply { .. } | Action::Repay { .. });
        if !adds_only {
            self.not_paused()?;
        }
        if let Some(t) = &p.pending {
            return Err(format!("tx in flight: nonce {} unconfirmed", t.tx.nonce));
        }
        if p.locked() && !adds_only {
            return Err(format!("claim open: {} refused", action.name()));
        }
        ensure!(self.book(id).outflows.is_empty(), "payouts queued on this position: pay_next first");
        // The position's own balances are held for buy-back while a claim is open
        if p.locked() {
            let e = self.book(id).escrow;
            ensure!(e.collateral_units == 0 && e.debt_units == 0, "claim open: the position's balance is reserved for buy-back, {} refused", action.name());
        }
        let m = self.market_of(p);
        Self::check_gas(m, &gas, TRANSFER_GAS)?;
        let (to, data) = match action {
            Action::Approve { token, amount } => {
                let t = match token {
                    TokenSide::Collateral => m.collateral,
                    TokenSide::Debt => m.debt,
                };
                (t, evm::approve(&m.pool, amount))
            }
            Action::Supply { amount } => {
                ensure!(amount > 0, "zero amount");
                let cap = self.limits.max_collateral_base;
                if cap > 0 {
                    let h = p.health.as_ref().ok_or("size cap set: a price reading is needed before a supply")?;
                    let adds = math::units_to_base_ceil(amount, h.r.collateral_price_base, m.collateral_decimals);
                    ensure!(h.r.collateral_base.saturating_add(adds) <= cap, "supply would take the collateral above the size cap");
                }
                (m.pool, evm::supply(&m.collateral, amount, &addr))
            }
            Action::Borrow { amount } => {
                ensure!(amount > 0, "zero amount");
                (m.pool, evm::borrow(&m.debt, amount, &addr))
            }
            Action::Repay { amount } => (m.pool, evm::repay(&m.debt, amount, &addr)),
            Action::Withdraw { amount } => (m.pool, evm::withdraw(&m.collateral, amount, &p.payout)),
            Action::TransferDebt { amount } => {
                ensure!(amount > 0, "zero amount");
                (m.debt, evm::transfer(&p.payout, amount))
            }
        };
        let tx = TxFields { chain_id: m.chain_id, nonce: p.next_nonce, to, data, gas };
        let kind = TxKind::Borrower { action: action.name().into() };
        self.set_pending(id, tx, kind, now)
    }

    fn set_pending(&mut self, id: u64, tx: TxFields, kind: TxKind, now: u64) -> R<SignPlan> {
        let p = self.position_mut(id)?;
        p.pending = Some(PendingTx {
            tx: tx.clone(),
            kind,
            signed_at: now,
            signed_raw: None,
            signing: true,
            ever_signed: false,
            replaced: false,
        });
        let plan = SignPlan { position_id: id, path: p.path.clone(), tx };
        self.emit("sign_requested", json!({"position_id": id, "nonce": plan.tx.nonce}));
        Ok(plan)
    }

    /// MPC callback. `raw` is the signed tx, or None if the MPC call failed.
    pub fn on_signed(&mut self, id: u64, nonce: u64, raw: Option<Vec<u8>>) -> R<()> {
        let p = self.position_mut(id)?;
        let t = p.pending.as_mut().ok_or("no pending tx")?;
        ensure!(t.tx.nonce == nonce && t.signing, "unexpected signature");
        t.signing = false;
        match raw {
            Some(r) => {
                t.signed_raw = Some(r);
                t.ever_signed = true;
            }
            None if !t.ever_signed => p.pending = None,
            None => {} // a failed burn/replacement: the earlier signature may still land
        }
        Ok(())
    }

    /// Replace a withheld borrower tx with a zero-value self-transfer at the same nonce.
    pub fn burn_nonce(&mut self, _c: &str, id: u64, gas: GasArgs, now: u64) -> R<SignPlan> {
        let burn_after = self.params.nonce_burn_after_ns;
        let p = self.position(id)?;
        let addr = p.evm_address.ok_or("no address")?;
        let t = p.pending.as_ref().ok_or("no pending tx")?;
        ensure!(!t.signing, "signature in progress");
        ensure!(matches!(t.kind, TxKind::Borrower { .. }), "only a borrower tx can be burned");
        ensure!(now >= t.signed_at + burn_after, "too early to burn");
        let m = self.market_of(p);
        Self::check_gas(m, &gas, TRANSFER_GAS)?;
        let tx = TxFields { chain_id: m.chain_id, nonce: t.tx.nonce, to: addr, data: vec![], gas };
        let plan = self.set_pending(id, tx, TxKind::NonceBurn, now)?;
        // The original signature still exists, so this slot counts as signed
        self.position_mut(id)?.pending.as_mut().unwrap().ever_signed = true;
        self.emit("nonce_burn", json!({"position_id": id, "nonce": plan.tx.nonce}));
        Ok(plan)
    }

    /// One higher-fee replacement of the pending tx, same nonce and calldata.
    pub fn replace_pending(&mut self, c: &str, id: u64, max_fee: u128, max_priority: u128) -> R<SignPlan> {
        let p = self.position(id)?;
        let t = p.pending.as_ref().ok_or("no pending tx")?;
        ensure!(t.ever_signed && !t.signing, "nothing signed to replace");
        ensure!(!t.replaced, "already replaced once");
        if matches!(t.kind, TxKind::Borrower { .. }) {
            ensure!(c == p.owner, "only the position owner");
        }
        let old = t.tx.gas;
        // Ethereum nodes need a ≥ 10 % bump on both fees to accept a replacement
        ensure!(max_fee * 10 >= old.max_fee_per_gas * 11, "max_fee must rise ≥ 10 %");
        ensure!(max_priority * 10 >= old.max_priority_fee_per_gas * 11, "priority fee must rise ≥ 10 %");
        let gas = GasArgs { gas_limit: old.gas_limit, max_fee_per_gas: max_fee, max_priority_fee_per_gas: max_priority };
        Self::check_gas(self.market_of(p), &gas, TRANSFER_GAS)?;
        let mut tx = t.tx.clone();
        tx.gas = gas;
        let p = self.position_mut(id)?;
        let t = p.pending.as_mut().unwrap();
        t.tx = tx.clone();
        t.signing = true;
        t.replaced = true;
        t.signed_raw = None;
        Ok(SignPlan { position_id: id, path: p.path.clone(), tx })
    }

    /// TEMPORARY trusted reporter: the reporter says the position's on-chain nonce moved.
    /// With verified reads: `evm_nonce` from the verified proof.
    pub fn confirm_nonce(&mut self, c: &str, id: u64, onchain_nonce: u64, success: bool, block: u64) -> R<()> {
        self.only_reporter(c)?;
        self.note_event(id, block);
        let p = self.position_mut(id)?;
        let Some(t) = p.pending.clone() else {
            ensure!(onchain_nonce == p.next_nonce, "no pending tx and nonce mismatch");
            return Ok(()); // duplicate confirm
        };
        ensure!(onchain_nonce == t.tx.nonce + 1, "nonce {onchain_nonce} doesn't follow pending {}", t.tx.nonce);
        p.next_nonce = onchain_nonce;
        p.pending = None;
        self.emit("nonce_confirmed", json!({"position_id": id, "nonce": t.tx.nonce, "success": success}));
        match (t.kind, success) {
            (TxKind::Settlement { rescue_id, leg }, true) => self.settlement_leg_done(rescue_id, leg)?,
            (TxKind::Outflow, true) => self.outflow_done(id)?,
            _ => {}
        }
        Ok(())
    }

    pub fn request_payout_change(&mut self, c: &str, id: u64, to: EvmAddr, now: u64) -> R<()> {
        let delay = self.params.payout_change_delay_ns;
        let p = self.position_mut(id)?;
        ensure!(p.owner == c, "only the position owner");
        ensure!(!p.locked(), "claim open: payout change refused");
        ensure!(to != EvmAddr::default(), "zero payout address");
        p.payout_change = Some(PayoutChange { to, effective_at: now + delay });
        Ok(())
    }

    pub fn apply_payout_change(&mut self, id: u64, now: u64) -> R<()> {
        let p = self.position_mut(id)?;
        ensure!(!p.locked(), "claim open: payout change refused");
        let ch = p.payout_change.clone().ok_or("no payout change requested")?;
        ensure!(now >= ch.effective_at, "payout change not effective yet");
        p.payout = ch.to;
        p.payout_change = None;
        Ok(())
    }

    // ── reporter: health and auction open ──
    /// TEMPORARY trusted reporter. Records a reading; opens an auction if HF < trigger. Returns the rescue id.
    pub fn report_health(&mut self, c: &str, id: u64, r: HealthReport, now: u64) -> R<Option<u64>> {
        self.only_reporter(c)?;
        ensure!(!self.is_verified(id)?, "verified market: readings come only from proofs");
        let last = self.book(id).last_event_block;
        ensure!(r.block >= last, "reading older than the last confirmed event (block {} < {last})", r.block);
        let out = self.report_health_inner(c, id, r, now, None)?;
        self.settle_books(id, now)?;
        Ok(out)
    }

    /// `scaled_collateral`: the exact scaled aToken balance from a verified proof (None on the
    /// reporter path, where collateral units come from the reading's base value).
    fn report_health_inner(&mut self, c: &str, id: u64, r: HealthReport, now: u64, scaled_collateral: Option<u128>) -> R<Option<u64>> {
        ensure!(r.collateral_price_base > 0 && r.debt_price_base > 0, "zero price");
        let paused = self.paused;
        let params = self.params.clone();
        let p = self.position(id)?;
        ensure!(p.evm_address.is_some(), "position address not derived yet");
        if let Some(h) = &p.health {
            ensure!(r.block >= h.r.block, "stale reading (block {} < {})", r.block, h.r.block);
        }
        let m = self.market_of(p).clone();
        // A liquidation during an auction or before its top-up lands fails that rescue (bonds
        // refunded, no slash) and lets a fresh auction open on this same reading. Evidence: while the
        // position is locked Stead signs no withdrawal, so collateral units AND debt units both
        // falling between two readings can only be a liquidation (With verified reads: verified balance proofs).
        // HF < 1 alone is not enough: the winner must still supply or be slashed.
        let claims_were_open = !p.open_rescues.is_empty();
        let mut liquidated = false;
        if let (Some(prev), Some(aid)) = (p.health.clone(), p.active_auction) {
            if matches!(self.rescue(aid)?.state, RescueState::Auction | RescueState::TopUpPending) && Self::liquidated_between(&prev.r, &r, &m) {
                self.fail_liquidated(aid, now)?;
                liquidated = true;
            }
        }
        // While claims are open, Stead signs no collateral withdrawal except settlement legs, so
        // collateral below its high-water mark (net of those legs) can only be a liquidation.
        if claims_were_open || !self.position(id)?.open_rescues.is_empty() {
            let c_now = scaled_collateral.unwrap_or_else(|| math::base_to_units_floor(r.collateral_base, r.collateral_price_base, m.collateral_decimals));
            liquidated |= self.collateral_watch(id, c_now, scaled_collateral.is_some())?;
        }
        // The borrower must never pay Aave's liquidation penalty AND a premium
        if liquidated {
            self.forfeit_premiums(id)?;
        }
        let p = self.position(id)?;
        let seq = self.rescues.values().filter(|x| x.position_id == id).count() as u32;
        // A stacked auction (claims already open) only while the borrower's own HF is at or
        // above the early-settle level; below it the open claims must settle first. With no open
        // claims net HF = Aave HF, so a first rescue opens whenever HF < trigger.
        let stacked_ok = p.open_rescues.is_empty() || !math::hf_below(self.net_hf_wad(id, &r)?, params.early_settle_hf_bps as u128);
        let p = self.position_mut(id)?;
        p.health = Some(Health { r: r.clone(), at_ns: now, source: c.into() });

        let no_payouts_queued = self.book(id).outflows.is_empty();
        let p = self.position_mut(id)?;
        let can_open = !paused
            && no_payouts_queued
            && stacked_ok
            && p.active_auction.is_none()
            && p.pending.is_none()
            && r.debt_base > 0
            && math::hf_below(r.hf_wad, params.trigger_hf_bps as u128);
        if !can_open {
            return Ok(None);
        }
        if p.open_rescues.is_empty() {
            p.premium_cap_base = math::premium_cap_base(r.debt_base, m.liq_bonus_bps as u128);
            p.premium_used_base = 0;
        }
        let remaining = p.premium_cap_base.saturating_sub(p.premium_used_base);
        let t_base = math::topup_base(r.collateral_base, r.debt_base, m.lt_bps as u128, params.target_hf_bps as u128);
        if t_base == 0 || remaining == 0 {
            return Ok(None);
        }
        // A size cap: no auction whose top-up would take the collateral above it
        let cap = self.limits.max_collateral_base;
        if cap > 0 && r.collateral_base.saturating_add(t_base) > cap {
            return Ok(None);
        }
        let cap_bps = (remaining * BPS / t_base).min(u32::MAX as u128) as u32;
        if cap_bps == 0 {
            return Ok(None);
        }
        let t_units = math::base_to_units_ceil(t_base, r.collateral_price_base, m.collateral_decimals);
        let rid = self.next_rescue_id;
        self.next_rescue_id += 1;
        self.positions.get_mut(&id).unwrap().active_auction = Some(rid);
        self.rescues.insert(
            rid,
            Rescue {
                id: rid,
                position_id: id,
                seq,
                state: RescueState::Auction,
                opened_at: now,
                closes_at: now + params.auction_window_ns,
                topup_deadline: 0,
                topup_units: t_units,
                topup_base: t_base,
                collateral_price_base: r.collateral_price_base,
                debt_price_base: r.debt_price_base,
                cap_bps,
                bids: vec![],
                members: vec![],
                claims_opened_at: 0,
                settlement: None,
                next_bid_seq: 0,
            },
        );
        self.emit(
            "auction_opened",
            json!({"rescue_id": rid, "position_id": id, "hf_wad": r.hf_wad.to_string(),
                   "topup_units": t_units.to_string(), "topup_base": t_base.to_string(), "cap_bps": cap_bps,
                   "trust": "TEMPORARY reporter"}),
        );
        Ok(Some(rid))
    }

    // ── stewards: bids ──
    /// Place or replace a bid. Returns NEAR to refund (excess deposit).
    pub fn bid(&mut self, c: &str, rid: u64, premium_bps: u32, amount_units: u128, deposit: u128, now: u64) -> R<Vec<Transfer>> {
        self.only_steward(c)?;
        self.not_paused()?;
        ensure!(self.evm_payouts.contains_key(c), "set_evm_payout first");
        let bond = self.params.bid_bond;
        let r = self.rescue(rid)?;
        ensure!(r.state == RescueState::Auction, "auction not open");
        ensure!(now < r.closes_at, "auction window closed");
        ensure!(amount_units > 0 && amount_units <= r.topup_units, "amount out of range");
        ensure!(premium_bps <= r.cap_bps, "premium {premium_bps} bps above cap {} bps", r.cap_bps);
        let r = self.rescue_mut(rid)?;
        let mut refunds = vec![];
        let mut new_bond = 0;
        if let Some(b) = r.bids.iter_mut().find(|b| b.steward == c) {
            b.premium_bps = premium_bps;
            b.amount_units = amount_units;
            b.seq = r.next_bid_seq;
            if deposit > 0 {
                refunds.push(Transfer { to: c.into(), amount: deposit });
            }
        } else {
            ensure!(deposit >= bond, "bond of {bond} yocto required");
            r.bids.push(Bid { steward: c.into(), premium_bps, amount_units, bond, seq: r.next_bid_seq });
            new_bond = bond;
            if deposit > bond {
                refunds.push(Transfer { to: c.into(), amount: deposit - bond });
            }
        }
        r.next_bid_seq += 1;
        self.bonds_held += new_bond;
        self.emit("bid_placed", json!({"rescue_id": rid, "steward": c, "premium_bps": premium_bps, "amount_units": amount_units.to_string()}));
        Ok(refunds)
    }

    /// Anyone, after the window: lowest premium first (ties: earlier bid), pay-as-bid, partial fills.
    pub fn close_auction(&mut self, rid: u64, now: u64) -> R<Vec<Transfer>> {
        let deadline = self.params.topup_deadline_ns;
        let r = self.rescue(rid)?;
        ensure!(r.state == RescueState::Auction, "auction not open");
        ensure!(now >= r.closes_at, "auction window still open");
        let mut bids = r.bids.clone();
        bids.sort_by_key(|b| (b.premium_bps, b.seq));
        let (t_units, t_base, trig_price) = (r.topup_units, r.topup_base, r.collateral_price_base);
        let dec = self.market_of(self.position(r.position_id)?).collateral_decimals;
        let mut left = t_units;
        let mut members = vec![];
        let mut refunds = vec![];
        for b in bids {
            if left == 0 {
                refunds.push(Transfer { to: b.steward.clone(), amount: b.bond });
                continue;
            }
            let share = b.amount_units.min(left);
            left -= share;
            members.push(Member {
                steward: b.steward,
                premium_bps: b.premium_bps,
                share_units: share,
                share_base: 0,
                premium_units: 0,
                premium_base: 0,
                bond: b.bond,
                confirmed: false,
                evm_tx: None,
                claim_id: None,
            });
        }
        let pid = r.position_id;
        if left > 0 {
            // Not covered: nobody wins, every bond goes back
            refunds.extend(members.iter().map(|m| Transfer { to: m.steward.clone(), amount: m.bond }));
            let r = self.rescue_mut(rid)?;
            r.state = RescueState::Failed;
            self.position_mut(pid)?.active_auction = None;
            self.release_bonds(&refunds);
            self.emit("auction_closed", json!({"rescue_id": rid, "result": "uncovered"}));
            return Ok(refunds);
        }
        // Split T (base) by units; the last member takes the rounding remainder
        let mut assigned = 0;
        let n = members.len();
        for (i, m) in members.iter_mut().enumerate() {
            m.share_base = if i + 1 == n { t_base - assigned } else { t_base * m.share_units / t_units };
            assigned += m.share_base;
            m.premium_units = math::premium_units(m.share_units, m.premium_bps as u128);
            m.premium_base = math::units_to_base(m.premium_units, trig_price, dec);
        }
        let r = self.rescue_mut(rid)?;
        r.members = members;
        r.state = RescueState::TopUpPending;
        r.topup_deadline = now + deadline;
        let winners: Vec<_> = r.members.iter().map(|m| (m.steward.clone(), m.premium_bps, m.share_units.to_string())).collect();
        self.release_bonds(&refunds);
        self.emit("auction_closed", json!({"rescue_id": rid, "result": "won", "winners": winners}));
        Ok(refunds)
    }

    fn release_bonds(&mut self, ts: &[Transfer]) {
        for t in ts {
            self.bonds_held -= t.amount;
        }
    }

    /// TEMPORARY trusted reporter: the reporter saw the steward's `supply(onBehalfOf = position)`.
    /// With verified reads: a verified receipt proof.
    pub fn confirm_topup(&mut self, c: &str, rid: u64, steward: &str, units: u128, evm_tx: &str, block: u64, now: u64) -> R<Vec<Transfer>> {
        self.only_reporter(c)?;
        if !self.use_key(format!("topup:{evm_tx}")) {
            return Ok(vec![]); // duplicate
        }
        let pid = self.rescue(rid)?.position_id;
        ensure!(!self.is_verified(pid)?, "verified market: a top-up is confirmed only by a proof");
        self.note_event(pid, block);
        let r = self.rescue_mut(rid)?;
        ensure!(r.state == RescueState::TopUpPending, "rescue not awaiting top-up");
        let m = r.members.iter_mut().find(|m| m.steward == steward && !m.confirmed).ok_or("not an unconfirmed winner")?;
        ensure!(units >= m.share_units, "top-up {units} < share {}", m.share_units);
        m.confirmed = true;
        m.evm_tx = Some(evm_tx.into());
        let refund = vec![Transfer { to: steward.into(), amount: m.bond }];
        let all = r.members.iter().all(|m| m.confirmed);
        self.release_bonds(&refund);
        self.emit("topup_confirmed", json!({"rescue_id": rid, "steward": steward, "evm_tx": evm_tx}));
        if all {
            self.open_claims(rid, now)?;
        }
        Ok(refund)
    }

    /// Anyone, after the top-up deadline: missing winners' bonds go to the borrower;
    /// confirmed members still get their claims.
    pub fn expire_topup(&mut self, rid: u64, now: u64) -> R<Vec<Transfer>> {
        let r = self.rescue(rid)?;
        ensure!(r.state == RescueState::TopUpPending, "rescue not awaiting top-up");
        ensure!(now > r.topup_deadline, "top-up deadline not passed");
        // verified market: the first verified reading from after the deadline decides (a top-up
        // that landed but wasn't proven yet still counts); a direct expiry only after the grace
        if self.is_verified(r.position_id)? {
            ensure!(now > r.topup_deadline + VERIFIED_EXPIRY_GRACE_NS, "verified market: waiting for a verified reading from after the top-up deadline");
        }
        self.expire_topup_now(rid, now)
    }

    fn expire_topup_now(&mut self, rid: u64, now: u64) -> R<Vec<Transfer>> {
        let r = self.rescue(rid)?;
        let borrower = self.position(r.position_id)?.owner.clone();
        let pid = r.position_id;
        let slashed: Vec<_> = r.members.iter().filter(|m| !m.confirmed).map(|m| Transfer { to: borrower.clone(), amount: m.bond }).collect();
        let r = self.rescue_mut(rid)?;
        r.members.retain(|m| m.confirmed);
        let any = !r.members.is_empty();
        self.release_bonds(&slashed);
        if any {
            self.open_claims(rid, now)?;
        } else {
            self.rescue_mut(rid)?.state = RescueState::Failed;
            self.position_mut(pid)?.active_auction = None;
        }
        self.emit("topup_expired", json!({"rescue_id": rid, "slashed": slashed.len()}));
        Ok(slashed)
    }

    /// Mint one claim NFT per confirmed member.
    fn open_claims(&mut self, rid: u64, now: u64) -> R<()> {
        let window = self.params.buyback_window_ns;
        let asset = self.market_of(self.position(self.rescue(rid)?.position_id)?).collateral;
        let r = self.rescue_mut(rid)?;
        let trig_price = r.collateral_price_base;
        r.state = RescueState::Open;
        r.claims_opened_at = now;
        let (pid, seq) = (r.position_id, r.seq);
        let mut minted = vec![];
        let mut premium = 0;
        for (i, m) in r.members.iter_mut().enumerate() {
            let token_id = format!("{pid}-{seq}-{i}");
            m.claim_id = Some(token_id.clone());
            premium += m.premium_base;
            minted.push(Claim {
                token_id,
                rescue_id: rid,
                position_id: pid,
                owner: m.steward.clone(),
                asset,
                share_units: m.share_units,
                premium_bps: m.premium_bps,
                premium_units: m.premium_units,
                owed_units: m.share_units + m.premium_units,
                trigger_price_base: trig_price,
                share_base: m.share_base,
                premium_base: m.premium_base,
                opened_at: now,
                expires_at: now + window,
                status: ClaimStatus::Open,
                evm_topup_tx: m.evm_tx.clone(),
                paid_by_tx: None,
            });
        }
        let p = self.position_mut(pid)?;
        p.active_auction = None;
        p.open_rescues.push(rid);
        p.premium_used_base += premium;
        for cl in minted {
            self.emit("nft_mint", json!({"owner_id": cl.owner, "token_ids": [cl.token_id]}));
            self.claims.insert(cl.token_id.clone(), cl);
        }
        Ok(())
    }

    /// Liquidation evidence: collateral units fell by more than 1 bps and debt units fell.
    fn liquidated_between(prev: &HealthReport, now: &HealthReport, m: &Market) -> bool {
        let cu = |r: &HealthReport| math::base_to_units_floor(r.collateral_base, r.collateral_price_base, m.collateral_decimals);
        let du = |r: &HealthReport| math::base_to_units_floor(r.debt_base, r.debt_price_base, m.debt_decimals);
        cu(now) * BPS < cu(prev) * (BPS - 1) && du(now) < du(prev)
    }

    /// A claim's first leg pays its principal (and the settler's R); any later leg for the same
    /// claim pays premium (its premium leg, or a takeover fee taken from it).
    pub fn is_premium_leg(legs: &[Leg], i: usize) -> bool {
        let id = &legs[i].claim_id;
        id.is_some() && legs[..i].iter().any(|l| &l.claim_id == id)
    }

    pub fn watch_of(&self, pid: u64) -> Watch {
        self.watch.get(&pid).copied().unwrap_or_default()
    }

    /// The most a Stead-signed `withdraw(amount)` can take off the watched collateral, in the
    /// watch's unit. Verified: scaled burned = amount / index at the withdraw ≤ amount / index at
    /// the settlement start (the index only rises), and ≤ amount without it (index ≥ 1 ray).
    fn withdraw_allowance(&self, pid: u64, amount: &AmountArg, exact: bool) -> u128 {
        match amount {
            AmountArg::Max => ALL,
            AmountArg::Exact(u) => {
                let ci0 = self.watch_of(pid).settle.map_or(0, |st| st.start.ci);
                if exact && ci0 >= RAY {
                    math::mul_div(*u, RAY, ci0) + 2
                } else {
                    *u
                }
            }
        }
    }

    /// A settlement leg signed but not yet confirmed may already have landed.
    fn inflight_allowance(&self, pid: u64, exact: bool) -> R<u128> {
        let Some(TxKind::Settlement { rescue_id, leg }) = self.position(pid)?.pending.as_ref().map(|t| t.kind.clone()) else { return Ok(0) };
        let leg = self.rescue(rescue_id)?.settlement.as_ref().and_then(|s| s.legs.get(leg as usize)).map(|l| l.amount);
        Ok(leg.map_or(0, |a| self.withdraw_allowance(pid, &a, exact)))
    }

    /// Liquidation evidence while claims are open: the collateral fell below its high-water mark
    /// (the highest seen while claims are open) by more than confirmed and in-flight Stead legs
    /// explain. A rise lifts the mark, so a supply can't hide a later liquidation. Exact in scaled
    /// units on a verified market; 1 bps tolerance on the reporter's base-derived units.
    fn collateral_watch(&mut self, pid: u64, c_now: u128, exact: bool) -> R<bool> {
        let inflight = self.inflight_allowance(pid, exact)?;
        let w = self.watch.entry(pid).or_default();
        let adj = c_now.saturating_add(w.withdrawn);
        if w.hw == 0 {
            w.hw = adj;
            return Ok(false);
        }
        let floor = adj.saturating_add(inflight);
        let liquidated = if exact { floor < w.hw } else { floor.saturating_mul(BPS) < w.hw.saturating_mul(BPS - 1) };
        w.hw = if liquidated { adj } else { w.hw.max(adj) };
        Ok(liquidated)
    }

    /// A proven liquidation while claims are open: every open claim of the position shrinks to
    /// its principal (premium forfeited). A settlement whose repay isn't confirmed aborts to
    /// `Open` (a fresh reading decides again; a repay already made becomes a stray repay,
    /// reimbursed at par). After the repay, the unsent claim legs drop their premium. A leg
    /// already sent, or in flight, keeps it.
    fn forfeit_premiums(&mut self, pid: u64) -> R<()> {
        let p = self.position(pid)?;
        let inflight = match p.pending.as_ref().map(|t| &t.kind) {
            Some(TxKind::Settlement { rescue_id, leg }) => Some((*rescue_id, *leg)),
            _ => None,
        };
        for rid in p.open_rescues.clone() {
            // only a PREMIUM leg in flight keeps its claim's premium (bounded by that one leg)
            let inflight_claim = inflight.filter(|(r, _)| *r == rid).and_then(|(_, i)| {
                let legs = &self.rescue(rid).ok()?.settlement.as_ref()?.legs;
                (Self::is_premium_leg(legs, i as usize)).then(|| legs[i as usize].claim_id.clone()).flatten()
            });
            let mut forfeited: BTreeMap<String, u128> = BTreeMap::new();
            for cl in self.claims.values_mut().filter(|c| c.rescue_id == rid && c.status == ClaimStatus::Open && c.premium_units > 0) {
                if inflight_claim.as_deref() == Some(cl.token_id.as_str()) {
                    continue;
                }
                forfeited.insert(cl.token_id.clone(), cl.premium_units);
                cl.owed_units = cl.share_units;
                cl.premium_units = 0;
            }
            if forfeited.is_empty() {
                continue;
            }
            let total: u128 = forfeited.values().sum();
            let r = self.rescue_mut(rid)?;
            let mut aborted = false;
            let mut zero_legs = vec![];
            if r.state == RescueState::Settling {
                let s = r.settlement.as_mut().ok_or("no settlement")?;
                if !s.repay_confirmed {
                    r.state = RescueState::Open;
                    r.settlement = None;
                    aborted = true;
                } else {
                    s.owed_units = s.owed_units.saturating_sub(total);
                    for i in 0..s.legs.len() {
                        let forfeits = s.legs[i].claim_id.as_ref().is_some_and(|id| forfeited.contains_key(id));
                        if !s.legs[i].done && inflight != Some((rid, i as u32)) && forfeits && Self::is_premium_leg(&s.legs, i) {
                            s.legs[i].amount = AmountArg::Exact(0);
                            zero_legs.push(i as u32); // a premium leg: dropped, nothing sent
                        }
                    }
                }
            }
            if aborted {
                if let Some(w) = self.watch.get_mut(&pid) {
                    if w.settle.is_some_and(|st| st.rescue_id == rid) {
                        w.settle = None;
                    }
                }
            }
            for i in zero_legs {
                self.settlement_leg_done(rid, i)?;
            }
            self.emit(
                "premiums_forfeited",
                json!({"rescue_id": rid, "position_id": pid, "claims": forfeited.iter().map(|(k, v)| (k.clone(), v.to_string())).collect::<BTreeMap<_, _>>(),
                       "settlement_aborted": aborted}),
            );
        }
        Ok(())
    }

    /// Refund every bond still held for this rescue (no slash). Members whose top-up was
    /// already confirmed keep their claims (they did supply); otherwise the rescue fails.
    fn fail_liquidated(&mut self, rid: u64, now: u64) -> R<()> {
        let r = self.rescue(rid)?.clone();
        let refunds: Vec<Transfer> = match r.state {
            RescueState::Auction => r.bids.iter().map(|b| Transfer { to: b.steward.clone(), amount: b.bond }).collect(),
            _ => r.members.iter().filter(|m| !m.confirmed).map(|m| Transfer { to: m.steward.clone(), amount: m.bond }).collect(),
        };
        self.release_bonds(&refunds);
        self.payouts.extend(refunds.iter().cloned());
        let kept = r.state == RescueState::TopUpPending && r.members.iter().any(|m| m.confirmed);
        if kept {
            self.rescue_mut(rid)?.members.retain(|m| m.confirmed);
            self.open_claims(rid, now)?;
        } else {
            self.rescue_mut(rid)?.state = RescueState::Failed;
            self.position_mut(r.position_id)?.active_auction = None;
        }
        self.emit("rescue_liquidated", json!({"rescue_id": rid, "refunded": refunds.len(), "claims_kept": kept, "trust": "TEMPORARY reporter"}));
        Ok(())
    }

    pub fn book(&self, pid: u64) -> Books {
        self.books.get(&pid).cloned().unwrap_or_default()
    }
    fn book_mut(&mut self, pid: u64) -> &mut Books {
        self.books.entry(pid).or_default()
    }

    /// Record the EVM block of a confirmed event on a position.
    fn note_event(&mut self, pid: u64, block: u64) {
        let b = &mut self.book_mut(pid).last_event_block;
        *b = (*b).max(block);
    }

    /// The reading every decision uses: fresh in time, and taken at an EVM block at least as new
    /// as the last confirmed event it depends on (top-up, repay, payment, signed tx). An older
    /// reading would count an event's effect on one side and not the other.
    pub fn decision_reading(&self, pid: u64, now: u64) -> R<Health> {
        let p = self.position(pid)?;
        let h = p.health.clone().ok_or("no health reading")?;
        ensure!(now.saturating_sub(h.at_ns) <= self.params.max_price_age_ns, "reading too old for a decision");
        let last = self.book(pid).last_event_block;
        ensure!(h.r.block >= last, "reading predates the last event (block {} < {}): wait for a fresh report", h.r.block, last);
        Ok(h)
    }

    /// Σ owed units of the position's open claims (all open rescues).
    pub fn open_owed_units(&self, pid: u64) -> u128 {
        self.claims.values().filter(|c| c.position_id == pid && c.status == ClaimStatus::Open).map(|c| c.owed_units).sum()
    }

    /// The borrower's own HF, net of what the open claims are owed: LT·(C − O)/D.
    /// With no open claims it equals Aave's HF.
    pub fn net_hf_wad(&self, pid: u64, r: &HealthReport) -> R<u128> {
        let p = self.position(pid)?;
        let m = self.market_of(p);
        let owed = math::units_to_base_ceil(self.open_owed_units(pid), r.collateral_price_base, m.collateral_decimals);
        Ok(math::hf_wad(r.collateral_base.saturating_sub(owed), r.debt_base, m.lt_bps as u128))
    }

    fn oldest_open(&self, pid: u64) -> Option<u64> {
        self.positions.get(&pid).and_then(|p| p.open_rescues.first().copied())
    }

    fn close_rescue(&mut self, rid: u64, state: RescueState) -> R<()> {
        let r = self.rescue_mut(rid)?;
        r.state = state;
        let pid = r.position_id;
        let p = self.position_mut(pid)?;
        p.open_rescues.retain(|x| *x != rid);
        let unlocked = p.open_rescues.is_empty() && p.active_auction.is_none();
        if unlocked {
            p.premium_used_base = 0;
            p.premium_cap_base = 0;
        }
        if let Some(w) = self.watch.get_mut(&pid) {
            if w.settle.is_some_and(|st| st.rescue_id == rid) {
                w.settle = None;
            }
            if self.positions[&pid].open_rescues.is_empty() {
                w.hw = 0;
                w.withdrawn = 0;
            }
        }
        Ok(())
    }

    // ── buy-back through the position (escrow) ──
    /// TEMPORARY reporter (verified balance proofs later): the position address's own balances of
    /// the claim asset and the debt asset at `block`. Accepted only while a claim is open and no
    /// payout is queued; then any buy-back the balance covers commits at once (oldest first).
    pub fn confirm_escrow(&mut self, c: &str, pid: u64, collateral_units: u128, debt_units: u128, block: u64, now: u64) -> R<()> {
        self.only_reporter(c)?;
        ensure!(!self.is_verified(pid)?, "verified market: balances come only from proofs");
        self.set_escrow(pid, collateral_units, debt_units, block, now, "TEMPORARY reporter")
    }

    fn set_escrow(&mut self, pid: u64, collateral_units: u128, debt_units: u128, block: u64, now: u64, trust: &str) -> R<()> {
        let p = self.position(pid)?;
        ensure!(!p.open_rescues.is_empty(), "no open claim: nothing to hold");
        ensure!(self.book(pid).outflows.is_empty(), "payouts queued: prove the balance after they're sent");
        ensure!(!matches!(p.pending.as_ref().map(|t| &t.kind), Some(TxKind::Outflow)), "a payout is in flight");
        let last = self.book(pid).last_event_block;
        ensure!(block >= last, "balance proof older than the last event (block {block} < {last})");
        let prev = self.book(pid).escrow;
        ensure!(block >= prev.block, "balance proof older than the previous one");
        self.book_mut(pid).escrow = Escrow { collateral_units, debt_units, block, collateral_committed: 0, debt_committed: 0 };
        self.note_event(pid, block);
        self.emit("escrow_proven", json!({"position_id": pid, "collateral_units": collateral_units.to_string(), "debt_units": debt_units.to_string(), "block": block, "trust": trust}));
        self.settle_books(pid, now)
    }

    /// TEMPORARY reporter: a registered steward repaid on the position without a committed
    /// settlement of its own (or before committing). Reimbursed at par once the claims resolve.
    pub fn confirm_stray_repay(&mut self, c: &str, pid: u64, steward: &str, units: u128, evm_tx: &str, block: u64) -> R<()> {
        self.only_reporter(c)?;
        if !self.use_key(format!("stray:{evm_tx}")) {
            return Ok(());
        }
        let holds_claim = self.claims.values().any(|x| x.position_id == pid && x.owner == steward && x.status == ClaimStatus::Open);
        ensure!((self.stewards.contains(steward) || holds_claim) && self.evm_payouts.contains_key(steward), "not a registered steward (or claim holder) with a payout");
        let p = self.position(pid)?;
        ensure!(!p.open_rescues.is_empty(), "no open claim: a repay now is the steward's own choice");
        let proving = self.watch_of(pid).settle.map(|st| st.rescue_id);
        for rid in &p.open_rescues {
            if let Some(s) = &self.rescues[rid].settlement {
                ensure!(!(s.settler == steward && !s.repay_confirmed), "that is the committed settlement's repay: confirm_settlement_repay");
                // its debt drop already counts toward the settlement: it can't also be reimbursed
                ensure!(!(proving == Some(*rid) && !s.repay_confirmed), "a settlement repay is being proven on this position: a repay now counts toward it");
            }
        }
        self.note_event(pid, block);
        self.book_mut(pid).stray_repays.push(StrayRepay { steward: steward.into(), units, evm_tx: evm_tx.into() });
        self.emit("stray_repay", json!({"position_id": pid, "steward": steward, "units": units.to_string(), "evm_tx": evm_tx}));
        Ok(())
    }

    pub fn set_verify_config(&mut self, c: &str, cfg: Option<VerifyConfig>) -> R<()> {
        self.only_owner(c)?;
        self.verify_cfg = cfg;
        Ok(())
    }

    pub fn is_verified(&self, pid: u64) -> R<bool> {
        let p = self.position(pid)?;
        Ok(self.verify_cfg.as_ref().is_some_and(|v| v.markets.contains(&p.market_id)))
    }

    /// A result of the pinned proof program (delivered only to the contract's own callback).
    /// It is the position's reading in a verified market: it may open an auction (HF < trigger),
    /// it proves a top-up landed (collateral grew by at least the winning shares since the
    /// auction opened) and it proves the escrow balances. Older or foreign results are refused.
    pub fn apply_verified(&mut self, pid: u64, out: &VerifiedOutput, now: u64) -> R<Option<u64>> {
        ensure!(self.is_verified(pid)?, "not a verified market");
        ensure!(out.v == 1, "unknown proof version");
        let p = self.position(pid)?;
        let addr = p.evm_address.ok_or("position address not derived yet")?;
        ensure!(out.pos.to_lowercase() == addr.to_hex(), "proof is for another address");
        let m = self.market_of(p).clone();
        ensure!(out.chain == m.chain_id, "proof is for another chain");
        let st = self.verified.get(&pid).cloned().unwrap_or_default();
        ensure!(out.block > st.last_block, "proof not newer than the last verified block {}", st.last_block);
        let num = |s: &str| s.parse::<u128>().map_err(|_| format!("bad number {s}"));
        let price_of = |a: &EvmAddr| -> R<u128> {
            let r = out.res.iter().find(|r| r.a.to_lowercase() == a.to_hex()).ok_or_else(|| format!("no price for {}", a.to_hex()))?;
            num(&r.p)
        };
        let (cb, db) = (num(&out.cb)?, num(&out.db)?);
        let hf = out.hf.parse::<u128>().unwrap_or(u128::MAX); // no debt: uint256 max
        let pc = price_of(&m.collateral)?;
        let pd = if db > 0 { price_of(&m.debt)? } else { out.res.iter().find(|r| r.a.to_lowercase() == m.debt.to_hex()).map_or(Ok(100_000_000), |r| num(&r.p))? };
        let units = math::base_to_units_floor(cb, pc, m.collateral_decimals);
        let reserve = |a: &EvmAddr| out.res.iter().find(|r| r.a.to_lowercase() == a.to_hex());
        let field = |a: &EvmAddr, f: fn(&VerifiedReserve) -> &Option<String>| -> R<u128> { reserve(a).and_then(|r| f(r).as_deref()).map_or(Ok(0), num) };
        let scaled = if out.res.iter().any(|r| r.cs.is_some()) {
            Some(Scaled {
                cs: field(&m.collateral, |r| &r.cs)?,
                ci: field(&m.collateral, |r| &r.ci)?,
                ds: field(&m.debt, |r| &r.ds)?,
                di: field(&m.debt, |r| &r.di)?,
                block: out.block,
            })
        } else {
            None
        };

        // a verified top-up: collateral grew by the winners' shares since the auction opened
        if let (Some(rid), Some((srid, units0))) = (p.active_auction, st.snapshot) {
            let r = self.rescue(rid)?.clone();
            if rid == srid && r.state == RescueState::TopUpPending {
                let need: u128 = r.members.iter().map(|x| x.share_units).sum();
                // units are recovered from base values (8 dp): allow 2 base units of rounding
                let slack = math::base_to_units_ceil(2, pc, m.collateral_decimals);
                if units + slack >= units0 + need {
                    let refunds: Vec<Transfer> = r.members.iter().filter(|x| !x.confirmed).map(|x| Transfer { to: x.steward.clone(), amount: x.bond }).collect();
                    for x in self.rescue_mut(rid)?.members.iter_mut() {
                        x.confirmed = true;
                        x.evm_tx = Some(format!("verified@{}", out.block));
                    }
                    self.release_bonds(&refunds);
                    self.payouts.extend(refunds);
                    self.note_event(pid, out.block);
                    self.emit("topup_verified", json!({"rescue_id": rid, "block": out.block, "collateral_units": units.to_string(), "at_open": units0.to_string()}));
                    self.open_claims(rid, now)?;
                }
            }
        }
        // no top-up shown by a reading from after the deadline: that reading expires the rescue
        if let Some(rid) = self.position(pid)?.active_auction {
            let r = self.rescue(rid)?;
            if r.state == RescueState::TopUpPending && out.ts > 0 && out.ts.saturating_mul(SEC) > r.topup_deadline {
                let slashed = self.expire_topup_now(rid, now)?;
                self.payouts.extend(slashed);
            }
        }

        let last = self.book(pid).last_event_block;
        ensure!(out.block >= last, "proof older than the last event (block {} < {last})", out.block);
        let r = HealthReport { hf_wad: hf, collateral_base: cb, debt_base: db, collateral_price_base: pc, debt_price_base: pd, block: out.block };
        let opened = self.report_health_inner("verified", pid, r, now, scaled.map(|x| x.cs))?;
        if let Some(sc) = scaled {
            self.watch.entry(pid).or_default().last = Some(sc);
            self.prove_settlement_repay(pid, &sc)?;
        }
        let snapshot = match opened {
            Some(rid) => Some((rid, units)),
            None => st.snapshot.filter(|(rid, _)| self.rescues.get(rid).is_some_and(|r| matches!(r.state, RescueState::Auction | RescueState::TopUpPending))),
        };
        self.verified.insert(pid, VerifiedState { last_block: out.block, snapshot });
        self.emit("health_verified", json!({"position_id": pid, "block": out.block, "hf_wad": hf.to_string(), "rpcs_agreeing": out.agree}));

        // escrow: the position's own balances, proven
        if !self.position(pid)?.open_rescues.is_empty() && self.book(pid).outflows.is_empty() {
            let bal = |a: &EvmAddr| -> R<u128> { out.bal.iter().find(|b| b.0.to_lowercase() == a.to_hex()).map_or(Ok(0), |b| num(&b.1)) };
            let (bc, bd) = (bal(&m.collateral)?, bal(&m.debt)?);
            let e = self.book(pid).escrow;
            if (bc, bd) != (e.collateral_units, e.debt_units) {
                self.set_escrow(pid, bc, bd, out.block, now, "verified")?;
            }
        }
        self.settle_books(pid, now)?;
        Ok(opened)
    }

    /// A verified reading after a verified settlement started: the repay is confirmed when the
    /// position's scaled variable debt fell by at least `need` (exact integers, no tolerance).
    /// Any repay on the position counts (the borrower's own included: Stead can't tell them apart
    /// without a receipt proof); the settler's credit stays its stored R leg.
    fn prove_settlement_repay(&mut self, pid: u64, sc: &Scaled) -> R<()> {
        let Some(st) = self.watch_of(pid).settle else { return Ok(()) };
        let r = self.rescue(st.rescue_id)?;
        let Some(s) = r.settlement.as_ref() else { return Ok(()) };
        if r.state != RescueState::Settling || s.repay_confirmed || sc.block <= st.start.block {
            return Ok(());
        }
        let drop = st.start.ds.saturating_sub(sc.ds);
        if drop < st.need {
            return Ok(());
        }
        let s = self.rescue_mut(st.rescue_id)?.settlement.as_mut().unwrap();
        s.repay_confirmed = true;
        s.committed = true;
        self.note_event(pid, sc.block);
        self.emit("settlement_repaid", json!({"rescue_id": st.rescue_id, "scaled_debt_drop": drop.to_string(), "need": st.need.to_string(), "block": sc.block, "trust": "verified"}));
        Ok(())
    }

    /// Commit every buy-back the escrow covers, oldest open rescue and claim first. Pays the
    /// claim asset (exactly the owed units) or else the debt asset (exactly the owed value at a
    /// decision reading). An underpayment is held. A committed settlement can't be bought back.
    fn commit_buybacks(&mut self, pid: u64, now: u64) -> R<()> {
        loop {
            let p = self.position(pid)?;
            let Some(&rid) = p.open_rescues.first() else { return Ok(()) };
            if self.rescue(rid)?.state != RescueState::Open {
                return Ok(());
            }
            let Some(cl) = self.claims.values().find(|c| c.rescue_id == rid && c.status == ClaimStatus::Open).cloned() else { return Ok(()) };
            let m = self.market_of(p).clone();
            let to = *self.evm_payouts.get(&cl.owner).ok_or_else(|| format!("{} has no EVM payout", cl.owner))?;
            let e = self.book(pid).escrow;
            let (side, amount) = if e.free(TokenSide::Collateral) >= cl.owed_units {
                (TokenSide::Collateral, cl.owed_units)
            } else {
                let Ok(h) = self.decision_reading(pid, now) else { return Ok(()) }; // wait for a fresh reading
                let value = math::units_to_base_ceil(cl.owed_units, h.r.collateral_price_base, m.collateral_decimals);
                let dai = math::base_to_units_ceil(value, h.r.debt_price_base, m.debt_decimals);
                if e.free(TokenSide::Debt) < dai {
                    return Ok(()); // underpaid: held until topped up, or refunded if settlement wins
                }
                (TokenSide::Debt, dai)
            };
            self.book_mut(pid).escrow.commit(side, amount);
            self.book_mut(pid).outflows.push(Outflow { to, action: OutAction::Transfer(side), amount, purpose: OutPurpose::BuyBack, token_id: Some(cl.token_id.clone()) });
            let claim = self.claims.get_mut(&cl.token_id).unwrap();
            claim.status = ClaimStatus::BoughtBack;
            claim.paid_by_tx = Some(format!("escrow@{}", e.block));
            self.emit("nft_burn", json!({"owner_id": cl.owner, "token_ids": [cl.token_id], "memo": "bought back"}));
            self.emit("buyback_committed", json!({"token_id": cl.token_id, "asset": format!("{side:?}").to_lowercase(), "amount": amount.to_string()}));
            if self.claims.values().filter(|x| x.rescue_id == rid).all(|x| x.status != ClaimStatus::Open) {
                self.close_rescue(rid, RescueState::BoughtBack)?;
                self.emit("bought_back", json!({"rescue_id": rid}));
            }
        }
    }

    /// Commit buy-backs; once no claim is open, reimburse stray repays at par and refund whatever
    /// escrow is left to the borrower's payout. Runs after every reading, proof and payout.
    pub fn settle_books(&mut self, pid: u64, now: u64) -> R<()> {
        self.commit_buybacks(pid, now)?;
        let p = self.position(pid)?;
        if !p.open_rescues.is_empty() {
            return Ok(());
        }
        let (borrower, m) = (p.payout, self.market_of(p).clone());
        let strays = self.book(pid).stray_repays;
        if !strays.is_empty() {
            let Ok(h) = self.decision_reading(pid, now) else { return Ok(()) }; // need a price
            for st in strays {
                let to = *self.evm_payouts.get(&st.steward).ok_or("steward payout missing")?;
                let free = self.book(pid).escrow.free(TokenSide::Debt);
                let (action, amount) = if free >= st.units {
                    self.book_mut(pid).escrow.commit(TokenSide::Debt, st.units);
                    (OutAction::Transfer(TokenSide::Debt), st.units)
                } else {
                    let base = math::units_to_base(st.units, h.r.debt_price_base, m.debt_decimals);
                    (OutAction::Withdraw, math::base_to_units_floor(base, h.r.collateral_price_base, m.collateral_decimals))
                };
                self.book_mut(pid).outflows.push(Outflow { to, action, amount, purpose: OutPurpose::Reimburse, token_id: None });
                self.emit("reimbursement_queued", json!({"position_id": pid, "steward": st.steward, "units": amount.to_string()}));
            }
            self.book_mut(pid).stray_repays.clear();
        }
        let e = self.book(pid).escrow;
        for side in [TokenSide::Collateral, TokenSide::Debt] {
            let left = e.free(side);
            if left > 0 {
                self.book_mut(pid).escrow.commit(side, left);
                self.book_mut(pid).outflows.push(Outflow { to: borrower, action: OutAction::Transfer(side), amount: left, purpose: OutPurpose::Refund, token_id: None });
                self.emit("refund_queued", json!({"position_id": pid, "asset": format!("{side:?}").to_lowercase(), "amount": left.to_string()}));
            }
        }
        Ok(())
    }

    /// Anyone: sign the next queued payout (gas from the position, the usual signed-tx rules apply).
    pub fn pay_next(&mut self, pid: u64, gas: GasArgs, now: u64) -> R<SignPlan> {
        let p = self.position(pid)?;
        if let Some(t) = &p.pending {
            return Err(format!("tx in flight: nonce {} unconfirmed", t.tx.nonce));
        }
        let o = self.book(pid).outflows.first().cloned().ok_or("no payouts queued")?;
        let m = self.market_of(p);
        Self::check_gas(m, &gas, TRANSFER_GAS)?;
        let (to, data) = match o.action {
            OutAction::Transfer(TokenSide::Collateral) => (m.collateral, evm::transfer(&o.to, o.amount)),
            OutAction::Transfer(TokenSide::Debt) => (m.debt, evm::transfer(&o.to, o.amount)),
            OutAction::Withdraw => (m.pool, evm::withdraw(&m.collateral, AmountArg::Exact(o.amount), &o.to)),
        };
        let tx = TxFields { chain_id: m.chain_id, nonce: p.next_nonce, to, data, gas };
        self.set_pending(pid, tx, TxKind::Outflow, now)
    }

    fn outflow_done(&mut self, pid: u64) -> R<()> {
        let q = &mut self.book_mut(pid).outflows;
        ensure!(!q.is_empty(), "no payouts queued");
        let o = q.remove(0);
        if let OutAction::Transfer(side) = o.action {
            let e = &mut self.book_mut(pid).escrow;
            match side {
                TokenSide::Collateral => {
                    e.collateral_units = e.collateral_units.saturating_sub(o.amount);
                    e.collateral_committed = e.collateral_committed.saturating_sub(o.amount);
                }
                TokenSide::Debt => {
                    e.debt_units = e.debt_units.saturating_sub(o.amount);
                    e.debt_committed = e.debt_committed.saturating_sub(o.amount);
                }
            }
        }
        self.emit("payout_sent", json!({"position_id": pid, "purpose": format!("{:?}", o.purpose).to_lowercase(), "amount": o.amount.to_string(), "token_id": o.token_id}));
        Ok(())
    }

    // ── settlement B ──
    pub fn start_settlement(&mut self, c: &str, rid: u64, now: u64) -> R<()> {
        let pr = self.params.clone();
        let r = self.rescue(rid)?;
        ensure!(r.state == RescueState::Open, "rescue not settleable (a buy-back or settlement already committed)");
        ensure!(self.oldest_open(r.position_id) == Some(rid), "settle the oldest rescue first");
        let open: Vec<Claim> = self.claims.values().filter(|x| x.rescue_id == rid && x.status == ClaimStatus::Open).cloned().collect();
        ensure!(open.iter().any(|x| x.owner == c), "only a claim owner can settle");
        let p = self.position(r.position_id)?;
        // A reading at least as new as the last event (a pre-top-up reading counts the claims'
        // owed units but not the top-up collateral, so net HF would look far too low)
        let h = self.decision_reading(r.position_id, now)?;
        // Each claim's own deadline, fixed when it opened: a later window change can't shorten it
        let expired = open.iter().all(|x| now >= x.expires_at);
        // Early settlement watches the borrower's own HF (net of every open claim), not
        // Aave's, which the stewards' top-ups hold up.
        let early = math::hf_below(self.net_hf_wad(r.position_id, &h.r)?, pr.early_settle_hf_bps as u128);
        ensure!(expired || early, "buy-back window still open and net HF above early-settle level");
        let m = self.market_of(p).clone();
        let (payout, borrower_payout) = (self.evm_payouts.clone(), p.payout);

        // Claims are owed in units of the supplied asset (the collateral here). Only R, the
        // settler's debt repayment, is converted, at the current price, and that swap is value-neutral.
        ensure!(open.iter().all(|x| x.asset == m.collateral), "claim asset is not this market's collateral");
        let dec = m.collateral_decimals;
        let owed_units: u128 = open.iter().map(|x| x.owed_units).sum();
        let (c_base, d_base, price) = (h.r.collateral_base, h.r.debt_base, h.r.collateral_price_base);
        let owed = math::units_to_base_ceil(owed_units, price, dec);
        let (repay, full) = math::settlement_repay_base(c_base, d_base, owed, m.lt_bps as u128, pr.target_hf_bps as u128);
        let repay_units = math::base_to_units_ceil(repay, h.r.debt_price_base, m.debt_decimals);
        let repay_coll_units = math::base_to_units_floor(repay, price, dec);

        // What each leg receives, in collateral units; R goes back to the settler first (deep crash: pro rata)
        let c_units = math::base_to_units_floor(c_base, price, dec);
        let need = owed_units + repay_coll_units;
        let avail = c_units.min(need);
        let settler_r = repay_coll_units.min(avail);
        let rest = avail - settler_r;
        // Principal legs first (each claim's principal, the settler's with its R), premium legs
        // last: every leg needs a fresh reading, so no premium is signed after a liquidation is
        // seen, and earlier legs carry principal only.
        let mut legs = vec![];
        let mut premium_legs = vec![];
        let mut r_paid = false;
        for cl in &open {
            let to = *payout.get(&cl.owner).ok_or_else(|| format!("{} has no EVM payout", cl.owner))?;
            let units = if avail >= need { cl.owed_units } else { math::mul_div(cl.owed_units, rest, owed_units) };
            let principal = units.min(cl.share_units);
            let mut first = principal;
            if cl.owner == c && !r_paid {
                first += settler_r;
                r_paid = true;
            }
            legs.push(Leg { to, amount: AmountArg::Exact(first), claim_id: Some(cl.token_id.clone()), done: false });
            if units > principal {
                premium_legs.push(Leg { to, amount: AmountArg::Exact(units - principal), claim_id: Some(cl.token_id.clone()), done: false });
            }
        }
        legs.extend(premium_legs);
        legs.retain(|l| l.amount != AmountArg::Exact(0)); // nothing to send (deep-crash pro rata)
        if full && avail >= need {
            legs.push(Leg { to: borrower_payout, amount: AmountArg::Max, claim_id: None, done: false });
        }
        let s = Settlement {
            settler: c.into(),
            early: early && !expired,
            price_base: price,
            collateral_base: c_base,
            debt_base: d_base,
            owed_units,
            owed_base: owed,
            repay_base: repay,
            repay_units,
            repay_collateral_units: settler_r,
            full_close: full,
            repay_confirmed: repay_units == 0,
            // Settlement commits on NEAR first: from here buy-back is refused (and vice versa)
            committed: true,
            legs,
            started_at: now,
        };
        self.emit(
            "settlement_started",
            json!({"rescue_id": rid, "settler": c, "early": s.early, "repay_units": repay_units.to_string(),
                   "full_close": full, "price_base": price.to_string(), "trust": "TEMPORARY reporter price"}),
        );
        // A verified market whose program outputs the debt index: the repay is proven from the
        // scaled debt, starting from this decision reading.
        let pid = self.rescue(rid)?.position_id;
        let verified_start = if self.is_verified(pid)? { self.watch_of(pid).last.filter(|l| l.di > 0) } else { None };
        if let Some(l) = verified_start {
            ensure!(l.block == h.r.block, "the decision reading is not the last verified reading");
            let need = if repay_units == 0 { 0 } else { math::mul_div(repay_units, RAY, l.di) + 1 };
            self.watch.entry(pid).or_default().settle = Some(SettleStart { rescue_id: rid, start: l, need });
        }
        let r = self.rescue_mut(rid)?;
        r.state = RescueState::Settling;
        r.settlement = Some(s);
        Ok(())
    }

    /// Any registered steward or holder of a claim in this rescue (not the settler) may take over a settlement whose repayment
    /// hasn't been supplied 3 min after it started. The taker supplies the repayment and receives the
    /// R leg plus a fee of `TAKEOVER_FEE_BPS` of it, taken from the stalled settler's own leg and
    /// capped at that claim's premium. What leaves the position is unchanged, so the borrower's cost
    /// is still exactly the premium. One takeover per settlement; the 15-min fallback stays.
    pub fn take_over_settlement(&mut self, c: &str, rid: u64, now: u64) -> R<()> {
        let holds_claim = self.claims.values().any(|x| x.rescue_id == rid && x.owner == c && x.status == ClaimStatus::Open);
        ensure!(self.stewards.contains(c) || holds_claim, "only a registered steward or a claim holder of this rescue");
        let to = *self.evm_payouts.get(c).ok_or("set_evm_payout first")?;
        let r = self.rescue(rid)?;
        let s = match (&r.state, &r.settlement) {
            (RescueState::Settling, Some(s)) => s.clone(),
            _ => return Err("not settling".into()),
        };
        ensure!(!s.repay_confirmed, "repayment already supplied: nothing to take over");
        ensure!(now >= s.started_at + TAKEOVER_AFTER_NS, "settler still has time to repay");
        ensure!(c != s.settler, "the settler can't take over its own settlement");
        let mine: Vec<&Claim> = self.claims.values().filter(|x| x.rescue_id == rid && x.status == ClaimStatus::Open && x.owner == s.settler).collect();
        let stalled = mine.first().ok_or("settlement already taken over")?;
        let (stalled_id, stalled_premium) = (stalled.token_id.clone(), stalled.premium_units);
        let r_units = s.repay_collateral_units;
        let i = s.legs.iter().position(|l| l.claim_id.as_deref() == Some(stalled_id.as_str())).ok_or("settler leg missing")?;
        let AmountArg::Exact(leg_units) = s.legs[i].amount else { return Err("settler leg not exact".into()) };
        ensure!(leg_units >= r_units, "settler leg below its R");
        // the fee comes out of the stalled settler's premium leg (capped at it), never the borrower
        let j = (i + 1..s.legs.len()).find(|&k| s.legs[k].claim_id.as_deref() == Some(stalled_id.as_str()));
        let prem_leg = j.map_or(0, |k| if let AmountArg::Exact(u) = s.legs[k].amount { u } else { 0 });
        let fee = (r_units * TAKEOVER_FEE_BPS / BPS).min(stalled_premium).min(prem_leg);
        let s = self.rescue_mut(rid)?.settlement.as_mut().unwrap();
        s.legs[i].amount = AmountArg::Exact(leg_units - r_units);
        // the taker's R joins the principal legs; its fee joins the premium legs (paid last, and
        // forfeited with the premium it came from)
        let first_premium = (0..s.legs.len()).find(|&k| Self::is_premium_leg(&s.legs, k) || s.legs[k].amount == AmountArg::Max).unwrap_or(s.legs.len());
        s.legs.insert(first_premium, Leg { to, amount: AmountArg::Exact(r_units), claim_id: None, done: false });
        if fee > 0 {
            let k = j.unwrap() + 1; // shifted by the insert above
            s.legs[k].amount = AmountArg::Exact(prem_leg - fee);
            let at = if s.legs.last().is_some_and(|l| l.amount == AmountArg::Max) { s.legs.len() - 1 } else { s.legs.len() };
            s.legs.insert(at, Leg { to, amount: AmountArg::Exact(fee), claim_id: Some(stalled_id.clone()), done: false });
        }
        s.legs.retain(|l| l.amount != AmountArg::Exact(0));
        let old = std::mem::replace(&mut s.settler, c.into());
        self.emit(
            "settlement_taken_over",
            json!({"rescue_id": rid, "from": old, "to": c, "r_units": r_units.to_string(), "fee_units": fee.to_string()}),
        );
        Ok(())
    }

    /// Fallback, anyone: the settler hasn't supplied the repayment within 15 min. The
    /// settlement drops the repay step and just withdraws each claim's owed units to its owner.
    /// Needs a fresh reading, and Aave's HF after those withdrawals ≥ 1 (else Aave would revert
    /// them; the repay path is then the only way out). Afterwards the claims are cleared, net HF =
    /// Aave HF, and a fresh first rescue may follow.
    pub fn settle_fallback(&mut self, rid: u64, now: u64) -> R<()> {
        let max_age = self.params.max_price_age_ns;
        let r = self.rescue(rid)?;
        let s = match (&r.state, &r.settlement) {
            (RescueState::Settling, Some(s)) => s.clone(),
            _ => return Err("not settling".into()),
        };
        ensure!(!s.repay_confirmed, "repay already confirmed: no fallback");
        ensure!(now >= s.started_at + SETTLE_FALLBACK_NS, "settler still has time to repay");
        let p = self.position(r.position_id)?;
        let _ = max_age;
        let h = self.decision_reading(r.position_id, now)?;
        let m = self.market_of(p).clone();
        let open: Vec<Claim> = self.claims.values().filter(|x| x.rescue_id == rid && x.status == ClaimStatus::Open).cloned().collect();
        let owed_units: u128 = open.iter().map(|x| x.owed_units).sum();
        let price = h.r.collateral_price_base;
        let owed = math::units_to_base_ceil(owed_units, price, m.collateral_decimals);
        ensure!(h.r.collateral_base > owed, "collateral below what's owed: only the repay path can settle");
        let hf_after = math::hf_wad(h.r.collateral_base - owed, h.r.debt_base, m.lt_bps as u128);
        ensure!(hf_after >= math::WAD, "Aave HF after the withdrawals would be < 1: only the repay path can settle");
        let (mut legs, mut premium_legs) = (vec![], vec![]);
        for cl in &open {
            let to = *self.evm_payouts.get(&cl.owner).ok_or_else(|| format!("{} has no EVM payout", cl.owner))?;
            legs.push(Leg { to, amount: AmountArg::Exact(cl.share_units), claim_id: Some(cl.token_id.clone()), done: false });
            if cl.premium_units > 0 {
                premium_legs.push(Leg { to, amount: AmountArg::Exact(cl.premium_units), claim_id: Some(cl.token_id.clone()), done: false });
            }
        }
        legs.extend(premium_legs);
        let s = self.rescue_mut(rid)?.settlement.as_mut().unwrap();
        s.price_base = price;
        s.collateral_base = h.r.collateral_base;
        s.debt_base = h.r.debt_base;
        s.owed_units = owed_units;
        s.owed_base = owed;
        s.repay_base = 0;
        s.repay_units = 0;
        s.repay_collateral_units = 0;
        s.full_close = false;
        s.repay_confirmed = true;
        s.legs = legs;
        self.emit(
            "settlement_fallback",
            json!({"rescue_id": rid, "owed_units": owed_units.to_string(), "hf_after_wad": hf_after.to_string(),
                   "price_base": price.to_string(), "trust": "TEMPORARY reporter price"}),
        );
        Ok(())
    }

    /// TEMPORARY trusted reporter: the reporter saw the settler's `repay(onBehalfOf = position)`.
    /// From here the settlement is committed and buy-back is closed.
    pub fn confirm_settlement_repay(&mut self, c: &str, rid: u64, evm_tx: &str, units: u128, block: u64) -> R<()> {
        self.only_reporter(c)?;
        let pid = self.rescue(rid)?.position_id;
        ensure!(self.watch_of(pid).settle.map_or(true, |st| st.rescue_id != rid), "verified market: the repay is confirmed by a proof of the debt drop");
        if !self.use_key(format!("repay:{evm_tx}")) {
            return Ok(());
        }
        self.note_event(pid, block);
        let r = self.rescue_mut(rid)?;
        ensure!(r.state == RescueState::Settling, "not settling");
        let s = r.settlement.as_mut().unwrap();
        ensure!(!s.repay_confirmed, "repay already confirmed");
        ensure!(units >= s.repay_units, "repaid {units} < required {}", s.repay_units);
        s.repay_confirmed = true;
        s.committed = true;
        self.emit("settlement_repaid", json!({"rescue_id": rid, "evm_tx": evm_tx}));
        Ok(())
    }

    /// Anyone: sign the next settlement withdraw (only from `Settling`, after the repay).
    pub fn settle_next(&mut self, rid: u64, gas: GasArgs, now: u64) -> R<SignPlan> {
        let r = self.rescue(rid)?;
        ensure!(r.state == RescueState::Settling, "not settling");
        let s = r.settlement.as_ref().unwrap();
        ensure!(s.repay_confirmed, "settler's repay not confirmed yet");
        let leg_i = s.legs.iter().position(|l| !l.done).ok_or("all legs done")?;
        let leg = s.legs[leg_i].clone();
        let pid = r.position_id;
        let p = self.position(pid)?;
        if let Some(t) = &p.pending {
            return Err(format!("tx in flight: nonce {} unconfirmed", t.tx.nonce));
        }
        // Each leg needs a reading at least as new as the last event (the repay or the previous
        // leg): a liquidation since then is seen first, so no leg pays a premium after one.
        self.decision_reading(pid, now)?;
        let p = self.position(pid)?;
        let m = self.market_of(p);
        Self::check_gas(m, &gas, TRANSFER_GAS)?;
        let tx = TxFields { chain_id: m.chain_id, nonce: p.next_nonce, to: m.pool, data: evm::withdraw(&m.collateral, leg.amount, &leg.to), gas };
        self.rescue_mut(rid)?.settlement.as_mut().unwrap().committed = true;
        self.set_pending(pid, tx, TxKind::Settlement { rescue_id: rid, leg: leg_i as u32 }, now)
    }

    fn settlement_leg_done(&mut self, rid: u64, leg: u32) -> R<()> {
        let pid = self.rescue(rid)?.position_id;
        let amount = self.rescue(rid)?.settlement.as_ref().and_then(|s| s.legs.get(leg as usize)).map(|l| l.amount);
        let exact = self.watch_of(pid).last.is_some() && self.is_verified(pid)?;
        if let Some(a) = amount {
            let allow = self.withdraw_allowance(pid, &a, exact);
            if let Some(w) = self.watch.get_mut(&pid) {
                if w.hw > 0 {
                    w.withdrawn = w.withdrawn.saturating_add(allow);
                }
            }
        }
        let r = self.rescue_mut(rid)?;
        let s = r.settlement.as_mut().ok_or("no settlement")?;
        let l = s.legs.get_mut(leg as usize).ok_or("no such leg")?;
        l.done = true;
        let claim = l.claim_id.clone();
        let all = s.legs.iter().all(|l| l.done);
        let claim_done = claim.as_ref().is_some_and(|id| s.legs.iter().filter(|l| l.claim_id.as_ref() == Some(id)).all(|l| l.done));
        let mut settled: Vec<String> = if claim_done { claim.into_iter().collect() } else { vec![] };
        if all {
            settled.extend(self.claims.values().filter(|c| c.rescue_id == rid && c.status == ClaimStatus::Open).map(|c| c.token_id.clone()));
            settled.dedup();
        }
        for id in settled {
            let cl = self.claims.get_mut(&id).unwrap();
            if cl.status != ClaimStatus::Open {
                continue;
            }
            cl.status = ClaimStatus::Settled;
            let owner = cl.owner.clone();
            self.emit("nft_burn", json!({"owner_id": owner, "token_ids": [id], "memo": "settled"}));
        }
        if all {
            self.close_rescue(rid, RescueState::Settled)?;
            self.emit("settled", json!({"rescue_id": rid}));
        }
        Ok(())
    }

    // ── NEP-171 ──
    pub fn nft_transfer(&mut self, c: &str, token_id: &str, receiver: &str) -> R<()> {
        let cl = self.claims.get(token_id).ok_or("no such token")?;
        ensure!(cl.status == ClaimStatus::Open, "token burned");
        ensure!(cl.owner == c, "only the token owner");
        ensure!(receiver != c, "receiver is the owner");
        ensure!(self.rescue(cl.rescue_id)?.state == RescueState::Open, "claim is settling");
        let claim = self.claims.get_mut(token_id).unwrap();
        claim.owner = receiver.into();
        self.emit("nft_transfer", json!({"old_owner_id": c, "new_owner_id": receiver, "token_ids": [token_id]}));
        Ok(())
    }
}

/// The OutLayer `request_execution` arguments, built as text (no generic JSON values: keeps the
/// wasm, and its storage cost, small). The program's input names the market's collateral and
/// debt: the reserves it reports and the escrow tokens it proves. Aave's testnet tokens keep
/// balances at storage slot 0; mainnet tokens need their own.
pub fn outlayer_args(cfg: &VerifyConfig, position: &str, collateral: &str, debt: &str, payer: &str) -> String {
    let (c, d) = (collateral, debt);
    let input = format!(
        "{{\"position\":\"{position}\",\"block\":null,\"tokens\":[{{\"address\":\"{c}\",\"balances_slot\":0}},{{\"address\":\"{d}\",\"balances_slot\":0}}],\"reserves\":[\"{c}\",\"{d}\"]}}"
    )
    .replace('"', "\\\"");
    let secrets = match &cfg.secrets {
        Some((owner, profile)) => format!("{{\"profile\":\"{profile}\",\"account_id\":\"{owner}\"}}"),
        None => "null".into(),
    };
    format!(
        "{{\"source\":{{\"WasmUrl\":{{\"url\":\"{}\",\"hash\":\"{}\",\"build_target\":\"wasm32-wasip2\"}}}},\
\"resource_limits\":{{\"max_instructions\":20000000000,\"max_memory_mb\":128,\"max_execution_seconds\":120}},\
\"input_data\":\"{input}\",\
\"secrets_ref\":{secrets},\"response_format\":\"Json\",\"payer_account_id\":\"{payer}\",\"params\":null}}",
        cfg.wasm_url, cfg.wasm_hash
    )
}

