//! Verified Aave V3 (v3.0) reads for Stead.
//!
//! 1. **Header agreement:** the block header (hash, stateRoot, timestamp, receiptsRoot) must be
//!    byte-identical from at least `min_agree` independent RPCs, and that answer must outnumber
//!    all other answers combined. Each call is retried once; without a fixed block the program
//!    steps back from head − depth to older blocks before giving up.
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
    /// The keyed RPC from the secret (also in the lists above). Never printed: errors name it
    /// `keyed-rpc`.
    #[serde(default)]
    pub keyed: Option<String>,
    /// More keyed RPCs from the secret (other providers); each votes on its own, none is printed.
    #[serde(default)]
    pub keyed_more: Vec<String>,
    /// Read each price from the oracle with `eth_call` at the agreed block, accepted only when a
    /// majority of at least `min_agree` header voters return the identical value (Ethereum
    /// mainnet: Chainlink feeds and capped adapters keep part of the price outside plain storage).
    /// Off: the price is a proven storage slot (Sepolia's simple feeds).
    #[serde(default)]
    pub price_by_call: bool,
    /// Round each user's debt up (Aave 3.4+, as on Ethereum mainnet); off: to nearest (Aave 3.0, Sepolia).
    #[serde(default)]
    pub debt_round_up: bool,
    /// Health factor as newer Aave computes it: `wadDiv(Σ collateral × LT, debt) / 10_000`
    /// (Base Sepolia, revision 10, matches `getUserAccountData` to the wei); off: Aave 3.0's
    /// `wadDiv(percentMul(collateral, avgLT), debt)`.
    #[serde(default)]
    pub hf_from_sum: bool,
    /// Round each aToken balance down, as newer Aave does (visible on 8-decimal collateral such as
    /// WBTC, where one unit is worth ~$0.001); off: to nearest (Aave 3.0).
    #[serde(default)]
    pub coll_round_down: bool,
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
    /// Escrow tokens to prove (the market's collateral and debt, with their balance slots).
    /// Absent: the config's list.
    #[serde(default)]
    pub tokens: Option<Vec<TokenSlot>>,
    /// Reserves to report in `res` (the market's collateral and debt). The health factor always
    /// counts every reserve the position uses. Absent: all of them.
    #[serde(default)]
    pub reserves: Option<Vec<String>>,
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
    /// Per reserve: asset, price (base), scaled aToken balance, scaled variable debt, and the
    /// liquidity and variable-debt indexes (ray).
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
    /// The reserve's liquidity index and variable-debt index at the block (ray), as
    /// `getReserveNormalizedIncome` / `getReserveNormalizedVariableDebt` return them.
    pub ci: String,
    pub di: String,
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

/// The most common answer wins if at least `min_agree` voters return it AND it has more votes
/// than every other answer combined: a lone lagging or odd node can't block a reading, and a
/// wrong header still needs a majority of at least `min_agree` voters.
pub fn agreed_header(rpc: &dyn Rpc, cfg: &Config, block: u64) -> Result<Header, String> {
    let mut seen: Vec<(String, String, String, u64)> = vec![];
    let mut failed: Vec<String> = vec![];
    for url in &cfg.header_rpcs {
        match call_twice(rpc, url, "eth_getBlockByNumber", json!([format!("0x{block:x}"), false])) {
            Ok(h) if !h.is_null() => seen.push((hexs(&h["hash"])?, hexs(&h["stateRoot"])?, hexs(&h["receiptsRoot"])?, u64_hex(&h["timestamp"])?)),
            Ok(_) => failed.push(format!("{}: no block", label(cfg, url))),
            Err(e) => failed.push(format!("{}: {}", label(cfg, url), short(&e))),
        }
    }
    let mut tally: Vec<((String, String, String, u64), usize)> = vec![];
    for x in &seen {
        match tally.iter_mut().find(|(k, _)| k == x) {
            Some((_, n)) => *n += 1,
            None => tally.push((x.clone(), 1)),
        }
    }
    let (best, agree) = tally.iter().max_by_key(|(_, n)| *n).cloned().ok_or_else(|| format!("no RPC returned block {block} ({})", failed.join("; ")))?;
    if agree < cfg.min_agree {
        let why = if failed.is_empty() { String::new() } else { format!(" ({})", failed.join("; ")) };
        return Err(format!("only {agree} RPCs agree on block {block} (need {}){why}", cfg.min_agree));
    }
    if 2 * agree <= seen.len() {
        return Err(format!("header disagreement at block {block}: {} distinct answers", tally.len()));
    }
    Ok(Header { number: block, hash: best.0, state_root: hex32(&best.1)?, receipts_root: hex32(&best.2)?, timestamp: best.3, agree })
}

