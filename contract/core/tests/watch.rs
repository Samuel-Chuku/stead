//! Liquidation while claims are open (premiums forfeited, high-water collateral watch, the
//! settlement abort/reduce rules) and the verified settlement repay. One test per rule; each
//! fails if its rule is broken.
mod common;
use common::*;

fn err<T: std::fmt::Debug>(r: Result<T, String>) -> String {
    r.expect_err("expected a refusal")
}

/// Aave liquidates `debt_bps` of the debt at `price` with a 10 % bonus (model chain).
fn liquidate(f: &mut F, price: u128, debt_bps: u128) -> u128 {
    let repaid = f.dai * debt_bps / BPS;
    let seized = units_to_base(repaid, E8, 18) * 11_000 / BPS * E18 / price;
    f.dai -= repaid;
    f.link -= seized;
    seized
}

fn events(f: &mut F, name: &str) -> Vec<String> {
    std::mem::take(&mut f.s.events).into_iter().filter(|e| e.contains(name)).collect()
}

/// Two stewards share one rescue (two claims, two settlement legs).
fn pooled(f: &mut F) -> u64 {
    let rid = f.report(2_850_000_000).expect("auction");
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 300, t / 2, BOND, f.now).unwrap();
    f.s.bid(STEWARDS[3], rid, 400, t - t / 2, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    for (k, m) in f.s.rescue(rid).unwrap().members.clone().iter().enumerate() {
        f.link += m.share_units;
        f.s.confirm_topup(REPORTER, rid, &m.steward, m.share_units, &format!("0xp{k}"), f.block + 1, f.now).unwrap();
    }
    rid
}

/// Expire the buy-back window and start the settlement as steward 0; returns the settlement.
fn start_at_expiry(f: &mut F, rid: u64) -> Settlement {
    f.now += 24 * 3600 * SEC;
    f.report(2_850_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    f.s.rescue(rid).unwrap().settlement.clone().unwrap()
}

/// Sign the next leg and land it on the model chain; `confirm` = the reporter confirms the nonce.
fn send_leg(f: &mut F, rid: u64, confirm: bool) -> (SignPlan, u128) {
    f.report(f.price);
    let leg = f.s.rescue(rid).unwrap().settlement.clone().unwrap().legs.into_iter().find(|l| !l.done).unwrap();
    let plan = f.s.settle_next(rid, gas(), f.now).unwrap().unwrap();
    let AmountArg::Exact(u) = leg.amount else { panic!("exact leg") };
    f.s.on_signed(f.pid, plan.tx.nonce, Some(vec![1])).unwrap();
    f.link -= u;
    if confirm {
        f.s.confirm_nonce(REPORTER, f.pid, plan.tx.nonce + 1, true, f.block + 1).unwrap();
    }
    (plan, u)
}

fn claims_of(f: &F, rid: u64) -> Vec<Claim> {
    f.s.claims.values().filter(|c| c.rescue_id == rid).cloned().collect()
}

// ── a proven liquidation while a claim is open forfeits the premium ──

#[test]
fn liquidation_with_a_claim_open_forfeits_the_premium_and_buyback_is_principal() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.report(2_850_000_000); // the watch starts on this reading
    let cl = claims_of(&f, rid)[0].clone();
    assert!(cl.premium_units > 0);
    f.tick(12);
    liquidate(&mut f, 2_400_000_000, 1000);
    f.report(2_400_000_000);
    let after = f.s.claims[&cl.token_id].clone();
    assert_eq!(after.owed_units, cl.share_units, "owed shrinks to the principal");
    assert_eq!(after.premium_units, 0);
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Open);
    assert_eq!(events(&mut f, "premiums_forfeited").len(), 1);
    // buy-back at the principal commits and pays exactly the principal
    f.pay_escrow(cl.share_units, 0).unwrap();
    assert_eq!(f.s.claims[&cl.token_id].status, ClaimStatus::BoughtBack);
    let outs = f.run_payouts();
    let bb = outs.iter().find(|o| o.purpose == OutPurpose::BuyBack).unwrap();
    assert_eq!(bb.amount, cl.share_units);
}

