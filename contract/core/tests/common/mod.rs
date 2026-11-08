//! Shared fixture: Sepolia LINK/DAI market on the fork (chain 31337), the worked example's numbers
//! (100 LINK, 1,900 DAI, LT 75 %, bonus 10 %).
#![allow(dead_code)]

pub use stead_core::evm::*;
pub use stead_core::math::*;
pub use stead_core::*;

pub const OWNER: &str = "steadfi.testnet";
pub const REPORTER: &str = "reporter.steadfi.testnet";
pub const BORROWER: &str = "alice.testnet";
pub const STEWARDS: [&str; 4] = ["patient.steadfi.testnet", "swift.steadfi.testnet", "deep.steadfi.testnet", "pool.steadfi.testnet"];
pub const POOL: &str = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951";
pub const LINK: &str = "0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5";
pub const DAI: &str = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357";
pub const A_LINK: &str = "0x3FfAf50D4F4E96eB78f2407c090b72e86eCaed24";
pub const POS_ADDR: &str = "0x00000000000000000000000000000000000000a1";
pub const PAYOUT: &str = "0x00000000000000000000000000000000000000b0";
pub const E18: u128 = 1_000_000_000_000_000_000;
pub const E8: u128 = 100_000_000;
pub const BOND: u128 = 100_000_000_000_000_000_000_000;
pub const T0: u64 = 1_800_000_000 * SEC;

pub fn a(s: &str) -> EvmAddr {
    EvmAddr::parse(s).unwrap()
}
pub fn steward_payout(i: usize) -> EvmAddr {
    a(&format!("0x00000000000000000000000000000000000000c{i}"))
}

pub fn market() -> Market {
    Market {
        chain_id: 31337,
        pool: a(POOL),
        collateral: a(LINK),
        debt: a(DAI),
        collateral_decimals: 18,
        debt_decimals: 18,
        lt_bps: 7500,
        liq_bonus_bps: 1000,
        gas_limit_cap: 500_000,
        max_fee_cap: 100_000_000_000,
    }
}

pub fn gas() -> GasArgs {
    GasArgs { gas_limit: 300_000, max_fee_per_gas: 20_000_000_000, max_priority_fee_per_gas: 1_000_000_000 }
}

/// A reading for `link` LINK units and `dai` DAI units of debt at `price` (base, 8 dp).
pub fn reading(link: u128, dai: u128, price: u128, block: u64) -> HealthReport {
    let c = units_to_base(link, price, 18);
    let d = units_to_base(dai, E8, 18);
    HealthReport { hf_wad: hf_wad(c, d, 7500), collateral_base: c, debt_base: d, collateral_price_base: price, debt_price_base: E8, block }
}

pub struct F {
    pub s: Stead,
    pub pid: u64,
    pub now: u64,
    pub block: u64,
    /// Fork-side model of the position: LINK units and DAI debt units.
    pub link: u128,
    pub dai: u128,
    /// The position address's own (not supplied) balances: buy-back escrow.
    pub idle_link: u128,
    pub idle_dai: u128,
    /// Last reported LINK price.
    pub price: u128,
}

impl F {
    pub fn new() -> Self {
        let mut s = Stead::new(OWNER, REPORTER);
        s.add_market(OWNER, market()).unwrap();
        for (i, st) in STEWARDS.iter().enumerate() {
            s.set_role(OWNER, "steward", st, true).unwrap();
            s.set_evm_payout(st, steward_payout(i)).unwrap();
        }
        let pid = s.register_position(BORROWER, 0, a(PAYOUT)).unwrap();
        s.set_position_address(pid, a(POS_ADDR)).unwrap();
        F { s, pid, now: T0, block: 100, link: 100 * E18, dai: 1900 * E18, idle_link: 0, idle_dai: 0, price: 0 }
    }

    pub fn tick(&mut self, secs: u64) {
        self.now += secs * SEC;
        self.block += 1;
    }

    /// Reporter posts the model state at `price`.
    pub fn report(&mut self, price: u128) -> Option<u64> {
        self.block += 1;
        self.price = price;
        self.now += 1; // a later report has a later timestamp (as on NEAR)
        let r = reading(self.link, self.dai, price, self.block);
        self.s.report_health(REPORTER, self.pid, r, self.now).unwrap()
    }

