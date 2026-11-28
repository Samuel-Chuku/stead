//! Ethereum mainnet readings equal Aave's own `getUserAccountData`, on a real borrower with
//! 8-decimal collateral (cbBTC), where a one-unit rounding difference is visible. `record` runs
//! live (read-only, public RPCs) and saves the tape with Aave's figures; the rest replay it offline.
use serde_json::{json, Value};
use stead_verifier::*;

const TAPE: &str = "tests/fixtures/mainnet_account_data.json";
const POS: &str = "0x5b3a59d923cff08e3d53f80d5ea2b9e94a0b3b86";
const WETH: &str = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC: &str = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

fn input(block: Option<u64>) -> Input {
    Input {
        position: POS.into(),
        block,
        tokens: Some(vec![TokenSlot { address: WETH.into(), balances_slot: 3 }, TokenSlot { address: USDC.into(), balances_slot: 9 }]),
        reserves: Some(vec![WETH.into(), USDC.into()]),
    }
}

fn getter(block: u64) -> Vec<String> {
    let data = format!("0xbf92857c000000000000000000000000{}", &POS[2..]);
    let r = CurlRpc
        .call("https://ethereum-rpc.publicnode.com", "eth_call", json!([{"to": mainnet_config().pool, "data": data}, format!("0x{block:x}")]))
        .unwrap();
    let h = r.as_str().unwrap().trim_start_matches("0x");
    let w = |i: usize| u256::U256::from_hex(&h[i * 64..i * 64 + 64]).unwrap();
    vec![w(0).to_string(), w(1).to_string(), w(3).to_string(), w(5).to_string()]
}

#[test]
#[ignore = "live: records the fixture (Ethereum mainnet, read-only, public RPCs)"]
fn record() {
    let rec = Recorder { inner: &CurlRpc, tape: Default::default() };
    let out = verify_position(&rec, &mainnet_config(), &input(None)).unwrap();
    let aave = getter(out.block);
    let mut tape = rec.tape.into_inner();
    tape.calls.retain(|c| c.1 != "eth_blockNumber");
    std::fs::write(TAPE, serde_json::to_string(&json!({"block": out.block, "output": out, "aave": aave, "tape": tape})).unwrap()).unwrap();
    assert_eq!(vec![out.cb, out.db, out.lt.to_string(), out.hf], aave, "must equal Pool.getUserAccountData exactly");
}

fn load() -> (u64, Vec<String>, Tape) {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(TAPE).expect("run `cargo test -- --ignored record` first")).unwrap();
    let aave = v["aave"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
    (v["block"].as_u64().unwrap(), aave, serde_json::from_value(v["tape"].clone()).unwrap())
}

fn read(cfg: &Config) -> Vec<String> {
    let (block, _, tape) = load();
    let o = verify_position(&tape, cfg, &input(Some(block))).unwrap();
    vec![o.cb, o.db, o.lt.to_string(), o.hf]
}

#[test]
fn mainnet_reading_equals_aave_to_the_wei() {
    let (_, aave, _) = load();
    assert_eq!(read(&mainnet_config()), aave);
}

#[test]
fn rounding_collateral_to_nearest_drifts_from_aave() {
    let (_, aave, _) = load();
    let got = read(&Config { coll_round_down: false, ..mainnet_config() });
    assert_ne!(got[0], aave[0], "collateral rounded to nearest should differ on cbBTC");
}

#[test]
fn the_aave_3_0_health_factor_formula_drifts_from_aave() {
    let (_, aave, _) = load();
    let got = read(&Config { hf_from_sum: false, ..mainnet_config() });
    assert_ne!(got[3], aave[3], "Aave 3.0's HF formula should differ here");
}