#[test]
fn a_falling_price_alone_is_not_a_liquidation() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.report(2_850_000_000);
    let cl = claims_of(&f, rid)[0].clone();
    for p in [2_700_000_000, 2_400_000_000, 2_000_000_000, 2_600_000_000] {
        f.tick(12);
        f.report(p);
    }
    assert_eq!(f.s.claims[&cl.token_id].owed_units, cl.owed_units, "no collateral left the position: premium stands");
}

// ── the high-water collateral mark ──

#[test]
fn supply_then_liquidation_is_caught_by_the_high_water_mark() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.report(2_850_000_000);
    let cl = claims_of(&f, rid)[0].clone();
    // the borrower supplies 50 LINK while the claim is open (allowed): the mark rises
    f.sign_ok(Action::Supply { amount: 50 * E18 });
    f.link += 50 * E18;
    f.report(2_850_000_000);
    // a liquidation seizes less than the supply: collateral is still above where it started
    f.tick(12);
    let seized = liquidate(&mut f, 2_850_000_000, 1000);
    assert!(seized < 50 * E18);
    f.report(2_850_000_000);
    assert_eq!(f.s.claims[&cl.token_id].owed_units, cl.share_units, "caught against the high-water mark, not the start");
}

#[test]
fn settlement_legs_in_flight_and_confirmed_are_not_a_liquidation() {
    let mut f = F::new();
    let rid = pooled(&mut f);
    let s = start_at_expiry(&mut f, rid);
    f.dai -= s.repay_units;
    f.s.confirm_settlement_repay(REPORTER, rid, "0xrep", s.repay_units, f.block + 1).unwrap();
    let before: Vec<Claim> = claims_of(&f, rid);
    // leg 1 lands on-chain but its nonce isn't confirmed yet: a reading now sees the fall
    let (plan, _) = send_leg(&mut f, rid, false);
    f.report(f.price);
    // leg 1 confirmed; the rest sent and confirmed, with a reading before each
    f.s.confirm_nonce(REPORTER, f.pid, plan.tx.nonce + 1, true, f.block + 1).unwrap();
    f.report(f.price);
    f.run_legs(rid);
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Settled);
    for c in before {
        assert_eq!(f.s.claims[&c.token_id].owed_units, c.owed_units, "premium kept: the legs explain the fall");
    }
    assert!(events(&mut f, "premiums_forfeited").is_empty());
}

// ── a liquidation during the settlement ──

#[test]
fn liquidation_before_the_settlement_repay_aborts_to_open_and_a_later_repay_is_a_stray() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.report(2_850_000_000);
    let cl = claims_of(&f, rid)[0].clone();
    let _ = start_at_expiry(&mut f, rid);
    f.tick(12);
    liquidate(&mut f, 2_850_000_000, 1000);
    f.report(2_850_000_000);
    let r = f.s.rescue(rid).unwrap();
    assert_eq!(r.state, RescueState::Open, "aborted back to Open");
    assert!(r.settlement.is_none());
    assert_eq!(f.s.claims[&cl.token_id].owed_units, cl.share_units);
    // the settler's repay lands after the abort: not a settlement repay any more, a stray
    assert!(err(f.s.confirm_settlement_repay(REPORTER, rid, "0xlate", 1, f.block + 1)).contains("not settling"));
    f.s.confirm_stray_repay(REPORTER, f.pid, STEWARDS[0], 100 * E18, "0xlate", f.block + 1).unwrap();
    // a fresh settlement at the principal
    f.report(2_850_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    assert_eq!(f.s.rescue(rid).unwrap().settlement.clone().unwrap().owed_units, cl.share_units);
}

