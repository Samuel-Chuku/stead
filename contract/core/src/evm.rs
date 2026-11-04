//! EVM calldata the contract builds itself (rule 3: no raw calldata, no raw hashes).
//! Selectors computed with `cast sig` on 2026-11-04.

use borsh::{BorshDeserialize, BorshSerialize};
use omni_transaction::evm::EVMTransaction;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub const SEL_APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3]; // approve(address,uint256)
pub const SEL_TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb]; // transfer(address,uint256)
pub const SEL_SUPPLY: [u8; 4] = [0x61, 0x7b, 0xa0, 0x37]; // supply(address,uint256,address,uint16)
pub const SEL_BORROW: [u8; 4] = [0xa4, 0x15, 0xbc, 0xad]; // borrow(address,uint256,uint256,uint16,address)
pub const SEL_REPAY: [u8; 4] = [0x57, 0x3a, 0xde, 0x81]; // repay(address,uint256,uint256,address)
pub const SEL_WITHDRAW: [u8; 4] = [0x69, 0x32, 0x8d, 0xec]; // withdraw(address,uint256,address)

/// Aave variable-rate mode.
const VARIABLE: u128 = 2;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Debug, BorshSerialize, BorshDeserialize)]
pub struct EvmAddr(pub [u8; 20]);

impl EvmAddr {
    pub fn parse(s: &str) -> Result<Self, String> {
        let b = hex::decode(s.trim_start_matches("0x")).map_err(|_| format!("bad address {s}"))?;
        let a: [u8; 20] = b.try_into().map_err(|_| format!("address must be 20 bytes: {s}"))?;
        Ok(Self(a))
    }
    pub fn to_hex(&self) -> String {
        format!("0x{}", hex::encode(self.0))
    }
}

impl Serialize for EvmAddr {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for EvmAddr {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = <String as Deserialize>::deserialize(d)?;
        EvmAddr::parse(&s).map_err(serde::de::Error::custom)
    }
}

/// An amount argument. `Max` encodes uint256 max (Aave: "all" for repay/withdraw).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "snake_case")]
pub enum AmountArg {
    Exact(#[serde(with = "crate::as_str")] u128),
    Max,
}

/// Which of the market's two underlying tokens. There is no way to name any other token,
/// so an aToken (or anything else) can never be approved or transferred.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenSide {
    Collateral,
    Debt,
}

/// The only things a borrower can ask the contract to sign. Targets and recipients are
/// filled in by the contract from the market and position, never by the caller.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    /// `token.approve(Pool, amount)`.
    Approve { token: TokenSide, amount: AmountArg },
    /// `Pool.supply(collateral, amount, onBehalfOf = position, 0)`.
    Supply { #[serde(with = "crate::as_str")] amount: u128 },
    /// `Pool.borrow(debt, amount, 2, 0, onBehalfOf = position)`.
    Borrow { #[serde(with = "crate::as_str")] amount: u128 },
    /// `Pool.repay(debt, amount, 2, onBehalfOf = position)`.
    Repay { amount: AmountArg },
    /// `Pool.withdraw(collateral, amount, to = payout)`.
    Withdraw { amount: AmountArg },
    /// `debt.transfer(payout, amount)` (loan proceeds).
    TransferDebt { #[serde(with = "crate::as_str")] amount: u128 },
}

impl Action {
    pub fn name(&self) -> &'static str {
        match self {
            Action::Approve { .. } => "approve",
            Action::Supply { .. } => "supply",
            Action::Borrow { .. } => "borrow",
            Action::Repay { .. } => "repay",
            Action::Withdraw { .. } => "withdraw",
            Action::TransferDebt { .. } => "transfer",
        }
    }
}

/// EIP-1559 fee fields chosen by the caller; checked against the market caps.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct GasArgs {
    #[serde(with = "crate::as_str")]
    pub gas_limit: u128,
    #[serde(with = "crate::as_str")]
    pub max_fee_per_gas: u128,
    #[serde(with = "crate::as_str")]
    pub max_priority_fee_per_gas: u128,
}

