//! Who the position can ever pay. Every transaction the contract signs for a position is decoded and
//! checked: value only ever leaves the position for the borrower's registered payout or a registered
//! steward payout; Pool calls act only on behalf of the position; approvals go only to the Pool.
//! A random driver runs thousands of call sequences (any caller, any order, any amounts, any time)
//! and fails on the first signed transaction that breaks this.
mod common;
use common::*;

const ATTACKER: &str = "mallory.testnet";
const ATTACKER_PAYOUT: &str = "0x00000000000000000000000000000000000000ba";

/// Where a signed transaction sends value, or None when it moves nothing out of the position.
/// Panics on a transaction shape the contract should never sign.
fn check(plan: &SignPlan, s: &Stead, pid: u64) {
    let p = s.position(pid).unwrap();
    let pos = p.evm_address.unwrap();
    let m = s.markets.get(&p.market_id).unwrap();
    let tx = &plan.tx;
    // the borrower's payout now, or one it registered earlier (a payout queued before a payout change
    // still goes to the address registered when it became owed), or a registered steward's payout
    let borrower_own = [p.payout, a(PAYOUT), a("0x00000000000000000000000000000000000000b1")];
    let ok_payout = |to: &EvmAddr| -> bool { borrower_own.contains(to) || s.evm_payouts.values().any(|x| x == to) };
    let bad = |why: &str| -> ! { panic!("{why}: to {} data {:02x?} value {}", tx.to.to_hex(), tx.data, plan.value) };

    if tx.data.is_empty() {
        // a plain ETH transfer: the zero-value nonce burn to itself, or the borrower's sweep
        if plan.value == 0 && tx.to == pos {
            return;
        }
        if !(tx.to == p.payout) {
            bad("native ETH to someone other than the borrower's payout");
        }
        return;
    }
    if plan.value != 0 {
        bad("value attached to a contract call");
    }
    let sel = tx.selector().unwrap();
    if tx.to == m.pool {
        match sel {
            SEL_SUPPLY => {
                if arg_addr(&tx.data, 2) != pos {
                    bad("supply on behalf of someone else");
                }
            }
            SEL_BORROW => {
                if arg_addr(&tx.data, 4) != pos {
                    bad("borrow on behalf of someone else");
                }
            }
            SEL_REPAY => {
                if arg_addr(&tx.data, 3) != pos {
                    bad("repay on behalf of someone else");
                }
            }
            SEL_WITHDRAW => {
                let to = arg_addr(&tx.data, 2);
                if !(ok_payout(&to) || to == pos) {
                    bad("withdraw to an unregistered address");
                }
            }
            _ => bad("unknown Pool call"),
        }
        return;
    }
    if tx.to == m.collateral || tx.to == m.debt {
        match sel {
            SEL_APPROVE => {
                if arg_addr(&tx.data, 0) != m.pool {
                    bad("approval to someone other than the Pool");
                }
            }
            SEL_TRANSFER => {
                let to = arg_addr(&tx.data, 0);
                if !ok_payout(&to) {
                    bad("token transfer to an unregistered address");
                }
                if to == a(ATTACKER_PAYOUT) {
                    bad("paid the attacker");
                }
            }
            _ => bad("unknown token call"),
        }
        return;
    }
    bad("call to a contract outside the market");
}

/// xorshift64*: deterministic, no dependency.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len() as u64) as usize]
    }
}

fn caller(r: &mut Rng) -> &'static str {
    *r.pick(&[BORROWER, STEWARDS[0], STEWARDS[1], STEWARDS[2], STEWARDS[3], ATTACKER, REPORTER, OWNER])
}

fn amount(r: &mut Rng) -> u128 {
    *r.pick(&[0, 1, E18 / 100, E18, 10 * E18, 30 * E18, u128::MAX / 2])
}

fn amount_arg(r: &mut Rng) -> AmountArg {
    if r.below(4) == 0 { AmountArg::Max } else { AmountArg::Exact(amount(r)) }
}

fn rand_gas(r: &mut Rng) -> GasArgs {
    GasArgs { gas_limit: *r.pick(&[21_000, 60_000, 300_000, 500_000]), max_fee_per_gas: *r.pick(&[1, 1_000_000_000, 100_000_000_000]), max_priority_fee_per_gas: *r.pick(&[0, 1_000_000_000]) }
}