#[test]
fn liquidation_after_the_repay_drops_the_premium_from_unsent_legs_only() {
    let mut f = F::new();
    let rid = pooled(&mut f);
    let s = start_at_expiry(&mut f, rid);
    f.dai -= s.repay_units;
    f.s.confirm_settlement_repay(REPORTER, rid, "0xrep", s.repay_units, f.block + 1).unwrap();
    let cls = claims_of(&f, rid);
    let (_, sent) = send_leg(&mut f, rid, true); // leg 1 (claim 0's principal + R) sent before the liquidation
    f.report(f.price);
    f.tick(12);
    liquidate(&mut f, 2_850_000_000, 1000);
    f.report(2_850_000_000);
    let s2 = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    assert_eq!(s2.legs[0].amount, AmountArg::Exact(sent), "a sent leg is history");
    for c in &cls {
        assert_eq!(f.s.claims[&c.token_id].owed_units, c.share_units, "premium forfeited, even for the claim whose principal leg was sent");
    }
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Settling, "keeps settling");
    // what's left pays principal only: each steward ends with its principal (+ the settler's R)
    let rest = f.run_legs(rid);
    let got = |i: usize| rest.iter().filter(|(to, _)| *to == steward_payout(i)).map(|(_, u)| u).sum::<u128>() + if i == 0 { sent } else { 0 };
    let c0 = cls.iter().find(|c| c.owner == STEWARDS[0]).unwrap();
    let c3 = cls.iter().find(|c| c.owner == STEWARDS[3]).unwrap();
    assert_eq!(got(0), c0.share_units + s2.repay_collateral_units);
    assert_eq!(got(3), c3.share_units);
}

#[test]
fn a_leg_needs_a_reading_after_the_last_event() {
    let mut f = F::new();
    let rid = pooled(&mut f);
    let s = start_at_expiry(&mut f, rid);
    f.dai -= s.repay_units;
    f.s.confirm_settlement_repay(REPORTER, rid, "0xrep", s.repay_units, f.block + 1).unwrap();
    assert!(err(f.s.settle_next(rid, gas(), f.now)).contains("predates the last event"));
    send_leg(&mut f, rid, true);
    assert!(err(f.s.settle_next(rid, gas(), f.now)).contains("predates the last event"), "the next leg waits for a reading after this one");
}

#[test]
fn auction_liquidated_with_an_earlier_claim_open_forfeits_that_premium() {
    let mut f = F::new();
    let mut p = f.s.params.clone();
    p.target_hf_bps = 12_000;
    p.early_settle_hf_bps = 10_500;
    f.s.set_params(OWNER, p).unwrap();
    let first = f.rescue_with(&[(0, 900, None)]);
    f.report(2_850_000_000);
    let cl = claims_of(&f, first)[0].clone();
    f.tick(60);
    f.report(2_730_000_000);
    let second = f.s.position(f.pid).unwrap().active_auction.expect("stacked auction");
    f.tick(12);
    liquidate(&mut f, 2_730_000_000, 1000);
    f.report(2_730_000_000);
    assert_eq!(f.s.rescue(second).unwrap().state, RescueState::Failed);
    assert_eq!(f.s.claims[&cl.token_id].owed_units, cl.share_units, "the earlier claim's premium is forfeited too");
}

#[test]
fn claims_kept_after_a_partial_topup_and_a_liquidation_carry_no_premium() {
    let mut f = F::new();
    let rid = f.report(2_850_000_000).unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 300, t / 2, BOND, f.now).unwrap();
    f.s.bid(STEWARDS[3], rid, 400, t - t / 2, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    let m0 = f.s.rescue(rid).unwrap().members[0].clone();
    f.link += m0.share_units;
    f.s.confirm_topup(REPORTER, rid, &m0.steward, m0.share_units, "0xa", f.block + 1, f.now).unwrap();
    f.tick(12);
    liquidate(&mut f, 2_400_000_000, 5000);
    f.report(2_400_000_000);
    let kept = claims_of(&f, rid);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].owed_units, kept[0].share_units);
}

// ── the verified settlement repay ──

const P: u128 = 2_850_000_000;

fn verified_market(f: &mut F) {
    f.s.set_verify_config(OWNER, Some(VerifyConfig { outlayer: "outlayer.testnet".into(), wasm_url: "https://x/p.wasm".into(), wasm_hash: "ab".into(), markets: [0u32].into(), secrets: None })).unwrap();
}

