//! One test per rule. Each fails if its rule is broken.
mod common;
use common::*;

fn err<T: std::fmt::Debug>(r: Result<T, String>) -> String {
    r.expect_err("expected a refusal")
}

// ── rule 3: allow-list, pinned targets and recipients ──

#[test]
fn allow_list_targets_and_pinned_arguments() {
    let mut f = F::new();
    let pos = a(POS_ADDR);
    let cases: Vec<(Action, &str, [u8; 4])> = vec![
        (Action::Approve { token: TokenSide::Collateral, amount: AmountArg::Max }, LINK, SEL_APPROVE),
        (Action::Approve { token: TokenSide::Debt, amount: AmountArg::Max }, DAI, SEL_APPROVE),
        (Action::Supply { amount: 5 }, POOL, SEL_SUPPLY),
        (Action::Borrow { amount: 5 }, POOL, SEL_BORROW),
        (Action::Repay { amount: AmountArg::Max }, POOL, SEL_REPAY),
        (Action::Withdraw { amount: AmountArg::Exact(5) }, POOL, SEL_WITHDRAW),
        (Action::TransferDebt { amount: 5 }, DAI, SEL_TRANSFER),
    ];
    for (action, to, sel) in cases {
        let plan = f.sign_ok(action.clone());
        let tx = &plan.tx;
        assert_eq!(tx.to, a(to), "{action:?} target");
        assert_eq!(tx.selector().unwrap(), sel, "{action:?} selector");
        assert_eq!(tx.chain_id, 31337, "chain pinned to the market");
        assert_eq!(plan.value, 0, "value is 0 for every token action");
        assert_eq!(plan.path, format!("pos-{}", f.pid));
        match action {
            Action::Approve { .. } => assert_eq!(arg_addr(&tx.data, 0), a(POOL), "spender is the Pool"),
            Action::Supply { .. } => {
                assert_eq!(arg_addr(&tx.data, 0), a(LINK));
                assert_eq!(arg_addr(&tx.data, 2), pos, "supply onBehalfOf = position");
            }
            Action::Borrow { .. } => {
                assert_eq!(arg_addr(&tx.data, 0), a(DAI));
                assert_eq!(arg_addr(&tx.data, 4), pos, "borrow onBehalfOf = position");
            }
            Action::Repay { .. } => {
                assert_eq!(arg_addr(&tx.data, 0), a(DAI));
                assert_eq!(arg_addr(&tx.data, 3), pos, "repay onBehalfOf = position");
            }
            Action::Withdraw { .. } => {
                assert_eq!(arg_addr(&tx.data, 0), a(LINK));
                assert_eq!(arg_addr(&tx.data, 2), a(PAYOUT), "withdraw to = payout");
            }
            Action::TransferDebt { .. } => assert_eq!(arg_addr(&tx.data, 0), a(PAYOUT), "transfer to = payout"),
            Action::SweepEth { .. } => unreachable!("covered by the sweep tests"),
        }
    }
}

#[test]
fn transfer_is_only_ever_the_debt_asset_never_an_atoken() {
    // The Action type can only name the market's collateral or debt token, so no call
    // can target the aToken. Check every signable target against the full address set.
    let mut f = F::new();
    for action in [
        Action::Approve { token: TokenSide::Collateral, amount: AmountArg::Max },
        Action::Approve { token: TokenSide::Debt, amount: AmountArg::Max },
        Action::TransferDebt { amount: 1 },
    ] {
        let plan = f.sign_ok(action);
        assert_ne!(plan.tx.to, a(A_LINK));
        assert!([a(LINK), a(DAI)].contains(&plan.tx.to));
    }
    let plan = f.sign_ok(Action::TransferDebt { amount: 1 });
    assert_eq!(plan.tx.to, a(DAI), "only the debt asset can be transferred");
}

#[test]
fn gas_caps_enforced() {
    let mut f = F::new();
    let mut g = gas();
    g.max_fee_per_gas = market().max_fee_cap + 1;
    assert!(err(f.s.sign_action(BORROWER, f.pid, Action::Supply { amount: 1 }, g, f.now)).contains("above cap"));
    let mut g = gas();
    g.gas_limit = market().gas_limit_cap + 1;
    assert!(err(f.s.sign_action(BORROWER, f.pid, Action::Supply { amount: 1 }, g, f.now)).contains("gas_limit"));
    let mut g = gas();
    g.max_priority_fee_per_gas = g.max_fee_per_gas + 1;
    assert!(err(f.s.sign_action(BORROWER, f.pid, Action::Supply { amount: 1 }, g, f.now)).contains("priority"));
}

// ── the claim lock ──

