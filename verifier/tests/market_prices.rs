//! The market's reserves are always reported, even when the position doesn't use them: a new
//! position's first supply needs the collateral's price, and a position with no debt yet still
//! gets the debt asset's price. Real Ethereum mainnet data: `record` runs live (public RPCs only,
//! read-only) and saves the tape; every other test replays it offline. One test per rule.
use serde_json::{json, Value};
use stead_verifier::u256::U256;
use stead_verifier::*;

const TAPE: &str = "tests/fixtures/mainnet_market_prices.json";
const WETH: &str = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC: &str = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
/// Never used at all: an absent account (no ETH, no nonce), nothing on Aave (both checked by the
/// recording). A new position address before its gas is sent.
const EMPTY: &str = "0x5eadf00d00000000000000000000000000000001";
/// An account that exists (holds ETH) with nothing on Aave, like a new position after its gas
/// arrived: the beacon deposit contract (its code can never call Aave; the recording checks both).
const FUNDED_EMPTY: &str = "0x00000000219ab540356cbb839cbe05303d7705fa";
/// Uses only WETH as collateral, no debt (the recording checks its config bits).
const COLL_ONLY: &str = "0x10ca34c3aeb9f58589f2e6d888e48b718de877da";
/// Not an Aave reserve.
const NOT_A_RESERVE: &str = "0x000000000000000000000000000000000000dead";

/// The contract's request shape: the market's collateral and debt as reserves and escrow tokens.
fn req(position: &str, block: Option<u64>, reserves: Option<[&str; 2]>) -> Input {
    let t = |a: &str| TokenSlot { address: a.into(), balances_slot: 0 };
    Input { position: position.into(), block, tokens: Some(vec![t(WETH), t(USDC)]), reserves: reserves.map(|r| r.iter().map(|a| a.to_string()).collect()) }
}

/// `Pool.getUserAccountData` and `getUserConfiguration` at `block` (eth_call on a public node).
fn getter(position: &str, block: u64) -> (String, String, u64, String, String) {
    let call = |sel: &str| {
        let data = format!("0x{sel}000000000000000000000000{}", &position[2..]);
        CurlRpc.call("https://ethereum-rpc.publicnode.com", "eth_call", json!([{"to": mainnet_config().pool, "data": data}, format!("0x{block:x}")])).unwrap().as_str().unwrap().trim_start_matches("0x").to_string()
    };
    let h = call("bf92857c");
    let w = |i: usize| U256::from_hex(&h[i * 64..i * 64 + 64]).unwrap();
    (w(0).to_string(), w(1).to_string(), w(3).low_u128() as u64, w(5).to_string(), U256::from_hex(&call("4417a583")).unwrap().to_string())
}

#[test]
#[ignore = "live: records the fixture (Ethereum mainnet, read-only, public RPCs)"]
fn record() {
    let cfg = mainnet_config();
    let rec = Recorder { inner: &CurlRpc, tape: Default::default() };
    let both = Some([WETH, USDC]);
    let empty = verify_position(&rec, &cfg, &req(EMPTY, None, both)).unwrap();
    let block = empty.block;
    let funded = verify_position(&rec, &cfg, &req(FUNDED_EMPTY, Some(block), both)).unwrap();
    let coll = verify_position(&rec, &cfg, &req(COLL_ONLY, Some(block), both)).unwrap();
    let coll_all = verify_position(&rec, &cfg, &req(COLL_ONLY, Some(block), None)).unwrap();
    let empty_odd = verify_position(&rec, &cfg, &req(EMPTY, Some(block), Some([USDC, NOT_A_RESERVE]))).unwrap();
    let coll_odd = verify_position(&rec, &cfg, &req(COLL_ONLY, Some(block), Some([WETH, NOT_A_RESERVE]))).unwrap();
    let (ge, gf, gc) = (getter(EMPTY, block), getter(FUNDED_EMPTY, block), getter(COLL_ONLY, block));
    let balance = |a: &str| CurlRpc.call("https://ethereum-rpc.publicnode.com", "eth_getBalance", json!([a, format!("0x{block:x}")])).unwrap().as_str().unwrap().to_string();
    assert!(balance(EMPTY) == "0x0" && empty.nonce == 0, "the never-used address is an absent account");
    assert!(balance(FUNDED_EMPTY) != "0x0", "the funded address exists");
    println!("empty   : {}", serde_json::to_string(&empty).unwrap());
    println!("coll    : {}", serde_json::to_string(&coll).unwrap());
    println!("getters : {ge:?} {gc:?}");
    assert_eq!((ge.4.as_str(), gf.4.as_str()), ("0", "0"), "the empty positions have no reserve bits");
    assert_eq!(gc.4, "2", "the collateral-only position uses only WETH (reserve 0) as collateral");
    assert_eq!((coll.cb.clone(), coll.db.clone(), coll.lt, coll.hf.clone()), (gc.0.clone(), gc.1.clone(), gc.2, gc.3.clone()), "must equal Pool.getUserAccountData exactly");
    let mut tape = rec.tape.into_inner();
    tape.calls.retain(|c| c.1 != "eth_blockNumber");
    let fixture = json!({
        "block": block,
        "cfg": cfg,
        "getter": {"empty": {"cb": ge.0, "db": ge.1, "lt": ge.2, "hf": ge.3}, "funded_empty": {"cb": gf.0, "db": gf.1, "lt": gf.2, "hf": gf.3}, "coll_only": {"cb": gc.0, "db": gc.1, "lt": gc.2, "hf": gc.3}},
        "output": {"empty": empty, "funded_empty": funded, "coll_only": coll, "coll_only_all": coll_all, "empty_odd": empty_odd, "coll_only_odd": coll_odd},
        "tape": tape,
    });
    std::fs::write(TAPE, serde_json::to_string(&fixture).unwrap()).unwrap();
}

