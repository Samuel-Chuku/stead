//! THE INVARIANT: a borrower is never worse off than after an Aave liquidation.
//!
//! Defined precisely:
//!   I1. Within one episode (from a first rescue until the position has no open claims again),
//!       Σ each premium valued at its own trigger price ≤ the Aave liquidation cost at the
//!       episode's first trigger (baseline: Aave v3.0, 50 % close, bonus from the reserve config).
//!       After early settlement clears the claims, the next auction is a new first rescue.
//!   I2. The borrower owes back exactly the supplied units plus the fixed-unit premium:
//!       measured in collateral units, with each settlement's R swap checked at its own price
//!       and taken out, the borrower ends at most Σ `premium_units` below no rescue.
//!
//! The model is timed (one reading per 12 s): auctions take 45 s + top-up; a settlement takes
//! 2–3 min from crossing to confirmed (verified path); Aave liquidates whenever its HF < 1 and
//! refuses any withdrawal that would leave HF < 1.
mod common;
use common::*;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn range(&mut self, lo: u128, hi: u128) -> u128 {
        lo + (self.next() as u128) % (hi - lo + 1)
    }
}

/// Independent Aave v3.0 liquidation (close factor 50 % at HF ≥ 0.95): the liquidator repays half
/// the debt and seizes that value × (1 + bonus) in collateral.
fn aave_liquidation_loss_base(debt_base: u128, price_base: u128, bonus_bps: u128) -> u128 {
    let repaid = debt_base / 2;
    let seized_units = repaid * (BPS + bonus_bps) / BPS * E18 / price_base;
    units_to_base(seized_units, price_base, 18) - repaid
}

/// Net worth × 1e26 (exact): LINK · price − DAI · $1.
fn worth(link: u128, dai: u128, price: u128) -> i128 {
    (link * price) as i128 - (dai * E8) as i128
}

