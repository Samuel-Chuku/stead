//! Base Sepolia settings of the proof program, against real data: `record` runs live (curl) on a
//! position with debt and saves the tape together with Aave's own `getUserAccountData` at the same
//! block; every other test replays it offline.
use serde_json::{json, Value};
use stead_verifier::*;

const TAPE: &str = "tests/fixtures/base_sepolia.json";
const POS: &str = "0x75a1c6258d2197aa45f15f05e0a16050bf3c6d6d";
const WETH: &str = "0x4200000000000000000000000000000000000006";
const USDC: &str = "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f";

/// What the contract sends: the market's collateral and debt, each with balances slot 0.
fn contract_input(block: Option<u64>) -> Input {
    Input {
        position: POS.into(),
        block,
        tokens: Some(vec![TokenSlot { address: WETH.into(), balances_slot: 0 }, TokenSlot { address: USDC.into(), balances_slot: 0 }]),
        reserves: Some(vec![WETH.into(), USDC.into()]),
    }
}

fn getter(block: u64) -> (String, String, u64, String) {
    let data = format!("0xbf92857c000000000000000000000000{}", &POS[2..]);
    let r = CurlRpc
        .call("https://sepolia.base.org", "eth_call", json!([{"to": base_sepolia_config().pool, "data": data}, format!("0x{block:x}")]))
        .unwrap();
    let h = r.as_str().unwrap().trim_start_matches("0x");
    let w = |i: usize| u256::U256::from_hex(&h[i * 64..i * 64 + 64]).unwrap();
    (w(0).to_string(), w(1).to_string(), w(3).low_u128() as u64, w(5).to_string())
}

#[test]
#[ignore = "live: records the fixture"]
fn record() {
    let cfg = config_for(&contract_input(None));
    assert_eq!(cfg.chain_id, 84532);
    let rec = Recorder { inner: &CurlRpc, tape: Default::default() };
    let out = verify_position(&rec, &cfg, &contract_input(None)).unwrap();
    let aave = getter(out.block);
    println!("verified: {}", serde_json::to_string(&out).unwrap());
    println!("getter  : {aave:?}");
    let mut tape = rec.tape.into_inner();
    tape.calls.retain(|c| c.1 != "eth_blockNumber");
    let fixture = json!({"block": out.block, "output": out, "aave": [aave.0, aave.1, aave.2, aave.3], "tape": tape});
    std::fs::write(TAPE, serde_json::to_string(&fixture).unwrap()).unwrap();
    assert_eq!((out.cb, out.db, out.lt, out.hf), aave, "must equal Pool.getUserAccountData exactly");
}

fn load() -> (u64, Output, Vec<String>, Tape) {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(TAPE).expect("run `cargo test -- --ignored record` first")).unwrap();
    let aave = v["aave"].as_array().unwrap().iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect();
    (v["block"].as_u64().unwrap(), serde_json::from_value(v["output"].clone()).unwrap(), aave, serde_json::from_value(v["tape"].clone()).unwrap())
}

#[test]
fn a_market_of_base_sepolia_tokens_gets_the_base_sepolia_config() {
    assert_eq!(config_for(&contract_input(None)).chain_id, 84532);
    // the Sepolia and mainnet markets still get their own
    let sep = Input { reserves: Some(vec!["0xf8fb3713d459d7c1018bd0a49d19b4c44290ebe5".into(), "0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357".into()]), ..contract_input(None) };
    assert_eq!(config_for(&sep).chain_id, 11155111);
    let main = Input { reserves: Some(vec!["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2".into(), "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".into()]), ..contract_input(None) };
    assert_eq!(config_for(&main).chain_id, 1);
    // WETH alone is the same address on every OP-stack chain: not enough to pick Base Sepolia
    let weth_only = Input { reserves: Some(vec![WETH.into(), "0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357".into()]), ..contract_input(None) };
    assert_eq!(config_for(&weth_only).chain_id, 11155111);
}

#[test]
fn base_sepolia_knows_the_token_slots_and_newer_aave_math() {
    let c = base_sepolia_config();
    let slot = |a: &str| c.tokens.iter().find(|t| t.address == a).map(|t| t.balances_slot);
    assert_eq!(slot(USDC), Some(0));
    assert_eq!(slot(WETH), Some(3), "WETH9 keeps balances at slot 3");
    assert!(c.price_by_call && c.debt_round_up && c.hf_from_sum);
    assert!(c.proof_rpcs.iter().all(|u| c.header_rpcs.contains(u)), "every proof source also votes on the header");
    assert!(c.header_rpcs.len() >= 2 * c.min_agree - 1);
}

#[test]
fn replay_equals_aave_get_user_account_data_to_the_wei() {
    let (block, want, aave, tape) = load();
    let out = verify_position(&tape, &base_sepolia_config(), &contract_input(Some(block))).unwrap();
    assert_eq!(out, want);
    assert_eq!(out.chain, 84532);
    assert_eq!(vec![out.cb.clone(), out.db.clone(), out.lt.to_string(), out.hf.clone()], aave, "cb, db, lt, hf must equal Aave's own figures");
    assert!(serde_json::to_string(&out).unwrap().len() <= 900, "OutLayer's 900-byte limit");
}

#[test]
fn the_older_formulas_do_not_match_aave_on_base_sepolia() {
    // guards the two settings: switch either off and the reading drifts from Aave's
    let (block, _, aave, tape) = load();
    let old_hf = Config { hf_from_sum: false, ..base_sepolia_config() };
    let o = verify_position(&tape, &old_hf, &contract_input(Some(block))).unwrap();
    assert_ne!(o.hf, aave[3], "Aave 3.0's HF formula should differ here");
    let no_round = Config { debt_round_up: false, ..base_sepolia_config() };
    let o = verify_position(&tape, &no_round, &contract_input(Some(block))).unwrap();
    assert_ne!(o.db, aave[1], "debt rounded to nearest should differ here");
}

#[test]
fn weth_escrow_is_proven_at_slot_3_even_when_the_contract_says_0() {
    // the tape only holds slot-3 proofs for WETH: a read at slot 0 isn't on it and fails
    let (block, _, _, tape) = load();
    let wrong = Config { tokens: vec![TokenSlot { address: WETH.into(), balances_slot: 0 }, TokenSlot { address: USDC.into(), balances_slot: 0 }], ..base_sepolia_config() };
    assert!(verify_position(&tape, &wrong, &contract_input(Some(block))).is_err());
    assert!(verify_position(&tape, &base_sepolia_config(), &contract_input(Some(block))).is_ok());
}