#[test]
fn claim_lock_from_auction_open_to_close() {
    let mut f = F::new();
    let rid = f.report(2_850_000_000).unwrap();
    let refused = [
        Action::Withdraw { amount: AmountArg::Max },
        Action::Borrow { amount: 1 },
        Action::Approve { token: TokenSide::Collateral, amount: AmountArg::Max },
        Action::TransferDebt { amount: 1 },
    ];
    let check = |f: &mut F, stage: &str| {
        for act in refused.clone() {
            let e = err(f.s.sign_action(BORROWER, f.pid, act.clone(), gas(), f.now));
            assert!(e.starts_with("claim open"), "{stage}: {act:?} → {e}");
        }
        f.sign_ok(Action::Supply { amount: 1 });
        f.sign_ok(Action::Repay { amount: AmountArg::Exact(1) });
    };
    check(&mut f, "auction");
    f.s.bid(STEWARDS[0], rid, 300, f.s.rescue(rid).unwrap().topup_units, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    check(&mut f, "top-up pending");
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.confirm_topup(REPORTER, rid, STEWARDS[0], t, "0xt", f.block + 1, f.now).unwrap();
    check(&mut f, "claim open");
    // buy-back clears it
    let _ = rid;
    f.pay_escrow(0, 2000 * E18).unwrap();
    f.run_payouts();
    f.sign_ok(Action::Withdraw { amount: AmountArg::Exact(1) });
}

// ── nonce discipline and the signed-tx lifecycle ──

#[test]
fn pre_sign_attack_one_tx_in_flight() {
    let mut f = F::new();
    let p0 = f.s.sign_action(BORROWER, f.pid, Action::Withdraw { amount: AmountArg::Exact(1) }, gas(), f.now).unwrap();
    assert_eq!(p0.tx.nonce, 0);
    // can't stack a second (future-nonce) signature while nonce 0 is unconfirmed
    let e = err(f.s.sign_action(BORROWER, f.pid, Action::Withdraw { amount: AmountArg::Max }, gas(), f.now));
    assert!(e.contains("tx in flight"));
    // and an auction can't open over an unconfirmed signed tx
    assert_eq!(f.report(2_850_000_000), None);
    f.land(&p0);
    let p1 = f.sign_ok(Action::Supply { amount: 1 });
    assert_eq!(p1.tx.nonce, 1, "only the next nonce is ever signed");
}

#[test]
fn signed_tx_is_public_and_failed_mpc_rolls_back() {
    let mut f = F::new();
    let p = f.s.sign_action(BORROWER, f.pid, Action::Supply { amount: 1 }, gas(), f.now).unwrap();
    f.s.on_signed(f.pid, 0, None).unwrap(); // MPC failure
    assert!(f.s.position(f.pid).unwrap().pending.is_none(), "nothing signed → slot freed");
    let p = f.s.sign_action(BORROWER, f.pid, Action::Supply { amount: 1 }, gas(), f.now).unwrap_or(p);
    f.s.on_signed(f.pid, p.tx.nonce, Some(vec![1, 2, 3])).unwrap();
    let pending = f.s.position(f.pid).unwrap().pending.clone().unwrap();
    assert_eq!(pending.signed_raw, Some(vec![1, 2, 3]), "signed raw tx stored in state for anyone to broadcast");
    let json = serde_json::to_string(&pending).unwrap();
    assert!(json.contains("\"signed_raw\":\"0x010203\""));
}

#[test]
fn nonce_burn_after_timeout_even_during_a_claim() {
    let mut f = F::new();
    let p = f.s.sign_action(BORROWER, f.pid, Action::Withdraw { amount: AmountArg::Max }, gas(), f.now).unwrap();
    f.s.on_signed(f.pid, p.tx.nonce, Some(vec![9])).unwrap();
    assert!(err(f.s.burn_nonce("anyone.testnet", f.pid, gas(), f.now)).contains("too early"));
    f.tick(601);
    let burn = f.s.burn_nonce("anyone.testnet", f.pid, gas(), f.now).unwrap();
    assert_eq!(burn.tx.nonce, p.tx.nonce, "same nonce");
    assert_eq!(burn.tx.to, a(POS_ADDR), "self-transfer");
    assert!(burn.tx.data.is_empty() && burn.value == 0, "zero value, no data");
    // a burn can't be burned again
    f.s.on_signed(f.pid, burn.tx.nonce, Some(vec![8])).unwrap();
    f.tick(601);
    assert!(err(f.s.burn_nonce("anyone.testnet", f.pid, gas(), f.now)).contains("only a borrower tx"));
}

#[test]
fn one_capped_replacement_per_tx() {
    let mut f = F::new();
    let p = f.s.sign_action(BORROWER, f.pid, Action::Supply { amount: 1 }, gas(), f.now).unwrap();
    f.s.on_signed(f.pid, 0, Some(vec![1])).unwrap();
    let g = p.tx.gas;
    assert!(err(f.s.replace_pending(BORROWER, f.pid, g.max_fee_per_gas, g.max_priority_fee_per_gas * 2)).contains("10 %"));
    assert!(err(f.s.replace_pending(BORROWER, f.pid, market().max_fee_cap + 1, g.max_priority_fee_per_gas * 2)).contains("cap"));
    assert!(err(f.s.replace_pending("mallory.testnet", f.pid, g.max_fee_per_gas * 2, g.max_priority_fee_per_gas * 2)).contains("owner"));
    let r = f.s.replace_pending(BORROWER, f.pid, g.max_fee_per_gas * 2, g.max_priority_fee_per_gas * 2).unwrap();
    assert_eq!((r.tx.nonce, r.tx.data.clone()), (p.tx.nonce, p.tx.data.clone()), "same nonce and calldata");
    f.s.on_signed(f.pid, 0, Some(vec![2])).unwrap();
    assert!(err(f.s.replace_pending(BORROWER, f.pid, g.max_fee_per_gas * 4, g.max_priority_fee_per_gas * 4)).contains("once"));
}

// ── payout address ──

#[test]
fn payout_change_delayed_and_blocked_during_claim() {
    let mut f = F::new();
    let new = a("0x00000000000000000000000000000000000000e1");
    f.s.request_payout_change(BORROWER, f.pid, new, f.now).unwrap();
    assert!(err(f.s.apply_payout_change(f.pid, f.now + 3600 * SEC)).contains("not effective"));
    f.report(2_850_000_000).unwrap();
    f.now += 24 * 3600 * SEC;
    assert!(err(f.s.apply_payout_change(f.pid, f.now)).starts_with("claim open"));
    assert!(err(f.s.request_payout_change(BORROWER, f.pid, new, f.now)).starts_with("claim open"));

    let mut g = F::new();
    g.s.request_payout_change(BORROWER, g.pid, new, g.now).unwrap();
    g.s.apply_payout_change(g.pid, g.now + 24 * 3600 * SEC).unwrap();
    let plan = g.sign_ok(Action::Withdraw { amount: AmountArg::Exact(1) });
    assert_eq!(arg_addr(&plan.tx.data, 2), new);
}

// ── access control ──

#[test]
fn access_control() {
    let mut f = F::new();
    let x = "mallory.testnet";
    assert!(err(f.s.add_market(x, market())).contains("only owner"));
    assert!(err(f.s.set_params(x, Params::default())).contains("only owner"));
    assert!(err(f.s.set_role(x, "reporter", x, true)).contains("only owner"));
    assert!(err(f.s.set_paused(x, true)).contains("only owner"));
    assert!(err(f.s.sign_action(x, f.pid, Action::Supply { amount: 1 }, gas(), f.now)).contains("position owner"));
    let r = reading(f.link, f.dai, 2_850_000_000, 999);
    assert!(err(f.s.report_health(x, f.pid, r, f.now)).contains("only reporter"));
    assert!(err(f.s.confirm_nonce(x, f.pid, 1, true, f.block + 1)).contains("only reporter"));
    let rid = f.report(2_850_000_000).unwrap();
    assert!(err(f.s.bid(x, rid, 1, 1, BOND, f.now)).contains("only registered steward"));
    assert!(err(f.s.confirm_topup(x, rid, STEWARDS[0], 1, "0x", f.block + 1, f.now)).contains("only reporter"));
    assert!(err(f.s.confirm_escrow(x, f.pid, 1, 1, f.block + 1, f.now)).contains("only reporter"));
    assert!(err(f.s.confirm_stray_repay(x, f.pid, STEWARDS[0], 1, "0x", f.block + 1)).contains("only reporter"));
    assert!(err(f.s.confirm_settlement_repay(x, rid, "0x", 1, f.block + 1)).contains("only reporter"));
}

// ── auction ──

#[test]
fn premium_cap_exact_boundary() {
    let mut f = F::new();
    let rid = f.report(2_850_000_000).unwrap();
    let r = f.s.rescue(rid).unwrap().clone();
    // The worked example at $28.50: T = $950, cap = 10 % × 50 % × $1,900 = $95 → 1,000 bps
    assert_eq!(r.topup_base, 950 * E8);
    assert_eq!(r.cap_bps, 1000);
    assert!(err(f.s.bid(STEWARDS[0], rid, 1001, r.topup_units, BOND, f.now)).contains("above cap"));
    f.s.bid(STEWARDS[0], rid, 1000, r.topup_units, BOND, f.now).unwrap();
}

#[test]
fn lowest_premium_wins_ties_to_earlier_bid() {
    let mut f = F::new();
    let rid = f.report(2_850_000_000).unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[1], rid, 400, t, BOND, f.now).unwrap(); // swift first
    f.s.bid(STEWARDS[0], rid, 250, t, BOND, f.now).unwrap(); // patient, same as deep
    f.s.bid(STEWARDS[2], rid, 250, t, BOND, f.now).unwrap();
    f.tick(46);
    let refunds = f.s.close_auction(rid, f.now).unwrap();
    let r = f.s.rescue(rid).unwrap();
    assert_eq!(r.members.len(), 1);
    assert_eq!(r.members[0].steward, STEWARDS[0]);
    assert_eq!(refunds.len(), 2, "losing bonds refunded");
}

#[test]
fn rebid_replaces_and_window_enforced() {
    let mut f = F::new();
    let rid = f.report(2_850_000_000).unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 500, t, BOND, f.now).unwrap();
    let refund = f.s.bid(STEWARDS[0], rid, 400, t, BOND, f.now).unwrap();
    assert_eq!(refund[0].amount, BOND, "second bond refunded; bid replaced");
    assert_eq!(f.s.rescue(rid).unwrap().bids.len(), 1);
    assert!(err(f.s.close_auction(rid, f.now)).contains("still open"));
    f.tick(46);
    assert!(err(f.s.bid(STEWARDS[1], rid, 1, t, BOND, f.now)).contains("closed"));
}

#[test]
fn no_bids_unlocks_and_reauctions() {
    let mut f = F::new();
    let rid = f.report(2_850_000_000).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Failed);
    assert!(!f.s.position(f.pid).unwrap().locked());
    assert!(f.report(2_850_000_000).is_some(), "next low reading re-opens");
}

#[test]
fn pooled_shares_sum_exactly_and_premiums_under_cap() {
    let mut f = F::new();
    let rid = f.report(2_850_000_000).unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[3], rid, 200, t / 3, BOND, f.now).unwrap();
    f.s.bid(STEWARDS[1], rid, 600, t / 2, BOND, f.now).unwrap();
    f.s.bid(STEWARDS[2], rid, 900, t, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    let r = f.s.rescue(rid).unwrap().clone();
    assert_eq!(r.members.len(), 3);
    assert_eq!(r.members.iter().map(|m| m.share_units).sum::<u128>(), t);
    assert_eq!(r.members.iter().map(|m| m.share_base).sum::<u128>(), r.topup_base);
    let prem: u128 = r.members.iter().map(|m| m.premium_base).sum();
    assert!(prem <= f.s.position(f.pid).unwrap().premium_cap_base);
    for (k, m) in r.members.iter().enumerate() {
        f.s.confirm_topup(REPORTER, rid, &m.steward, m.share_units, &format!("0x{k}"), f.block + 1, f.now).unwrap();
    }
    assert_eq!(f.s.claims.values().filter(|c| c.rescue_id == rid).count(), 3, "one NFT per member");
}