/// One random step. Signed plans are checked, then landed (or left in flight, or failed).
fn step(f: &mut F, r: &mut Rng, signed: &mut usize, kinds: &mut std::collections::BTreeMap<&'static str, usize>) {
    let pid = f.pid;
    let rids: Vec<u64> = f.s.position(pid).unwrap().open_rescues.iter().copied().chain(f.s.position(pid).unwrap().active_auction).collect();
    let rid = if rids.is_empty() { 0 } else { *r.pick(&rids) };
    let mut plan: Option<SignPlan> = None;
    match r.below(19) {
        0 => {
            // the price moves (both ways), the model reports it
            let price = *r.pick(&[3_000_000_000u128, 2_850_000_000, 2_600_000_000, 2_200_000_000, 1_500_000_000, 4_000_000_000]);
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ()));
            f.block += 1;
            f.price = price;
            f.now += 1;
            let rd = reading(f.link, f.dai, price, f.block);
            let _ = f.s.report_health(REPORTER, pid, rd, f.now);
        }
        1 => {
            let action = match r.below(7) {
                0 => Action::Approve { token: if r.below(2) == 0 { TokenSide::Collateral } else { TokenSide::Debt }, amount: amount_arg(r) },
                1 => Action::Supply { amount: amount(r) },
                2 => Action::Borrow { amount: amount(r) },
                3 => Action::Repay { amount: amount_arg(r) },
                4 => Action::Withdraw { amount: amount_arg(r) },
                5 => Action::TransferDebt { amount: amount(r) },
                _ => Action::SweepEth { amount: amount(r) },
            };
            let c = caller(r);
            plan = f.s.sign_action(c, pid, action, rand_gas(r), f.now).ok();
        }
        2 => {
            let c = caller(r);
            let t = f.s.rescue(rid).map(|x| x.topup_units).unwrap_or(E18);
            let _ = f.s.bid(c, rid, *r.pick(&[1u32, 100, 300, 500, 1000, 5000]), *r.pick(&[t, t / 2, 1, u128::MAX / 2]), BOND, f.now);
        }
        3 => {
            let _ = f.s.close_auction(rid, f.now);
        }
        4 => {
            // a top-up lands (or a fake confirm from a random caller)
            if let Ok(x) = f.s.rescue(rid) {
                let members = x.members.clone();
                if let Some(m) = members.first() {
                    let c = caller(r);
                    if f.s.confirm_topup(c, rid, &m.steward, m.share_units, &format!("0xt{}", r.next()), f.block + 1, f.now).is_ok() {
                        f.link += m.share_units;
                    }
                }
            }
        }
        5 => {
            let _ = f.s.expire_topup(rid, f.now);
        }
        6 => {
            // the borrower (or anyone) pays into the position; the reporter proves it
            let (l, d) = (amount(r).min(50 * E18), amount(r).min(5_000 * E18));
            f.idle_link += l;
            f.idle_dai += d;
            f.block += 1;
            let c = caller(r);
            let _ = f.s.confirm_escrow(c, pid, f.idle_link, f.idle_dai, f.block, f.now);
        }
        7 => {
            let _ = f.s.start_settlement(caller(r), rid, f.now);
        }
        8 => {
            let _ = f.s.take_over_settlement(caller(r), rid, f.now);
        }
        9 => {
            let _ = f.s.settle_fallback(rid, f.now);
        }
        10 => {
            if let Ok(x) = f.s.rescue(rid) {
                if let Some(s) = x.settlement.clone() {
                    let c = caller(r);
                    if f.s.confirm_settlement_repay(c, rid, &format!("0xr{}", r.next()), s.repay_units, f.block + 1).is_ok() {
                        f.dai = f.dai.saturating_sub(s.repay_units);
                    }
                }
            }
            plan = f.s.settle_next(rid, rand_gas(r), f.now).ok().flatten();
        }
        11 => {
            plan = f.s.pay_next(pid, rand_gas(r), f.now).ok();
        }
        12 => {
            plan = f.s.burn_nonce(caller(r), pid, rand_gas(r), f.now).ok();
        }
        13 => {
            // the borrower may move its payout (to its own new address); anyone else tries the attacker's
            let c = caller(r);
            let to = if c == BORROWER { a("0x00000000000000000000000000000000000000b1") } else { a(ATTACKER_PAYOUT) };
            let _ = f.s.request_payout_change(c, pid, to, f.now);
            let _ = f.s.apply_payout_change(pid, f.now);
        }
        14 => {
            plan = f.s.replace_pending(caller(r), pid, *r.pick(&[1u128, 2_000_000_000, 200_000_000_000]), *r.pick(&[0u128, 1_000_000_000])).ok();
        }
        16 => rescue_walk(f, r),
        17 => settle_walk(f, r, signed, kinds),
        18 => buyback_walk(f, r, signed, kinds),
        _ => {
            // time passes: seconds, minutes, a buy-back window, a payout-change delay
            let secs = *r.pick(&[1u64, 30, 46, 200, 600, 3_600, 90_000]);
            f.tick(secs);
        }
    }
    if let Some(p) = plan {
        handle(f, r, &p, signed, kinds, true);
    }
}

