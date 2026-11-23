//! Batched settlements on a wrapped-native (WETH) market: one withdraw of everything owed to the
//! position (the borrower's gas), then one transfer per payout, each recipient paying its own
//! transfer's gas out of what it receives. One test per rule; each fails if its rule is broken.
mod common;
use common::*;

fn err<T: std::fmt::Debug>(r: Result<T, String>) -> String {
    r.expect_err("expected a refusal")
}

/// Two stewards share one rescue at different premiums.
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

/// Window over; `starter` starts; the repay is confirmed. Returns the settlement.
fn settle(f: &mut F, rid: u64, starter: &str) -> Settlement {
    f.now += 24 * 3600 * SEC;
    f.report(2_850_000_000);
    f.s.start_settlement(starter, rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    f.dai -= s.repay_units;
    f.s.confirm_settlement_repay(REPORTER, rid, "0xrep", s.repay_units, f.block + 1).unwrap();
    f.s.rescue(rid).unwrap().settlement.clone().unwrap()
}

#[derive(Debug, Default)]
struct Run {
    withdraws: Vec<(EvmAddr, AmountArg)>,
    /// (recipient, amount sent, gas limit x max fee of that very tx)
    transfers: Vec<(EvmAddr, u128, u128)>,
}

/// Sign and land every remaining step with `gas_of(i)` as the i-th tx's gas args.
fn run(f: &mut F, rid: u64, gas_of: &dyn Fn(usize) -> GasArgs) -> Run {
    let m = f.s.markets[&0].clone();
    let mut out = Run::default();
    for i in 0..20 {
        if f.s.rescue(rid).unwrap().state != RescueState::Settling {
            break;
        }
        f.report(f.price);
        let g = gas_of(i);
        let Some(plan) = f.s.settle_next(rid, g, f.now).unwrap() else { break };
        assert_eq!(plan.value, 0);
        match plan.tx.selector() {
            Some(SEL_WITHDRAW) => {
                assert_eq!(plan.tx.to, m.pool);
                let to = arg_addr(&plan.tx.data, 2);
                let w = &plan.tx.data[4 + 32..4 + 64];
                let u = u128::from_be_bytes(w[16..].try_into().unwrap());
                out.withdraws.push((to, AmountArg::Exact(u)));
                f.link -= u;
                f.idle_link += u; // it lands at the position itself
            }
            Some(SEL_TRANSFER) => {
                assert_eq!(plan.tx.to, m.collateral, "only the collateral is paid out");
                let to = arg_addr(&plan.tx.data, 0);
                let w = &plan.tx.data[4 + 32..4 + 64];
                let u = u128::from_be_bytes(w[16..].try_into().unwrap());
                out.transfers.push((to, u, plan.tx.gas.gas_limit * plan.tx.gas.max_fee_per_gas));
                f.idle_link -= u;
            }
            other => panic!("unexpected settlement tx {other:?}"),
        }
        f.land(&plan);
    }
    out
}

fn owed_by_address(s: &Settlement, pos: EvmAddr) -> std::collections::BTreeMap<EvmAddr, u128> {
    let mut m = std::collections::BTreeMap::new();
    for l in s.legs.iter().filter(|l| l.to != pos) {
        if let AmountArg::Exact(u) = l.amount {
            *m.entry(l.to).or_insert(0) += u;
        }
    }
    m
}

#[test]
fn a_wrapped_native_settlement_is_one_withdraw_to_the_position_then_one_transfer_per_payout() {
    let mut f = F::with_market(weth_market());
    let rid = pooled(&mut f);
    let s = settle(&mut f, rid, STEWARDS[0]);
    assert_eq!(s.legs[0].to, a(POS_ADDR), "the batch leg comes first");
    let owed = owed_by_address(&s, a(POS_ADDR));
    let r = run(&mut f, rid, &|_| gas());
    assert_eq!(r.withdraws.len(), 1, "exactly one Aave withdraw");
    assert_eq!(r.withdraws[0].0, a(POS_ADDR), "to the position itself");
    assert_eq!(r.withdraws[0].1, AmountArg::Exact(owed.values().sum()), "everything owed, once");
    assert_eq!(r.transfers.len(), owed.len(), "one transfer per payout address (legs merged)");
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Settled);
    assert!(f.s.claims.values().filter(|c| c.rescue_id == rid).all(|c| c.status == ClaimStatus::Settled));
}