#[test]
fn missed_topup_slashes_bond_to_borrower_and_bonds_are_conserved() {
    let mut f = F::new();
    let rid = f.report(2_850_000_000).unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 300, t / 2, BOND, f.now).unwrap();
    f.s.bid(STEWARDS[1], rid, 300, t, BOND, f.now).unwrap();
    assert_eq!(f.s.bonds_held, 2 * BOND);
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    f.s.confirm_topup(REPORTER, rid, STEWARDS[0], t / 2, "0xa", f.block + 1, f.now).unwrap();
    assert!(err(f.s.expire_topup(rid, f.now)).contains("not passed"));
    f.tick(121);
    let slashed = f.s.expire_topup(rid, f.now).unwrap();
    assert_eq!(slashed, vec![Transfer { to: BORROWER.into(), amount: BOND }]);
    assert_eq!(f.s.bonds_held, 0);
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Open, "confirmed member still gets a claim");
}

#[test]
fn duplicate_confirms_are_no_ops() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    let n = f.s.claims.len();
    f.s.confirm_topup(REPORTER, rid, STEWARDS[0], 1, &format!("0xtop{rid}-0"), f.block + 1, f.now).unwrap();
    assert_eq!(f.s.claims.len(), n);
    // a duplicate stray-repay report is a no-op
    f.s.confirm_stray_repay(REPORTER, f.pid, STEWARDS[1], E18, "0xs", f.block + 1).unwrap();
    f.s.confirm_stray_repay(REPORTER, f.pid, STEWARDS[1], E18, "0xs", f.block + 1).unwrap();
    assert_eq!(f.s.book(f.pid).stray_repays.len(), 1);
}

#[test]
fn stale_reading_refused() {
    let mut f = F::new();
    f.report(3_000_000_000);
    let r = reading(f.link, f.dai, 2_850_000_000, f.block - 1);
    assert!(err(f.s.report_health(REPORTER, f.pid, r, f.now)).contains("stale"));
}

// ── buy-back and settlement B ──

#[test]
fn buyback_burns_and_unlocks() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    let cl = f.s.claims.values().next().unwrap().clone();
    // one unit short: held in escrow, nothing commits, nothing is paid out
    f.pay_escrow(cl.owed_units - 1, 0).unwrap();
    assert_eq!(f.s.claims[&cl.token_id].status, ClaimStatus::Open);
    assert!(f.s.book(f.pid).outflows.is_empty());
    // the rest plus 5 units too many: commits; the owner gets exactly the owed units, the rest is refunded
    f.pay_escrow(1 + 5, 0).unwrap();
    let outs = f.run_payouts();
    assert_eq!(outs[0], Outflow { to: steward_payout(0), action: OutAction::Transfer(TokenSide::Collateral), amount: cl.owed_units, purpose: OutPurpose::BuyBack, token_id: Some(cl.token_id.clone()) });
    assert_eq!(outs[1], Outflow { to: a(PAYOUT), action: OutAction::Transfer(TokenSide::Collateral), amount: 5, purpose: OutPurpose::Refund, token_id: None });
    assert_eq!(outs.len(), 2);
    assert_eq!((f.idle_link, f.idle_dai), (0, 0));
    assert_eq!(f.s.claims[&cl.token_id].status, ClaimStatus::BoughtBack);
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::BoughtBack);
    assert!(!f.s.position(f.pid).unwrap().locked());
}

#[test]
fn settlement_refused_before_expiry_unless_hf_below_early_level() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.report(2_850_000_000);
    let e = err(f.s.start_settlement(STEWARDS[0], rid, f.now));
    assert!(e.contains("buy-back window still open"), "{e}");
    assert!(err(f.s.start_settlement(STEWARDS[1], rid, f.now)).contains("claim owner"));
    // early: price falls until HF (with the top-up) < 1.05
    f.report(1_950_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    assert!(f.s.rescue(rid).unwrap().settlement.as_ref().unwrap().early);
}

#[test]
fn settlement_b_full_flow_and_buyback_closes_on_commit() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.now += 24 * 3600 * SEC;
    f.report(2_850_000_000);
    // reading must be fresh
    f.tick(121);
    assert!(err(f.s.start_settlement(STEWARDS[0], rid, f.now)).contains("too old"));
    f.report(2_850_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    assert!(s.repay_units > 0 && !s.full_close);
    assert!(err(f.s.settle_next(rid, gas(), f.now)).contains("repay not confirmed"));
    // the settlement committed when it started: a payment now is held, never used, and refunded
    let cl = format!("{}-0-0", f.pid);
    f.pay_escrow(0, 5000 * E18).unwrap();
    assert_eq!(f.s.claims[&cl].status, ClaimStatus::Open);
    assert!(f.s.book(f.pid).outflows.is_empty());
    f.s.confirm_settlement_repay(REPORTER, rid, "0xrepay", s.repay_units, f.block + 1).unwrap();
    f.report(f.price); // each leg needs a reading after the last event
    let plan = f.s.settle_next(rid, gas(), f.now).unwrap().unwrap();
    assert_eq!(plan.tx.selector().unwrap(), SEL_WITHDRAW);
    assert_eq!(arg_addr(&plan.tx.data, 2), steward_payout(0), "settlement withdraw to the claim owner's payout");
    f.land(&plan);
    assert_eq!(f.s.claims[&cl].status, ClaimStatus::Open, "settles only once its premium leg is sent too");
    let sent = f.run_legs(rid);
    assert!(sent.iter().all(|(to, _)| *to == steward_payout(0)));
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Settled);
    assert_eq!(f.s.claims[&cl].status, ClaimStatus::Settled);
    assert!(!f.s.position(f.pid).unwrap().locked());
    f.report(2_850_000_000);
    let outs = f.run_payouts();
    assert_eq!(outs, vec![Outflow { to: a(PAYOUT), action: OutAction::Transfer(TokenSide::Debt), amount: 5000 * E18, purpose: OutPurpose::Refund, token_id: None }]);
}

#[test]
fn settlement_withdraw_cannot_be_burned_and_failed_leg_can_be_resigned() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.report(1_950_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    f.s.confirm_settlement_repay(REPORTER, rid, "0xr", s.repay_units, f.block + 1).unwrap();
    f.report(f.price); // each leg needs a reading after the last event
    let plan = f.s.settle_next(rid, gas(), f.now).unwrap().unwrap();
    f.s.on_signed(f.pid, plan.tx.nonce, Some(vec![1])).unwrap();
    f.tick(601);
    assert!(err(f.s.burn_nonce("x.testnet", f.pid, gas(), f.now)).contains("only a borrower tx"));
    f.s.confirm_nonce(REPORTER, f.pid, plan.tx.nonce + 1, false, f.block + 1).unwrap(); // reverted on-chain
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Settling);
    f.report(f.price); // each leg needs a reading after the last event
    let again = f.s.settle_next(rid, gas(), f.now).unwrap().unwrap();
    assert_eq!(again.tx.data, plan.tx.data);
}

#[test]
fn stacked_rescues_cumulative_cap_and_oldest_first() {
    let mut f = F::new();
    params_with(&mut f, 12_000, 10_500); // a stack needs net HF ≥ the early level, so small top-ups
    let first = f.rescue_with(&[(0, 900, None)]);
    // price keeps falling: Aave HF with the top-up drops under 1.15 again, net HF still ≥ 1.05
    f.tick(60);
    f.report(2_730_000_000);
    let second = f.s.position(f.pid).unwrap().active_auction.expect("second auction");
    let p = f.s.position(f.pid).unwrap().clone();
    let r2 = f.s.rescue(second).unwrap().clone();
    let room = p.premium_cap_base - p.premium_used_base;
    assert_eq!(r2.cap_bps as u128, room * BPS / r2.topup_base, "cap is what's left of the first trigger's cap");
    f.s.bid(STEWARDS[1], second, r2.cap_bps, r2.topup_units, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(second, f.now).unwrap();
    f.s.confirm_topup(REPORTER, second, STEWARDS[1], r2.topup_units, "0xs2", f.block + 1, f.now).unwrap();
    let p = f.s.position(f.pid).unwrap();
    assert!(p.premium_used_base <= p.premium_cap_base, "Σ premiums ≤ one Aave liquidation baseline");
    assert_eq!(p.open_rescues, vec![first, second]);
    // the newer rescue can't be settled or bought back first
    f.report(1_500_000_000);
    assert!(err(f.s.start_settlement(STEWARDS[1], second, f.now)).contains("oldest"));
    // a payment that covers the newer claim but not the oldest commits nothing (oldest first)
    let cl1 = f.s.claims[&format!("{}-0-0", f.pid)].clone();
    let cl2 = f.s.claims[&format!("{}-1-0", f.pid)].clone();
    f.pay_escrow(cl2.owed_units.min(cl1.owed_units - 1), 0).unwrap();
    assert_eq!(f.s.claims[&cl1.token_id].status, ClaimStatus::Open);
    assert_eq!(f.s.claims[&cl2.token_id].status, ClaimStatus::Open);
}

#[test]
fn pause_never_traps_funds() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.s.set_paused(OWNER, true).unwrap();
    assert!(err(f.s.register_position("bob.testnet", 0, a(PAYOUT))).contains("paused"));
    f.sign_ok(Action::Repay { amount: AmountArg::Exact(1) });
    f.pay_escrow(0, 2000 * E18).unwrap();
    f.run_payouts();
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::BoughtBack);
    assert!(err(f.s.sign_action(BORROWER, f.pid, Action::Withdraw { amount: AmountArg::Max }, gas(), f.now)).contains("paused"));
}