/// The proof program's output with exact values: scaled = units / index.
fn vread(f: &mut F, ci: u128, di: Option<u128>) -> Result<Option<u64>, String> {
    f.block += 1;
    f.now += 1;
    f.price = P;
    let c = units_to_base(f.link, P, 18);
    let d = units_to_base(f.dai, E8, 18);
    let (cs, ds) = (mul_div(f.link, RAY, ci), mul_div(f.dai, RAY, di.unwrap_or(RAY)));
    let dai_res = match di {
        Some(di) => serde_json::json!({"a": DAI.to_lowercase(), "p": E8.to_string(), "cs": "0", "ds": ds.to_string(), "ci": RAY.to_string(), "di": di.to_string()}),
        None => serde_json::json!({"a": DAI.to_lowercase(), "p": E8.to_string(), "cs": "0", "ds": ds.to_string()}),
    };
    let link_res = match di {
        Some(_) => serde_json::json!({"a": LINK.to_lowercase(), "p": P.to_string(), "cs": cs.to_string(), "ds": "0", "ci": ci.to_string(), "di": RAY.to_string()}),
        None => serde_json::json!({"a": LINK.to_lowercase(), "p": P.to_string(), "cs": cs.to_string(), "ds": "0"}),
    };
    let o: VerifiedOutput = serde_json::from_value(serde_json::json!({
        "v": 1, "pos": POS_ADDR, "chain": 31337, "block": f.block,
        "hf": hf_wad(c, d, 7500).to_string(), "cb": c.to_string(), "db": d.to_string(),
        "res": [link_res, dai_res],
        "bal": [[LINK.to_lowercase(), f.idle_link.to_string()], [DAI.to_lowercase(), f.idle_dai.to_string()]],
        "agree": 3
    }))
    .unwrap();
    f.s.apply_verified(f.pid, &o, f.now)
}

/// Interest accrues: the liquidity index moves from `from` to `to`; the scaled balance stays,
/// the token units grow with it (as on Aave).
fn accrue(f: &mut F, from: u128, to: u128) {
    f.link = mul_div(f.link, to, from) + 1; // rounded up so units / index gives back the scaled balance
}

/// A verified rescue: auction, bid, top-up proven; claims open. `di` None: the older program.
fn verified_rescue(f: &mut F, di: Option<u128>) -> u64 {
    verified_market(f);
    let rid = vread(f, RAY, di).unwrap().expect("auction");
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 300, t, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    f.link += t;
    vread(f, RAY, di).unwrap();
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Open);
    rid
}

/// A verified pooled rescue: two stewards, two claims (so one is still open after a leg).
fn verified_pooled(f: &mut F) -> u64 {
    verified_market(f);
    let rid = vread(f, RAY, Some(RAY)).unwrap().expect("auction");
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 300, t / 2, BOND, f.now).unwrap();
    f.s.bid(STEWARDS[3], rid, 400, t - t / 2, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    f.link += t;
    vread(f, RAY, Some(RAY)).unwrap();
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Open);
    rid
}

fn verified_start(f: &mut F, rid: u64, di: u128) -> (Settlement, SettleStart) {
    f.now += 24 * 3600 * SEC;
    vread(f, RAY, Some(di)).unwrap();
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    (s, f.s.watch_of(f.pid).settle.expect("verified start"))
}

#[test]
fn reporter_cannot_confirm_a_proven_repay() {
    let mut f = F::new();
    let rid = verified_rescue(&mut f, Some(RAY));
    let (s, _) = verified_start(&mut f, rid, RAY);
    assert!(err(f.s.confirm_settlement_repay(REPORTER, rid, "0xr", s.repay_units, f.block + 1)).contains("proof of the debt drop"));
}

#[test]
fn start_snapshots_the_decision_reading() {
    let mut f = F::new();
    let rid = verified_rescue(&mut f, Some(RAY));
    let di = RAY + RAY / 20;
    let (s, st) = verified_start(&mut f, rid, di);
    let last = f.s.watch_of(f.pid).last.unwrap();
    assert_eq!(st.start, last, "snapshot = the verified decision reading");
    assert_eq!(st.start.block, f.s.position(f.pid).unwrap().health.clone().unwrap().r.block);
    assert_eq!(st.need, mul_div(s.repay_units, RAY, di) + 1, "need = repay in scaled units, rounded up");
}

