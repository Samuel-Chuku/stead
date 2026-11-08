//! Open steward registration, owner removal and the demo buy-back window. One test per rule;
//! each fails if its rule is broken.
mod common;
use common::*;

fn err<T: std::fmt::Debug>(r: Result<T, String>) -> String {
    r.expect_err("expected a refusal")
}

const NEW: &str = "newcomer.testnet";

fn payout_n() -> EvmAddr {
    a("0x00000000000000000000000000000000000000d1")
}

#[test]
fn anyone_can_register_with_the_deposit_and_excess_is_refunded() {
    let mut f = F::new();
    assert!(err(f.s.register_steward(NEW, payout_n(), STEWARD_DEPOSIT - 1)).contains("deposit"));
    assert!(err(f.s.register_steward(NEW, EvmAddr::default(), STEWARD_DEPOSIT)).contains("zero payout"));
    assert!(!f.s.stewards.contains(NEW));
    let refund = f.s.register_steward(NEW, payout_n(), STEWARD_DEPOSIT + 7).unwrap();
    assert_eq!(refund, vec![Transfer { to: NEW.into(), amount: 7 }]);
    assert!(f.s.stewards.contains(NEW));
    assert_eq!(f.s.evm_payouts[NEW], payout_n());
    assert!(err(f.s.register_steward(NEW, payout_n(), STEWARD_DEPOSIT)).contains("already"));
    // a self-registered steward bids like any other, under the same cap and bond
    let rid = f.report(2_850_000_000).unwrap();
    let r = f.s.rescue(rid).unwrap().clone();
    assert!(err(f.s.bid(NEW, rid, r.cap_bps + 1, r.topup_units, BOND, f.now)).contains("above cap"));
    assert!(err(f.s.bid(NEW, rid, 100, r.topup_units, BOND - 1, f.now)).contains("bond"));
    f.s.bid(NEW, rid, 100, r.topup_units, BOND, f.now).unwrap();
}

#[test]
fn registration_refused_while_paused() {
    let mut f = F::new();
    f.s.set_paused(OWNER, true).unwrap();
    assert!(err(f.s.register_steward(NEW, payout_n(), STEWARD_DEPOSIT)).contains("paused"));
}

#[test]
fn deposit_covers_measured_storage_with_margin() {
    let mut f = F::new();
    let worst = "a".repeat(56) + ".testnet"; // 64 bytes, the longest NEAR account id
    assert_eq!(worst.len(), 64);
    let before = borsh::to_vec(&f.s).unwrap().len();
    f.s.register_steward(&worst, payout_n(), STEWARD_DEPOSIT).unwrap();
    let grew = (borsh::to_vec(&f.s).unwrap().len() - before) as u128;
    let cost = grew * 10_000_000_000_000_000_000; // 1e19 yocto per byte
    assert!(cost * 2 <= STEWARD_DEPOSIT, "deposit {STEWARD_DEPOSIT} must be ≥ 2× measured cost {cost} ({grew} bytes)");
}

#[test]
fn removed_steward_cannot_bid_or_re_register() {
    let mut f = F::new();
    f.s.register_steward(NEW, payout_n(), STEWARD_DEPOSIT).unwrap();
    f.s.set_role(OWNER, "steward", NEW, false).unwrap();
    assert!(err(f.s.register_steward(NEW, payout_n(), STEWARD_DEPOSIT)).contains("removed by the owner"));
    let rid = f.report(2_850_000_000).unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    assert!(err(f.s.bid(NEW, rid, 100, t, BOND, f.now)).contains("only registered steward"));
    // only the owner can remove, and re-adding by the owner lifts it
    assert!(err(f.s.set_role(NEW, "steward", STEWARDS[0], false)).contains("only owner"));
    f.s.set_role(OWNER, "steward", NEW, true).unwrap();
    assert!(!f.s.removed_stewards.contains(NEW));
    f.s.bid(NEW, rid, 100, t, BOND, f.now).unwrap();
}

#[test]
fn removal_mid_auction_leaves_bonds_untouched() {
    let mut f = F::new();
    let rid = f.report(2_850_000_000).unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 150, t, BOND, f.now).unwrap(); // winner
    f.s.bid(STEWARDS[1], rid, 300, t, BOND, f.now).unwrap(); // loser
    f.s.set_role(OWNER, "steward", STEWARDS[0], false).unwrap();
    f.s.set_role(OWNER, "steward", STEWARDS[1], false).unwrap();
    f.tick(46);
    let refunds = f.s.close_auction(rid, f.now).unwrap();
    assert!(refunds.contains(&Transfer { to: STEWARDS[1].into(), amount: BOND }), "the removed loser's bond comes back");
    // the removed winner still tops up, gets its claim and its bond back
    let m = f.s.rescue(rid).unwrap().members[0].clone();
    assert_eq!(m.steward, STEWARDS[0]);
    f.link += m.share_units;
    f.s.confirm_topup(REPORTER, rid, &m.steward, m.share_units, "0xtop", f.block + 1, f.now).unwrap();
    let cl = f.s.claims.values().next().unwrap();
    assert_eq!((cl.owner.as_str(), cl.status.clone()), (STEWARDS[0], ClaimStatus::Open));
    assert_eq!(f.s.bonds_held, 0, "no bond is kept because of the removal");
}