#[test]
fn claim_nft_transfer_moves_settlement_payout() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    let cl = format!("{}-0-0", f.pid);
    let buyer = "carol.testnet";
    assert!(err(f.s.nft_transfer(STEWARDS[1], &cl, buyer)).contains("only the token owner"));
    f.s.nft_transfer(STEWARDS[0], &cl, buyer).unwrap();
    f.s.set_evm_payout(buyer, a("0x00000000000000000000000000000000000000d1")).unwrap();
    f.report(1_950_000_000);
    f.s.start_settlement(buyer, rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    assert_eq!(s.legs[0].to, a("0x00000000000000000000000000000000000000d1"));
}

#[test]
fn edge_amounts() {
    let mut f = F::new();
    assert!(err(f.s.sign_action(BORROWER, f.pid, Action::Supply { amount: 0 }, gas(), f.now)).contains("zero"));
    f.sign_ok(Action::Supply { amount: u128::MAX });
    let rid = f.report(2_850_000_000).unwrap();
    assert!(err(f.s.bid(STEWARDS[0], rid, 0, 0, BOND, f.now)).contains("amount"));
    assert!(err(f.s.bid(STEWARDS[0], rid, 0, u128::MAX, BOND, f.now)).contains("amount"));
    assert!(err(f.s.bid(STEWARDS[0], rid, u32::MAX, 1, BOND, f.now)).contains("cap"));
    assert!(err(f.s.bid(STEWARDS[0], rid, 0, 1, BOND - 1, f.now)).contains("bond"));
}

// ── claims owed in units of the supplied asset ──

#[test]
fn claim_is_fixed_in_supplied_units() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    let r = f.s.rescue(rid).unwrap().clone();
    let cl = f.s.claims.values().next().unwrap().clone();
    assert_eq!(cl.asset, a(LINK));
    assert_eq!(cl.share_units, r.topup_units);
    assert_eq!(cl.premium_units, r.topup_units * 300 / BPS);
    assert_eq!(cl.owed_units, cl.share_units + cl.premium_units);
    assert_eq!(cl.trigger_price_base, 2_850_000_000);
    assert_eq!(cl.premium_base, units_to_base(cl.premium_units, 2_850_000_000, 18), "cap counts the premium at its trigger price");
}

#[test]
fn buyback_in_debt_asset_is_priced_now_not_at_trigger() {
    let mut f = F::new();
    f.rescue_with(&[(0, 300, None)]);
    let cl = f.s.claims.values().next().unwrap().clone();
    // LINK falls from $28.50 to $26: the borrower owes the same LINK, now worth less
    f.tick(60);
    f.report(2_600_000_000);
    let owed_now_dai = f.dai_for(cl.owed_units); // owed LINK × current price, rounded up
    let owed_at_trigger_dai = base_to_units_ceil(units_to_base(cl.owed_units, 2_850_000_000, 18), E8, 18);
    assert!(owed_now_dai < owed_at_trigger_dai);
    // one DAI short: held
    f.pay_escrow(0, owed_now_dai - E18).unwrap();
    assert_eq!(f.s.claims[&cl.token_id].status, ClaimStatus::Open);
    // the last DAI: commits at the current price; exactly the owed DAI goes to the claim owner
    f.pay_escrow(0, E18).unwrap();
    assert_eq!(f.s.claims[&cl.token_id].status, ClaimStatus::BoughtBack);
    let outs = f.run_payouts();
    assert_eq!(outs, vec![Outflow { to: steward_payout(0), action: OutAction::Transfer(TokenSide::Debt), amount: owed_now_dai, purpose: OutPurpose::BuyBack, token_id: Some(cl.token_id.clone()) }]);
}

#[test]
fn settlement_pays_steward_exactly_owed_units() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    let cl = f.s.claims.values().next().unwrap().clone();
    f.now += 24 * 3600 * SEC;
    f.report(2_400_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    assert_eq!(s.owed_units, cl.owed_units);
    let r_units = base_to_units_floor(s.repay_base, 2_400_000_000, 18);
    assert_eq!(s.legs[0].amount, AmountArg::Exact(cl.share_units + r_units), "principal + R at the current price first");
    assert_eq!(s.legs[1].amount, AmountArg::Exact(cl.premium_units), "the premium last");
    assert_eq!(s.legs.len(), 2, "owed units + R in total, nothing more");
}

#[test]
fn mul_div_is_exact_where_u128_overflows() {
    assert_eq!(mul_div(7, 3, 2), 10);
    assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
    // 5,000 LINK owed × 4,000 LINK available / 6,000 LINK needed (18 dp): a·b ≈ 2e43 > u128
    assert_eq!(mul_div(5000 * E18, 4000 * E18, 6000 * E18), 5000 * E18 * 2 / 3);
    assert_eq!(mul_div(u128::MAX - 1, u128::MAX - 3, u128::MAX), u128::MAX - 4); // M − 4 + 3/M
}

// ── net HF (the borrower's own HF, net of open claims) ──

fn params_with(f: &mut F, target: u32, early: u32) {
    let mut p = f.s.params.clone();
    p.target_hf_bps = target;
    p.early_settle_hf_bps = early;
    f.s.set_params(OWNER, p).unwrap();
}

#[test]
fn net_hf_gates_stacked_auctions() {
    let mut f = F::new();
    params_with(&mut f, 12_000, 10_500); // small top-ups so a stack is possible at all
    let first = f.rescue_with(&[(0, 300, None)]);
    // Aave HF < 1.15 but net HF ≥ 1.05: a stacked auction opens
    f.tick(60);
    let r = reading(f.link, f.dai, 2_730_000_000, f.block + 1);
    let net = f.s.net_hf_wad(f.pid, &r).unwrap();
    assert!(hf_below(r.hf_wad, 11_500) && !hf_below(net, 10_500), "fixture: aave {} net {}", r.hf_wad, net);
    let second = f.report(2_730_000_000).expect("stacked auction while net HF ≥ early level");
    f.s.bid(STEWARDS[1], second, 0, f.s.rescue(second).unwrap().topup_units, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(second, f.now).unwrap();
    let t2 = f.s.rescue(second).unwrap().topup_units;
    f.link += t2;
    f.s.confirm_topup(REPORTER, second, STEWARDS[1], t2, "0xs2", f.block + 1, f.now).unwrap();
    assert_eq!(f.s.position(f.pid).unwrap().open_rescues, vec![first, second]);
    // price falls on: Aave HF < 1.15 but net HF < 1.05 → no third auction, the claims settle first
    f.tick(60);
    let price = 2_300_000_000;
    let r = reading(f.link, f.dai, price, f.block + 1);
    assert!(hf_below(r.hf_wad, 11_500) && hf_below(f.s.net_hf_wad(f.pid, &r).unwrap(), 10_500));
    assert!(f.report(price).is_none(), "no stacked auction below the early level");
}

#[test]
fn early_settlement_uses_net_hf_not_aave_hf() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    // LINK $25: Aave HF (with the top-up) ≈ 1.31, well above 1.10; net HF ≈ 0.98 < 1.10
    f.tick(60);
    f.report(2_500_000_000);
    let h = f.s.position(f.pid).unwrap().health.clone().unwrap();
    assert!(!hf_below(h.r.hf_wad, 11_000));
    assert!(hf_below(f.s.net_hf_wad(f.pid, &h.r).unwrap(), 11_000));
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    assert!(f.s.rescue(rid).unwrap().settlement.as_ref().unwrap().early);
}

