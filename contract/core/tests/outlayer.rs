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


/// A real result of the pinned proof program on an Ethereum mainnet Aave position (WETH
/// collateral, USDC debt), produced from the contract's own request shape with only the public
/// mainnet voters. Each value equals Aave's getUserAccountData and the tokens' balanceOf at that
/// block (the health factor to Aave's own rounding).
const MAINNET_OUTPUT: &str = r#"{"v":1,"pos":"0x90b7c98a7289cd0e1a2b332bc7da2ac0c45c1b47","chain":1,"block":26391338,"ts":1794395987,"hf":"1009983186395726701","cb":"352205161248","db":"292927980815","lt":8400,"nonce":164,"res":[{"a":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","p":"205940415716","cs":"1593758962114335703","ds":"1281119108846272950","ci":"1073078493431457933990537353","di":"1110272962154599079376528266"}],"bal":[["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","7551782479935590"],["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","0"]],"agree":8}"#;

#[test]
fn a_mainnet_proof_parses_into_what_the_contract_reads() {
    let o: VerifiedOutput = serde_json::from_str(MAINNET_OUTPUT).expect("the contract parses a mainnet proof");
    assert_eq!(o.chain, 1);
    assert_eq!(o.cb, "352205161248");
    assert_eq!(o.db, "292927980815");
    assert!(o.agree >= 3, "at least three independent RPCs agree");
    assert!(MAINNET_OUTPUT.len() <= 900, "fits OutLayer's output limit");
    let weth = o.res.iter().find(|r| r.a == "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2").expect("the collateral reserve");
    assert!(weth.cs.is_some() && weth.ds.is_some() && weth.ci.is_some() && weth.di.is_some());
    assert_eq!(o.bal.len(), 2);
}