/// `getAssetPrice(asset)` on the oracle at `block`, by `eth_call` on every header voter. The same
/// rule as the header: the most common answer needs at least `min_agree` votes and a majority of
/// the answers, so one RPC can't move a price.
pub fn agreed_price(rpc: &dyn Rpc, cfg: &Config, asset: &str, block: u64) -> Result<U256, String> {
    let data = format!("0xb3596f07{:0>64}", asset.trim_start_matches("0x").to_lowercase()); // getAssetPrice(address)
    let mut seen: Vec<String> = vec![];
    let mut failed: Vec<String> = vec![];
    for url in &cfg.header_rpcs {
        match call_twice(rpc, url, "eth_call", json!([{ "to": cfg.oracle, "data": data }, format!("0x{block:x}")])) {
            Ok(v) if v.is_string() => seen.push(v.as_str().unwrap().to_lowercase()),
            Ok(_) => failed.push(format!("{}: no result", label(cfg, url))),
            Err(e) => failed.push(format!("{}: {}", label(cfg, url), short(&e))),
        }
    }
    let mut tally: Vec<(String, usize)> = vec![];
    for x in &seen {
        match tally.iter_mut().find(|(k, _)| k == x) {
            Some((_, n)) => *n += 1,
            None => tally.push((x.clone(), 1)),
        }
    }
    let (best, agree) = tally.iter().max_by_key(|(_, n)| *n).cloned().ok_or_else(|| format!("no RPC returned the price of {asset} ({})", failed.join("; ")))?;
    if agree < cfg.min_agree {
        return Err(format!("only {agree} RPCs agree on the price of {asset} at block {block} (need {})", cfg.min_agree));
    }
    if 2 * agree <= seen.len() {
        return Err(format!("price disagreement for {asset} at block {block}: {} distinct answers", tally.len()));
    }
    let raw = hex::decode(best.trim_start_matches("0x")).map_err(|e| format!("price: {e}"))?;
    if raw.len() != 32 {
        return Err(format!("price of {asset}: {} bytes", raw.len()));
    }
    U256::from_be_slice(&raw).ok_or_else(|| format!("price of {asset}: not a uint256"))
}

/// One retry on any error (a rate limit or a dropped connection is often gone a moment later).
fn call_twice(rpc: &dyn Rpc, url: &str, method: &str, params: Value) -> Result<Value, String> {
    rpc.call(url, method, params.clone()).or_else(|_| rpc.call(url, method, params))
}

/// A voter's name in errors: its host, or `keyed-rpc` (the secret's URL is never printed).
fn label(cfg: &Config, url: &str) -> String {
    if cfg.keyed.as_deref() == Some(url) {
        return "keyed-rpc".into();
    }
    if let Some(i) = cfg.keyed_more.iter().position(|k| k == url) {
        return format!("keyed-rpc-{}", i + 2);
    }
    url.trim_start_matches("https://").split('/').next().unwrap_or(url).to_string()
}
fn short(e: &str) -> String {
    let e = e.rsplit(": ").next().unwrap_or(e); // drop the "url: " prefix
    e.chars().take(40).collect()
}