#[test]
fn early_settlement_refused_while_net_hf_above_level() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.tick(60);
    f.report(2_850_000_000); // net HF ≈ 1.114 ≥ 1.10
    let h = f.s.position(f.pid).unwrap().health.clone().unwrap();
    assert!(!hf_below(f.s.net_hf_wad(f.pid, &h.r).unwrap(), 11_000));
    assert!(err(f.s.start_settlement(STEWARDS[0], rid, f.now)).contains("net HF above"));
}

#[test]
fn fallback_after_15_min_pays_owed_units_then_a_first_rescue_can_follow() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    let cl = f.s.claims.values().next().unwrap().clone();
    f.tick(60);
    let price = 2_700_000_000; // net HF ≈ 1.055: early settlement, and Aave allows the plain withdrawal
    f.report(price);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    // too soon
    f.tick(14 * 60);
    f.report(price);
    assert!(err(f.s.settle_fallback(rid, f.now)).contains("still has time"));
    // stale reading refused
    f.tick(61);
    f.now += 120 * SEC;
    assert!(err(f.s.settle_fallback(rid, f.now)).contains("too old"));
    f.report(price);
    f.s.settle_fallback(rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    assert_eq!(s.repay_units, 0);
    assert_eq!(s.legs.len(), 2);
    assert_eq!((s.legs[0].amount, s.legs[1].amount), (AmountArg::Exact(cl.share_units), AmountArg::Exact(cl.premium_units)), "exactly the owed units, principal first, nothing for R");
    assert_eq!(s.legs[0].to, steward_payout(0));
    // a late repay report can't reopen the repay path
    assert!(err(f.s.confirm_settlement_repay(REPORTER, rid, "0xlate", 1, f.block + 1)).contains("already confirmed"));
    let sent = f.run_legs(rid);
    assert_eq!(sent, vec![(steward_payout(0), cl.share_units), (steward_payout(0), cl.premium_units)]);
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Settled);
    // claims cleared → net HF = Aave HF ≈ 1.05 < 1.15 → a new FIRST rescue, fresh cap
    f.tick(12);
    let next = f.report(price).expect("first rescue after the claims clear");
    let p = f.s.position(f.pid).unwrap();
    assert_eq!(p.premium_used_base, 0);
    assert_eq!(p.premium_cap_base, premium_cap_base(units_to_base(f.dai, E8, 18), 1000));
    assert_eq!(f.s.rescue(next).unwrap().state, RescueState::Auction);
}

#[test]
fn fallback_refused_when_aave_would_revert_the_withdrawal() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.tick(60);
    f.report(2_400_000_000); // net HF ≈ 0.94: withdrawing the owed units would leave Aave HF < 1
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    f.tick(15 * 60);
    f.report(2_400_000_000);
    assert!(err(f.s.settle_fallback(rid, f.now)).contains("< 1"));
    // the repay path stays open
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    f.s.confirm_settlement_repay(REPORTER, rid, "0xr", s.repay_units, f.block + 1).unwrap();
}

#[test]
fn fallback_refused_once_repay_confirmed() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.tick(60);
    f.report(2_500_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    f.s.confirm_settlement_repay(REPORTER, rid, "0xr", s.repay_units, f.block + 1).unwrap();
    f.tick(16 * 60);
    f.report(2_500_000_000);
    assert!(err(f.s.settle_fallback(rid, f.now)).contains("repay already confirmed"));
}

// ── settlement takeover ──

fn early_settle_started(f: &mut F) -> u64 {
    let rid = f.rescue_with(&[(0, 500, None)]);
    f.tick(60);
    f.report(2_500_000_000); // net HF < 1.10
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    rid
}

fn exact_sum(s: &Settlement) -> u128 {
    s.legs.iter().map(|l| if let AmountArg::Exact(u) = l.amount { u } else { 0 }).sum()
}

#[test]
fn takeover_after_3_min_moves_r_leg_and_fee_from_settler_not_borrower() {
    let mut f = F::new();
    let rid = early_settle_started(&mut f);
    let before = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    let cl = f.s.claims.values().next().unwrap().clone();
    assert!(err(f.s.take_over_settlement(STEWARDS[1], rid, f.now)).contains("still has time"));
    f.tick(180);
    assert!(err(f.s.take_over_settlement(STEWARDS[0], rid, f.now)).contains("own settlement"));
    assert!(err(f.s.take_over_settlement("x.testnet", rid, f.now)).contains("only a registered steward or a claim holder"));
    f.s.take_over_settlement(STEWARDS[1], rid, f.now).unwrap();
    let after = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    assert_eq!(after.settler, STEWARDS[1]);
    assert_eq!(exact_sum(&after), exact_sum(&before), "what leaves the position is unchanged: borrower cost stays the premium");
    let r_units = before.repay_collateral_units;
    let fee = r_units * TAKEOVER_FEE_BPS / BPS;
    assert!(fee > 0 && fee <= cl.premium_units);
    assert_eq!(after.legs[0].amount, AmountArg::Exact(cl.share_units), "stalled settler keeps its principal, R moves");
    assert_eq!(after.legs[0].to, steward_payout(0));
    let taker = after.legs.iter().find(|l| l.claim_id.is_none()).unwrap();
    assert_eq!(taker.amount, AmountArg::Exact(r_units), "the taker's R, among the principal legs");
    assert_eq!(taker.to, steward_payout(1));
    let premium_legs: Vec<_> = after.legs.iter().enumerate().filter(|(i, _)| Stead::is_premium_leg(&after.legs, *i)).map(|(_, l)| l.clone()).collect();
    assert_eq!(premium_legs.len(), 2);
    assert_eq!((premium_legs[0].to, premium_legs[0].amount), (steward_payout(0), AmountArg::Exact(cl.premium_units - fee)), "stalled settler pays the fee from its premium");
    assert_eq!((premium_legs[1].to, premium_legs[1].amount), (steward_payout(1), AmountArg::Exact(fee)), "the fee is paid last, with the premiums");
    // one takeover only
    assert!(err(f.s.take_over_settlement(STEWARDS[2], rid, f.now)).contains("already taken over"));
    // the taker repays; legs run; the claim settles
    f.s.confirm_settlement_repay(REPORTER, rid, "0xtake", after.repay_units, f.block + 1).unwrap();
    while f.s.rescue(rid).unwrap().state == RescueState::Settling {
        f.report(f.price); // each leg needs a reading after the last event
        let plan = f.s.settle_next(rid, gas(), f.now).unwrap().unwrap();
        f.land(&plan);
    }
    assert_eq!(f.s.claims[&cl.token_id].status, ClaimStatus::Settled);
}

#[test]
fn takeover_fee_capped_at_stalled_premium() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 0, None)]); // zero premium
    f.tick(60);
    f.report(2_500_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    f.tick(180);
    f.s.take_over_settlement(STEWARDS[1], rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    let taker = s.legs.iter().find(|l| l.claim_id.is_none()).unwrap();
    assert_eq!(taker.amount, AmountArg::Exact(s.repay_collateral_units), "no premium → no fee; never from the borrower");
}

#[test]
fn takeover_refused_once_repay_supplied() {
    let mut f = F::new();
    let rid = early_settle_started(&mut f);
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    f.s.confirm_settlement_repay(REPORTER, rid, "0xr", s.repay_units, f.block + 1).unwrap();
    f.tick(180);
    assert!(err(f.s.take_over_settlement(STEWARDS[1], rid, f.now)).contains("already supplied"));
}

// ── liquidation before the top-up ──

/// Aave liquidator: repays `debt_bps` of the debt and seizes that value × 1.10 in collateral.
fn liquidate(f: &mut F, price: u128, debt_bps: u128) {
    let repaid = f.dai * debt_bps / BPS;
    let seized = units_to_base(repaid, E8, 18) * 11_000 / BPS * E18 / price;
    f.dai -= repaid;
    f.link -= seized;
}

#[test]
fn liquidation_before_topup_fails_rescue_refunds_and_reauctions() {
    let mut f = F::new();
    let rid = f.report(2_850_000_000).unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 300, t, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    let held = f.s.bonds_held;
    // price gaps down and Aave liquidates half the debt before the top-up lands
    f.tick(12);
    let price = 2_400_000_000;
    liquidate(&mut f, price, 5000);
    let fresh = f.report(price);
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Failed);
    assert_eq!(f.s.payouts, vec![Transfer { to: STEWARDS[0].into(), amount: BOND }], "bond refunded, not slashed");
    assert_eq!(f.s.bonds_held, held - BOND);
    assert!(err(f.s.confirm_topup(REPORTER, rid, STEWARDS[0], t, "0xlate", f.block + 1, f.now)).contains("not awaiting"));
    // the position is still below the trigger: a fresh first auction opens on the same reading
    let fresh = fresh.expect("fresh auction after the liquidation");
    assert_ne!(fresh, rid);
    assert_eq!(f.s.position(f.pid).unwrap().active_auction, Some(fresh));
}