fn aave_hf(f: &F, price: u128) -> u128 {
    hf_wad(units_to_base(f.link, price, 18), units_to_base(f.dai, E8, 18), 7500)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Drift {
    Falling,
    Crash,
    Flat,
    Rising,
    /// constant fall, bps per minute
    Const(u128),
}
#[derive(Debug, Clone, Copy, PartialEq)]
enum End {
    BuyBack,
    SettleAtExpiry,
}

struct Cfg {
    drift: Drift,
    end: End,
    early_bps: u32,
    /// the settler never supplies the repayment (the fallback after 15 min)
    absent_settler: bool,
    /// with an absent settler, another steward takes the repayment over after 3 min
    taker: bool,
    readings: u32,
    /// constant-fall runs stop once the first rescue is resolved
    stop_after_first: bool,
}

struct Auction {
    rid: u64,
    close_at: u64,
    land_at: u64,
    closed: bool,
}
struct Settle {
    rid: u64,
    start_at: u64,
    repay_at: u64,
    exec_at: u64,
    started: bool,
    dai_before: u128,
    taken_at: Option<u64>,
}

#[derive(Debug, Default)]
struct Outcome {
    liquidated: bool,
    liquidated_with_claims: bool,
    rescues: usize,
    episodes: usize,
    early: usize,
    fallbacks: usize,
    fallback_refusals: usize,
    /// first rescue: resolved with every claim paid its owed units
    first_paid_full: Option<bool>,
    /// first rescue's top-ups landed before any liquidation (else: too late, no steward money at risk)
    first_landed: bool,
    any_short: bool,
    i1_max_ratio: f64,
    premium_units: u128,
    loss_units: i128,
    slack: i128,
    own_equity_units: i128,
}

/// Everything one 12 s reading does to the model world.
struct World {
    f: F,
    rng: Rng,
    o: Outcome,
    latency: u64,
    auction: Option<Auction>,
    settle: Option<Settle>,
    first_rid: Option<u64>,
    /// rescue id → episode; baseline per episode (I1)
    episode_of: Vec<(u64, usize)>,
    baselines: Vec<u128>,
    undo_link: u128,
    undo_dai: u128,
    to_borrower: u128,
    paid_dai: u128,
    short_rids: Vec<u64>,
}

impl World {
    /// Returns false once Aave has liquidated the position.
    fn step(&mut self, price: u128, cfg: &Cfg) -> bool {
        let f = &mut self.f;
        if f.dai > 0 && aave_hf(f, price) < WAD {
            self.o.liquidated = true;
            self.o.liquidated_with_claims = !f.s.position(f.pid).unwrap().open_rescues.is_empty() || self.auction.is_some();
            return false;
        }
        let new_episode = f.s.position(f.pid).unwrap().open_rescues.is_empty();
        if let Some(rid) = f.report(price) {
            let r = f.s.rescue(rid).unwrap().clone();
            if new_episode || self.baselines.is_empty() {
                self.baselines.push(aave_liquidation_loss_base(units_to_base(f.dai, E8, 18), price, 1000));
            }
            self.episode_of.push((rid, self.baselines.len() - 1));
            self.first_rid.get_or_insert(rid);
            let n = self.rng.range(1, 3) as usize;
            for i in 0..n {
                let amt = if i + 1 == n { r.topup_units } else { r.topup_units / (n as u128) };
                let bps = self.rng.range(0, r.cap_bps as u128) as u32;
                f.s.bid(STEWARDS[i], rid, bps, amt, BOND, f.now).unwrap();
            }
            self.auction = Some(Auction { rid, close_at: f.now + 46 * SEC, land_at: f.now + 61 * SEC, closed: false });
            self.o.rescues += 1;
        }
        // settlement pipeline (detected on this reading, before any top-up lands): crossing → start (+24 s, fresh verified reading) → repay → withdrawals
        if self.settle.is_none() {
            let pos = f.s.position(f.pid).unwrap().clone();
            if let Some(&rid) = pos.open_rescues.first() {
                let h = pos.health.clone().unwrap();
                let net = f.s.net_hf_wad(f.pid, &h.r).unwrap();
                let expired = f.now >= f.s.rescue(rid).unwrap().claims_opened_at + f.s.params.buyback_window_ns;
                if hf_below(net, cfg.early_bps as u128) || expired {
                    let l = self.latency;
                    self.settle = Some(Settle { rid, start_at: f.now + 24 * SEC, repay_at: f.now + l / 2, exec_at: f.now + l, started: false, dai_before: 0, taken_at: None });
                }
            }
        }
        if let Some(a) = &mut self.auction {
            if !a.closed && f.now >= a.close_at {
                f.s.close_auction(a.rid, f.now).unwrap();
                a.closed = true;
            }
            if a.closed && f.now >= a.land_at {
                for (k, m) in f.s.rescue(a.rid).unwrap().members.clone().iter().enumerate() {
                    f.link += m.share_units;
                    f.s.confirm_topup(REPORTER, a.rid, &m.steward, m.share_units, &format!("0x{}-{k}", a.rid), f.block + 1, f.now).unwrap();
                }
                self.auction = None;
            }
        }
        let Some(st) = &mut self.settle else { return true };
        if !st.started && f.now >= st.start_at {
            let settler = f.s.claims.values().find(|c| c.rescue_id == st.rid && c.status == ClaimStatus::Open).unwrap().owner.clone();
            if let Err(e) = f.s.start_settlement(&settler, st.rid, f.now) {
                assert!(e.contains("net HF above") || e.contains("predates the last event"), "{e}");
                self.settle = None; // price bounced back above the early level before the start
                return true;
            }
            self.o.early += f.s.rescue(st.rid).unwrap().settlement.as_ref().unwrap().early as usize;
            st.started = true;
            st.dai_before = f.dai;
        }
        if !st.started {
            return true;
        }
        let s = f.s.rescue(st.rid).unwrap().settlement.clone().unwrap();
        if !s.repay_confirmed {
            if cfg.absent_settler && cfg.taker {
                if st.taken_at.is_none() && f.now >= st.start_at + TAKEOVER_AFTER_NS {
                    let taker = STEWARDS.iter().find(|x| **x != s.settler.as_str()).unwrap();
                    f.s.take_over_settlement(taker, st.rid, f.now).unwrap();
                    st.taken_at = Some(f.now);
                }
                if let Some(t) = st.taken_at {
                    if f.now >= t + self.latency / 2 {
                        let s = f.s.rescue(st.rid).unwrap().settlement.clone().unwrap();
                        f.dai = if s.full_close { 0 } else { f.dai - s.repay_units.min(f.dai) };
                        f.s.confirm_settlement_repay(REPORTER, st.rid, &format!("0xtake{}", st.rid), s.repay_units, f.block + 1).unwrap();
                    }
                }
            } else if cfg.absent_settler {
                if f.now >= st.start_at + SETTLE_FALLBACK_NS {
                    match f.s.settle_fallback(st.rid, f.now) {
                        Ok(()) => self.o.fallbacks += 1,
                        Err(_) => self.o.fallback_refusals += 1,
                    }
                }
            } else if f.now >= st.repay_at {
                f.dai = if s.full_close { 0 } else { f.dai - s.repay_units.min(f.dai) };
                f.s.confirm_settlement_repay(REPORTER, st.rid, &format!("0xrepay{}", st.rid), s.repay_units, f.block + 1).unwrap();
            }
        }
        let s = f.s.rescue(st.rid).unwrap().settlement.clone().unwrap();
        let exec_at = st.taken_at.map_or(st.exec_at, |t| t + self.latency);
        if !(s.repay_confirmed && (f.now >= exec_at || (cfg.absent_settler && !cfg.taker))) {
            return true;
        }
        // withdrawals land one per reading (each needs a reading at least as new as the last
        // event); Aave refuses one that leaves HF < 1 (re-signed after the next reading)
        if f.s.rescue(st.rid).unwrap().state == RescueState::Settling {
            let Ok(plan) = f.s.settle_next(st.rid, gas(), f.now) else { return true };
            let leg = f.s.rescue(st.rid).unwrap().settlement.as_ref().unwrap().legs.iter().find(|l| !l.done).unwrap().clone();
            let u = match leg.amount {
                AmountArg::Exact(u) => u,
                AmountArg::Max => f.link,
            };
            let left = f.link.saturating_sub(u);
            let ok = u <= f.link && (f.dai == 0 || hf_wad(units_to_base(left, price, 18), units_to_base(f.dai, E8, 18), 7500) >= WAD);
            f.s.on_signed(f.pid, plan.tx.nonce, Some(vec![1])).unwrap();
            f.s.confirm_nonce(REPORTER, f.pid, plan.tx.nonce + 1, ok, f.block + 1).unwrap();
            if !ok {
                return true;
            }
            f.link = left;
            if leg.amount == AmountArg::Max {
                self.to_borrower += u;
            }
            if f.s.rescue(st.rid).unwrap().state == RescueState::Settling {
                return true; // more legs: next reading
            }
        }
        let paid: u128 = s.legs.iter().map(|l| if let AmountArg::Exact(u) = l.amount { u } else { 0 }).sum();
        if paid < s.owed_units + s.repay_collateral_units || s.repay_collateral_units < base_to_units_floor(s.repay_base, s.price_base, 18) {
            self.short_rids.push(st.rid);
        }
        let swap_debt = st.dai_before - f.dai;
        assert!(s.repay_collateral_units * s.price_base <= swap_debt * E8, "R swap not at the oracle price");
        self.undo_link += s.repay_collateral_units;
        self.undo_dai += swap_debt;
        self.settle = None;
        true
    }
}

fn path(seed: u64, cfg: &Cfg) -> Option<Outcome> {
    let mut rng = Rng(seed | 1);
    let mut f = F::new();
    let mut p = f.s.params.clone();
    p.early_settle_hf_bps = cfg.early_bps;
    f.s.set_params(OWNER, p).unwrap();
    let mut price = rng.range(5, 50) * E8;
    f.link = rng.range(10, 5000) * E18;
    // start above the trigger and let the price fall into it (the reporter reads every 12 s)
    let hf0 = rng.range(11_600, 13_000);
    f.dai = units_to_base(f.link, price, 18) * 7500 / hf0 * 10_000_000_000;
    let (link0, dai0) = (f.link, f.dai);
    let latency = rng.range(120, 180) as u64 * SEC;
    let mut w = World {
        f, rng, o: Outcome::default(), latency, auction: None, settle: None, first_rid: None,
        episode_of: vec![], baselines: vec![], undo_link: 0, undo_dai: 0, to_borrower: 0, paid_dai: 0, short_rids: vec![],
    };

    for _ in 0..cfg.readings {
        let (down, up) = match cfg.drift {
            Drift::Falling => (w.rng.range(0, 60), w.rng.range(0, 40)),
            Drift::Crash => (w.rng.range(0, 150), w.rng.range(0, 50)),
            Drift::Flat => (w.rng.range(0, 100), w.rng.range(0, 100)),
            Drift::Rising => (w.rng.range(0, 50), w.rng.range(0, 150)),
            Drift::Const(bps_min) => (bps_min / 5, 0),
        };
        price = (price * (BPS + up - down) / BPS).max(E8 / 100);
        w.f.tick(12);
        if !w.step(price, cfg) {
            break;
        }
        if let (true, Some(r1)) = (cfg.stop_after_first, w.first_rid) {
            if matches!(w.f.s.rescue(r1).unwrap().state, RescueState::Settled | RescueState::BoughtBack) {
                break;
            }
        }
    }
    let r1 = w.first_rid?;
    w.o.first_landed = !matches!(w.f.s.rescue(r1).unwrap().state, RescueState::Auction | RescueState::TopUpPending | RescueState::Failed);
    if cfg.stop_after_first {
        let st = w.f.s.rescue(r1).unwrap().state;
        w.o.first_paid_full = Some(!w.o.liquidated && st == RescueState::Settled && !w.short_rids.contains(&r1));
        return Some(w.o);
    }

    // end: finish any auction at the last price, then +24 h and buy back or settle what's left
    for _ in 0..8 {
        w.f.tick(12);
        if !w.step(price, cfg) {
            break;
        }
    }
    if !w.o.liquidated {
        w.f.now += 24 * 3600 * SEC;
        let mut guard = 0;
        while !w.f.s.position(w.f.pid).unwrap().open_rescues.is_empty() || w.settle.is_some() {
            guard += 1;
            assert!(guard < 2000, "settlement never finished");
            w.f.tick(12);
            if cfg.end == End::BuyBack && w.settle.as_ref().is_none_or(|s| !s.started) {
                w.settle = None;
                w.f.report(price);
                for rid in w.f.s.position(w.f.pid).unwrap().open_rescues.clone() {
                    for cl in w.f.s.claims.values().filter(|c| c.rescue_id == rid && c.status == ClaimStatus::Open).cloned().collect::<Vec<_>>() {
                        // pay the position (escrow) in DAI at the current price; the contract pays the owner
                        let dai = w.f.dai_for(cl.owed_units);
                        w.f.pay_escrow(0, dai).unwrap();
                        w.paid_dai += dai;
                        for o in w.f.run_payouts() {
                            if o.purpose == OutPurpose::Refund && o.action == OutAction::Transfer(TokenSide::Debt) {
                                w.paid_dai -= o.amount; // came back to the borrower
                            }
                        }
                    }
                }
                continue;
            }
            if !w.step(price, cfg) {
                break;
            }
        }
    }
    let mut o = w.o;
    o.first_paid_full = Some(!o.liquidated && !w.short_rids.contains(&r1));
    o.any_short = !w.short_rids.is_empty();
    o.episodes = w.baselines.len();
    if o.liquidated {
        return Some(o);
    }
    let f = &w.f;
    let claims: Vec<_> = f.s.claims.values().filter(|c| c.position_id == f.pid).cloned().collect();
    assert!(claims.iter().all(|c| c.status != ClaimStatus::Open));
    // I1 per episode
    for (ep, base) in w.baselines.iter().enumerate() {
        let prem: u128 = claims.iter().filter(|c| w.episode_of.iter().any(|(r, e)| *r == c.rescue_id && *e == ep)).map(|c| c.premium_base).sum();
        o.i1_max_ratio = o.i1_max_ratio.max(prem as f64 / *base as f64);
    }
    // I2
    o.premium_units = claims.iter().map(|c| c.premium_units).sum();
    let none = worth(link0, dai0, price);
    let stead = worth(f.link + w.to_borrower + w.undo_link, f.dai + w.undo_dai, price) - (w.paid_dai * E8) as i128;
    o.loss_units = (none - stead) / price as i128;
    o.slack = (3 * claims.len() as i128 + 3) * E18 as i128 / price as i128;
    o.own_equity_units = none / price as i128;
    Some(o)
}

#[test]
fn invariant_property_sweep() {
    let mut failures: Vec<String> = vec![];
    println!("\nRandom paths, timed model (1 h of readings, then +24 h), early_settle_hf = 1.10 (default)");
    println!("{:<8} {:<15} {:>5} {:>6} {:>7} {:>8} {:>6} {:>6} {:>9} {:>8}", "drift", "end", "paths", "early", "stacked", "2+ eps", "liq'd", "short", "max I1", "I1/I2 ✗");
    for drift in [Drift::Falling, Drift::Crash, Drift::Flat, Drift::Rising] {
        for end in [End::BuyBack, End::SettleAtExpiry] {
            let cfg = Cfg { drift, end, early_bps: Params::default().early_settle_hf_bps, absent_settler: false, taker: false, readings: 300, stop_after_first: false };
            let (mut n, mut early, mut stacked, mut multi_ep, mut liq, mut short, mut viol) = (0, 0, 0, 0, 0, 0, 0);
            let mut max_i1 = 0f64;
            for seed in 1..=300u64 {
                let Some(o) = path(seed * 7919 + 17, &cfg) else { continue };
                n += 1;
                early += (o.early > 0) as u32;
                stacked += (o.rescues > o.episodes) as u32;
                multi_ep += (o.episodes > 1) as u32;
                liq += o.liquidated as u32;
                short += o.any_short as u32;
                if o.liquidated_with_claims {
                    failures.push(format!("{drift:?}/{end:?} seed {seed}: Aave liquidated with a claim open: {o:?}"));
                }
                if o.liquidated {
                    continue;
                }
                max_i1 = max_i1.max(o.i1_max_ratio);
                let over = o.loss_units - o.premium_units as i128;
                if o.i1_max_ratio > 1.0 || over > o.slack || (over < -o.slack && !o.any_short) {
                    viol += 1;
                    failures.push(format!("{drift:?}/{end:?} seed {seed}: {o:?}"));
                }
            }
            println!("{:<8} {:<15} {:>5} {:>6} {:>7} {:>8} {:>6} {:>6} {:>9.4} {:>8}", format!("{drift:?}"), format!("{end:?}"), n, early, stacked, multi_ep, liq, short, max_i1, viol);
        }
    }
    assert!(failures.is_empty(), "{} violations; first: {}", failures.len(), failures[0]);
}

/// Constant falls, timed model. For each early-settle level, the share of positions whose
/// FIRST steward is paid its owed units in full (no liquidation, no short settlement), with the
/// settler repaying (normal) or absent (the fallback after 15 min).
#[test]
fn fastest_fall_first_steward_paid_in_full() {
    let rates: [u128; 14] = [50, 100, 200, 300, 400, 500, 600, 700, 800, 1000, 1200, 1500, 2000, 3000]; // bps per minute
    for (absent, taker) in [(false, false), (true, true), (true, false)] {
        println!(
            "\nConstant fall, settler {}: % of first stewards paid in full, of those whose top-up landed (% too late: liquidated before the top-up landed)",
            match (absent, taker) {
                (false, _) => "repays (2–3 min verified path)",
                (true, true) => "ABSENT → takeover after 3 min",
                (true, false) => "ABSENT, no taker → fallback after 15 min",
            }
        );
        print!("{:<9}", "early HF");
        for r in rates {
            print!("{:>10}", format!("{}%/m", r as f64 / 100.0));
        }
        println!("   fastest at 100 %");
        for early in [10_500u32, 10_800, 11_000] {
            print!("{:<9}", format!("{:.2}", early as f64 / 1e4));
            let (mut fastest, mut still_full) = (0u128, true);
            for r in rates {
                let cfg = Cfg { drift: Drift::Const(r), end: End::SettleAtExpiry, early_bps: early, absent_settler: absent, taker, readings: 1500, stop_after_first: true };
                let (mut all, mut n, mut full, mut late) = (0, 0, 0, 0);
                for seed in 1..=200u64 {
                    let Some(o) = path(seed * 104_729 + r as u64, &cfg) else { continue };
                    all += 1;
                    if !o.first_landed {
                        late += 1;
                        continue;
                    }
                    n += 1;
                    full += o.first_paid_full.unwrap_or(false) as u32;
                }
                still_full &= full == n && n > 0;
                if still_full {
                    fastest = r;
                }
                let pct = |a: u32, b: u32| if b == 0 { "-".to_string() } else { format!("{:.0}", 100.0 * a as f64 / b as f64) };
                print!("{:>10}", format!("{} ({})", pct(full, n), pct(late, all)));
            }
            println!("   {}", if fastest == 0 { "none".into() } else { format!("{}%/min", fastest as f64 / 100.0) });
        }
    }
}

/// The worked example: 100 LINK / 1,900 DAI, trigger at $29.13, 3 %, LINK falls to $26, settlement
/// at expiry. The borrower loses exactly the premium in LINK.
#[test]
fn worked_example_at_26_dollars() {
    let mut f = F::new();
    let trig = 2_913_330_000 - 1;
    let rid = f.report(trig).unwrap();
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.s.bid(STEWARDS[0], rid, 300, t, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    f.link += t;
    f.s.confirm_topup(REPORTER, rid, STEWARDS[0], t, "0x1", f.block + 1, f.now).unwrap();
    let cl = f.s.claims.values().next().unwrap().clone();
    f.now += 24 * 3600 * SEC;
    let end = 2_600_000_000;
    f.report(end);
    f.s.start_settlement(STEWARDS[0], rid, f.now).unwrap();
    let s = f.s.rescue(rid).unwrap().settlement.clone().unwrap();
    f.dai -= s.repay_units;
    f.s.confirm_settlement_repay(REPORTER, rid, "0xr", s.repay_units, f.block + 1).unwrap();
    f.price = end;
    f.run_legs(rid);
    let stead = worth(f.link + s.repay_collateral_units, f.dai + s.repay_units, end);
    let loss_units = (worth(100 * E18, 1900 * E18, end) - stead) / end as i128;
    let baseline = aave_liquidation_loss_base(1900 * E8, trig, 1000);
    println!(
        "Worked example: T = {:.4} LINK, premium = {:.4} LINK (${:.2} at trigger ≤ ${:.2}); at $26 the borrower loses {:.4} LINK",
        t as f64 / 1e18, cl.premium_units as f64 / 1e18, cl.premium_base as f64 / 1e8, baseline as f64 / 1e8, loss_units as f64 / 1e18
    );
    assert!(cl.premium_base <= baseline);
    assert!((loss_units - cl.premium_units as i128).abs() <= 1_000_000_000);
}
