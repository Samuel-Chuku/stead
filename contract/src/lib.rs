//! Stead NEAR contract: a thin wrapper around `stead-core` (every rule lives there).
//!
//! This layer only: reads the caller / block time / deposit, calls the core, turns sign
//! plans into MPC `sign` requests (signed raw txs are stored on-chain), sends NEAR
//! transfers (bond refunds and slashes), logs NEP-297 events, and serves views + NEP-171.
//!
//! Started from the Lifeline spike contract (Oct 2026): MPC request shape, gas/deposit
//! constants and the build-then-hash flow come from there.

use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};
use omni_transaction::evm::types::Signature;
use stead_core::{
    Action, Books, Claim, ClaimStatus, EvmAddr, GasArgs, HealthReport, Market, Params, PendingTx, Position, Rescue,
    SignPlan, Stead, SteadV3, Transfer, VerifiedOutput, VerifyConfig,
};

/// The stored contract before steward self-registration, for `migrate`.
#[derive(near_sdk::borsh::BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
struct ContractV3 {
    core: SteadV3,
    mpc: AccountId,
}

/// OutLayer execution: generous gas for the yield/resume round trip; the callback is small.
const VERIFY_GAS: Gas = Gas::from_tgas(200);
const VERIFY_CALLBACK_GAS: Gas = Gas::from_tgas(40);

/// Live `config().sign_call_gas_attachment_requirement_tera_gas` is 15; leave headroom (spike).
const SIGN_GAS: Gas = Gas::from_tgas(50);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
const DERIVE_GAS: Gas = Gas::from_tgas(10);
/// `SIGN_DEPOSIT_YOCTONEAR` in near/mpc.
const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

#[near(serializers = [json])]
pub enum Payload {
    Ecdsa(String),
}

#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct AffinePoint {
    pub affine_point: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Scalar {
    pub scalar: String,
}

/// MPC Secp256k1 response: `{scheme, big_r:{affine_point}, s:{scalar}, recovery_id}`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct SignResponse {
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

#[allow(dead_code)]
#[ext_contract(mpc)]
trait MpcSigner {
    fn sign(&mut self, request: SignRequest);
    fn derived_public_key(&self, path: String, predecessor: Option<AccountId>, domain_id: Option<u32>) -> String;
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct TokenMetadata {
    pub title: String,
    pub description: String,
    pub extra: String,
}

/// NEP-171 `Token`.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct JsonToken {
    pub token_id: String,
    pub owner_id: String,
    pub metadata: TokenMetadata,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct NftContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    core: Stead,
    mpc: AccountId,
}

fn ok<T>(r: Result<T, String>) -> T {
    r.unwrap_or_else(|e| env::panic_str(&e))
}

fn caller() -> String {
    env::predecessor_account_id().to_string()
}

/// OutLayer returns the program's stdout as JSON: the result object itself, a JSON string
/// holding it, or an envelope with it under `output` / `result` / `stdout`.
fn parse_verified(b: &[u8]) -> Option<VerifiedOutput> {
    use near_sdk::serde_json::from_slice;
    #[derive(near_sdk::serde::Deserialize)]
    #[serde(crate = "near_sdk::serde")]
    struct Envelope {
        output: Option<String>,
        result: Option<String>,
        stdout: Option<String>,
    }
    if let Ok(o) = from_slice::<VerifiedOutput>(b) {
        return Some(o);
    }
    if let Ok(s) = from_slice::<String>(b) {
        return from_slice::<VerifiedOutput>(s.as_bytes()).ok();
    }
    let e = from_slice::<Envelope>(b).ok()?;
    let s = e.output.or(e.result).or(e.stdout)?;
    from_slice::<VerifiedOutput>(s.as_bytes()).ok()
}

fn parse_addr(s: &str) -> EvmAddr {
    ok(EvmAddr::parse(s))
}

/// `secp256k1:<base58 of 64-byte X‖Y>` → keccak256 → last 20 bytes (verified in the spike).
fn address_from_derived_key(key: &str) -> Result<EvmAddr, String> {
    let b58 = key.strip_prefix("secp256k1:").ok_or("not a secp256k1 key")?;
    let raw = bs58::decode(b58).into_vec().map_err(|_| "bad base58")?;
    let xy: [u8; 64] = raw.try_into().map_err(|_| "key must be 64 bytes")?;
    let h = env::keccak256_array(&xy);
    Ok(EvmAddr(h[12..].try_into().unwrap()))
}

