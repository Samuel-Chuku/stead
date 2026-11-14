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

// ── a position the program reads before it uses the market's reserves ──

/// Real results of the proof program at Ethereum mainnet block 26409438 (public voters only), for
/// a never-used address and for a position holding only WETH collateral. Both name the market's
/// collateral and debt with their prices although the position doesn't use them (balances 0).
const EMPTY_OUTPUT: &str = r#"{"v":1,"pos":"0x5eadf00d00000000000000000000000000000001","chain":1,"block":26409438,"ts":1794613751,"hf":"115792089237316195423570985008687907853269984665640564039457584007913129639935","cb":"0","db":"0","lt":0,"nonce":0,"res":[{"a":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","p":"191872455522","cs":"0","ds":"0","ci":"1073183265200599983254076920","di":"1110427820050836835052740386"},{"a":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","p":"99973126","cs":"0","ds":"0","ci":"1193798208765396815898194317","di":"1259018753544507550692379110"}],"bal":[["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","0"],["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","0"]],"agree":8}"#;
const COLL_ONLY_OUTPUT: &str = r#"{"v":1,"pos":"0x10ca34c3aeb9f58589f2e6d888e48b718de877da","chain":1,"block":26409438,"ts":1794613751,"hf":"115792089237316195423570985008687907853269984665640564039457584007913129639935","cb":"959363936","db":"0","lt":8400,"nonce":2,"res":[{"a":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","p":"191872455522","cs":"4659044553883809","ds":"0","ci":"1073183265200599983254076920","di":"1110427820050836835052740386"},{"a":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","p":"99973126","cs":"0","ds":"0","ci":"1193798208765396815898194317","di":"1259018753544507550692379110"}],"bal":[["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","0"],["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","0"]],"agree":8}"#;
/// The same empty position as the previous program reported it: no reserve at all.
const EMPTY_OUTPUT_BEFORE: &str = r#"{"v":1,"pos":"0x5eadf00d00000000000000000000000000000001","chain":1,"block":26409438,"ts":1794613751,"hf":"115792089237316195423570985008687907853269984665640564039457584007913129639935","cb":"0","db":"0","lt":0,"nonce":0,"res":[],"bal":[["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","0"],["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","0"]],"agree":8}"#;

const WETH: &str = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC: &str = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const E18: u128 = 1_000_000_000_000_000_000;
const NOW: u64 = 1_800_000_000 * SEC;

/// The mainnet setup: market 0 WETH/USDC (LT 84 %, bonus 5 %), the $150 size cap, verified reads
/// on market 0, and one position at `pos`.
fn mainnet_stead(pos: &str) -> (Stead, u64) {
    let a = |s: &str| EvmAddr::parse(s).unwrap();
    let mut s = Stead::new("usestead.near", "reporter.usestead.near");
    let m = Market { chain_id: 1, pool: a("0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"), collateral: a(WETH), debt: a(USDC), collateral_decimals: 18, debt_decimals: 6, lt_bps: 8400, liq_bonus_bps: 500, gas_limit_cap: 375_332, max_fee_cap: 1_000_000_000 };
    s.add_market("usestead.near", m).unwrap();
    s.set_limits("usestead.near", Limits { max_collateral_base: 150 * 100_000_000, borrowers: Default::default() }).unwrap();
    s.set_verify_config("usestead.near", Some(VerifyConfig { outlayer: "outlayer.near".into(), wasm_url: "https://x/p.wasm".into(), wasm_hash: "ab".into(), markets: [0u32].into(), secrets: None })).unwrap();
    let pid = s.register_position("borrower.usestead.near", 0, a("0x00000000000000000000000000000000000000b0")).unwrap();
    s.set_position_address(pid, a(pos)).unwrap();
    (s, pid)
}
fn supply(s: &mut Stead, pid: u64, amount: u128) -> Result<SignPlan, String> {
    let gas = GasArgs { gas_limit: 300_000, max_fee_per_gas: 1_000_000_000, max_priority_fee_per_gas: 100_000_000 };
    s.sign_action("borrower.usestead.near", pid, Action::Supply { amount }, gas, NOW)
}
fn parse(s: &str) -> VerifiedOutput {
    assert!(s.len() <= 900, "fits OutLayer's output limit");
    serde_json::from_str(s).expect("the contract parses it")
}

// A new position's first reading carries the collateral's price, so its first supply passes the
// size cap check (and one above the cap is still refused).
#[test]
fn an_empty_positions_reading_prices_its_first_supply() {
    let (mut s, pid) = mainnet_stead("0x5eadf00d00000000000000000000000000000001");
    let e = supply(&mut s, pid, E18 / 100).unwrap_err();
    assert!(e.contains("price reading"), "{e}");
    // the previous program's reading of the same position is refused: no price
    let e = s.apply_verified(pid, &parse(EMPTY_OUTPUT_BEFORE), NOW).unwrap_err();
    assert!(e.contains("no price for 0xc02a"), "{e}");
    assert_eq!(s.apply_verified(pid, &parse(EMPTY_OUTPUT), NOW).unwrap(), None);
    let h = s.position(pid).unwrap().health.clone().expect("a reading");
    assert_eq!((h.r.collateral_price_base, h.r.debt_price_base), (191_872_455_522, 99_973_126));
    assert_eq!((h.r.collateral_base, h.r.debt_base, h.r.hf_wad), (0, 0, u128::MAX));
    // $1,918.72 per WETH: 0.08 WETH ≈ $153.50 is above the $150 cap, 0.07 WETH ≈ $134.31 is not
    let e = supply(&mut s, pid, 8 * E18 / 100).unwrap_err();
    assert!(e.contains("size cap"), "{e}");
    supply(&mut s, pid, 7 * E18 / 100).expect("the first supply is signed");
}

// A position holding only the collateral: its reading carries the debt's price and its
// collateral counts against the cap.
#[test]
fn a_collateral_only_reading_carries_the_debt_price() {
    let (mut s, pid) = mainnet_stead("0x10ca34c3aeb9f58589f2e6d888e48b718de877da");
    let o = parse(COLL_ONLY_OUTPUT);
    assert!(o.res.iter().any(|r| r.a == USDC && r.p == "99973126"), "the debt asset's price");
    s.apply_verified(pid, &o, NOW).unwrap();
    let h = s.position(pid).unwrap().health.clone().unwrap();
    assert_eq!((h.r.collateral_base, h.r.debt_price_base), (959_363_936, 99_973_126));
    // $9.59 held: + 0.074 WETH ≈ $141.98 is above $150, + 0.073 WETH ≈ $140.07 is not
    assert!(supply(&mut s, pid, 74 * E18 / 1000).unwrap_err().contains("size cap"));
    supply(&mut s, pid, 73 * E18 / 1000).expect("signed");
}
