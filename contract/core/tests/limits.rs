//! Owner-set limits with hard bounds, and the claim window fixed at opening. One test per rule;
//! each fails if its rule is broken.
mod common;
use common::*;

fn err<T: std::fmt::Debug>(r: Result<T, String>) -> String {
    r.expect_err("expected a refusal")
}
fn events(f: &mut F, name: &str) -> Vec<String> {
    std::mem::take(&mut f.s.events).into_iter().filter(|e| e.contains(name)).collect()
}
const USD: u128 = 100_000_000;
/// A small position: 10 LINK, 190 DAI ($285 of collateral at $28.50, HF ≈ 1.125; top-up to 1.50 ≈ $95).
fn small() -> F {
    let mut f = F::new();
    f.link = 10 * E18;
    f.dai = 190 * E18;
    f
}
fn cap(f: &mut F, usd: u128) {
    f.s.set_limits(OWNER, Limits { max_collateral_base: usd * USD, borrowers: Default::default() }).unwrap();
}

// settlement uses each claim's own deadline; a later window change can't shorten it
#[test]
fn shorter_window_does_not_shorten_open_claims() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    let expires = f.s.claims.values().find(|c| c.rescue_id == rid).unwrap().expires_at;
    let mut p = f.s.params.clone();
    p.buyback_window_ns = 3600 * SEC;
    f.s.set_params(OWNER, p).unwrap();
    f.now += 3600 * SEC + 10 * SEC; // past opened + the NEW window, well before the claim's own deadline
    f.report(2_850_000_000);
    let e = err(f.s.start_settlement(STEWARDS[0], rid, f.now));
    assert!(e.contains("buy-back window still open"), "{e}");
    f.now = expires;
    f.report(2_850_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
}

#[test]
fn claims_opened_after_a_change_get_the_new_window() {
    let mut f = F::new();
    let mut p = f.s.params.clone();
    p.buyback_window_ns = 3600 * SEC;
    f.s.set_params(OWNER, p).unwrap();
    let rid = f.rescue_with(&[(0, 300, None)]);
    let c = f.s.claims.values().find(|c| c.rescue_id == rid).unwrap().clone();
    assert_eq!(c.expires_at, f.s.rescue(rid).unwrap().claims_opened_at + 3600 * SEC);
}

// every window has hard bounds
#[test]
fn windows_outside_their_bounds_are_refused() {
    let mut f = F::new();
    let base = f.s.params.clone();
    type Set = fn(&mut Params, u64);
    let cases: [(&str, (u64, u64), Set); 3] = [
        ("buyback_window", BUYBACK_WINDOW_RANGE_NS, |p, v| p.buyback_window_ns = v),
        ("auction_window", AUCTION_WINDOW_RANGE_NS, |p, v| p.auction_window_ns = v),
        ("topup_deadline", TOPUP_DEADLINE_RANGE_NS, |p, v| p.topup_deadline_ns = v),
    ];
    for (name, (lo, hi), set) in cases {
        for (v, ok) in [(lo - 1, false), (lo, true), (hi, true), (hi + 1, false)] {
            let mut p = base.clone();
            set(&mut p, v);
            let r = f.s.set_params(OWNER, p);
            assert_eq!(r.is_ok(), ok, "{name} = {v}: {r:?}");
            if !ok {
                assert!(r.unwrap_err().contains(name));
            }
        }
    }
    assert!(err(f.s.init_buyback_window(BUYBACK_WINDOW_RANGE_NS.0 - 1)).contains("out of range"));
}

// the size cap can't go above the ceiling; only the owner sets limits
#[test]
fn cap_above_the_ceiling_is_refused() {
    let mut f = F::new();
    let over = Limits { max_collateral_base: MAX_COLLATERAL_CEILING_BASE + 1, borrowers: Default::default() };
    assert!(err(f.s.set_limits(OWNER, over)).contains("ceiling"));
    let at = Limits { max_collateral_base: MAX_COLLATERAL_CEILING_BASE, borrowers: Default::default() };
    assert!(err(f.s.set_limits(BORROWER, at.clone())).contains("only owner"));
    f.s.set_limits(OWNER, at.clone()).unwrap();
    assert_eq!(f.s.limits, at);
}

// no auction whose top-up would cross the cap; no borrower supply that would
#[test]
fn no_auction_above_the_cap() {
    let mut f = small();
    cap(&mut f, 300); // $285 + ≈ $95 top-up > $300
    assert_eq!(f.report(2_850_000_000), None);
    cap(&mut f, 400);
    assert!(f.report(2_850_000_000).is_some());
}

#[test]
fn no_supply_above_the_cap() {
    let mut f = small();
    cap(&mut f, 400);
    // no reading yet: no price to value the supply
    let e = err(f.s.sign_action(BORROWER, f.pid, Action::Supply { amount: E18 }, gas(), f.now));
    assert!(e.contains("price reading"), "{e}");
    f.report(3_500_000_000); // $350 of collateral, HF above the trigger
    let e = err(f.s.sign_action(BORROWER, f.pid, Action::Supply { amount: 2 * E18 }, gas(), f.now)); // + $70
    assert!(e.contains("size cap"), "{e}");
    f.sign_ok(Action::Supply { amount: E18 }); // + $35 = $385
}

#[test]
fn no_cap_by_default() {
    let mut f = F::new(); // $2,850 of collateral, far above the ceiling
    assert!(f.report(2_850_000_000).is_some());
}

// the borrower allow-list gates new positions only
#[test]
fn allow_list_gates_registration_not_existing_positions() {
    let mut f = F::new();
    let list = Limits { max_collateral_base: 0, borrowers: ["bob.testnet".to_string()].into() };
    f.s.set_limits(OWNER, list).unwrap();
    assert!(err(f.s.register_position(BORROWER, 0, a(PAYOUT))).contains("allow-list"));
    f.s.register_position("bob.testnet", 0, a(PAYOUT)).unwrap();
    // alice's existing position keeps working, including through a rescue and buy-back repay
    let rid = f.rescue_with(&[(0, 300, None)]);
    assert!(f.s.rescue(rid).is_ok());
    f.s.sign_action(BORROWER, f.pid, Action::Repay { amount: AmountArg::Exact(E18) }, gas(), f.now).unwrap();
}

// every change is logged with the old and new values
#[test]
fn changes_emit_old_and_new() {
    let mut f = F::new();
    events(&mut f, "");
    let mut p = f.s.params.clone();
    p.buyback_window_ns = 3600 * SEC;
    f.s.set_params(OWNER, p).unwrap();
    let e = events(&mut f, "params_set");
    assert_eq!(e.len(), 1);
    assert!(e[0].contains("\"old\"") && e[0].contains("\"new\"") && e[0].contains(&(3600 * SEC).to_string()) && e[0].contains(&(24 * 3600 * SEC).to_string()), "{}", e[0]);
    cap(&mut f, 500);
    let e = events(&mut f, "limits_set");
    assert_eq!(e.len(), 1);
    assert!(e[0].contains(&(500 * USD).to_string()) && e[0].contains("\"old\""), "{}", e[0]);
}

// a running auction keeps its terms when the limits change
#[test]
fn cap_change_mid_auction_leaves_it_alone() {
    let mut f = small();
    cap(&mut f, 400);
    let rid = f.report(2_850_000_000).expect("auction");
    cap(&mut f, 100); // now far below this position
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 300, t, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    let m = f.s.rescue(rid).unwrap().members[0].clone();
    f.link += m.share_units;
    f.s.confirm_topup(REPORTER, rid, &m.steward, m.share_units, "0xtop", f.block + 1, f.now).unwrap();
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Open);
}