#[test]
fn the_borrower_pays_at_most_one_withdraw_and_each_recipient_its_own_transfer() {
    // any gas args within the market's caps, different for every tx
    let caps = weth_market();
    for seed in 0..200u128 {
        let mut f = F::with_market(weth_market());
        let rid = pooled(&mut f);
        let s = settle(&mut f, rid, STEWARDS[0]);
        let owed = owed_by_address(&s, a(POS_ADDR));
        let gas_of = move |i: usize| {
            let k = (seed * 7919 + i as u128 * 104_729) % 1000;
            GasArgs { gas_limit: TRANSFER_GAS + (caps.gas_limit_cap - TRANSFER_GAS) * k / 999, max_fee_per_gas: 1 + (caps.max_fee_cap - 1) * ((k * 31) % 1000) / 999, max_priority_fee_per_gas: 0 }
        };
        let r = run(&mut f, rid, &gas_of);
        assert_eq!(r.withdraws.len(), 1, "the borrower's only settlement gas is one withdraw");
        for (to, sent, charge) in &r.transfers {
            // the recipient paid its own transfer, at the most that tx can cost
            assert_eq!(*sent + *charge, owed[to], "seed {seed}: {to:?} got owed minus exactly its own transfer's gas bound");
        }
        // conservation: what left Aave = what was sent + what was charged + what was skipped
        let sent: u128 = r.transfers.iter().map(|t| t.1).sum();
        let AmountArg::Exact(w) = r.withdraws[0].1 else { panic!() };
        assert!(sent <= w);
        assert_eq!(f.idle_link, w - sent, "the charges stay at the position, the borrower's");
    }
}

#[test]
fn a_payout_that_cannot_cover_its_own_transfer_is_not_sent_and_stays_with_the_borrower() {
    // a market whose fee cap is high enough that one transfer's gas bound can exceed a payout
    let m = Market { max_fee_cap: 10 * E18, ..weth_market() };
    let mut f = F::with_market(m.clone());
    let rid = pooled(&mut f);
    let s = settle(&mut f, rid, STEWARDS[0]);
    let owed = owed_by_address(&s, a(POS_ADDR));
    let smallest = *owed.values().min().unwrap();
    let big_fee = smallest / m.gas_limit_cap + 1;
    assert!(big_fee <= m.max_fee_cap);
    let g = GasArgs { gas_limit: m.gas_limit_cap, max_fee_per_gas: big_fee, max_priority_fee_per_gas: 0 };
    let r = run(&mut f, rid, &|i| if i == 0 { gas() } else { g });
    let paid: Vec<EvmAddr> = r.transfers.iter().map(|t| t.0).collect();
    let skipped: Vec<&EvmAddr> = owed.iter().filter(|(_, u)| **u <= g.gas_limit * g.max_fee_per_gas).map(|(a, _)| a).collect();
    assert!(!skipped.is_empty());
    for a in skipped {
        assert!(!paid.contains(a), "no transfer for a payout its own gas would eat");
    }
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Settled, "the settlement still closes");
}

#[test]
fn nothing_is_left_to_sign_once_every_payout_is_done() {
    let mut f = F::with_market(weth_market());
    let rid = pooled(&mut f);
    settle(&mut f, rid, STEWARDS[0]);
    run(&mut f, rid, &|_| gas());
    f.report(f.price);
    assert!(err(f.s.settle_next(rid, gas(), f.now)).contains("not settling"));
}

