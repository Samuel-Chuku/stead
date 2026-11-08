//! Verified reads against real Sepolia data. `record` runs live (curl) and saves the tape;
//! every other test replays it offline.
use serde_json::{json, Value};
use stead_verifier::*;

const SPIKE: &str = "0xaAbeb4a4851b4a2D11635cCa5808707E4DE2D617";
const TAPE: &str = "tests/fixtures/sepolia_spike.json";

fn getter(block: u64) -> (String, String, u64, String) {
    // Pool.getUserAccountData(spike) at the same block, via eth_call on a header RPC
    let data = format!("0xbf92857c000000000000000000000000{}", &SPIKE[2..].to_lowercase());
    let r = CurlRpc
        .call("https://1rpc.io/sepolia", "eth_call", json!([{"to": "0x6ae43d3271ff6888e7fc43fd7321a503ff738951", "data": data}, format!("0x{block:x}")]))
        .unwrap();
    let h = r.as_str().unwrap().trim_start_matches("0x");
    let w = |i: usize| u256::U256::from_hex(&h[i * 64..i * 64 + 64]).unwrap();
    (w(0).to_string(), w(1).to_string(), w(3).low_u128() as u64, w(5).to_string())
}

#[test]
#[ignore = "live: records the fixture"]
fn record() {
    let cfg = sepolia_config();
    let rec = Recorder { inner: &CurlRpc, tape: Default::default() };
    let out = verify_position(&rec, &cfg, &Input { position: SPIKE.into(), block: None, tokens: None, reserves: None }).unwrap();
    let (cb, db, lt, hf) = getter(out.block);
    println!("verified: {}", serde_json::to_string(&out).unwrap());
    println!("getter  : cb {cb} db {db} lt {lt} hf {hf}");
    assert_eq!((out.cb.clone(), out.db.clone(), out.lt, out.hf.clone()), (cb, db, lt, hf), "must equal Pool.getUserAccountData exactly");
    let mut tape = rec.tape.into_inner();
    tape.calls.retain(|c| c.1 != "eth_blockNumber");
    let fixture = json!({"block": out.block, "output": out, "tape": tape});
    std::fs::write(TAPE, serde_json::to_string(&fixture).unwrap()).unwrap();
}

/// The proof sources the tape was recorded with (the live order changed since).
fn rec_config() -> Config {
    Config { proof_rpcs: vec!["https://1rpc.io/sepolia".into(), "https://sepolia.gateway.tenderly.co".into()], ..sepolia_config() }
}

fn load() -> (u64, Output, Tape) {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(TAPE).expect("run `cargo test -- --ignored record` first")).unwrap();
    (v["block"].as_u64().unwrap(), serde_json::from_value(v["output"].clone()).unwrap(), serde_json::from_value(v["tape"].clone()).unwrap())
}


/// All recorded proofs answered by one endpoint, so a tampered answer is the only one.
fn single_source(tape: &mut Tape) -> Config {
    let url = "https://1rpc.io/sepolia".to_string();
    for c in tape.calls.iter_mut().filter(|c| c.1 == "eth_getProof") {
        c.0 = url.clone();
    }
    Config { proof_rpcs: vec![url], ..rec_config() }
}

#[test]
fn replay_matches_the_recorded_verified_output() {
    let (block, want, tape) = load();
    let out = verify_position(&tape, &rec_config(), &Input { position: SPIKE.into(), block: Some(block), tokens: None, reserves: None }).unwrap();
    assert_eq!(out, want);
    let size = serde_json::to_string(&out).unwrap().len();
    assert!(size <= 900, "output {size} bytes > OutLayer's 900-byte limit");
    println!("output {size} bytes, {} header RPCs agreed", out.agree);
}

/// The tape, plus made-up voters: `extra` answers like a recorded voter, `odd` with another
/// state root; optionally every first call fails (a rate limit) and the head is moved.
struct Wrap {
    tape: Tape,
    flaky: bool,
    head: Option<u64>,
    tried: std::cell::RefCell<Vec<String>>,
}
const REC: &str = "https://sepolia.gateway.tenderly.co";
impl Rpc for Wrap {
    fn call(&self, url: &str, method: &str, params: Value) -> Result<Value, String> {
        let key = format!("{url} {method} {params}");
        if self.flaky && !self.tried.borrow().contains(&key) {
            self.tried.borrow_mut().push(key);
            return Err(format!("{url}: HTTP 429"));
        }
        if method == "eth_blockNumber" {
            return self.head.map(|h| json!(format!("0x{h:x}"))).ok_or_else(|| "no head".to_string());
        }
        if url.starts_with("https://extra") {
            return self.tape.call(REC, method, params);
        }
        if url.starts_with("https://odd") {
            let mut h = self.tape.call(REC, method, params)?;
            h["stateRoot"] = json!(format!("0x{}", "11".repeat(32)));
            return Ok(h);
        }
        self.tape.call(url, method, params)
    }
}
fn wrap(tape: Tape) -> Wrap {
    Wrap { tape, flaky: false, head: None, tried: Default::default() }
}
fn voters(v: &[&str], min_agree: usize) -> Config {
    Config { header_rpcs: v.iter().map(|s| s.to_string()).collect(), min_agree, ..rec_config() }
}
fn at(block: Option<u64>) -> Input {
    Input { position: SPIKE.into(), block, tokens: None, reserves: None }
}

