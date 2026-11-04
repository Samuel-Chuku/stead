//! Lifeline spike contract. Throwaway; never reused.
//! Q1: the contract itself asks the MPC signer for a secp256k1 signature.
//! The derived key is bound to (this contract's account id, path).
//! Q4: no raw-hash signing; every tx is built here so rules can inspect it.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, Promise};
use omni_transaction::evm::EVMTransaction;

/// Live `config().sign_call_gas_attachment_requirement_tera_gas` is 15; leave headroom.
const SIGN_GAS: Gas = Gas::from_tgas(50);
/// `SIGN_DEPOSIT_YOCTONEAR` in near/mpc.
const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// Aave V3 `withdraw(address,uint256,address)`.
const WITHDRAW_SELECTOR: [u8; 4] = [0x69, 0x32, 0x8d, 0xec];

/// Stored outside the contract struct so Q4 needs no state migration.
fn claim_key(path: &str) -> Vec<u8> {
    [b"claim:".as_slice(), path.as_bytes()].concat()
}

#[near(serializers = [json])]
pub enum Payload {
    /// 32-byte hash, hex encoded.
    Ecdsa(String),
}

#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

/// EIP-1559 fields; the contract builds and hashes the tx itself (Q2+).
#[near(serializers = [json])]
pub struct EvmTx {
    pub chain_id: U64,
    pub nonce: U64,
    /// 0x-prefixed 20-byte address.
    pub to: String,
    pub value: U128,
    /// 0x-prefixed calldata.
    pub data: String,
    pub gas_limit: U128,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
}

fn parse_hex(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).expect("bad hex")
}

#[allow(dead_code)]
#[ext_contract(mpc)]
trait MpcSigner {
    fn sign(&mut self, request: SignRequest);
}

#[near(contract_state)]
pub struct Contract {
    owner: AccountId,
    mpc_contract: AccountId,
}

impl Default for Contract {
    fn default() -> Self {
        env::panic_str("not initialized")
    }
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, mpc_contract: AccountId) -> Self {
        Self { owner, mpc_contract }
    }

    /// Q4: while a claim is open on `path`, refuse to sign any Aave `withdraw`.
    pub fn open_claim(&mut self, path: String) {
        require!(env::predecessor_account_id() == self.owner, "only owner");
        env::storage_write(&claim_key(&path), &[1]);
    }

    pub fn clear_claim(&mut self, path: String) {
        require!(env::predecessor_account_id() == self.owner, "only owner");
        env::storage_remove(&claim_key(&path));
    }

    pub fn is_claim_open(&self, path: String) -> bool {
        env::storage_has_key(&claim_key(&path))
    }

    /// Q2+: build the EIP-1559 tx on-chain, keccak it, and request the signature.
    pub fn sign_evm_tx(&mut self, path: String, tx: EvmTx) -> Promise {
        require!(env::predecessor_account_id() == self.owner, "only owner");
        let to: [u8; 20] = parse_hex(&tx.to).try_into().expect("to must be 20 bytes");
        let input = parse_hex(&tx.data);
        if input.starts_with(&WITHDRAW_SELECTOR) {
            require!(!self.is_claim_open(path.clone()), "claim open: withdraw refused");
        }
        let evm_tx = EVMTransaction {
            chain_id: tx.chain_id.0,
            nonce: tx.nonce.0,
            to: Some(to),
            value: tx.value.0,
            input,
            gas_limit: tx.gas_limit.0,
            max_fee_per_gas: tx.max_fee_per_gas.0,
            max_priority_fee_per_gas: tx.max_priority_fee_per_gas.0,
            access_list: vec![],
        };
        let hash = env::keccak256(&evm_tx.build_for_signing());
        mpc::ext(self.mpc_contract.clone())
            .with_attached_deposit(SIGN_DEPOSIT)
            .with_static_gas(SIGN_GAS)
            .sign(SignRequest {
                path,
                payload_v2: Payload::Ecdsa(hex::encode(hash)),
                domain_id: 0,
            })
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }
}