#[test]
fn a_takeover_pays_the_taker_its_repay_collateral_and_fee_in_one_transfer() {
    let mut f = F::with_market(weth_market());
    let rid = pooled(&mut f);
    f.now += 24 * 3600 * SEC;
    f.report(2_850_000_000);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    f.tick(181);
    f.report(2_850_000_000);
    f.s.take_over_settlement(STEWARDS[1], rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    assert_eq!(s.legs[0].to, a(POS_ADDR), "the batch leg survives a takeover, still first");
    f.dai -= s.repay_units;
    f.s.confirm_settlement_repay(REPORTER, rid, "0xrep2", s.repay_units, f.block + 1).unwrap();
    let owed = owed_by_address(&f.s.rescue(rid).unwrap().settlement.clone().unwrap(), a(POS_ADDR));
    let r = run(&mut f, rid, &|_| gas());
    let to_taker: Vec<_> = r.transfers.iter().filter(|t| t.0 == steward_payout(1)).collect();
    assert_eq!(to_taker.len(), 1, "the taker's R and fee arrive in one transfer");
    assert_eq!(to_taker[0].1 + to_taker[0].2, owed[&steward_payout(1)]);
    assert_eq!(f.s.rescue(rid).unwrap().state, RescueState::Settled);
}

#[test]
fn while_the_position_holds_the_claim_owners_weth_no_escrow_reading_counts_it_as_the_borrowers() {
    let mut f = F::with_market(weth_market());
    let rid = pooled(&mut f);
    settle(&mut f, rid, STEWARDS[0]);
    // the batch withdraw lands: the WETH now sits at the position
    f.report(f.price);
    let plan = f.s.settle_next(rid, gas(), f.now).unwrap().unwrap();
    assert_eq!(plan.tx.selector(), Some(SEL_WITHDRAW));
    let AmountArg::Exact(w) = f.s.rescue(rid).unwrap().settlement.clone().unwrap().legs[0].amount else { panic!() };
    f.link -= w;
    f.idle_link += w;
    f.land(&plan);
    assert!(f.s.holds_settlement_collateral(f.pid));
    f.block += 1;
    assert!(err(f.s.confirm_escrow(REPORTER, f.pid, 10 * E18, 0, f.block, f.now)).contains("settlement's collateral"));
    // after the payouts it is the borrower's again (and no claim is open: nothing to hold)
    run(&mut f, rid, &|_| gas());
    assert!(!f.s.holds_settlement_collateral(f.pid));
}

#[test]
fn a_liquidation_after_the_batch_withdraw_still_drops_the_unsent_premiums() {
    let mut f = F::with_market(weth_market());
    let rid = pooled(&mut f);
    let s = settle(&mut f, rid, STEWARDS[0]);
    let cls: Vec<Claim> = f.s.claims.values().filter(|c| c.rescue_id == rid).cloned().collect();
    f.report(f.price);
    let plan = f.s.settle_next(rid, gas(), f.now).unwrap().unwrap();
    let AmountArg::Exact(w) = f.s.rescue(rid).unwrap().settlement.clone().unwrap().legs[0].amount else { panic!() };
    f.link -= w;
    f.idle_link += w;
    f.land(&plan);
    // Aave liquidates part of what's left (10 % of the debt, 10 % bonus)
    f.report(f.price);
    f.tick(12);
    let repaid = f.dai / 10;
    f.dai -= repaid;
    f.link -= units_to_base(repaid, E8, 18) * 11_000 / BPS * E18 / 2_850_000_000;
    f.report(2_850_000_000);
    for c in &cls {
        assert_eq!(f.s.claims[&c.token_id].owed_units, c.share_units, "premium forfeited");
    }
    let r = run(&mut f, rid, &|_| gas());
    let charge = gas().gas_limit * gas().max_fee_per_gas;
    let got = |i: usize| r.transfers.iter().filter(|t| t.0 == steward_payout(i)).map(|t| t.1).sum::<u128>();
    let c0 = cls.iter().find(|c| c.owner == STEWARDS[0]).unwrap();
    let c3 = cls.iter().find(|c| c.owner == STEWARDS[3]).unwrap();
    assert_eq!(got(0), c0.share_units + s.repay_collateral_units - charge, "principal + R, minus its transfer");
    assert_eq!(got(3), c3.share_units - charge, "principal only, minus its transfer");
    assert_eq!(f.idle_link, w - got(0) - got(3), "the forfeited premiums and the charges stay with the borrower");
}

#[test]
fn a_market_whose_collateral_is_not_wrapped_native_keeps_per_leg_withdraws() {
    let mut f = F::new(); // LINK
    let rid = pooled(&mut f);
    let s = settle(&mut f, rid, STEWARDS[0]);
    assert!(s.legs.iter().all(|l| l.to != a(POS_ADDR)), "no batch leg");
    let r = run(&mut f, rid, &|_| gas());
    assert!(r.transfers.is_empty());
    assert_eq!(r.withdraws.len(), s.legs.len());
}

#[test]
fn the_same_weth_address_on_another_chain_is_not_batched() {
    let mut f = F::with_market(Market { chain_id: 10, ..weth_market() });
    let rid = pooled(&mut f);
    let s = settle(&mut f, rid, STEWARDS[0]);
    assert!(s.legs.iter().all(|l| l.to != a(POS_ADDR)));
}

#[test]
fn on_an_op_stack_market_each_payout_also_pays_the_capped_l1_data_fee_of_its_own_transfer() {
    // Base and Optimism take an L1 data fee on top of gas x price, from the position's ETH: it is
    // added to each recipient's charge, so the borrower still pays none of it
    let l1 = 3_000_000_000_000u128; // 0.000003 ETH
    let mut f = F::with_market(weth_market());
    f.s.set_market_ext(OWNER, 0, MarketExt { l1_fee_cap: l1, ..Default::default() }).unwrap();
    let rid = pooled(&mut f);
    let s = settle(&mut f, rid, STEWARDS[0]);
    let owed = owed_by_address(&s, a(POS_ADDR));
    let r = run(&mut f, rid, &|_| gas());
    assert!(!r.transfers.is_empty());
    for (to, sent, gas_bound) in &r.transfers {
        assert_eq!(*sent + *gas_bound + l1, owed[to], "{to:?} paid its transfer's gas bound plus the L1 fee cap");
    }
    let sent: u128 = r.transfers.iter().map(|t| t.1).sum();
    let AmountArg::Exact(w) = r.withdraws[0].1 else { panic!() };
    assert_eq!(f.idle_link, w - sent, "the charges stay at the position, the borrower's");
}

#[test]
fn without_an_l1_fee_cap_the_charge_is_the_gas_bound_alone() {
    let mut f = F::with_market(weth_market());
    let rid = pooled(&mut f);
    let s = settle(&mut f, rid, STEWARDS[0]);
    let owed = owed_by_address(&s, a(POS_ADDR));
    for (to, sent, gas_bound) in run(&mut f, rid, &|_| gas()).transfers {
        assert_eq!(sent + gas_bound, owed[&to]);
    }
}