#[test]
fn repay_confirmed_only_on_the_exact_scaled_drop() {
    let mut f = F::new();
    let rid = verified_rescue(&mut f, Some(RAY));
    let (_, st) = verified_start(&mut f, rid, RAY);
    f.dai -= st.need - 1;
    vread(&mut f, RAY, Some(RAY)).unwrap();
    assert!(!f.s.rescue(rid).unwrap().settlement.clone().unwrap().repay_confirmed, "need − 1: not confirmed");
    f.dai -= 1;
    vread(&mut f, RAY, Some(RAY)).unwrap();
    assert!(f.s.rescue(rid).unwrap().settlement.clone().unwrap().repay_confirmed, "need: confirmed");
}

#[test]
fn a_repay_after_the_index_rose_must_cover_the_interest_slice() {
    let mut f = F::new();
    let rid = verified_rescue(&mut f, Some(RAY));
    let (s, st) = verified_start(&mut f, rid, RAY);
    // interest accrues: the debt index is up 0.1 % when the settler repays
    let di_t = RAY + RAY / 1000;
    let ds0 = f.dai;
    f.dai = mul_div(ds0, di_t, RAY);
    f.dai -= s.repay_units; // exactly R: burns R / di_t scaled, short of need
    vread(&mut f, RAY, Some(di_t)).unwrap();
    assert!(!f.s.rescue(rid).unwrap().settlement.clone().unwrap().repay_confirmed);
    // the steward's formula: ceil(need × di_t) + 2 wei in total
    let total = mul_div(st.need, di_t, RAY) + 2;
    f.dai -= total - s.repay_units;
    vread(&mut f, RAY, Some(di_t)).unwrap();
    assert!(f.s.rescue(rid).unwrap().settlement.clone().unwrap().repay_confirmed);
}

#[test]
fn a_larger_drop_never_raises_the_settlers_credit() {
    let mut f = F::new();
    let rid = verified_rescue(&mut f, Some(RAY));
    let (s, st) = verified_start(&mut f, rid, RAY);
    f.dai -= (st.need + st.need / 2).min(f.dai);
    vread(&mut f, RAY, Some(RAY)).unwrap();
    let after = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    assert!(after.repay_confirmed);
    assert_eq!(after.legs, s.legs, "legs exactly as stored at start");
    assert_eq!(after.repay_collateral_units, s.repay_collateral_units);
}

#[test]
fn borrower_self_repay_counts_and_the_settlers_own_repay_is_then_a_stray() {
    let mut f = F::new();
    let rid = verified_rescue(&mut f, Some(RAY));
    let (s, st) = verified_start(&mut f, rid, RAY);
    // the borrower repays on Aave directly (Stead can't block it): the drop is credited
    f.dai -= st.need;
    vread(&mut f, RAY, Some(RAY)).unwrap();
    let after = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    assert!(after.repay_confirmed);
    assert_eq!(after.repay_collateral_units, s.repay_collateral_units, "settler's credit stays its stored R leg");
    // the settler then repays too: a stray, reimbursed at par once claims resolve
    f.s.confirm_stray_repay(REPORTER, f.pid, STEWARDS[0], s.repay_units, "0xsettler", f.block + 1).unwrap();
    assert_eq!(f.s.book(f.pid).stray_repays.len(), 1);
}

#[test]
fn no_stray_repay_while_a_settlement_repay_is_being_proven() {
    let mut f = F::new();
    let rid = verified_rescue(&mut f, Some(RAY));
    verified_start(&mut f, rid, RAY);
    assert!(err(f.s.confirm_stray_repay(REPORTER, f.pid, STEWARDS[1], E18, "0xs", f.block + 1)).contains("being proven"));
}

#[test]
fn verified_watch_is_exact_beyond_the_legs() {
    let mut f = F::new();
    let rid = verified_rescue(&mut f, Some(RAY));
    let cl = claims_of(&f, rid)[0].clone();
    let ci = RAY + RAY / 10;
    // interest accrues (scaled unchanged): not a liquidation
    accrue(&mut f, RAY, ci);
    vread(&mut f, ci, Some(RAY)).unwrap();
    assert_eq!(f.s.claims[&cl.token_id].owed_units, cl.owed_units, "interest is not a liquidation");
    // two scaled units go missing: a liquidation, with no tolerance
    f.link -= 2 * ci / RAY + 1;
    vread(&mut f, ci, Some(RAY)).unwrap();
    assert_eq!(f.s.claims[&cl.token_id].owed_units, cl.share_units, "exact on a verified market: no tolerance");
}