#[test]
fn removal_never_touches_open_claims_or_payouts() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    let cl = f.s.claims.values().next().unwrap().clone();
    f.s.set_role(OWNER, "steward", STEWARDS[0], false).unwrap();
    assert_eq!(f.s.claims[&cl.token_id], cl, "claim unchanged");
    assert_eq!(f.s.evm_payouts[STEWARDS[0]], steward_payout(0), "payout unchanged");
    // a stray repay by the removed claim holder is still reimbursed
    f.dai -= 10 * E18;
    f.s.confirm_stray_repay(REPORTER, f.pid, STEWARDS[0], 10 * E18, "0xstray", f.block + 1).unwrap();
    // the buy-back still pays the removed steward exactly what it's owed
    f.pay_escrow(cl.owed_units, 0).unwrap();
    let outs = f.run_payouts();
    let paid = outs.iter().find(|o| o.purpose == OutPurpose::BuyBack).unwrap();
    assert_eq!((paid.to, paid.amount), (steward_payout(0), cl.owed_units));
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::BoughtBack);
}

#[test]
fn removed_claim_holder_can_still_settle_its_claim() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.s.set_role(OWNER, "steward", STEWARDS[0], false).unwrap();
    f.now += 24 * 3600 * SEC;
    f.report(2_400_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Settling);
}

#[test]
fn demo_buyback_window_is_an_init_setting() {
    let mut s = Stead::new(OWNER, REPORTER);
    assert_eq!(s.params.buyback_window_ns, 24 * 3600 * SEC, "production default");
    assert!(err(s.init_buyback_window(0)).contains("out of range"));
    s.init_buyback_window(180 * SEC).unwrap();
    assert_eq!(s.params.buyback_window_ns, 180 * SEC);
    assert!(s.events.last().unwrap().contains("\"demo_setting\":true"));
}

#[test]
fn expiry_settlement_after_a_three_minute_window() {
    let mut f = F::new();
    f.s.init_buyback_window(180 * SEC).unwrap();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.tick(170);
    f.report(2_850_000_000);
    assert!(err(f.s.start_settlement(STEWARDS[0], rid, f.now)).contains("window still open"));
    f.tick(15);
    f.report(2_850_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    let cl = f.s.claims.values().next().unwrap();
    assert_eq!(s.owed_units, cl.owed_units, "the shorter window changes when, never what is owed");
}

#[test]
fn removed_claim_holder_can_take_over_a_stalled_settlement_in_its_rescue() {
    let mut f = F::new();
    let half = {
        let rid = f.report(2_850_000_000).unwrap();
        let t = f.s.rescue(rid).unwrap().topup_units;
        f.s.bid(STEWARDS[0], rid, 300, t / 2, BOND, f.now).unwrap();
        f.s.bid(STEWARDS[1], rid, 300, t - t / 2, BOND, f.now).unwrap();
        f.tick(46);
        f.s.close_auction(rid, f.now).unwrap();
        for (k, m) in f.s.rescue(rid).unwrap().members.clone().iter().enumerate() {
            f.link += m.share_units;
            f.s.confirm_topup(REPORTER, rid, &m.steward, m.share_units, &format!("0xtop-{k}"), f.block + 1, f.now).unwrap();
        }
        rid
    };
    f.now += 24 * 3600 * SEC;
    f.report(2_850_000_000);
    f.s.start_settlement(STEWARDS[0], half, f.now).unwrap();
    f.tick(180);
    f.s.set_role(OWNER, "steward", STEWARDS[1], false).unwrap();
    f.s.set_role(OWNER, "steward", STEWARDS[2], false).unwrap();
    assert!(err(f.s.take_over_settlement(STEWARDS[2], half, f.now)).contains("only a registered steward or a claim holder"));
    f.s.take_over_settlement(STEWARDS[1], half, f.now).unwrap();
    assert_eq!(f.s.rescue(half).unwrap().settlement.as_ref().unwrap().settler, STEWARDS[1]);
}