#[test]
fn header_disagreement_is_refused() {
    // two voters against two: no majority, even with min_agree met
    let (block, _, tape) = load();
    let cfg = voters(&[REC, "https://extra.a", "https://odd.a", "https://odd.b"], 2);
    let e = verify_position(&wrap(tape), &cfg, &at(Some(block))).unwrap_err();
    assert!(e.contains("disagreement"), "{e}");
}

#[test]
fn a_lone_odd_voter_is_outvoted() {
    let (block, want, tape) = load();
    let cfg = voters(&["https://ethereum-sepolia-rpc.publicnode.com", "https://1rpc.io/sepolia", REC, "https://extra.a", "https://odd.a"], 3);
    let out = verify_position(&wrap(tape), &cfg, &at(Some(block))).unwrap();
    assert_eq!((out.block, out.hf.clone(), out.agree), (block, want.hf, 4));
}

#[test]
fn a_rate_limited_first_call_is_retried() {
    let (block, want, tape) = load();
    let w = Wrap { flaky: true, ..wrap(tape) };
    let out = verify_position(&w, &rec_config(), &at(Some(block))).unwrap();
    assert_eq!(out, want);
}

#[test]
fn without_a_fixed_block_it_steps_back_to_a_block_the_voters_have() {
    // head − 3 isn't on the tape (no voter has it yet): the recorded block, 3 older, is used
    let (block, want, tape) = load();
    let w = Wrap { head: Some(block + 6), ..wrap(tape) };
    let out = verify_position(&w, &rec_config(), &at(None)).unwrap();
    assert_eq!(out, want);
    let w = Wrap { head: Some(block + 12), ..wrap(load().2) };
    assert!(verify_position(&w, &rec_config(), &at(None)).is_err(), "at most 6 blocks back");
}

#[test]
fn a_refusal_names_the_failing_voters_but_never_the_keyed_url() {
    let (block, _, tape) = load();
    let key = "https://name.ethereum-sepolia.quiknode.pro/SECRETTOKEN123/";
    let mut cfg = voters(&[key, REC, "https://1rpc.io/sepolia"], 3);
    cfg.keyed = Some(key.into());
    cfg.proof_rpcs.insert(0, key.into());
    let e = verify_position(&wrap(tape), &cfg, &at(Some(block + 1))).unwrap_err();
    assert!(!e.contains("SECRETTOKEN123") && !e.contains("quiknode"), "{e}");
    assert!(e.contains("keyed-rpc") && e.contains("tenderly"), "{e}");
    // a failed proof read returns the whole error, URL included: scrubbed too
    let (block, _, tape) = load();
    let mut cfg = rec_config();
    cfg.keyed = Some(key.into());
    cfg.proof_rpcs = vec![key.into()];
    let e = verify_position(&wrap(tape), &cfg, &at(Some(block))).unwrap_err();
    assert!(!e.contains("SECRETTOKEN123") && e.contains("keyed-rpc"), "{e}");
}

#[test]
fn too_few_agreeing_rpcs_is_refused() {
    let (block, _, tape) = load();
    let mut cfg = rec_config();
    cfg.min_agree = 4;
    let e = verify_position(&tape, &cfg, &Input { position: SPIKE.into(), block: Some(block), tokens: None, reserves: None }).unwrap_err();
    assert!(e.contains("agree"), "{e}");
}

#[test]
fn tampered_storage_value_is_refused() {
    let (block, _, mut tape) = load();
    let cfg = single_source(&mut tape);
    // change the last node of one storage proof (its leaf): the hash chain breaks
    let c = tape.calls.iter_mut().find(|c| c.1 == "eth_getProof" && !c.3["storageProof"].as_array().unwrap().is_empty()).unwrap();
    let proof = c.3["storageProof"][0]["proof"].as_array_mut().unwrap();
    let last = proof.last_mut().unwrap();
    let mut s = last.as_str().unwrap().to_string();
    let n = s.len();
    s.replace_range(n - 2..n, if &s[n - 2..] == "00" { "01" } else { "00" });
    *last = json!(s);

    let e = verify_position(&tape, &cfg, &Input { position: SPIKE.into(), block: Some(block), tokens: None, reserves: None }).unwrap_err();
    assert!(e.contains("proof"), "{e}");
}