#[test]
fn older_program_without_indexes_keeps_the_reporter_repay() {
    let mut f = F::new();
    let rid = verified_rescue(&mut f, None);
    f.now += 24 * 3600 * SEC;
    vread(&mut f, RAY, None).unwrap();
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    assert!(f.s.watch_of(f.pid).settle.is_none());
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    f.s.confirm_settlement_repay(REPORTER, rid, "0xr", s.repay_units, f.block + 1).unwrap();
}

#[test]
fn verified_legs_are_allowed_at_the_start_index() {
    let mut f = F::new();
    let rid = verified_pooled(&mut f);
    let cl = claims_of(&f, rid).into_iter().find(|c| c.owner == STEWARDS[3]).unwrap(); // its leg is second
    let ci0 = RAY + RAY / 10;
    accrue(&mut f, RAY, ci0);
    vread(&mut f, ci0, Some(RAY)).unwrap();
    f.now += 24 * 3600 * SEC;
    vread(&mut f, ci0, Some(RAY)).unwrap();
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    let st = f.s.watch_of(f.pid).settle.unwrap();
    f.dai -= st.need;
    vread(&mut f, ci0, Some(RAY)).unwrap();
    // the leg withdraws at index ci_a (a little above the start), then the index keeps rising to
    // ci_b before the readings that follow: the leg's burn must be bounded by the START index,
    // since a later reading's index would understate it
    let (ci_a, ci_b) = (ci0 + RAY / 1000, ci0 + RAY / 100);
    accrue(&mut f, ci0, ci_a);
    let leg = f.s.rescue(rid).unwrap().settlement.clone().unwrap().legs[0].clone();
    let plan = f.s.settle_next(rid, gas(), f.now).unwrap().unwrap();
    f.s.on_signed(f.pid, plan.tx.nonce, Some(vec![1])).unwrap();
    let AmountArg::Exact(u) = leg.amount else { panic!() };
    f.link -= u; // burns u / ci_a scaled units
    vread(&mut f, ci_a, Some(RAY)).unwrap(); // in flight
    assert_eq!(f.s.claims[&cl.token_id].owed_units, cl.owed_units, "in-flight leg explained");
    accrue(&mut f, ci_a, ci_b);
    vread(&mut f, ci_b, Some(RAY)).unwrap(); // still in flight, index higher
    f.s.confirm_nonce(REPORTER, f.pid, plan.tx.nonce + 1, true, f.block).unwrap();
    vread(&mut f, ci_b, Some(RAY)).unwrap(); // confirmed
    assert_eq!(f.s.claims[&cl.token_id].owed_units, cl.owed_units, "confirmed leg explained at the start index");
}

// ── the invariant across a liquidation ──

/// What the stewards take out of the position in collateral units (legs) must be at most the
/// principal plus the settler's R swap: never a premium on top of Aave's penalty.
fn steward_take(s: &Settlement) -> u128 {
    s.legs.iter().filter(|l| l.claim_id.is_some()).map(|l| if let AmountArg::Exact(u) = l.amount { u } else { 0 }).sum()
}