type Kinds = std::collections::BTreeMap<&'static str, usize>;

/// Check and count a signed plan, then MPC answers and the chain includes it (always, when `land`;
/// otherwise at random: a failed signature, a signature never mined, or mined).
fn handle(f: &mut F, r: &mut Rng, p: &SignPlan, signed: &mut usize, kinds: &mut Kinds, random_fate: bool) {
    let pid = f.pid;
    *signed += 1;
    let k: &'static str = match p.tx.selector() {
        None => if p.value == 0 { "nonce burn" } else { "eth sweep" },
        Some(SEL_WITHDRAW) => {
            let to = arg_addr(&p.tx.data, 2);
            if to == f.s.position(pid).unwrap().payout {
                "withdraw to borrower"
            } else if Some(to) == f.s.position(pid).unwrap().evm_address {
                "withdraw to the position"
            } else {
                "withdraw to a steward"
            }
        }
        Some(SEL_TRANSFER) => if p.tx.to == f.s.markets[&0].collateral { "collateral transfer" } else { "debt transfer" },
        Some(SEL_APPROVE) => "approve",
        Some(SEL_SUPPLY) => "supply",
        Some(SEL_BORROW) => "borrow",
        Some(SEL_REPAY) => "repay",
        _ => "other",
    };
    *kinds.entry(k).or_default() += 1;
    check(p, &f.s, pid);
    let fate = if random_fate { r.below(4) } else { 3 };
    match fate {
        0 => {
            let _ = f.s.on_signed(p.position_id, p.tx.nonce, None);
        }
        1 => {
            let _ = f.s.on_signed(p.position_id, p.tx.nonce, Some(vec![1]));
        }
        _ => {
            let _ = f.s.on_signed(p.position_id, p.tx.nonce, Some(vec![1]));
            let _ = f.s.confirm_nonce(REPORTER, p.position_id, p.tx.nonce + 1, !random_fate || r.below(5) != 0, f.block + 1);
            // the model chain follows the withdraws and transfers it can see
            if p.tx.selector() == Some(SEL_WITHDRAW) {
                let w = &p.tx.data[4 + 32..4 + 64];
                let u = u128::from_be_bytes(w[16..].try_into().unwrap());
                f.link = f.link.saturating_sub(if u == u128::MAX { f.link } else { u });
            }
        }
    }
}

/// A whole rescue: the price falls under the trigger, one or two stewards bid, the auction closes
/// and the top-ups are confirmed.
fn rescue_walk(f: &mut F, r: &mut Rng) {
    let pid = f.pid;
    let p = f.s.position(pid).unwrap();
    if p.active_auction.is_some() || !p.open_rescues.is_empty() || p.pending.is_some() {
        return;
    }
    f.link = 100 * E18;
    f.dai = 1900 * E18;
    f.block += 1;
    f.price = 2_850_000_000;
    f.now += 1;
    let rd = reading(f.link, f.dai, f.price, f.block);
    let Ok(Some(rid)) = f.s.report_health(REPORTER, pid, rd, f.now) else { return };
    let t = f.s.rescue(rid).unwrap().topup_units;
    let n = 1 + r.below(2) as usize;
    for i in 0..n {
        let amt = if n == 1 { t } else { t / 2 + 1 };
        let _ = f.s.bid(STEWARDS[(i + r.below(4) as usize) % 4], rid, *r.pick(&[100u32, 300, 500]), amt, BOND, f.now);
    }
    f.tick(46);
    let _ = f.s.close_auction(rid, f.now);
    let members = f.s.rescue(rid).unwrap().members.clone();
    for (k, m) in members.iter().enumerate() {
        if f.s.confirm_topup(REPORTER, rid, &m.steward, m.share_units, &format!("0xw{rid}-{k}-{}", r.next()), f.block + 1, f.now).is_ok() {
            f.link += m.share_units;
        }
    }
}