#[test]
fn wrong_storage_hash_is_refused() {
    let (block, _, mut tape) = load();
    let cfg = single_source(&mut tape);
    let c = tape.calls.iter_mut().find(|c| c.1 == "eth_getProof" && !c.3["storageProof"].as_array().unwrap().is_empty()).unwrap();
    c.3["storageHash"] = json!(format!("0x{}", "22".repeat(32)));
    let e = verify_position(&tape, &cfg, &Input { position: SPIKE.into(), block: Some(block), tokens: None, reserves: None }).unwrap_err();
    assert!(e.contains("storageHash"), "{e}");
}

#[test]
fn u256_math() {
    use u256::U256;
    let a = U256::from_hex("0x33b2e3c9fd0803ce8000000").unwrap(); // 1e27
    assert_eq!(a, ray());
    assert_eq!((ray() * ray() / ray()).to_string(), ray().to_string());
    assert_eq!(U256::MAX.to_string(), "115792089237316195423570985008687907853269984665640564039457584007913129639935");
    assert_eq!(ray_mul(U256::from(3u128) * ray(), U256::from(2u128) * ray()), U256::from(6u128) * ray());
    assert_eq!(U256::from(1u128).shl(200).shr(200), U256::from(1u128));
    assert_eq!(U256::from(0xffu128).mask(4), U256::from(0xfu128));
}

/// The indexes the contract uses to check a settlement repay exactly: equal to Aave's own
/// `getReserveNormalizedIncome` / `getReserveNormalizedVariableDebt` at the recorded block
/// (read from an archive RPC, 1rpc.io, on 2026-11-06).
#[test]
fn indexes_equal_aave_getters_at_the_recorded_block() {
    let (block, _, tape) = load();
    let out = verify_position(&tape, &rec_config(), &Input { position: SPIKE.into(), block: Some(block), tokens: None, reserves: None }).unwrap();
    let want = [
        ("0xf8fb3713d459d7c1018bd0a49d19b4c44290ebe5", "54594184083501305371085646663", "260929572666315329960299137179"),
        ("0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357", "4702104320609953716454145472", "5750484138257992983807473381"),
    ];
    for (asset, ci, di) in want {
        let r = out.res.iter().find(|r| r.a == asset).expect("reserve in the output");
        assert_eq!((r.ci.as_str(), r.di.as_str()), (ci, di), "indexes of {asset}");
    }
}

const LINK_A: &str = "0xf8fb3713d459d7c1018bd0a49d19b4c44290ebe5";
const DAI_A: &str = "0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357";

/// The contract names the market's collateral and debt: only those are reported, the health
/// factor still counts every reserve, and the escrow tokens come from the input.
#[test]
fn tokens_and_reserves_come_from_the_input() {
    let (block, want, tape) = load();
    let input = Input {
        position: SPIKE.into(),
        block: Some(block),
        tokens: Some(vec![TokenSlot { address: DAI_A.into(), balances_slot: 0 }]),
        reserves: Some(vec![LINK_A.to_uppercase().replace("0X", "0x")]),
    };
    let out = verify_position(&tape, &rec_config(), &input).unwrap();
    assert_eq!((out.hf.clone(), out.cb.clone(), out.db.clone()), (want.hf.clone(), want.cb.clone(), want.db.clone()), "health over every reserve");
    assert_eq!(out.res.iter().map(|r| r.a.as_str()).collect::<Vec<_>>(), vec![LINK_A], "only the named reserve");
    assert_eq!(out.res[0], *want.res.iter().find(|r| r.a == LINK_A).unwrap());
    assert_eq!(out.bal, vec![want.bal.iter().find(|b| b.0 == DAI_A).unwrap().clone()], "only the named token");
}

#[test]
fn at_most_two_tokens_and_reserves() {
    let (block, _, tape) = load();
    let t = |a: &str| TokenSlot { address: a.into(), balances_slot: 0 };
    let too_many = Input { position: SPIKE.into(), block: Some(block), tokens: Some(vec![t(LINK_A), t(DAI_A), t(LINK_A)]), reserves: None };
    assert!(verify_position(&tape, &rec_config(), &too_many).unwrap_err().contains("at most 2"));
    let too_many_r = Input { position: SPIKE.into(), block: Some(block), tokens: None, reserves: Some(vec![LINK_A.into(), DAI_A.into(), LINK_A.into()]) };
    assert!(verify_position(&tape, &rec_config(), &too_many_r).unwrap_err().contains("at most 2"));
}