#[test]
fn invariant_liquidation_during_settling_before_the_repay() {
    let mut f = F::new();
    let rid = pooled(&mut f);
    f.report(2_850_000_000);
    let principal: u128 = claims_of(&f, rid).iter().map(|c| c.share_units).sum();
    start_at_expiry(&mut f, rid);
    f.tick(12);
    liquidate(&mut f, 2_850_000_000, 1000);
    f.report(2_850_000_000);
    f.report(2_850_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    assert_eq!(s.owed_units, principal);
    assert!(steward_take(&s) <= principal + s.repay_collateral_units, "borrower pays the penalty only, no premium");
}

#[test]
fn invariant_liquidation_during_settling_after_the_repay() {
    let mut f = F::new();
    let rid = pooled(&mut f);
    f.report(2_850_000_000);
    let principal: u128 = claims_of(&f, rid).iter().map(|c| c.share_units).sum();
    let s = start_at_expiry(&mut f, rid);
    f.dai -= s.repay_units;
    f.s.confirm_settlement_repay(REPORTER, rid, "0xrep", s.repay_units, f.block + 1).unwrap();
    f.report(f.price);
    f.tick(12);
    liquidate(&mut f, 2_850_000_000, 1000);
    f.report(2_850_000_000);
    let s2 = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    assert!(steward_take(&s2) <= principal + s2.repay_collateral_units, "no premium left in any unsent leg");
}

// ── premiums last (no premium leg is signed after a liquidation is seen) ──

#[test]
fn premium_legs_come_after_every_principal_leg() {
    let mut f = F::new();
    let rid = pooled(&mut f);
    let s = start_at_expiry(&mut f, rid);
    let kinds: Vec<bool> = (0..s.legs.len()).map(|i| Stead::is_premium_leg(&s.legs, i)).collect();
    assert_eq!(kinds, vec![false, false, true, true], "principal, principal, premium, premium");
    for c in claims_of(&f, rid) {
        let mine: Vec<_> = s.legs.iter().filter(|l| l.claim_id.as_ref() == Some(&c.token_id)).collect();
        let AmountArg::Exact(p) = mine[0].amount else { panic!() };
        assert!(p == c.share_units || p == c.share_units + s.repay_collateral_units);
        assert_eq!(mine[1].amount, AmountArg::Exact(c.premium_units));
    }
}

#[test]
fn a_premium_leg_in_flight_keeps_only_its_own_premium() {
    let mut f = F::new();
    let rid = pooled(&mut f);
    let s = start_at_expiry(&mut f, rid);
    f.dai -= s.repay_units;
    f.s.confirm_settlement_repay(REPORTER, rid, "0xrep", s.repay_units, f.block + 1).unwrap();
    send_leg(&mut f, rid, true);
    send_leg(&mut f, rid, true); // both principal legs sent
    let (_, prem0) = send_leg(&mut f, rid, false); // the first premium leg is in flight
    f.tick(12);
    liquidate(&mut f, 2_850_000_000, 1000);
    f.report(2_850_000_000);
    let s2 = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    assert_eq!(s2.legs[2].amount, AmountArg::Exact(prem0), "the in-flight premium leg was signed before: it stands");
    assert_eq!(s2.legs[3].amount, AmountArg::Exact(0), "the other premium leg is dropped");
    assert!(s2.legs[3].done);
    // the records match what is paid: the in-flight claim keeps its premium, the other forfeits
    let id = |i: usize| s2.legs[i].claim_id.clone().unwrap();
    let (paid, dropped) = (f.s.claims[&id(2)].clone(), f.s.claims[&id(3)].clone());
    assert_eq!(paid.owed_units, paid.share_units + paid.premium_units);
    assert!(paid.premium_units > 0);
    assert_eq!(dropped.owed_units, dropped.share_units);
}

#[test]
fn a_takeover_fee_is_forfeited_with_the_premium_it_came_from() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 500, None)]);
    f.tick(60);
    f.report(2_500_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    f.tick(180);
    f.s.take_over_settlement(STEWARDS[1], rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    f.dai -= s.repay_units;
    f.s.confirm_settlement_repay(REPORTER, rid, "0xtake", s.repay_units, f.block + 1).unwrap();
    let px = f.price;
    f.report(px);
    f.tick(12);
    liquidate(&mut f, px, 1000);
    f.report(px);
    let s2 = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    for i in 0..s2.legs.len() {
        if Stead::is_premium_leg(&s2.legs, i) {
            assert_eq!(s2.legs[i].amount, AmountArg::Exact(0), "premium and the fee taken from it: dropped");
        }
    }
    let sent = f.run_legs(rid);
    let taker: u128 = sent.iter().filter(|(to, _)| *to == steward_payout(1)).map(|(_, u)| u).sum();
    assert_eq!(taker, s.repay_collateral_units, "the taker gets its R back, no fee");
}