/// The window passes and the oldest open rescue settles: a claim owner starts, the repay is
/// confirmed, then every leg is signed (a fresh reading before each).
fn settle_walk(f: &mut F, r: &mut Rng, signed: &mut usize, kinds: &mut Kinds) {
    let pid = f.pid;
    let Some(&rid) = f.s.position(pid).unwrap().open_rescues.first() else { return };
    f.tick(90_000);
    let price = *r.pick(&[2_850_000_000u128, 2_600_000_000, 3_000_000_000]);
    f.block += 1;
    f.price = price;
    f.now += 1;
    let _ = f.s.report_health(REPORTER, pid, reading(f.link, f.dai, price, f.block), f.now);
    let owners: Vec<String> = f.s.claims.values().filter(|c| c.rescue_id == rid && c.status == ClaimStatus::Open).map(|c| c.owner.clone()).collect();
    if let Some(o) = owners.first() {
        let _ = f.s.start_settlement(o, rid, f.now);
    }
    if r.below(3) == 0 {
        f.tick(200);
        let _ = f.s.take_over_settlement(STEWARDS[r.below(4) as usize], rid, f.now);
    }
    if let Ok(x) = f.s.rescue(rid) {
        if let Some(st) = x.settlement.clone() {
            if f.s.confirm_settlement_repay(REPORTER, rid, &format!("0xs{rid}-{}", r.next()), st.repay_units, f.block + 1).is_ok() {
                f.dai = f.dai.saturating_sub(st.repay_units);
            }
        }
    }
    for _ in 0..10 {
        f.block += 1;
        f.now += 1;
        let _ = f.s.report_health(REPORTER, pid, reading(f.link, f.dai, f.price, f.block), f.now);
        match f.s.settle_next(rid, gas(), f.now) {
            Ok(Some(p)) => handle(f, r, &p, signed, kinds, false),
            _ => break,
        }
    }
}

/// The borrower pays the owed amount into the position, the balance is proven, and every queued
/// payout is sent.
fn buyback_walk(f: &mut F, r: &mut Rng, signed: &mut usize, kinds: &mut Kinds) {
    let pid = f.pid;
    let Some(&rid) = f.s.position(pid).unwrap().open_rescues.first() else { return };
    let owed: u128 = f.s.claims.values().filter(|c| c.rescue_id == rid && c.status == ClaimStatus::Open).map(|c| c.owed_units).sum();
    let extra = *r.pick(&[0u128, 1, E18]);
    f.idle_link += owed + extra;
    f.block += 1;
    let _ = f.s.confirm_escrow(REPORTER, pid, f.idle_link, f.idle_dai, f.block, f.now);
    f.block += 1;
    f.now += 1;
    let _ = f.s.report_health(REPORTER, pid, reading(f.link, f.dai, f.price.max(1), f.block), f.now);
    for _ in 0..6 {
        match f.s.pay_next(pid, gas(), f.now) {
            Ok(p) => handle(f, r, &p, signed, kinds, false),
            Err(_) => break,
        }
    }
}

#[test]
fn the_position_only_ever_pays_the_borrower_or_a_registered_steward() {
    let mut signed = 0usize;
    let mut kinds = std::collections::BTreeMap::new();
    for seed in 1..=4_000u64 {
        // every other sequence on a WETH market, where settlements are batched (withdraw + transfers)
        let mut f = if seed % 2 == 0 { F::with_market(weth_market()) } else { F::new() };
        // the attacker is not a steward and has a payout address of its own on file nowhere
        let mut r = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        // start from a normal open position: supplied and borrowed
        f.report(3_000_000_000);
        for _ in 0..300 {
            step(&mut f, &mut r, &mut signed, &mut kinds);
        }
    }
    eprintln!("signed by kind: {kinds:?}");
    // the driver must actually reach signing paths, or the test proves nothing
    assert!(signed > 40_000, "only {signed} transactions signed across all sequences");
    for k in ["withdraw to a steward", "collateral transfer", "debt transfer", "withdraw to the position"] {
        assert!(kinds.get(k).copied().unwrap_or(0) > 1_000, "the driver barely reached {k}: {kinds:?}");
    }
}

#[test]
fn the_checker_catches_a_payment_to_an_unregistered_address() {
    // the check itself must fail on a bad transaction (a checker that never fires proves nothing)
    let f = F::new();
    let p = f.s.position(f.pid).unwrap();
    let m = f.s.markets.get(&p.market_id).unwrap().clone();
    let bad = SignPlan { position_id: f.pid, path: "x".into(), tx: TxFields { chain_id: m.chain_id, nonce: 0, to: m.collateral, data: transfer(&a(ATTACKER_PAYOUT), 1), gas: gas() }, value: 0 };
    let r = std::panic::catch_unwind(|| check(&bad, &f.s, f.pid));
    assert!(r.is_err());
    let bad_withdraw = SignPlan { position_id: f.pid, path: "x".into(), tx: TxFields { chain_id: m.chain_id, nonce: 0, to: m.pool, data: withdraw(&m.collateral, AmountArg::Max, &a(ATTACKER_PAYOUT)), gas: gas() }, value: 0 };
    assert!(std::panic::catch_unwind(|| check(&bad_withdraw, &f.s, f.pid)).is_err());
}