#[test]
fn hf_below_one_without_liquidation_still_requires_the_topup() {
    let mut f = F::new();
    let rid = f.report(2_850_000_000).unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 300, t, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    f.tick(12);
    f.report(2_400_000_000); // HF ≈ 0.95 but nothing was seized
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::TopUpPending);
    assert!(f.s.payouts.is_empty());
    f.tick(121);
    let slashed = f.s.expire_topup(rid, f.now).unwrap();
    assert_eq!(slashed, vec![Transfer { to: BORROWER.into(), amount: BOND }]);
}

#[test]
fn liquidation_during_auction_refunds_every_bid() {
    let mut f = F::new();
    let rid = f.report(2_850_000_000).unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 300, t, BOND, f.now).unwrap();
    f.s.bid(STEWARDS[1], rid, 400, t, BOND, f.now).unwrap();
    f.tick(12);
    liquidate(&mut f, 2_400_000_000, 5000);
    f.report(2_400_000_000);
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Failed);
    assert_eq!(f.s.payouts.len(), 2);
    assert_eq!(f.s.bonds_held, 0);
}

#[test]
fn partial_topup_then_liquidation_keeps_confirmed_claims_refunds_the_rest() {
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
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Open);
    assert_eq!(f.s.payouts, vec![Transfer { to: STEWARDS[3].into(), amount: BOND }]);
    let claims: Vec<_> = f.s.claims.values().filter(|c| c.rescue_id == rid).collect();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].owner, m0.steward);
}

/// Found in a live run: a reading taken before the top-up landed counts the claim's owed units but not
/// the top-up's collateral, so net HF looked ~0.77 instead of ~1.13 and early settlement fired.
#[test]
fn settlement_needs_a_reading_taken_after_the_topup() {
    let mut f = F::new();
    let rid = f.report(2_888_000_000).unwrap(); // HF 1.14 (1,900 DAI debt)
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 150, t, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    f.link += t;
    f.tick(5);
    f.s.confirm_topup(REPORTER, rid, STEWARDS[0], t, "0x1", f.block + 1, f.now).unwrap();
    // the stored reading is from before the top-up
    let e = err(f.s.start_settlement(STEWARDS[0], rid, f.now));
    assert!(e.contains("predates the last event"), "{e}");
    // a fresh reading shows the real net HF (≈ 1.135 ≥ 1.10): no early settlement
    f.tick(1);
    f.report(2_888_000_000);
    let e = err(f.s.start_settlement(STEWARDS[0], rid, f.now));
    assert!(e.contains("net HF above"), "{e}");
}

/// Found in a live run: an MPC signature with r = 0x00… produced a raw tx anvil refused to decode
/// ("Failed to decode transaction"). r and s must be minimal big-endian integers in RLP.
#[test]
fn signed_raw_encodes_r_and_s_without_leading_zeros() {
    let tx = TxFields { chain_id: 31337, nonce: 0, to: a(LINK), data: vec![0x09, 0x5e, 0xa7, 0xb3], gas: gas() };
    let mut r = vec![0u8; 32];
    r[1..].copy_from_slice(&[0x7b; 31]);
    let s = vec![0x15; 32];
    let raw = signed_raw(&tx, 0, 1, &r, &s);
    // the tail is: v (0x01), r as a 31-byte string (0x9f ‖ 31 bytes), s as 32 bytes (0xa0 ‖ 32)
    let tail = &raw[raw.len() - (1 + 1 + 31 + 1 + 32)..];
    assert_eq!(tail[0], 0x01);
    assert_eq!(tail[1], 0x9f, "r with a leading zero must be encoded as 31 bytes");
    assert_eq!(&tail[2..33], &[0x7b; 31]);
    assert_eq!(tail[33], 0xa0);
    assert_eq!(minimal_be(&[0, 0, 1]), vec![1]);
    assert_eq!(minimal_be(&[5, 0]), vec![5, 0]);
}

// ── buy-back escrow through the position ──

#[test]
fn buyback_commits_first_then_settlement_is_refused() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    let cl = f.s.claims.values().next().unwrap().clone();
    f.pay_escrow(cl.owed_units, 0).unwrap();
    f.now += 24 * 3600 * SEC;
    f.report(2_850_000_000);
    assert!(err(f.s.start_settlement(STEWARDS[0], rid, f.now)).contains("not settleable"));
}

#[test]
fn settlement_commits_first_then_a_buyback_never_commits() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    let cl = f.s.claims.values().next().unwrap().clone();
    f.now += 24 * 3600 * SEC;
    f.report(2_850_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    f.pay_escrow(cl.owed_units * 2, 0).unwrap();
    assert_eq!(f.s.claims[&cl.token_id].status, ClaimStatus::Open);
    assert!(f.s.book(f.pid).outflows.is_empty(), "held while the settlement runs");
}

#[test]
fn held_balance_blocks_borrower_repay_and_supply_while_claim_open() {
    let mut f = F::new();
    f.rescue_with(&[(0, 300, None)]);
    // before any payment the borrower may still add (repay / supply)
    f.sign_ok(Action::Repay { amount: AmountArg::Exact(1) });
    let cl = f.s.claims.values().next().unwrap().clone();
    f.pay_escrow(cl.owed_units / 2, 0).unwrap(); // held, not enough to commit
    for action in [Action::Repay { amount: AmountArg::Exact(1) }, Action::Supply { amount: 1 }, Action::Approve { token: TokenSide::Debt, amount: AmountArg::Max }] {
        let e = err(f.s.sign_action(BORROWER, f.pid, action, gas(), f.now));
        assert!(e.contains("reserved for buy-back") || e.contains("claim open"), "{e}");
    }
}

#[test]
fn borrower_actions_wait_for_queued_payouts() {
    let mut f = F::new();
    f.rescue_with(&[(0, 300, None)]);
    let cl = f.s.claims.values().next().unwrap().clone();
    f.pay_escrow(cl.owed_units, 0).unwrap();
    assert!(err(f.s.sign_action(BORROWER, f.pid, Action::TransferDebt { amount: 1 }, gas(), f.now)).contains("pay_next"));
    f.run_payouts();
    f.sign_ok(Action::TransferDebt { amount: 1 });
}

#[test]
fn stray_repay_is_reimbursed_at_par_and_borrower_is_no_worse_off() {
    let mut f = F::new();
    f.rescue_with(&[(0, 300, None)]);
    let cl = f.s.claims.values().next().unwrap().clone();
    // swift repays 100 DAI on the position without any committed settlement
    f.dai -= 100 * E18;
    f.s.confirm_stray_repay(REPORTER, f.pid, STEWARDS[1], 100 * E18, "0xstray", f.block + 1).unwrap();
    // the settler's own committed repay can't be filed as a stray (tested below by refusal text)
    let (link0, dai0) = (f.link, f.dai);
    // buy-back in LINK; then the reimbursement at par comes from collateral at the current price
    f.pay_escrow(cl.owed_units, 0).unwrap();
    let outs = f.run_payouts();
    let r = outs.iter().find(|o| o.purpose == OutPurpose::Reimburse).unwrap();
    assert_eq!(r.to, steward_payout(1));
    assert_eq!(r.action, OutAction::Withdraw);
    assert_eq!(r.amount, base_to_units_floor(100 * E8, f.price, 18), "100 DAI at par, in LINK at the verified price");
    // borrower: debt fell by 100 DAI, collateral fell by 100 DAI worth (rounded in its favour)
    assert_eq!(dai0, f.dai);
    assert!(units_to_base(link0 - f.link, f.price, 18) <= 100 * E8);
}