struct Fixture {
    block: u64,
    cfg: Config,
    v: Value,
    tape: Tape,
}
fn load() -> Fixture {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(TAPE).expect("run `cargo test --test market_prices -- --ignored record` first")).unwrap();
    Fixture { block: v["block"].as_u64().unwrap(), cfg: serde_json::from_value(v["cfg"].clone()).unwrap(), tape: serde_json::from_value(v["tape"].clone()).unwrap(), v }
}
fn recorded(f: &Fixture, k: &str) -> Output {
    serde_json::from_value(f.v["output"][k].clone()).unwrap()
}
fn reserve<'a>(o: &'a Output, a: &str) -> &'a ReserveOut {
    o.res.iter().find(|r| r.a == a).unwrap_or_else(|| panic!("no reserve {a} in {o:?}"))
}
fn nonzero(s: &str) -> bool {
    !s.is_empty() && s.chars().any(|c| c != '0')
}

/// Rule 1: a position with nothing on Aave still gets both market prices (and the indexes), with
/// zero balances, no collateral and no debt (HF = uint256 max, as Aave reports it).
#[test]
fn an_empty_position_still_gets_both_market_prices() {
    let f = load();
    for (pos, k) in [(EMPTY, "empty"), (FUNDED_EMPTY, "funded_empty")] {
    let out = verify_position(&f.tape, &f.cfg, &req(pos, Some(f.block), Some([WETH, USDC]))).unwrap();
    assert_eq!(out, recorded(&f, k));
    assert_eq!(out.res.iter().map(|r| r.a.as_str()).collect::<Vec<_>>(), vec![WETH, USDC], "both requested reserves, in request order");
    for a in [WETH, USDC] {
        let r = reserve(&out, a);
        assert!(nonzero(&r.p) && nonzero(&r.ci) && nonzero(&r.di), "{a}: price and indexes {r:?}");
        assert_eq!((r.cs.as_str(), r.ds.as_str()), ("0", "0"), "{a}: no balances");
    }
    assert_eq!((out.cb.as_str(), out.db.as_str(), out.lt), ("0", "0", 0));
    assert_eq!(out.hf, U256::MAX.to_string());
    let g = &f.v["getter"][k];
    assert_eq!((out.cb.as_str(), out.db.as_str(), out.lt, out.hf.as_str()), (g["cb"].as_str().unwrap(), g["db"].as_str().unwrap(), g["lt"].as_u64().unwrap(), g["hf"].as_str().unwrap()), "equals getUserAccountData");
    assert!(serde_json::to_string(&out).unwrap().len() <= 900, "fits OutLayer's output limit");
    }
}

/// Rule 7: an absent account (a new position before its gas arrives) is read: nodes report its
/// storageHash as zero. Any other claim for it, or a zero claim for an account that exists, is
/// still refused.
#[test]
fn an_absent_account_is_read_and_only_a_zero_claim_is_accepted_for_it() {
    let f = load();
    let own = |t: &mut Tape, pos: &str, h: &str| {
        let mut n = 0;
        for c in t.calls.iter_mut().filter(|c| c.1 == "eth_getProof" && c.2[0].as_str() == Some(pos)) {
            c.3["storageHash"] = json!(h);
            n += 1;
        }
        assert!(n > 0);
    };
    let zero = format!("0x{}", "00".repeat(32));
    let out = verify_position(&f.tape, &f.cfg, &req(EMPTY, Some(f.block), Some([WETH, USDC]))).unwrap();
    assert_eq!((out.nonce, out.res.len()), (0, 2));
    let mut t = load().tape;
    own(&mut t, EMPTY, &format!("0x{}", "22".repeat(32)));
    assert!(verify_position(&t, &f.cfg, &req(EMPTY, Some(f.block), Some([WETH, USDC]))).unwrap_err().contains("storageHash"));
    let mut t = load().tape;
    own(&mut t, FUNDED_EMPTY, &zero);
    assert!(verify_position(&t, &f.cfg, &req(FUNDED_EMPTY, Some(f.block), Some([WETH, USDC]))).unwrap_err().contains("storageHash"));
}

