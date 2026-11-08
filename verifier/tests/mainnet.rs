//! Ethereum mainnet settings of the proof program: which config a request gets, the price vote,
//! the known tokens' balance slots, and Aave 3.4+ rounding. One test per rule.
use serde_json::{json, Value};
use stead_verifier::u256::U256;
use stead_verifier::*;

const WETH: &str = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC: &str = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

fn input(reserves: Option<Vec<&str>>) -> Input {
    Input { position: "0x0000000000000000000000000000000000000001".into(), block: None, tokens: None, reserves: reserves.map(|r| r.into_iter().map(String::from).collect()) }
}

/// Each voter answers `eth_call` with the price it is given (or an error).
struct Voters(Vec<(String, Result<String, String>)>);
impl Rpc for Voters {
    fn call(&self, url: &str, method: &str, _params: Value) -> Result<Value, String> {
        assert_eq!(method, "eth_call");
        let (_, r) = self.0.iter().find(|(u, _)| u == url).expect("unknown voter");
        r.clone().map(Value::String)
    }
}
fn word(v: u128) -> String {
    format!("0x{v:064x}")
}
fn cfg_with(urls: &[&str]) -> Config {
    Config { header_rpcs: urls.iter().map(|u| u.to_string()).collect(), ..mainnet_config() }
}

#[test]
fn a_market_of_known_mainnet_tokens_gets_the_mainnet_config() {
    assert_eq!(config_for(&input(Some(vec![WETH, USDC]))).chain_id, 1);
    assert_eq!(config_for(&input(Some(vec!["0xf8fb3713d459d7c1018bd0a49d19b4c44290ebe5", "0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357"]))).chain_id, 11155111);
    // one unknown token: not mainnet (the contract would refuse a mismatched chain anyway)
    assert_eq!(config_for(&input(Some(vec![WETH, "0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357"]))).chain_id, 11155111);
    assert_eq!(config_for(&input(None)).chain_id, 11155111);
}

#[test]
fn mainnet_reads_prices_by_vote_and_knows_the_token_slots() {
    let m = mainnet_config();
    assert!(m.price_by_call && m.debt_round_up);
    let slot = |a: &str| m.tokens.iter().find(|t| t.address == a).unwrap().balances_slot;
    assert_eq!((slot(WETH), slot(USDC)), (3, 9));
    assert!(!sepolia_config().price_by_call && !sepolia_config().debt_round_up);
}

#[test]
fn a_price_needs_a_majority_of_at_least_three() {
    let urls = ["https://a", "https://b", "https://c", "https://d"];
    let v = |answers: [Result<String, String>; 4]| Voters(urls.iter().map(|u| u.to_string()).zip(answers).collect());
    let p = word(223_315_000_000);
    // 3 of 4 agree, one odd: accepted
    let ok = v([Ok(p.clone()), Ok(p.clone()), Ok(p.clone()), Ok(word(1))]);
    assert_eq!(agreed_price(&ok, &cfg_with(&urls), WETH, 1).unwrap(), U256::from(223_315_000_000u128));
    // only 2 agree, 2 errors: refused
    let few = v([Ok(p.clone()), Ok(p.clone()), Err("down".into()), Err("down".into())]);
    assert!(agreed_price(&few, &cfg_with(&urls), WETH, 1).unwrap_err().contains("only 2"));
    // 2 vs 2: no majority, refused
    let split = v([Ok(p.clone()), Ok(p.clone()), Ok(word(1)), Ok(word(1))]);
    assert!(agreed_price(&split, &cfg_with(&urls), WETH, 1).is_err());
    // 3 vs 3: each side reaches the minimum, neither is a majority: refused
    let six = ["https://a", "https://b", "https://c", "https://d", "https://e", "https://f"];
    let three_three = Voters(six.iter().enumerate().map(|(i, u)| (u.to_string(), Ok(if i < 3 { p.clone() } else { word(1) }))).collect());
    assert!(agreed_price(&three_three, &cfg_with(&six), WETH, 1).unwrap_err().contains("disagreement"));
}

#[test]
fn a_keyed_voter_is_never_named_in_a_price_error() {
    let key = "https://name.quiknode.pro/SECRETKEY/";
    let mut cfg = cfg_with(&[key, "https://b"]);
    cfg.keyed = Some(key.into());
    let rpc = Voters(vec![(key.into(), Err(format!("{key}: 429"))), ("https://b".into(), Err("https://b: 500".into()))]);
    let e = agreed_price(&rpc, &cfg, WETH, 1).unwrap_err();
    assert!(!e.contains("SECRETKEY") && !e.contains("quiknode"), "{e}");
    let _ = json!(null);
}

#[test]
fn debt_rounds_up_on_mainnet() {
    let ray = U256::from(10u128.pow(27));
    // 3 × 1.5 RAY / RAY = 4.5 → 5 up; ray_mul rounds half up too, so use 3 × 1.2 = 3.6 → 4 up, 4 nearest
    let idx = ray * U256::from(12u128) / U256::from(10u128);
    assert_eq!(ray_mul_up(U256::from(3u128), idx), U256::from(4u128));
    // 3 × 1.1 = 3.3 → 4 up, 3 nearest
    let idx2 = ray * U256::from(11u128) / U256::from(10u128);
    assert_eq!(ray_mul_up(U256::from(3u128), idx2), U256::from(4u128));
    assert_eq!(ray_mul(U256::from(3u128), idx2), U256::from(3u128));
    // exact: no change
    assert_eq!(ray_mul_up(U256::from(3u128), ray), U256::from(3u128));
}