#[test]
fn stray_repay_reimbursed_from_spare_escrow_dai_first() {
    let mut f = F::new();
    f.rescue_with(&[(0, 300, None)]);
    let cl = f.s.claims.values().next().unwrap().clone();
    f.s.confirm_stray_repay(REPORTER, f.pid, STEWARDS[1], 100 * E18, "0xstray", f.block + 1).unwrap();
    f.pay_escrow(cl.owed_units, 150 * E18).unwrap(); // LINK buys back; 150 DAI spare
    let outs = f.run_payouts();
    assert!(outs.contains(&Outflow { to: steward_payout(1), action: OutAction::Transfer(TokenSide::Debt), amount: 100 * E18, purpose: OutPurpose::Reimburse, token_id: None }));
    assert!(outs.contains(&Outflow { to: a(PAYOUT), action: OutAction::Transfer(TokenSide::Debt), amount: 50 * E18, purpose: OutPurpose::Refund, token_id: None }));
}

#[test]
fn committed_settlers_repay_is_not_a_stray() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.now += 24 * 3600 * SEC;
    f.report(2_850_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    assert!(err(f.s.confirm_stray_repay(REPORTER, f.pid, STEWARDS[0], E18, "0xr", f.block + 1)).contains("confirm_settlement_repay"));
    // and with no claim open a repay is the steward's own business
    let mut g = F::new();
    assert!(err(g.s.confirm_stray_repay(REPORTER, g.pid, STEWARDS[1], E18, "0xg", g.block + 1)).contains("no open claim"));
}

#[test]
fn every_payout_goes_only_to_a_registered_payout() {
    let mut f = F::new();
    f.rescue_with(&[(0, 300, Some(10 * E18)), (1, 400, None)]);
    f.s.confirm_stray_repay(REPORTER, f.pid, STEWARDS[2], 7 * E18, "0xs", f.block + 1).unwrap();
    f.pay_escrow(1_000 * E18, 3_000 * E18).unwrap();
    let outs = f.run_payouts();
    let allowed = [steward_payout(0), steward_payout(1), steward_payout(2), a(PAYOUT)];
    assert!(!outs.is_empty());
    for o in &outs {
        assert!(allowed.contains(&o.to), "{o:?}");
        match o.purpose {
            OutPurpose::BuyBack => assert!(o.to == steward_payout(0) || o.to == steward_payout(1)),
            OutPurpose::Refund => assert_eq!(o.to, a(PAYOUT)),
            OutPurpose::Reimburse => assert_eq!(o.to, steward_payout(2)),
        }
    }
}

#[test]
fn escrow_proof_rules() {
    let mut f = F::new();
    // no claim open → nothing to hold
    assert!(err(f.s.confirm_escrow(REPORTER, f.pid, 1, 0, f.block + 1, f.now)).contains("no open claim"));
    f.rescue_with(&[(0, 300, None)]);
    assert!(err(f.s.confirm_escrow("x.testnet", f.pid, 1, 0, f.block + 1, f.now)).contains("only reporter"));
    // older than the last event → refused
    let last = f.s.book(f.pid).last_event_block;
    assert!(err(f.s.confirm_escrow(REPORTER, f.pid, 1, 0, last - 1, f.now)).contains("older than the last event"));
}

/// Rule: every decision uses a reading at least as new as the last event it depends on.
/// Random interleavings of events (top-up, payment, signed tx) and readings at random blocks:
/// a decision may only succeed when the stored reading's block ≥ the last event block.
#[test]
fn property_decisions_never_use_a_reading_older_than_the_last_event() {
    let mut seed: u64 = 0x5eed;
    let mut rnd = |n: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % n
    };
    let mut checked = 0;
    for _ in 0..300 {
        let mut f = F::new();
        let rid = f.rescue_with(&[(0, rnd(900) as u32, None)]);
        f.now += 24 * 3600 * SEC;
        f.report(2_850_000_000);
        for _ in 0..12 {
            match rnd(4) {
                0 => {
                    // an event lands at a later block
                    let b = f.block + 1 + rnd(3);
                    f.s.confirm_stray_repay(REPORTER, f.pid, STEWARDS[1], 1, &format!("0x{}", rnd(u64::MAX)), b).unwrap();
                }
                1 => {
                    // a reading at a random block (may lag the last event: then it's refused)
                    let b = f.block + rnd(3);
                    let r = reading(f.link, f.dai, 2_850_000_000, b);
                    if let Ok(_) = f.s.report_health(REPORTER, f.pid, r, f.now) {
                        f.block = b.max(f.block);
                    }
                }
                _ => {
                    let h = f.s.position(f.pid).unwrap().health.clone().unwrap();
                    let last = f.s.book(f.pid).last_event_block;
                    let ok = f.s.start_settlement(STEWARDS[0], rid, f.now).is_ok();
                    if ok {
                        assert!(h.r.block >= last, "decision on a reading at block {} < last event {}", h.r.block, last);
                        checked += 1;
                        break;
                    }
                }
            }
        }
    }
    assert!(checked > 50, "too few successful decisions to mean anything ({checked})");
}

// ── verified reads (OutLayer proofs) ──

fn verified_market(f: &mut F) {
    f.s.set_verify_config(OWNER, Some(VerifyConfig { outlayer: "outlayer.testnet".into(), wasm_url: "https://x/stead-proof.wasm".into(), wasm_hash: "ab".into(), markets: [0u32].into(), secrets: None })).unwrap();
}

/// The proof program's output for the fixture's model position at `price` (LINK, 8 dp).
fn vout(f: &F, price: u128, block: u64) -> VerifiedOutput {
    let c = units_to_base(f.link, price, 18);
    let d = units_to_base(f.dai, E8, 18);
    let json = serde_json::json!({
        "v": 1, "pos": POS_ADDR, "chain": 31337, "block": block,
        "hf": hf_wad(c, d, 7500).to_string(), "cb": c.to_string(), "db": d.to_string(),
        "res": [{"a": LINK.to_lowercase(), "p": price.to_string()}, {"a": DAI.to_lowercase(), "p": E8.to_string()}],
        "bal": [[LINK.to_lowercase(), f.idle_link.to_string()], [DAI.to_lowercase(), f.idle_dai.to_string()]],
        "agree": 3
    });
    serde_json::from_value(json).unwrap()
}

fn verify(f: &mut F, price: u128) -> Result<Option<u64>, String> {
    f.block += 1;
    f.price = price;
    let o = vout(f, price, f.block);
    f.s.apply_verified(f.pid, &o, f.now)
}

#[test]
fn verified_market_refuses_reporter_evidence() {
    let mut f = F::new();
    verified_market(&mut f);
    let r = reading(f.link, f.dai, 2_850_000_000, 999);
    assert!(err(f.s.report_health(REPORTER, f.pid, r, f.now)).contains("only from proofs"));
    let rid = verify(&mut f, 2_850_000_000).unwrap().expect("verified HF < trigger opens the auction");
    assert!(err(f.s.confirm_topup(REPORTER, rid, STEWARDS[0], 1, "0x", f.block + 1, f.now)).contains("only by a proof"));
    assert!(err(f.s.confirm_escrow(REPORTER, f.pid, 1, 1, f.block + 1, f.now)).contains("only from proofs"));
}

#[test]
fn verified_reading_opens_auction_only_below_trigger() {
    let mut f = F::new();
    verified_market(&mut f);
    assert_eq!(verify(&mut f, 3_000_000_000).unwrap(), None, "HF 1.18 ≥ 1.15: no auction");
    let rid = verify(&mut f, 2_850_000_000).unwrap().expect("HF 1.125 < 1.15: auction");
    assert_eq!(f.s.verified[&f.pid].snapshot, Some((rid, f.link)), "collateral snapshot at auction open");
}

#[test]
fn verified_reads_refuse_replay_and_foreign_proofs() {
    let mut f = F::new();
    verified_market(&mut f);
    verify(&mut f, 3_000_000_000).unwrap();
    let old = vout(&f, 2_850_000_000, f.block);
    assert!(err(f.s.apply_verified(f.pid, &old, f.now)).contains("not newer"));
    let mut other = vout(&f, 2_850_000_000, f.block + 1);
    other.pos = "0x00000000000000000000000000000000000000ff".into();
    assert!(err(f.s.apply_verified(f.pid, &other, f.now)).contains("another address"));
    let mut chain = vout(&f, 2_850_000_000, f.block + 1);
    chain.chain = 11155111;
    assert!(err(f.s.apply_verified(f.pid, &chain, f.now)).contains("another chain"));
}