/// Rule 2: a position using only the collateral still gets the debt asset's price.
#[test]
fn a_collateral_only_position_still_gets_the_debt_price() {
    let f = load();
    let out = verify_position(&f.tape, &f.cfg, &req(COLL_ONLY, Some(f.block), Some([WETH, USDC]))).unwrap();
    assert_eq!(out, recorded(&f, "coll_only"));
    let usdc = reserve(&out, USDC);
    assert!(nonzero(&usdc.p) && nonzero(&usdc.ci) && nonzero(&usdc.di), "{usdc:?}");
    assert_eq!((usdc.cs.as_str(), usdc.ds.as_str()), ("0", "0"));
    let weth = reserve(&out, WETH);
    assert!(nonzero(&weth.cs) && weth.ds == "0", "{weth:?}");
    assert!(serde_json::to_string(&out).unwrap().len() <= 900, "fits OutLayer's output limit");
}

/// Rule 3: a reserve added only because it was requested changes nothing in the health: the
/// totals equal Aave's getUserAccountData and the reading made without naming any reserve.
#[test]
fn an_added_reserve_leaves_the_health_unchanged() {
    let f = load();
    let named = verify_position(&f.tape, &f.cfg, &req(COLL_ONLY, Some(f.block), Some([WETH, USDC]))).unwrap();
    let all = verify_position(&f.tape, &f.cfg, &req(COLL_ONLY, Some(f.block), None)).unwrap();
    assert_eq!(all, recorded(&f, "coll_only_all"));
    assert_eq!(all.res.iter().map(|r| r.a.as_str()).collect::<Vec<_>>(), vec![WETH], "unnamed: only the reserves it uses");
    assert_eq!((named.hf.clone(), named.cb.clone(), named.db.clone(), named.lt), (all.hf.clone(), all.cb.clone(), all.db.clone(), all.lt));
    let g = &f.v["getter"]["coll_only"];
    assert_eq!((named.cb.as_str(), named.db.as_str(), named.lt, named.hf.as_str()), (g["cb"].as_str().unwrap(), g["db"].as_str().unwrap(), g["lt"].as_u64().unwrap(), g["hf"].as_str().unwrap()), "equals getUserAccountData");
}

/// Rule 4: an asset that isn't an Aave reserve is left out, as before (its empty ReserveData
/// gives id 0, whose listed asset is WETH: never reported under the wrong name).
#[test]
fn an_asset_that_is_not_a_reserve_is_left_out() {
    let f = load();
    let e = verify_position(&f.tape, &f.cfg, &req(EMPTY, Some(f.block), Some([USDC, NOT_A_RESERVE]))).unwrap();
    assert_eq!(e, recorded(&f, "empty_odd"));
    assert_eq!(e.res.iter().map(|r| r.a.as_str()).collect::<Vec<_>>(), vec![USDC]);
    let c = verify_position(&f.tape, &f.cfg, &req(COLL_ONLY, Some(f.block), Some([WETH, NOT_A_RESERVE]))).unwrap();
    assert_eq!(c, recorded(&f, "coll_only_odd"));
    assert_eq!(c.res.iter().map(|r| r.a.as_str()).collect::<Vec<_>>(), vec![WETH]);
}

/// Rule 5: the added reserve's id is a proven read like every other: a tampered answer is refused.
#[test]
fn the_added_reserves_id_is_proven() {
    let f = load();
    let want = recorded(&f, "empty");
    let mut tape = f.tape;
    // the one-slot pool read that looks up the added reserve's id (ReserveData slot 3 of USDC)
    let n = tape
        .calls
        .iter_mut()
        .filter(|c| c.1 == "eth_getProof" && c.2[0].as_str() == Some(f.cfg.pool.as_str()) && c.2[1].as_array().is_some_and(|s| s.len() == 1))
        .map(|c| c.3["storageProof"][0]["value"] = json!("0x1"))
        .count();
    assert!(n > 0, "the lookup is on the tape");
    // the claimed value is ignored: the value comes from the proof itself, so the reading holds
    let out = verify_position(&tape, &f.cfg, &req(EMPTY, Some(f.block), Some([WETH, USDC]))).unwrap();
    assert_eq!(out, want);
    // a broken proof node is refused
    for c in tape.calls.iter_mut().filter(|c| c.1 == "eth_getProof" && c.2[0].as_str() == Some(f.cfg.pool.as_str()) && c.2[1].as_array().is_some_and(|s| s.len() == 1)) {
        let proof = c.3["storageProof"][0]["proof"].as_array_mut().unwrap();
        let last = proof.last_mut().unwrap();
        let mut s = last.as_str().unwrap().to_string();
        let k = s.len();
        s.replace_range(k - 2..k, if &s[k - 2..] == "00" { "01" } else { "00" });
        *last = json!(s);
    }
    let e = verify_position(&tape, &f.cfg, &req(EMPTY, Some(f.block), Some([WETH, USDC]))).unwrap_err();
    assert!(e.contains("proof"), "{e}");
}

/// Rule 6: still at most 2 reserves (and 2 tokens) per request: the output must fit 900 bytes.
#[test]
fn at_most_two_reserves_with_added_ones() {
    let f = load();
    let mut i = req(EMPTY, Some(f.block), None);
    i.reserves = Some(vec![WETH.into(), USDC.into(), NOT_A_RESERVE.into()]);
    assert!(verify_position(&f.tape, &f.cfg, &i).unwrap_err().contains("at most 2"));
}