/// The chain head from the first voter that answers (the keyed RPC first when present).
fn head(rpc: &dyn Rpc, cfg: &Config) -> Result<u64, String> {
    let mut last = String::from("no header RPC configured");
    for url in &cfg.header_rpcs {
        match call_twice(rpc, url, "eth_blockNumber", json!([])) {
            Ok(h) => return u64_hex(&h),
            Err(e) => last = format!("head: {}: {}", label(cfg, url), short(&e)),
        }
    }
    Err(last)
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
        // every source's reason, shortened, if none gives a proof that verifies
        let mut why: Vec<String> = vec![];
        for url in self.cfg.proof_rpcs.clone() {
            self.calls += 1;
            let res = match call_twice(self.rpc, &url, "eth_getProof", json!([account, keys, format!("0x{:x}", self.header.number)])) {
                Ok(r) => r,
                Err(e) => {
                    why.push(format!("{}: {}", label(self.cfg, &url), short(&e)));
                    continue;
                }
            };
            match self.check(account, slots, &res) {
                Ok(p) => {
                    self.slots_read += slots.len();
                    return Ok(p);
                }
                Err(e) => why.push(format!("{}: {}", label(self.cfg, &url), short(&e))),
            }
        }
        Err(if why.is_empty() { "no proof RPC configured".into() } else { format!("no proof of {account}: {}", why.join("; ")) })
    }

    fn check(&self, account: &str, slots: &[U256], res: &Value) -> Result<ProvenAccount, String> {
        let nodes = |v: &Value| -> Result<Vec<Vec<u8>>, String> {
            v.as_array().ok_or("proof not a list")?.iter().map(|n| hex::decode(n.as_str().unwrap_or("").trim_start_matches("0x")).map_err(|e| e.to_string())).collect()
        };
        let path = keccak(&addr_bytes(account)?);
        let acct = mpt::verify(self.header.state_root, path, &nodes(&res["accountProof"])?).map_err(|e| format!("account proof: {e:?}"))?;
        let absent = acct.is_none();
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
        // An account the proof shows absent (a new position address with no ETH yet) has no
        // storage; nodes report its storageHash as zero. Every slot is still checked against the
        // empty trie, never against the claim.
        if claimed != storage_root && !(absent && claimed == [0u8; 32]) {
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
/// `a × b / RAY`, rounded up (Aave 3.4+ rounds a user's debt up).
pub fn ray_mul_up(a: U256, b: U256) -> U256 {
    let p = a * b;
    let q = p / ray();
    if q * ray() == p { q } else { q + U256::from(1u128) }
}
/// `a × b / RAY`, rounded down (newer Aave rounds a user's aToken balance down).
pub fn ray_mul_down(a: U256, b: U256) -> U256 {
    a * b / ray()
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
/// Errors never contain the keyed RPC's URL.
pub fn verify_position(rpc: &dyn Rpc, cfg: &Config, input: &Input) -> Result<Output, String> {
    verify_inner(rpc, cfg, input).map_err(|e| {
        let mut e = match &cfg.keyed {
            Some(k) if !k.is_empty() => e.replace(k.as_str(), "keyed-rpc").replace(k.trim_end_matches('/'), "keyed-rpc"),
            _ => e,
        };
        for (i, k) in cfg.keyed_more.iter().enumerate().filter(|(_, k)| !k.is_empty()) {
            let l = format!("keyed-rpc-{}", i + 2);
            e = e.replace(k.as_str(), &l).replace(k.trim_end_matches('/'), &l);
        }
        e
    })
}

/// Blocks tried when the caller didn't fix one: head − depth, then 3 and 6 blocks older (a voter
/// that hasn't caught up yet has the older block).
const STEP_BACK: [u64; 3] = [0, 3, 6];

fn verify_inner(rpc: &dyn Rpc, cfg: &Config, input: &Input) -> Result<Output, String> {
    // the output must stay under OutLayer's 900 bytes
    let tokens = input.tokens.as_ref().unwrap_or(&cfg.tokens);
    if tokens.len() > 2 || input.reserves.as_ref().is_some_and(|r| r.len() > 2) {
        return Err("at most 2 tokens and 2 reserves per request".into());
    }
    let wanted = |a: &str| input.reserves.as_ref().map_or(true, |r| r.iter().any(|x| x.eq_ignore_ascii_case(a)));
    let header = match input.block {
        Some(b) => agreed_header(rpc, cfg, b)?,
        None => {
            let h = head(rpc, cfg)?;
            let mut last = String::new();
            let mut found = None;
            for back in STEP_BACK {
                let b = h.checked_sub(cfg.depth + back).ok_or("chain too short")?;
                match agreed_header(rpc, cfg, b) {
                    Ok(x) => {
                        found = Some(x);
                        break;
                    }
                    Err(e) => last = e,
                }
            }
            found.ok_or(last)?
        }
    };
    let block = header.number;
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
        let r = read_reserve(&mut pv, rpc, cfg, *rid, None, ucfg, user, now, block)?.ok_or("reserve read")?;
        tot_coll = tot_coll + r.coll_base;
        lt_acc = lt_acc + r.lt_part;
        tot_debt = tot_debt + r.debt_base;
        if wanted(&r.out.a) {
            res.push(r.out);
        }
    }
    // A requested reserve the position doesn't use (a new position's first supply needs the
    // collateral's price): its id comes from its own proven ReserveData, and it is read exactly
    // as above. Its bits are unset, so it adds nothing to the totals. An asset that isn't an
    // Aave reserve is left out, as before.
    for a in input.reserves.iter().flatten() {
        if res.iter().any(|r| r.a.eq_ignore_ascii_case(a)) {
            continue;
        }
        let b = map_slot(word_addr(a)?, U256::from(RESERVES));
        let s3 = pv.read(&cfg.pool, &[b + U256::from(3u128)])?.values[0];
        let rid = s3.shr(128 + 40).mask(16).low_u128() as u32;
        if ids.contains(&rid) {
            continue; // that id's reserve is another asset (this one isn't listed)
        }
        if let Some(r) = read_reserve(&mut pv, rpc, cfg, rid, Some(a), ucfg, user, now, block)? {
            debug_assert!(r.coll_base.is_zero() && r.debt_base.is_zero() && r.lt_part.is_zero());
            tot_coll = tot_coll + r.coll_base;
            lt_acc = lt_acc + r.lt_part;
            tot_debt = tot_debt + r.debt_base;
            res.push(r.out);
        }
    }
    let avg_lt = if tot_coll.is_zero() { U256::ZERO } else { lt_acc / tot_coll };
    let hf = if tot_debt.is_zero() {
        U256::MAX
    } else if cfg.hf_from_sum {
        wad_div(lt_acc, tot_debt) / U256::from(10_000u128)
    } else {
        wad_div(percent_mul(tot_coll, avg_lt), tot_debt)
    };

    // escrow: the position's own token balances
    let mut bal = vec![];
    for t in tokens {
        // a token this config knows uses the config's balances slot (the caller may not know a
        // mainnet token's layout: WETH keeps balances at slot 3, USDC at slot 9)
        let slot = cfg.tokens.iter().find(|k| k.address.eq_ignore_ascii_case(&t.address)).map_or(t.balances_slot, |k| k.balances_slot);
        let v = pv.read(&t.address, &[map_slot(user, U256::from(slot as u128))])?.values[0];
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

/// One reserve, proven: its line in the output and what it adds to the totals (zero unless the
/// user's config marks it as collateral or as borrowed).
struct ReserveRead {
    out: ReserveOut,
    coll_base: U256,
    lt_part: U256,
    debt_base: U256,
}

/// Reads reserve `rid` (its asset from the proven reserves list, then its ReserveData, price and
/// the user's balances). `expect`: the asset the caller looked the id up for; `None` is returned
/// when the list names another asset (the requested one isn't an Aave reserve).
#[allow(clippy::too_many_arguments)]
fn read_reserve(pv: &mut Prover, rpc: &dyn Rpc, cfg: &Config, rid: u32, expect: Option<&str>, ucfg: U256, user: [u8; 32], now: u64, block: u64) -> Result<Option<ReserveRead>, String> {
    let mut rid_w = [0u8; 32];
    rid_w[28..].copy_from_slice(&rid.to_be_bytes());
    let asset = as_addr(pv.read(&cfg.pool, &[map_slot(rid_w, U256::from(RESERVES_LIST))])?.values[0]);
    if expect.is_some_and(|e| !e.eq_ignore_ascii_case(&asset)) {
        return Ok(None);
    }
    let b = map_slot(word_addr(&asset)?, U256::from(RESERVES));
    let one = U256::from(1u128);
    let r = pv.read(&cfg.pool, &[b, b + one, b + U256::from(2u128), b + U256::from(3u128), b + U256::from(4u128), b + U256::from(5u128), b + U256::from(6u128)])?.values;
    let (rcfg, s1, s2, s3) = (r[0], r[1], r[2], r[3]);
    let id_check = s3.shr(128 + 40).mask(16).low_u128() as u32;
    if id_check != rid {
        return Err(format!("reserve id mismatch {id_check} != {rid}"));
    }
    let last = s3.shr(128).mask(40).low_u128() as u64;
    let lt = rcfg.shr(16).mask(16);
    let dec = rcfg.shr(48).mask(8).low_u128() as u32;
    let unit = U256::pow10(dec);
    let price = if cfg.price_by_call {
        agreed_price(rpc, cfg, &asset, block)?
    } else {
        let src = as_addr(pv.read(&cfg.oracle, &[map_slot(word_addr(&asset)?, U256::ZERO)])?.values[0]);
        pv.read(&src, &[U256::ZERO])?.values[0]
    };
    let (mut coll_base, mut lt_part, mut debt_base) = (U256::ZERO, U256::ZERO, U256::ZERO);
    let (mut cs, mut ds) = (U256::ZERO, U256::ZERO);
    let (liq_rate, liq_index) = (s1.shr(128), s1.mask(128));
    let income = if now != last { ray_mul(linear_interest(liq_rate, last, now), liq_index) } else { liq_index };
    let (var_rate, var_index) = (s2.shr(128), s2.mask(128));
    let debt_index = if now != last { ray_mul(compounded_interest(var_rate, last, now), var_index) } else { var_index };
    let collateral = ucfg.bit(2 * rid + 1) && !lt.is_zero();
    if collateral {
        let a_tok = as_addr(r[4]);
        cs = pv.read(&a_tok, &[map_slot(user, U256::from(ATOKEN_USER_STATE))])?.values[0].mask(128);
        let bal = if cfg.coll_round_down { ray_mul_down(cs, income) } else { ray_mul(cs, income) };
        let base = bal * price / unit;
        coll_base = base;
        lt_part = base * lt;
    }
    if ucfg.bit(2 * rid) {
        let (v_tok, s_tok) = (as_addr(r[6]), as_addr(r[5]));
        ds = pv.read(&v_tok, &[map_slot(user, U256::from(DEBT_USER_STATE))])?.values[0].mask(128);
        // Aave 3.2+ (Ethereum mainnet, revision 11) removed stable-rate debt: its token address is zero
        let stable = if s_tok.trim_start_matches("0x").chars().all(|c| c == '0') {
            U256::ZERO
        } else {
            pv.read(&s_tok, &[map_slot(user, U256::from(DEBT_USER_STATE))])?.values[0].mask(128)
        };
        if !stable.is_zero() {
            return Err("stable debt isn't supported".into());
        }
        let debt = if ds.is_zero() {
            U256::ZERO
        } else if cfg.debt_round_up {
            ray_mul_up(ds, debt_index)
        } else {
            ray_mul(ds, debt_index)
        };
        // in dollars too, Aave 3.4+ rounds the debt up
        let in_base = price * debt;
        let q = in_base / unit;
        debt_base = if cfg.debt_round_up && q * unit != in_base { q + U256::from(1u128) } else { q };
    }
    Ok(Some(ReserveRead { out: ReserveOut { a: asset, p: price.to_string(), cs: cs.to_string(), ds: ds.to_string(), ci: income.to_string(), di: debt_index.to_string() }, coll_base, lt_part, debt_base }))
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
        // voters and proof sources re-tested 2026-11-07 (headers and eth_getProof at head − 3)
        header_rpcs: vec![
            "https://ethereum-sepolia-rpc.publicnode.com".into(),
            "https://1rpc.io/sepolia".into(),
            "https://sepolia.gateway.tenderly.co".into(),
            "https://rpc.sepolia.ethpandaops.io".into(),
            "https://0xrpc.io/sep".into(),
            "https://eth-sepolia.api.onfinality.io/public".into(),
        ],
        // fastest first; 1rpc and publicnode refuse eth_getProof near the head (votes only)
        proof_rpcs: vec![
            "https://sepolia.gateway.tenderly.co".into(),
            "https://rpc.sepolia.ethpandaops.io".into(),
            "https://0xrpc.io/sep".into(),
            "https://eth-sepolia.api.onfinality.io/public".into(),
            "https://sepolia.rpc.thirdweb.com".into(),
        ],
        min_agree: 3,
        depth: 3,
        pool: "0x6ae43d3271ff6888e7fc43fd7321a503ff738951".into(),
        oracle: "0x2da88497588bf89281816106c7259e31af45a663".into(),
        tokens: vec![
            TokenSlot { address: "0xf8fb3713d459d7c1018bd0a49d19b4c44290ebe5".into(), balances_slot: 0 },
            TokenSlot { address: "0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357".into(), balances_slot: 0 },
        ],
        keyed: None,
        keyed_more: vec![],
        price_by_call: false,
        debt_round_up: false,
        hf_from_sum: false,
        coll_round_down: false,
    }
}

/// Ethereum mainnet: Aave V3 Ethereum Pool and AaveOracle (the oracle read from the Pool's
/// AddressesProvider on chain, 2026-11-08); header and price voters run by different operators and
/// storage-proof sources, each tested 2026-11-08 at head − 3; escrow tokens WETH (balances slot 3)
/// and USDC (slot 9).
pub fn mainnet_config() -> Config {
    Config {
        chain_id: 1,
        header_rpcs: vec![
            "https://ethereum-rpc.publicnode.com".into(),
            "https://1rpc.io/eth".into(),
            "https://eth.drpc.org".into(),
            "https://eth-mainnet.public.blastapi.io".into(),
            "https://mainnet.gateway.tenderly.co".into(),
            "https://rpc.mevblocker.io".into(),
            "https://0xrpc.io/eth".into(),
            "https://eth-pokt.nodies.app".into(),
        ],
        proof_rpcs: vec![
            "https://eth.drpc.org".into(),
            "https://1rpc.io/eth".into(),
            "https://eth-mainnet.public.blastapi.io".into(),
            "https://rpc.mevblocker.io".into(),
            "https://0xrpc.io/eth".into(),
            "https://ethereum.publicnode.com".into(),
        ],
        min_agree: 3,
        depth: 3,
        pool: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2".into(),
        oracle: "0x54586be62e3c3580375ae3723c145253060ca0c2".into(),
        tokens: vec![
            TokenSlot { address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2".into(), balances_slot: 3 },
            TokenSlot { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".into(), balances_slot: 9 },
        ],
        keyed: None,
        keyed_more: vec![],
        price_by_call: true,
        debt_round_up: true,
        hf_from_sum: true,
        coll_round_down: true,
    }
}

/// Base Sepolia: Aave V3 Pool (revision 10) and AaveOracle (read from the Pool's AddressesProvider
/// on chain, 2026-11-28); header voters and storage-proof sources each tested 2026-11-28 at
/// head − 3 (publicnode, dRPC and Tenderly refuse proofs: votes only); escrow tokens Aave's test
/// USDC (balances slot 0) and WETH (the OP-stack predeploy, slot 3). Prices by agreed `eth_call`.
pub fn base_sepolia_config() -> Config {
    Config {
        chain_id: 84532,
        header_rpcs: vec![
            "https://sepolia.base.org".into(),
            "https://base-sepolia-rpc.publicnode.com".into(),
            "https://base-sepolia.drpc.org".into(),
            "https://base-sepolia.gateway.tenderly.co".into(),
            "https://84532.rpc.thirdweb.com".into(),
            "https://base-sepolia.api.onfinality.io/public".into(),
        ],
        proof_rpcs: vec![
            "https://sepolia.base.org".into(),
            "https://base-sepolia.api.onfinality.io/public".into(),
            "https://84532.rpc.thirdweb.com".into(),
        ],
        min_agree: 3,
        depth: 3,
        pool: "0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27".into(),
        oracle: "0x943b0de18d4abf4ef02a85912f8fc07684c141df".into(),
        tokens: vec![
            TokenSlot { address: "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f".into(), balances_slot: 0 },
            TokenSlot { address: "0x4200000000000000000000000000000000000006".into(), balances_slot: 3 },
        ],
        keyed: None,
        keyed_more: vec![],
        price_by_call: true,
        debt_round_up: true,
        hf_from_sum: true,
        coll_round_down: true,
    }
}

/// The config for a request, chosen by the market's tokens (the contract names its collateral and
/// debt): Ethereum mainnet or Base Sepolia when every reserve named is a token that chain's config
/// knows, else Sepolia. The contract still refuses a result whose `chain` isn't its market's.
pub fn config_for(input: &Input) -> Config {
    let all_known = |c: &Config| match &input.reserves {
        Some(r) if !r.is_empty() => r.iter().all(|a| c.tokens.iter().any(|t| t.address.eq_ignore_ascii_case(a))),
        _ => false,
    };
    for c in [mainnet_config(), base_sepolia_config()] {
        if all_known(&c) {
            return c;
        }
    }
    sepolia_config()
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