#[test]
fn claim_mints_only_on_a_verified_collateral_increase_of_the_winning_shares() {
    let mut f = F::new();
    verified_market(&mut f);
    let rid = verify(&mut f, 2_850_000_000).unwrap().unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 300, t, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    // someone supplies less than the share: still waiting
    f.link += t / 2;
    verify(&mut f, 2_850_000_000).unwrap();
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::TopUpPending);
    assert!(f.s.claims.is_empty());
    // the rest lands: proven, claims open, bond refunded
    f.link += t - t / 2;
    verify(&mut f, 2_850_000_000).unwrap();
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Open);
    assert_eq!(f.s.claims.len(), 1);
    assert_eq!(f.s.payouts, vec![Transfer { to: STEWARDS[0].into(), amount: BOND }]);
    assert!(f.s.rescue(rid).unwrap().members[0].evm_tx.as_deref().unwrap().starts_with("verified@"));
}

#[test]
fn verified_escrow_balance_commits_a_buyback() {
    let mut f = F::new();
    verified_market(&mut f);
    let rid = verify(&mut f, 2_850_000_000).unwrap().unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 300, t, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    f.link += t;
    verify(&mut f, 2_850_000_000).unwrap();
    let cl = f.s.claims.values().next().unwrap().clone();
    // the borrower pays the position in LINK; the next proof shows it
    f.idle_link += cl.owed_units;
    verify(&mut f, 2_850_000_000).unwrap();
    assert_eq!(f.s.claims[&cl.token_id].status, ClaimStatus::BoughtBack);
    assert_eq!(f.s.book(f.pid).outflows[0].amount, cl.owed_units);
}

// ── a missed top-up on a verified market is decided by a reading from after the deadline ──

/// A verified reading at `price` whose block timestamp is `ts_s` (seconds).
fn verify_at(f: &mut F, price: u128, ts_s: u64) -> Result<Option<u64>, String> {
    f.block += 1;
    f.price = price;
    let mut o = vout(f, price, f.block);
    o.ts = ts_s;
    f.s.apply_verified(f.pid, &o, f.now)
}

/// Auction won by STEWARDS[2]; now just past the top-up deadline, nothing proven yet.
fn won_and_deadline_passed(f: &mut F) -> (u64, u128) {
    verified_market(f);
    let rid = verify(f, 2_850_000_000).unwrap().unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[2], rid, 150, t, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    f.now = f.s.rescue(rid).unwrap().topup_deadline + SEC;
    (rid, t)
}
fn deadline_s(f: &F, rid: u64) -> u64 {
    f.s.rescue(rid).unwrap().topup_deadline / SEC
}

#[test]
fn no_expiry_call_before_the_grace_on_a_verified_market() {
    let mut f = F::new();
    let (rid, _) = won_and_deadline_passed(&mut f);
    assert!(err(f.s.expire_topup(rid, f.now)).contains("waiting for a verified reading"));
    f.now += VERIFIED_EXPIRY_GRACE_NS - 2 * SEC;
    assert!(err(f.s.expire_topup(rid, f.now)).contains("waiting for a verified reading"));
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::TopUpPending);
}

#[test]
fn a_proven_topup_still_counts_after_the_deadline() {
    // rescue 5 on sepolia-demo: supplied in time, proofs refused until after the deadline
    let mut f = F::new();
    let (rid, t) = won_and_deadline_passed(&mut f);
    f.link += t;
    let d = deadline_s(&f, rid);
    verify_at(&mut f, 2_850_000_000, d + 30).unwrap();
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Open, "the honest steward keeps its claim");
    assert_eq!(f.s.claims.len(), 1);
    assert_eq!(f.s.payouts, vec![Transfer { to: STEWARDS[2].into(), amount: BOND }], "bond refunded, not slashed");
}

#[test]
fn a_reading_after_the_deadline_without_the_topup_expires_it() {
    let mut f = F::new();
    let (rid, _) = won_and_deadline_passed(&mut f);
    let d = deadline_s(&f, rid);
    verify_at(&mut f, 3_000_000_000, d + 30).unwrap(); // HF back above the trigger: no new auction
    let r = f.s.rescue(rid).unwrap();
    assert_eq!(r.state, RescueState::Failed);
    assert!(r.members.is_empty());
    assert_eq!(f.s.position(f.pid).unwrap().active_auction, None);
    assert_eq!(f.s.payouts, vec![Transfer { to: BORROWER.into(), amount: BOND }], "bond to the borrower");
    assert!(f.s.claims.is_empty());
}

#[test]
fn a_reading_from_before_the_deadline_does_not_expire() {
    let mut f = F::new();
    let (rid, _) = won_and_deadline_passed(&mut f);
    let d = deadline_s(&f, rid);
    verify_at(&mut f, 2_850_000_000, d - 5).unwrap(); // applied after the deadline, but read before it
    verify_at(&mut f, 2_850_000_000, 0).unwrap(); // a proof without a timestamp never expires
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::TopUpPending);
    assert!(f.s.payouts.is_empty());
}

#[test]
fn after_the_grace_the_expiry_works_without_a_reading() {
    let mut f = F::new();
    let (rid, _) = won_and_deadline_passed(&mut f);
    f.now += VERIFIED_EXPIRY_GRACE_NS;
    let slashed = f.s.expire_topup(rid, f.now).unwrap();
    assert_eq!(slashed, vec![Transfer { to: BORROWER.into(), amount: BOND }]);
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Failed);
}

/// The opening event names where its reading came from: a proof says "verified", a report says
/// "TEMPORARY reporter" (it used to say the latter for both).
#[test]
fn auction_opened_event_names_its_reading_source() {
    let opened = |f: &mut F| -> String {
        std::mem::take(&mut f.s.events).into_iter().find(|e| e.contains("auction_opened")).expect("auction_opened emitted")
    };
    let mut f = F::new();
    verified_market(&mut f);
    verify(&mut f, 2_850_000_000).unwrap().expect("verified HF < trigger opens the auction");
    let e = opened(&mut f);
    assert!(e.contains("\"trust\":\"verified\""), "{e}");

    let mut g = F::new();
    g.block += 1;
    let r = reading(g.link, g.dai, 2_850_000_000, g.block);
    g.s.report_health(REPORTER, g.pid, r, g.now).unwrap().expect("reported HF < trigger opens the auction");
    let e = opened(&mut g);
    assert!(e.contains("\"trust\":\"TEMPORARY reporter\""), "{e}");
}

/// A balance held while a claim was open is the borrower's: when a settlement ends the rescue, its
/// refund is queued in the same call, so no borrower request can spend it first (a repay that did
/// would leave the refund unpayable and every later request refused).
#[test]
fn settlement_end_queues_the_held_balance_refund_at_once() {
    let mut f = F::new();
    let rid = f.rescue_with(&[(0, 300, None)]);
    f.now += 24 * 3600 * SEC;
    f.report(2_850_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    f.pay_escrow(0, 59 * E18).unwrap(); // borrowed DAI left in the position: held, never used
    f.s.confirm_settlement_repay(REPORTER, rid, "0xrepay", s.repay_units, f.block + 1).unwrap();
    f.report(f.price);
    f.run_legs(rid);
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Settled);
    // no reading in between: the refund is already queued, and the borrower waits for it
    assert_eq!(f.s.book(f.pid).outflows, vec![Outflow { to: a(PAYOUT), action: OutAction::Transfer(TokenSide::Debt), amount: 59 * E18, purpose: OutPurpose::Refund, token_id: None }]);
    assert!(err(f.s.sign_action(BORROWER, f.pid, Action::Repay { amount: AmountArg::Max }, gas(), f.now)).contains("pay_next"));
    f.run_payouts();
    f.sign_ok(Action::Repay { amount: AmountArg::Max });
}

/// Whatever path ends the last claim, a held balance not yet refunded blocks borrower requests
/// (a refusal changes nothing) until a reading queues the refund.
#[test]
fn unrefunded_held_balance_blocks_borrower_requests() {
    let mut f = F::new();
    f.rescue_with(&[(0, 300, None)]);
    f.pay_escrow(0, 10 * E18).unwrap();
    // simulate a path that closed the rescue without refunding (the state this rule guards against)
    let rid = *f.s.position(f.pid).unwrap().open_rescues.first().unwrap();
    f.s.positions.get_mut(&f.pid).unwrap().open_rescues.retain(|x| *x != rid);
    for c in f.s.claims.values_mut() {
        c.status = ClaimStatus::Settled;
    }
    assert!(err(f.s.sign_action(BORROWER, f.pid, Action::Repay { amount: AmountArg::Max }, gas(), f.now)).contains("being refunded"));
    f.report(f.price); // the next reading queues the refund
    f.run_payouts();
    f.sign_ok(Action::Repay { amount: AmountArg::Max });
}

