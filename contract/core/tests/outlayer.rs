//! The request the contract sends to OutLayer.
use serde_json::Value;
use stead_core::*;

#[test]
fn outlayer_input_names_the_markets_tokens_and_reserves() {
    let cfg = VerifyConfig { outlayer: "outlayer.testnet".into(), wasm_url: "https://x/p.wasm".into(), wasm_hash: "ab".into(), markets: [1u32].into(), secrets: Some(("usestead.testnet".into(), "default".into())) };
    let args = outlayer_args(&cfg, "0xaa", "0xc0", "0xd0", "reporter.steadfi.testnet");
    let v: Value = serde_json::from_str(&args).expect("args are JSON");
    assert_eq!(v["source"]["WasmUrl"]["hash"], "ab");
    assert_eq!(v["payer_account_id"], "reporter.steadfi.testnet");
    assert_eq!(v["secrets_ref"]["account_id"], "usestead.testnet");
    let input: Value = serde_json::from_str(v["input_data"].as_str().unwrap()).expect("input is JSON");
    assert_eq!(input["position"], "0xaa");
    assert_eq!(input["reserves"], serde_json::json!(["0xc0", "0xd0"]));
    assert_eq!(input["tokens"][0], serde_json::json!({"address": "0xc0", "balances_slot": 0}));
    assert_eq!(input["tokens"][1]["address"], "0xd0");
    assert!(input["block"].is_null());
}

