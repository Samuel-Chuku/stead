//! Verified Aave V3 (v3.0) reads for Stead.
//!
//! 1. **Header agreement:** the block header (hash, stateRoot, timestamp, receiptsRoot) must be
//!    byte-identical from at least `min_agree` independent RPCs. Any disagreement is a failure.
//! 2. **Proofs:** every value used is a storage slot proven with `eth_getProof` against that
//!    stateRoot (account proof, then storage proof). One honest proof source is enough: a proof
//!    either links to the agreed root or it doesn't.
//! 3. **HF from raw storage:** Aave v3.0 integer math (rayMul, linear income, 3-term compounded
//!    debt, percentMul, wadDiv) with the header timestamp, exactly as `getUserAccountData`.
//!
//! Trust: the enclave running this, and that the header RPCs aren't a colluding majority. It is
//! not a light client.
pub mod mpt;
pub mod u256;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tiny_keccak::{Hasher, Keccak};
use u256::U256;

pub fn keccak(b: &[u8]) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(b);
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

/// JSON-RPC transport: the OutLayer build uses WASI HTTP, native tests use curl or a replay.
pub trait Rpc {
    fn call(&self, url: &str, method: &str, params: Value) -> Result<Value, String>;
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Config {
    pub chain_id: u64,
    pub header_rpcs: Vec<String>,
    pub proof_rpcs: Vec<String>,
    pub min_agree: usize,
    /// Read at head − depth (re-org margin).
    pub depth: u64,
    pub pool: String,
    pub oracle: String,
    /// ERC-20 tokens whose balance *held by the position address itself* is proven (escrow),
    /// with the storage slot of their `_balances` mapping.
    pub tokens: Vec<TokenSlot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TokenSlot {
    pub address: String,
    pub balances_slot: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Input {
    /// The position's EVM address.
    pub position: String,
    /// Optional fixed block (default: head − depth).
    pub block: Option<u64>,
}

/// The ≤ 900-byte result returned to the contract. Amounts are decimal strings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Output {
    pub v: u8,
    pub pos: String,
    pub chain: u64,
    pub block: u64,
    pub ts: u64,
    /// Health factor (WAD), collateral and debt in Aave base units (USD, 8 dp), average LT (bps).
    pub hf: String,
    pub cb: String,
    pub db: String,
    pub lt: u64,
    /// The position's account nonce (confirms its signed txs without a reporter).
    pub nonce: u64,
    /// Per reserve: asset, price (base), scaled aToken balance, scaled variable debt.
    pub res: Vec<ReserveOut>,
    /// Escrow: the position address's own token balances.
    pub bal: Vec<(String, String)>,
    pub agree: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReserveOut {
    pub a: String,
    pub p: String,
    pub cs: String,
    pub ds: String,
}

fn hexs(v: &Value) -> Result<String, String> {
    v.as_str().map(|s| s.to_lowercase()).ok_or_else(|| format!("expected hex string, got {v}"))
}
fn hex32(s: &str) -> Result<[u8; 32], String> {
    let b = hex::decode(s.trim_start_matches("0x")).map_err(|e| e.to_string())?;
    b.try_into().map_err(|_| format!("not 32 bytes: {s}"))
}
fn addr_bytes(a: &str) -> Result<[u8; 20], String> {
    let b = hex::decode(a.trim_start_matches("0x")).map_err(|e| e.to_string())?;
    b.try_into().map_err(|_| format!("not an address: {a}"))
}
fn word_addr(a: &str) -> Result<[u8; 32], String> {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(&addr_bytes(a)?);
    Ok(w)
}
fn u64_hex(v: &Value) -> Result<u64, String> {
    u64::from_str_radix(v.as_str().ok_or("expected hex")?.trim_start_matches("0x"), 16).map_err(|e| e.to_string())
}
/// Solidity `mapping(key => …)` at `slot`: keccak(key ‖ slot).
pub fn map_slot(key: [u8; 32], slot: U256) -> U256 {
    let mut b = key.to_vec();
    b.extend(slot.to_be_bytes());
    U256::from_be_slice(&keccak(&b)).unwrap()
}
fn as_addr(v: U256) -> String {
    format!("0x{}", hex::encode(&v.to_be_bytes()[12..]))
}

/// The agreed header: every listed RPC returns the same (hash, stateRoot, timestamp, receiptsRoot).
#[derive(Debug, Clone, PartialEq)]
pub struct Header {
    pub number: u64,
    pub hash: String,
    pub state_root: [u8; 32],
    pub receipts_root: [u8; 32],
    pub timestamp: u64,
    pub agree: usize,
}

pub fn agreed_header(rpc: &dyn Rpc, cfg: &Config, block: u64) -> Result<Header, String> {
    let mut seen: Vec<(String, String, String, u64)> = vec![];
    for url in &cfg.header_rpcs {
        if let Ok(h) = rpc.call(url, "eth_getBlockByNumber", json!([format!("0x{block:x}"), false])) {
            if h.is_null() {
                continue;
            }
            seen.push((hexs(&h["hash"])?, hexs(&h["stateRoot"])?, hexs(&h["receiptsRoot"])?, u64_hex(&h["timestamp"])?));
        }
    }
    let first = seen.first().cloned().ok_or("no RPC returned the header")?;
    let agree = seen.iter().filter(|x| **x == first).count();
    if seen.iter().any(|x| *x != first) {
        return Err(format!("header disagreement at block {block}: {} distinct answers", {
            let mut u = seen.clone();
            u.dedup();
            u.len()
        }));
    }
    if agree < cfg.min_agree {
        return Err(format!("only {agree} RPCs agree on block {block} (need {})", cfg.min_agree));
    }
    Ok(Header { number: block, hash: first.0, state_root: hex32(&first.1)?, receipts_root: hex32(&first.2)?, timestamp: first.3, agree })
}

/// Storage reads proven against the agreed state root.
pub struct Prover<'a> {
    rpc: &'a dyn Rpc,
    cfg: &'a Config,
    pub header: Header,
    pub slots_read: usize,
    pub calls: usize,
}

pub struct ProvenAccount {
    pub nonce: u64,
    pub storage_root: [u8; 32],
    pub values: Vec<U256>,
}

impl<'a> Prover<'a> {
    pub fn new(rpc: &'a dyn Rpc, cfg: &'a Config, header: Header) -> Self {
        Prover { rpc, cfg, header, slots_read: 0, calls: 0 }
    }

    /// `eth_getProof(account, slots)` from the first proof RPC that answers with a proof that
    /// verifies; returns the account nonce and the proven slot values.
    pub fn read(&mut self, account: &str, slots: &[U256]) -> Result<ProvenAccount, String> {
        let keys: Vec<String> = slots.iter().map(|s| format!("0x{}", hex::encode(s.to_be_bytes()))).collect();
        let mut last_err = String::from("no proof RPC configured");
        for url in self.cfg.proof_rpcs.clone() {
            self.calls += 1;
            let res = match self.rpc.call(&url, "eth_getProof", json!([account, keys, format!("0x{:x}", self.header.number)])) {
                Ok(r) => r,
                Err(e) => {
                    last_err = e;
                    continue;
                }
            };
            match self.check(account, slots, &res) {
                Ok(p) => {
                    self.slots_read += slots.len();
                    return Ok(p);
                }
                Err(e) => last_err = format!("{url}: {e}"),
            }
        }
        Err(last_err)
    }

    fn check(&self, account: &str, slots: &[U256], res: &Value) -> Result<ProvenAccount, String> {
        let nodes = |v: &Value| -> Result<Vec<Vec<u8>>, String> {
            v.as_array().ok_or("proof not a list")?.iter().map(|n| hex::decode(n.as_str().unwrap_or("").trim_start_matches("0x")).map_err(|e| e.to_string())).collect()
        };
        let path = keccak(&addr_bytes(account)?);
        let acct = mpt::verify(self.header.state_root, path, &nodes(&res["accountProof"])?).map_err(|e| format!("account proof: {e:?}"))?;
        let (nonce, storage_root) = match acct {
            Some(rlp_bytes) => {
                let r = rlp::Rlp::new(&rlp_bytes);
                let nonce: u64 = r.val_at(0).map_err(|e| e.to_string())?;
                let sr: Vec<u8> = r.val_at(2).map_err(|e| e.to_string())?;
                (nonce, sr.try_into().map_err(|_| "storage root length")?)
            }
            None => (0, keccak(&[0x80])), // absent account: empty trie
        };
        let claimed = hex32(res["storageHash"].as_str().ok_or("no storageHash")?)?;
        if claimed != storage_root {
            return Err("storageHash doesn't match the proven account".into());
        }
        let sp = res["storageProof"].as_array().ok_or("no storageProof")?;
        if sp.len() != slots.len() {
            return Err("storage proof count mismatch".into());
        }
        let mut values = vec![];
        for (slot, p) in slots.iter().zip(sp) {
            let key = U256::from_hex(p["key"].as_str().ok_or("no key")?).ok_or("bad key")?;
            if key != *slot {
                return Err(format!("proof for the wrong slot {key}"));
            }
            let v = mpt::verify(storage_root, keccak(&slot.to_be_bytes()), &nodes(&p["proof"])?).map_err(|e| format!("storage proof {slot}: {e:?}"))?;
            let val = match v {
                Some(enc) => {
                    let d: Vec<u8> = rlp::Rlp::new(&enc).as_val().map_err(|e| e.to_string())?;
                    U256::from_be_slice(&d).ok_or("value too long")?
                }
                None => U256::ZERO,
            };
            values.push(val);
        }
        Ok(ProvenAccount { nonce, storage_root, values })
    }
}

// ── Aave v3.0 math (MathUtils / WadRayMath / PercentageMath) ──
pub fn ray() -> U256 {
    U256::pow10(27)
}
pub fn wad() -> U256 {
    U256::pow10(18)
}
const SECONDS_PER_YEAR: u128 = 365 * 24 * 3600;
pub fn ray_mul(a: U256, b: U256) -> U256 {
    (a * b + ray() / U256::from(2u128)) / ray()
}
pub fn percent_mul(v: U256, p: U256) -> U256 {
    (v * p + U256::from(5000u128)) / U256::from(10_000u128)
}
pub fn wad_div(a: U256, b: U256) -> U256 {
    (a * wad() + b / U256::from(2u128)) / b
}
pub fn linear_interest(rate: U256, last: u64, now: u64) -> U256 {
    ray() + rate * U256::from((now - last) as u128) / U256::from(SECONDS_PER_YEAR)
}
pub fn compounded_interest(rate: U256, last: u64, now: u64) -> U256 {
    let e = now - last;
    if e == 0 {
        return ray();
    }
    let (e, e1, e2) = (U256::from(e as u128), U256::from((e - 1) as u128), U256::from(if e > 2 { e - 2 } else { 0 } as u128));
    let spy = U256::from(SECONDS_PER_YEAR);
    let p2 = ray_mul(rate, rate) / (spy * spy);
    let p3 = ray_mul(p2, rate) / spy;
    ray() + rate * e / spy + e * e1 * p2 / U256::from(2u128) + e * e1 * e2 * p3 / U256::from(6u128)
}

/// Pool storage layout (Sepolia Pool v3.0, verified against the getters).
const RESERVES: u128 = 52;
const USERS_CONFIG: u128 = 53;
const RESERVES_LIST: u128 = 54;
const EMODE: u128 = 56;
const ATOKEN_USER_STATE: u128 = 52;
const DEBT_USER_STATE: u128 = 56;

/// Recompute the position's health exactly as `Pool.getUserAccountData`, from proven slots.
pub fn verify_position(rpc: &dyn Rpc, cfg: &Config, input: &Input) -> Result<Output, String> {
    let block = match input.block {
        Some(b) => b,
        None => {
            let head = u64_hex(&rpc.call(&cfg.header_rpcs[0], "eth_blockNumber", json!([]))?)?;
            head.checked_sub(cfg.depth).ok_or("chain too short")?
        }
    };
    let header = agreed_header(rpc, cfg, block)?;
    let now = header.timestamp;
    let agree = header.agree;
    let mut pv = Prover::new(rpc, cfg, header);
    let user = word_addr(&input.position)?;

    // the position's own account (nonce) and the pool's per-user config
    let pos = pv.read(&input.position, &[])?;
    let ucfg_eh = pv.read(&cfg.pool, &[map_slot(user, U256::from(USERS_CONFIG)), map_slot(user, U256::from(EMODE))])?;
    let (ucfg, emode) = (ucfg_eh.values[0], ucfg_eh.values[1]);
    if !emode.is_zero() {
        return Err("eMode positions aren't supported".into());
    }
    let ids: Vec<u32> = (0..128u32).filter(|i| !ucfg.shr(2 * i).mask(2).is_zero()).collect();

    let (mut tot_coll, mut tot_debt, mut lt_acc) = (U256::ZERO, U256::ZERO, U256::ZERO);
    let mut res = vec![];
    for rid in &ids {
        let mut rid_w = [0u8; 32];
        rid_w[28..].copy_from_slice(&rid.to_be_bytes());
        let asset = as_addr(pv.read(&cfg.pool, &[map_slot(rid_w, U256::from(RESERVES_LIST))])?.values[0]);
        let b = map_slot(word_addr(&asset)?, U256::from(RESERVES));
        let one = U256::from(1u128);
        let r = pv.read(&cfg.pool, &[b, b + one, b + U256::from(2u128), b + U256::from(3u128), b + U256::from(4u128), b + U256::from(5u128), b + U256::from(6u128)])?.values;
        let (rcfg, s1, s2, s3) = (r[0], r[1], r[2], r[3]);
        let id_check = s3.shr(128 + 40).mask(16).low_u128() as u32;
        if id_check != *rid {
            return Err(format!("reserve id mismatch {id_check} != {rid}"));
        }
        let last = s3.shr(128).mask(40).low_u128() as u64;
        let lt = rcfg.shr(16).mask(16);
        let dec = rcfg.shr(48).mask(8).low_u128() as u32;
        let unit = U256::pow10(dec);
        let src = as_addr(pv.read(&cfg.oracle, &[map_slot(word_addr(&asset)?, U256::ZERO)])?.values[0]);
        let price = pv.read(&src, &[U256::ZERO])?.values[0];
        let (mut cs, mut ds) = (U256::ZERO, U256::ZERO);
        let collateral = ucfg.bit(2 * rid + 1) && !lt.is_zero();
        if collateral {
            let a_tok = as_addr(r[4]);
            cs = pv.read(&a_tok, &[map_slot(user, U256::from(ATOKEN_USER_STATE))])?.values[0].mask(128);
            let (liq_rate, liq_index) = (s1.shr(128), s1.mask(128));
            let income = if now != last { ray_mul(linear_interest(liq_rate, last, now), liq_index) } else { liq_index };
            let bal = ray_mul(cs, income);
            let base = bal * price / unit;
            tot_coll = tot_coll + base;
            lt_acc = lt_acc + base * lt;
        }
        if ucfg.bit(2 * rid) {
            let (v_tok, s_tok) = (as_addr(r[6]), as_addr(r[5]));
            ds = pv.read(&v_tok, &[map_slot(user, U256::from(DEBT_USER_STATE))])?.values[0].mask(128);
            let stable = pv.read(&s_tok, &[map_slot(user, U256::from(DEBT_USER_STATE))])?.values[0].mask(128);
            if !stable.is_zero() {
                return Err("stable debt isn't supported".into());
            }
            let (var_rate, var_index) = (s2.shr(128), s2.mask(128));
            let debt = if ds.is_zero() { U256::ZERO } else { ray_mul(ds, ray_mul(compounded_interest(var_rate, last, now), var_index)) };
            tot_debt = tot_debt + price * debt / unit;
        }
        res.push(ReserveOut { a: asset, p: price.to_string(), cs: cs.to_string(), ds: ds.to_string() });
    }
    let avg_lt = if tot_coll.is_zero() { U256::ZERO } else { lt_acc / tot_coll };
    let hf = if tot_debt.is_zero() { U256::MAX } else { wad_div(percent_mul(tot_coll, avg_lt), tot_debt) };

    // escrow: the position's own token balances
    let mut bal = vec![];
    for t in &cfg.tokens {
        let v = pv.read(&t.address, &[map_slot(user, U256::from(t.balances_slot as u128))])?.values[0];
        bal.push((t.address.to_lowercase(), v.to_string()));
    }
    Ok(Output {
        v: 1,
        pos: input.position.to_lowercase(),
        chain: cfg.chain_id,
        block,
        ts: now,
        hf: hf.to_string(),
        cb: tot_coll.to_string(),
        db: tot_debt.to_string(),
        lt: avg_lt.low_u128() as u64,
        nonce: pos.nonce,
        res,
        bal,
        agree,
    })
}

/// Native transport via `curl` (tests, local runs). Not compiled into the WASI build.
#[cfg(not(target_os = "wasi"))]
pub struct CurlRpc;

#[cfg(not(target_os = "wasi"))]
impl Rpc for CurlRpc {
    fn call(&self, url: &str, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string();
        let out = std::process::Command::new("curl")
            .args(["-s", "--max-time", "20", "-H", "content-type: application/json", "-d", &body, url])
            .output()
            .map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("{url}: {e}"))?;
        if let Some(e) = v.get("error") {
            return Err(format!("{url}: {e}"));
        }
        Ok(v["result"].clone())
    }
}

/// Records every call (to save as a fixture) or replays recorded ones (offline tests).
#[derive(Default, Serialize, Deserialize)]
pub struct Tape {
    pub calls: Vec<(String, String, Value, Value)>,
}

pub struct Recorder<'a, R: Rpc> {
    pub inner: &'a R,
    pub tape: std::cell::RefCell<Tape>,
}
impl<R: Rpc> Rpc for Recorder<'_, R> {
    fn call(&self, url: &str, method: &str, params: Value) -> Result<Value, String> {
        let r = self.inner.call(url, method, params.clone())?;
        self.tape.borrow_mut().calls.push((url.into(), method.into(), params, r.clone()));
        Ok(r)
    }
}
impl Rpc for Tape {
    fn call(&self, url: &str, method: &str, params: Value) -> Result<Value, String> {
        self.calls
            .iter()
            .find(|(u, m, p, _)| u == url && m == method && *p == params)
            .map(|c| c.3.clone())
            .ok_or_else(|| format!("not on tape: {method} {params} @ {url}"))
    }
}