    /// Sign as the borrower and confirm on the "chain" straight away.
    pub fn sign_ok(&mut self, action: Action) -> SignPlan {
        let plan = self.s.sign_action(BORROWER, self.pid, action, gas(), self.now).unwrap();
        self.land(&plan);
        plan
    }

    /// MPC signs, then the reporter confirms the nonce.
    pub fn land(&mut self, plan: &SignPlan) {
        self.s.on_signed(plan.position_id, plan.tx.nonce, Some(vec![0xde, 0xad])).unwrap();
        self.s.confirm_nonce(REPORTER, plan.position_id, plan.tx.nonce + 1, true, self.block + 1).unwrap();
    }

    /// Trigger at $28.50 (HF ≈ 1.125), bid, close, top up, mint. Returns the rescue id.
    pub fn rescue_with(&mut self, bids: &[(usize, u32, Option<u128>)]) -> u64 {
        let rid = self.report(2_850_000_000).expect("auction should open");
        let t = self.s.rescue(rid).unwrap().topup_units;
        for (i, bps, amt) in bids {
            self.s.bid(STEWARDS[*i], rid, *bps, amt.unwrap_or(t), BOND, self.now).unwrap();
        }
        self.tick(46);
        self.s.close_auction(rid, self.now).unwrap();
        let members = self.s.rescue(rid).unwrap().members.clone();
        for (k, m) in members.iter().enumerate() {
            self.link += m.share_units;
            self.s.confirm_topup(REPORTER, rid, &m.steward, m.share_units, &format!("0xtop{rid}-{k}"), self.block + 1, self.now).unwrap();
        }
        rid
    }

    /// The borrower pays into the position (escrow); the reporter proves the balance at a new
    /// block, then reads again (a DAI buy-back commits on a reading at least that new).
    pub fn pay_escrow(&mut self, link: u128, dai: u128) -> Result<(), String> {
        self.idle_link += link;
        self.idle_dai += dai;
        self.block += 1;
        let r = self.s.confirm_escrow(REPORTER, self.pid, self.idle_link, self.idle_dai, self.block, self.now);
        let p = self.price;
        self.report(p);
        r
    }

    /// DAI (18 dp) worth `units` LINK at the last reported price, rounded up.
    pub fn dai_for(&self, units: u128) -> u128 {
        base_to_units_ceil(units_to_base_ceil(units, self.price, 18), E8, 18)
    }

    /// Send every remaining settlement leg, a fresh reading before each (as the keeper does),
    /// moving the model's collateral. Returns what each payout received, in order.
    pub fn run_legs(&mut self, rid: u64) -> Vec<(EvmAddr, u128)> {
        let mut sent = vec![];
        while self.s.rescue(rid).unwrap().state == RescueState::Settling {
            let p = self.price;
            self.report(p);
            let s = self.s.rescue(rid).unwrap().settlement.clone().unwrap();
            let leg = s.legs.iter().find(|l| !l.done).unwrap().clone();
            let plan = self.s.settle_next(rid, gas(), self.now).unwrap();
            let u = match leg.amount {
                AmountArg::Exact(u) => u,
                AmountArg::Max => self.link,
            };
            self.link -= u;
            self.land(&plan);
            sent.push((leg.to, u));
        }
        sent
    }

    /// Send every queued payout on the model chain. Returns them in order.
    pub fn run_payouts(&mut self) -> Vec<Outflow> {
        let mut out = vec![];
        while let Some(o) = self.s.book(self.pid).outflows.first().cloned() {
            let plan = self.s.pay_next(self.pid, gas(), self.now).unwrap();
            match o.action {
                OutAction::Transfer(TokenSide::Collateral) => self.idle_link -= o.amount,
                OutAction::Transfer(TokenSide::Debt) => self.idle_dai -= o.amount,
                OutAction::Withdraw => self.link -= o.amount,
            }
            self.land(&plan);
            out.push(o);
        }
        out
    }
}