/// A fully built EIP-1559 tx. `value` is always 0 (rule: gas caps, value == 0).
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct TxFields {
    pub chain_id: u64,
    pub nonce: u64,
    pub to: EvmAddr,
    #[serde(with = "hex_bytes")]
    pub data: Vec<u8>,
    pub gas: GasArgs,
}

impl TxFields {
    pub fn to_evm(&self) -> EVMTransaction {
        EVMTransaction {
            chain_id: self.chain_id,
            nonce: self.nonce,
            to: Some(self.to.0),
            value: 0,
            input: self.data.clone(),
            gas_limit: self.gas.gas_limit,
            max_fee_per_gas: self.gas.max_fee_per_gas,
            max_priority_fee_per_gas: self.gas.max_priority_fee_per_gas,
            access_list: vec![],
        }
    }
    pub fn selector(&self) -> Option<[u8; 4]> {
        self.data.get(..4).map(|s| s.try_into().unwrap())
    }
}

pub mod hex_bytes {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{}", hex::encode(v)))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = <String as Deserialize>::deserialize(d)?;
        hex::decode(s.trim_start_matches("0x")).map_err(serde::de::Error::custom)
    }
}

fn w_addr(a: &EvmAddr) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(&a.0);
    w
}

fn w_u128(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

fn w_amount(a: AmountArg) -> [u8; 32] {
    match a {
        AmountArg::Exact(v) => w_u128(v),
        AmountArg::Max => [0xff; 32],
    }
}

fn call(sel: [u8; 4], words: &[[u8; 32]]) -> Vec<u8> {
    let mut d = sel.to_vec();
    for w in words {
        d.extend_from_slice(w);
    }
    d
}

pub fn approve(spender: &EvmAddr, amount: AmountArg) -> Vec<u8> {
    call(SEL_APPROVE, &[w_addr(spender), w_amount(amount)])
}
pub fn transfer(to: &EvmAddr, amount: u128) -> Vec<u8> {
    call(SEL_TRANSFER, &[w_addr(to), w_u128(amount)])
}
pub fn supply(asset: &EvmAddr, amount: u128, on_behalf: &EvmAddr) -> Vec<u8> {
    call(SEL_SUPPLY, &[w_addr(asset), w_u128(amount), w_addr(on_behalf), w_u128(0)])
}
pub fn borrow(asset: &EvmAddr, amount: u128, on_behalf: &EvmAddr) -> Vec<u8> {
    call(SEL_BORROW, &[w_addr(asset), w_u128(amount), w_u128(VARIABLE), w_u128(0), w_addr(on_behalf)])
}
pub fn repay(asset: &EvmAddr, amount: AmountArg, on_behalf: &EvmAddr) -> Vec<u8> {
    call(SEL_REPAY, &[w_addr(asset), w_amount(amount), w_u128(VARIABLE), w_addr(on_behalf)])
}
pub fn withdraw(asset: &EvmAddr, amount: AmountArg, to: &EvmAddr) -> Vec<u8> {
    call(SEL_WITHDRAW, &[w_addr(asset), w_amount(amount), w_addr(to)])
}

/// Decode word `i` (0-based, after the selector) as an address. Test and view helper.
pub fn arg_addr(data: &[u8], i: usize) -> EvmAddr {
    let w = &data[4 + 32 * i..4 + 32 * (i + 1)];
    EvmAddr(w[12..].try_into().unwrap())
}

/// RLP encodes `r` and `s` as integers: no leading zero bytes. omni-transaction appends them as
/// raw byte strings, so a signature whose r (or s) starts with 0x00 (~1 in 128) would produce a
/// tx every node refuses to decode. Found in a demo run; trim before assembling.
pub fn minimal_be(b: &[u8]) -> Vec<u8> {
    let i = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    b[i..].to_vec()
}

/// The signed raw EIP-1559 tx for `tx` with (v, r, s), r and s as minimal big-endian integers.
pub fn signed_raw(tx: &TxFields, v: u64, r: &[u8], s: &[u8]) -> Vec<u8> {
    let sig = omni_transaction::evm::types::Signature { v, r: minimal_be(r), s: minimal_be(s) };
    tx.to_evm().build_with_signature(&sig)
}