/// Sepolia: Aave V3 Pool and AaveOracle (bgd-labs aave-address-book, verified live 2026-10-29),
/// the header voters and proof sources tested 2026-11-04, and the escrow tokens (LINK, DAI).
pub fn sepolia_config() -> Config {
    Config {
        chain_id: 11155111,
        header_rpcs: vec![
            "https://ethereum-sepolia-rpc.publicnode.com".into(),
            "https://1rpc.io/sepolia".into(),
            "https://sepolia.gateway.tenderly.co".into(),
        ],
        proof_rpcs: vec!["https://1rpc.io/sepolia".into(), "https://sepolia.gateway.tenderly.co".into()],
        min_agree: 3,
        depth: 3,
        pool: "0x6ae43d3271ff6888e7fc43fd7321a503ff738951".into(),
        oracle: "0x2da88497588bf89281816106c7259e31af45a663".into(),
        tokens: vec![
            TokenSlot { address: "0xf8fb3713d459d7c1018bd0a49d19b4c44290ebe5".into(), balances_slot: 0 },
            TokenSlot { address: "0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357".into(), balances_slot: 0 },
        ],
    }
}

/// WASI Preview 2 HTTP transport (OutLayer). JSON-RPC over HTTPS with a connect timeout.
#[cfg(target_os = "wasi")]
pub mod wasi {
    use super::Rpc;
    use serde_json::{json, Value};
    use std::time::Duration;

    pub struct WasiRpc;
    impl Rpc for WasiRpc {
        fn call(&self, url: &str, method: &str, params: Value) -> Result<Value, String> {
            let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string();
            let resp = wasi_http_client::Client::new()
                .post(url)
                .header("content-type", "application/json")
                .connect_timeout(Duration::from_secs(10))
                .body(body.as_bytes())
                .send()
                .map_err(|e| format!("{url}: {e}"))?;
            if resp.status() != 200 {
                return Err(format!("{url}: HTTP {}", resp.status()));
            }
            let v: Value = serde_json::from_slice(&resp.body().map_err(|e| e.to_string())?).map_err(|e| format!("{url}: {e}"))?;
            if let Some(e) = v.get("error") {
                return Err(format!("{url}: {e}"));
            }
            Ok(v["result"].clone())
        }
    }
}