fn signature_from(r: &SignResponse) -> Result<Signature, String> {
    let big_r = hex::decode(&r.big_r.affine_point).map_err(|_| "bad big_r")?;
    let s = hex::decode(&r.s.scalar).map_err(|_| "bad s")?;
    if big_r.len() != 33 || s.len() != 32 {
        return Err("bad signature lengths".into());
    }
    // Compressed point: drop the 02/03 prefix → r = x coordinate (spike lifeline.py)
    Ok(Signature { v: r.recovery_id as u64, r: big_r[1..].to_vec(), s })
}

#[near]
impl Contract {
    /// `buyback_window_s` is for demo deployments only (e.g. 180 on the Sepolia demo contract);
    /// omitted, the window is the production 24 h.
    #[init]
    pub fn new(owner: AccountId, mpc: AccountId, reporter: AccountId, buyback_window_s: Option<u64>) -> Self {
        let mut core = Stead::new(owner.as_str(), reporter.as_str());
        if let Some(s) = buyback_window_s {
            ok(core.init_buyback_window(s * stead_core::SEC));
        }
        let mut c = Self { core, mpc };
        c.flush();
        c
    }

    /// One-off state migration to the self-registration layout (adds the removed-steward set).
    /// Only the contract account itself can call it, with the deploy.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: ContractV3 = env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"));
        Self { core: old.core.into(), mpc: old.mpc }
    }

    // ── verified reads (OutLayer) ──
    pub fn set_verify_config(&mut self, config: Option<VerifyConfig>) {
        ok(self.core.set_verify_config(&caller(), config));
    }

    /// Anyone: run the pinned proof program for a position on OutLayer. The attached deposit
    /// pays OutLayer (unused part refunded to the caller). The result is accepted only in this
    /// contract's own callback.
    #[payable]
    pub fn request_verified(&mut self, position_id: u64) -> Promise {
        let cfg = self.core.verify_cfg.clone().unwrap_or_else(|| env::panic_str("verified reads not configured"));
        ok(self.core.is_verified(position_id).and_then(|v| if v { Ok(()) } else { Err("not a verified market".into()) }));
        let addr = self.core.position(position_id).ok().and_then(|p| p.evm_address).unwrap_or_else(|| env::panic_str("no position address"));
        // built as text (no generic JSON values: keeps the wasm, and its storage cost, small)
        let secrets = match &cfg.secrets {
            Some((owner, profile)) => format!("{{\"profile\":\"{profile}\",\"account_id\":\"{owner}\"}}"),
            None => "null".into(),
        };
        let args = format!(
            "{{\"source\":{{\"WasmUrl\":{{\"url\":\"{}\",\"hash\":\"{}\",\"build_target\":\"wasm32-wasip2\"}}}},\
\"resource_limits\":{{\"max_instructions\":20000000000,\"max_memory_mb\":128,\"max_execution_seconds\":120}},\
\"input_data\":\"{{\\\"position\\\":\\\"{}\\\",\\\"block\\\":null}}\",\
\"secrets_ref\":{},\"response_format\":\"Json\",\"payer_account_id\":\"{}\",\"params\":null}}",
            cfg.wasm_url, cfg.wasm_hash, addr.to_hex(), secrets, env::predecessor_account_id()
        );
        let outlayer: AccountId = cfg.outlayer.parse().unwrap_or_else(|_| env::panic_str("bad outlayer account"));
        Promise::new(outlayer)
            .function_call("request_execution", args.into_bytes(), env::attached_deposit(), VERIFY_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(VERIFY_CALLBACK_GAS).on_verified(position_id))
    }

    /// OutLayer's answer: the proof program's stdout as JSON. Errors from the program, or a
    /// result for anything other than this position, change nothing.
    #[private]
    pub fn on_verified(&mut self, position_id: u64) -> Option<u64> {
        let bytes = match env::promise_result(0) {
            near_sdk::PromiseResult::Successful(b) => b,
            _ => {
                env::log_str("verified read failed: OutLayer returned no result");
                return None;
            }
        };
        let Some(out) = parse_verified(&bytes) else {
            let shown = String::from_utf8_lossy(&bytes[..bytes.len().min(300)]).to_string();
            env::log_str(&format!("verified read refused or unreadable: {shown}"));
            return None;
        };
        let res = match self.core.apply_verified(position_id, &out, env::block_timestamp()) {
            Ok(r) => r,
            Err(e) => {
                env::log_str(&format!("verified read not applied: {e}"));
                None
            }
        };
        self.flush();
        Self::pay(self.core.payouts.drain(..).collect());
        res
    }

    pub fn get_verify_config(&self) -> Option<VerifyConfig> {
        self.core.verify_cfg.clone()
    }
    pub fn get_verified(&self, position_id: u64) -> Option<stead_core::VerifiedState> {
        self.core.verified.get(&position_id).cloned()
    }

    fn flush(&mut self) {
        for e in self.core.events.drain(..) {
            env::log_str(&format!("EVENT_JSON:{e}"));
        }
    }

    fn pay(ts: Vec<Transfer>) {
        for t in ts.into_iter().filter(|t| t.amount > 0) {
            let to: AccountId = t.to.parse().unwrap_or_else(|_| env::panic_str("bad account"));
            Promise::new(to).transfer(NearToken::from_yoctonear(t.amount)).detach();
        }
    }

    fn request_sign(&mut self, plan: SignPlan) -> Promise {
        self.flush();
        let hash = env::keccak256(&plan.tx.to_evm().build_for_signing());
        mpc::ext(self.mpc.clone())
            .with_attached_deposit(SIGN_DEPOSIT)
            .with_static_gas(SIGN_GAS)
            .sign(SignRequest { path: plan.path, payload_v2: Payload::Ecdsa(hex::encode(hash)), domain_id: 0 })
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_signed(plan.position_id, plan.tx.nonce))
    }

    /// MPC callback: assemble the signed raw tx and store it publicly. Never panics,
    /// so a failed signature always rolls the nonce slot back.
    #[private]
    pub fn on_signed(&mut self, position_id: u64, nonce: u64, #[callback_result] r: Result<SignResponse, PromiseError>) -> Option<String> {
        let raw = r.ok().and_then(|resp| {
            let tx = self.core.position(position_id).ok()?.pending.as_ref()?.tx.clone();
            let sig = signature_from(&resp).ok()?;
            Some(stead_core::evm::signed_raw(&tx, sig.v, &sig.r, &sig.s))
        });
        let out = raw.as_ref().map(|b| format!("0x{}", hex::encode(b)));
        if let Err(e) = self.core.on_signed(position_id, nonce, raw) {
            env::log_str(&format!("on_signed ignored: {e}"));
        }
        self.flush();
        out
    }

    // ── owner ──
    pub fn add_market(&mut self, market: Market) -> u32 {
        let id = ok(self.core.add_market(&caller(), market));
        self.flush();
        id
    }
    pub fn set_params(&mut self, params: Params) {
        ok(self.core.set_params(&caller(), params));
    }
    pub fn set_role(&mut self, role: String, account_id: AccountId, enabled: bool) {
        ok(self.core.set_role(&caller(), &role, account_id.as_str(), enabled));
        self.flush();
    }
    pub fn set_paused(&mut self, paused: bool) {
        ok(self.core.set_paused(&caller(), paused));
    }

    // ── anyone ──
    pub fn set_evm_payout(&mut self, address: String) {
        ok(self.core.set_evm_payout(&caller(), parse_addr(&address)));
    }

    /// Anyone can become a steward: attach `STEWARD_DEPOSIT` (0.005 NEAR; the rest is refunded)
    /// and give the EVM address settlement pays. The owner can remove a steward: that stops new
    /// bids only, never its open claims, bonds or payouts.
    #[payable]
    pub fn register_steward(&mut self, payout: String) {
        let dep = env::attached_deposit().as_yoctonear();
        let ts = ok(self.core.register_steward(&caller(), parse_addr(&payout), dep));
        self.flush();
        Self::pay(ts);
    }
    pub fn get_steward_deposit(&self) -> U128 {
        U128(stead_core::STEWARD_DEPOSIT)
    }
    pub fn get_removed_stewards(&self) -> Vec<String> {
        self.core.removed_stewards.iter().cloned().collect()
    }

    // ── borrower ──
    /// Registers a position and derives its EVM address from the MPC key (never trusted from the caller).
    pub fn register_position(&mut self, market_id: u32, payout: String) -> Promise {
        let id = ok(self.core.register_position(&caller(), market_id, parse_addr(&payout)));
        self.flush();
        let path = self.core.position(id).unwrap().path.clone();
        mpc::ext(self.mpc.clone())
            .with_static_gas(DERIVE_GAS)
            .derived_public_key(path, Some(env::current_account_id()), Some(0))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_derived(id))
    }

    #[private]
    pub fn on_derived(&mut self, position_id: u64, #[callback_result] key: Result<String, PromiseError>) -> String {
        let key = key.unwrap_or_else(|_| env::panic_str("derived_public_key failed"));
        let addr = ok(address_from_derived_key(&key));
        ok(self.core.set_position_address(position_id, addr));
        self.flush();
        addr.to_hex()
    }

    pub fn sign_action(&mut self, position_id: u64, action: Action, gas: GasArgs) -> Promise {
        let plan = ok(self.core.sign_action(&caller(), position_id, action, gas, env::block_timestamp()));
        self.request_sign(plan)
    }

    pub fn burn_nonce(&mut self, position_id: u64, gas: GasArgs) -> Promise {
        let plan = ok(self.core.burn_nonce(&caller(), position_id, gas, env::block_timestamp()));
        self.request_sign(plan)
    }

    pub fn replace_pending(&mut self, position_id: u64, max_fee_per_gas: U128, max_priority_fee_per_gas: U128) -> Promise {
        let plan = ok(self.core.replace_pending(&caller(), position_id, max_fee_per_gas.0, max_priority_fee_per_gas.0));
        self.request_sign(plan)
    }

    pub fn request_payout_change(&mut self, position_id: u64, payout: String) {
        ok(self.core.request_payout_change(&caller(), position_id, parse_addr(&payout), env::block_timestamp()));
    }

    pub fn apply_payout_change(&mut self, position_id: u64) {
        ok(self.core.apply_payout_change(position_id, env::block_timestamp()));
    }

    // ── reporter (TEMPORARY trusted role) ──
    pub fn report_health(&mut self, position_id: u64, report: HealthReport) -> Option<u64> {
        let r = ok(self.core.report_health(&caller(), position_id, report, env::block_timestamp()));
        self.flush();
        Self::pay(self.core.payouts.drain(..).collect()); // bond refunds after a liquidation
        r
    }
    /// A registered steward takes over a stalled settlement's repayment.
    pub fn take_over_settlement(&mut self, rescue_id: u64) {
        ok(self.core.take_over_settlement(&caller(), rescue_id, env::block_timestamp()));
        self.flush();
    }
    pub fn confirm_nonce(&mut self, position_id: u64, onchain_nonce: u64, success: bool, block: u64) {
        ok(self.core.confirm_nonce(&caller(), position_id, onchain_nonce, success, block));
        self.flush();
    }
    pub fn confirm_topup(&mut self, rescue_id: u64, steward: AccountId, units: U128, evm_tx: String, block: u64) {
        let ts = ok(self.core.confirm_topup(&caller(), rescue_id, steward.as_str(), units.0, &evm_tx, block, env::block_timestamp()));
        self.flush();
        Self::pay(ts);
    }
    /// The position address's own balances of the claim asset and the debt asset at `block`
    /// (buy-back escrow). Any buy-back they cover commits at once.
    pub fn confirm_escrow(&mut self, position_id: u64, collateral_units: U128, debt_units: U128, block: u64) {
        ok(self.core.confirm_escrow(&caller(), position_id, collateral_units.0, debt_units.0, block, env::block_timestamp()));
        self.flush();
    }
    /// A registered steward repaid on the position without a committed settlement of its own.
    pub fn confirm_stray_repay(&mut self, position_id: u64, steward: AccountId, units: U128, evm_tx: String, block: u64) {
        ok(self.core.confirm_stray_repay(&caller(), position_id, steward.as_str(), units.0, &evm_tx, block));
        self.flush();
    }
    pub fn confirm_settlement_repay(&mut self, rescue_id: u64, evm_tx: String, units: U128, block: u64) {
        ok(self.core.confirm_settlement_repay(&caller(), rescue_id, &evm_tx, units.0, block));
        self.flush();
    }
    /// Anyone: sign the next queued payout from the position (buy-back, refund, reimbursement).
    pub fn pay_next(&mut self, position_id: u64, gas: GasArgs) -> Promise {
        let plan = ok(self.core.pay_next(position_id, gas, env::block_timestamp()));
        self.request_sign(plan)
    }
    /// Anyone, 15 min after a settlement started without its repayment.
    pub fn settle_fallback(&mut self, rescue_id: u64) {
        ok(self.core.settle_fallback(rescue_id, env::block_timestamp()));
        self.flush();
    }

    // ── stewards ──
    #[payable]
    pub fn bid(&mut self, rescue_id: u64, premium_bps: u32, amount_units: U128) {
        let dep = env::attached_deposit().as_yoctonear();
        let ts = ok(self.core.bid(&caller(), rescue_id, premium_bps, amount_units.0, dep, env::block_timestamp()));
        self.flush();
        Self::pay(ts);
    }

    // ── anyone ──
    pub fn close_auction(&mut self, rescue_id: u64) {
        let ts = ok(self.core.close_auction(rescue_id, env::block_timestamp()));
        self.flush();
        Self::pay(ts);
    }
    pub fn expire_topup(&mut self, rescue_id: u64) {
        let ts = ok(self.core.expire_topup(rescue_id, env::block_timestamp()));
        self.flush();
        Self::pay(ts);
    }
    /// Claim owner: start settlement B (after the buy-back window, or early when HF < 1.05).
    pub fn start_settlement(&mut self, rescue_id: u64) {
        ok(self.core.start_settlement(&caller(), rescue_id, env::block_timestamp()));
        self.flush();
    }
    pub fn settle_next(&mut self, rescue_id: u64, gas: GasArgs) -> Promise {
        let plan = ok(self.core.settle_next(rescue_id, gas, env::block_timestamp()));
        self.request_sign(plan)
    }

    // ── views ──
    pub fn get_params(&self) -> Params {
        self.core.params.clone()
    }
    pub fn get_market(&self, market_id: u32) -> Option<Market> {
        self.core.markets.get(&market_id).cloned()
    }
    pub fn get_position(&self, position_id: u64) -> Option<Position> {
        self.core.positions.get(&position_id).cloned()
    }
    /// (Aave HF, borrower's own HF net of open claims, Σ owed units) at the latest reading.
    pub fn get_net_health(&self, position_id: u64) -> Option<(U128, U128, U128)> {
        let p = self.core.positions.get(&position_id)?;
        let h = p.health.as_ref()?;
        let net = self.core.net_hf_wad(position_id, &h.r).ok()?;
        Some((U128(h.r.hf_wad), U128(net), U128(self.core.open_owed_units(position_id))))
    }
    /// The signed raw tx (if any) for anyone to broadcast.
    /// Buy-back escrow, queued payouts, last event block and stray repays of a position.
    pub fn get_books(&self, position_id: u64) -> Books {
        self.core.book(position_id)
    }
    pub fn get_pending_tx(&self, position_id: u64) -> Option<PendingTx> {
        self.core.positions.get(&position_id).and_then(|p| p.pending.clone())
    }
    pub fn get_rescue(&self, rescue_id: u64) -> Option<Rescue> {
        self.core.rescues.get(&rescue_id).cloned()
    }
    pub fn get_rescues(&self, from: u64, limit: u64) -> Vec<Rescue> {
        self.core.rescues.range(from..).take(limit.min(50) as usize).map(|(_, r)| r.clone()).collect()
    }
    pub fn get_claim(&self, token_id: String) -> Option<Claim> {
        self.core.claims.get(&token_id).cloned()
    }
    /// A steward's registered EVM payout (also the wallet its top-ups must come from).
    pub fn get_evm_payout(&self, account_id: AccountId) -> Option<String> {
        self.core.evm_payouts.get(account_id.as_str()).map(|a| a.to_hex())
    }
    pub fn get_roles(&self) -> (String, Vec<String>, Vec<String>, bool) {
        let c = &self.core;
        (c.owner.clone(), c.reporters.iter().cloned().collect(), c.stewards.iter().cloned().collect(), c.paused)
    }

    // ── NEP-171 / NEP-177 ──
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u32>, memo: Option<String>) {
        let _ = (approval_id, memo);
        assert_eq!(env::attached_deposit(), NearToken::from_yoctonear(1), "requires 1 yoctoNEAR");
        ok(self.core.nft_transfer(&caller(), &token_id, receiver_id.as_str()));
        self.flush();
    }

    pub fn nft_token(&self, token_id: String) -> Option<JsonToken> {
        self.core.claims.get(&token_id).filter(|c| c.status == ClaimStatus::Open).map(json_token)
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let from = from_index.map(|x| x.0 as usize).unwrap_or(0);
        self.core
            .claims
            .values()
            .filter(|c| c.status == ClaimStatus::Open && c.owner == account_id.as_str())
            .skip(from)
            .take(limit.unwrap_or(50).min(50) as usize)
            .map(json_token)
            .collect()
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.core.claims.values().filter(|c| c.status == ClaimStatus::Open).count() as u128)
    }

    pub fn nft_metadata(&self) -> NftContractMetadata {
        NftContractMetadata { spec: "nft-1.0.0".into(), name: "Stead rescue claims".into(), symbol: "STEAD".into() }
    }
}

fn json_token(c: &Claim) -> JsonToken {
    JsonToken {
        token_id: c.token_id.clone(),
        owner_id: c.owner.clone(),
        metadata: TokenMetadata {
            title: format!("Stead claim {}", c.token_id),
            description: format!(
                "Rescue {} of position {}: owed {} units of {} (top-up {} + premium {}, {} bps)",
                c.rescue_id, c.position_id, c.owed_units, c.asset.to_hex(), c.share_units, c.premium_units, c.premium_bps
            ),
            extra: near_sdk::serde_json::to_string(c).unwrap_or_default(),
        },
    }
}
