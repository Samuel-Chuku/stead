//! The multi-chain markets: native ETH through Aave's gateway, the per-market settings, home
//! addresses and the state migration. One test per rule; each fails if its rule is broken.
mod common;
use common::*;

fn err<T: std::fmt::Debug>(r: Result<T, String>) -> String {
    r.expect_err("expected a refusal")
}

const GATEWAY: &str = "0x0568130e794429d2eebc4dafe18f25ff1a1ed8b6";
const A_WETH: &str = "0x73a5bb60b0b0fc35710ddc0ea9c407031e31bdbb";
const ETH: u128 = E18;

fn ext() -> MarketExt {
    MarketExt { gateway: Some(a(GATEWAY)), a_collateral: Some(a(A_WETH)), l1_fee_cap: 0 }
}

/// The fixture on the wrapped-native market, with the gateway configured.
fn gw() -> F {
    let mut f = F::with_market(weth_market());
    f.s.set_market_ext(OWNER, 0, ext()).unwrap();
    f
}

fn sign(f: &mut F, action: Action) -> Result<SignPlan, String> {
    f.s.sign_action(BORROWER, f.pid, action, gas(), f.now)
}

fn word_u128(data: &[u8], i: usize) -> u128 {
    u128::from_be_bytes(data[4 + 32 * i + 16..4 + 32 * (i + 1)].try_into().unwrap())
}

// ── depositETH ──

#[test]
fn deposit_eth_calls_the_gateway_for_the_position_and_carries_exactly_the_amount() {
    let mut f = gw();
    let plan = f.sign_ok(Action::DepositEth { amount: 2 * ETH });
    assert_eq!(plan.tx.to, a(GATEWAY), "only the market's gateway");
    assert_eq!(plan.tx.selector().unwrap(), SEL_DEPOSIT_ETH);
    assert_eq!(arg_addr(&plan.tx.data, 0), a(POOL), "into this market's pool");
    assert_eq!(arg_addr(&plan.tx.data, 1), a(POS_ADDR), "onBehalfOf = the position");
    assert_eq!(word_u128(&plan.tx.data, 2), 0, "referral code 0");
    assert_eq!(plan.tx.data.len(), 4 + 3 * 32);
    assert_eq!(plan.value, 2 * ETH, "the tx carries exactly the supplied ETH");
    assert_eq!(plan.tx.chain_id, 31337, "chain pinned to the market");
}

#[test]
fn every_gateway_action_is_refused_on_a_market_without_a_gateway() {
    let mut f = F::with_market(weth_market());
    for act in [Action::DepositEth { amount: ETH }, Action::ApproveGateway { amount: ETH }, Action::WithdrawEth { amount: ETH }] {
        assert!(err(sign(&mut f, act.clone())).contains("no ETH gateway"), "{act:?}");
    }
}

#[test]
fn deposit_eth_respects_the_size_cap_like_supply() {
    let mut f = gw();
    f.dai = 100 * E18;
    f.report(5 * E8); // 100 WETH units at $5 = $500 of collateral
    f.s.set_limits(OWNER, Limits { max_collateral_base: 600 * E8, borrowers: Default::default() }).unwrap();
    assert!(err(sign(&mut f, Action::DepositEth { amount: 30 * ETH })).contains("size cap"), "+$150 would pass $600");
    f.sign_ok(Action::DepositEth { amount: 10 * ETH });
}

#[test]
fn deposit_eth_with_zero_is_refused() {
    let mut f = gw();
    assert!(err(sign(&mut f, Action::DepositEth { amount: 0 })).contains("zero amount"));
}

// ── approve to the gateway ──

#[test]
fn the_only_atoken_approval_is_of_the_exact_amount_to_the_markets_gateway() {
    let mut f = gw();
    let plan = f.sign_ok(Action::ApproveGateway { amount: 3 * ETH });
    assert_eq!(plan.tx.to, a(A_WETH), "the collateral's aToken");
    assert_eq!(plan.tx.selector().unwrap(), SEL_APPROVE);
    assert_eq!(arg_addr(&plan.tx.data, 0), a(GATEWAY), "spender = the gateway, nothing else");
    assert_eq!(plan.tx.data[4 + 32..4 + 48], [0u8; 16], "not an unlimited approval");
    assert_eq!(word_u128(&plan.tx.data, 1), 3 * ETH, "exactly the amount");
    assert_eq!(plan.value, 0);
    assert!(err(sign(&mut f, Action::ApproveGateway { amount: 0 })).contains("zero amount"));
}

// ── withdrawETH ──

#[test]
fn withdraw_eth_pays_the_payout_exactly_the_amount_approved_just_before() {
    let mut f = gw();
    f.sign_ok(Action::ApproveGateway { amount: 3 * ETH });
    let plan = f.sign_ok(Action::WithdrawEth { amount: 3 * ETH });
    assert_eq!(plan.tx.to, a(GATEWAY));
    assert_eq!(plan.tx.selector().unwrap(), SEL_WITHDRAW_ETH);
    assert_eq!(arg_addr(&plan.tx.data, 0), a(POOL));
    assert_eq!(word_u128(&plan.tx.data, 1), 3 * ETH);
    assert_eq!(arg_addr(&plan.tx.data, 2), a(PAYOUT), "to = the payout, never another address");
    assert_eq!(plan.value, 0);
}

#[test]
fn withdraw_eth_without_a_matching_approval_just_before_is_refused() {
    let mut f = gw();
    // no approval at all
    assert!(err(sign(&mut f, Action::WithdrawEth { amount: ETH })).contains("exactly the amount approved"));
    // a different amount
    f.sign_ok(Action::ApproveGateway { amount: 3 * ETH });
    assert!(err(sign(&mut f, Action::WithdrawEth { amount: 2 * ETH })).contains("exactly the amount approved"));
    assert!(err(sign(&mut f, Action::WithdrawEth { amount: 4 * ETH })).contains("exactly the amount approved"));
    // another action in between clears it
    f.sign_ok(Action::TransferDebt { amount: 1 });
    assert!(err(sign(&mut f, Action::WithdrawEth { amount: 3 * ETH })).contains("exactly the amount approved"));
    // one approval, one withdrawal
    f.sign_ok(Action::ApproveGateway { amount: 3 * ETH });
    f.sign_ok(Action::WithdrawEth { amount: 3 * ETH });
    assert!(err(sign(&mut f, Action::WithdrawEth { amount: 3 * ETH })).contains("exactly the amount approved"));
}

#[test]
fn approving_and_withdrawing_eth_are_refused_while_a_claim_is_open_but_depositing_is_not() {
    let mut f = gw();
    f.rescue_with(&[(2, 150, None)]);
    assert!(f.s.position(f.pid).unwrap().locked());
    assert!(err(sign(&mut f, Action::ApproveGateway { amount: ETH })).contains("claim open"));
    assert!(err(sign(&mut f, Action::WithdrawEth { amount: ETH })).contains("claim open"));
    // adding collateral stays open to the borrower, like supply
    f.sign_ok(Action::DepositEth { amount: ETH });
}

#[test]
fn an_approval_made_before_a_claim_opened_cannot_be_used_while_it_is_open() {
    let mut f = gw();
    f.sign_ok(Action::ApproveGateway { amount: ETH });
    f.rescue_with(&[(2, 150, None)]);
    assert!(err(sign(&mut f, Action::WithdrawEth { amount: ETH })).contains("claim open"));
}

#[test]
fn withdraw_eth_is_refused_when_the_payout_is_a_market_contract() {
    let mut f = gw();
    for bad in [GATEWAY, A_WETH, WETH, POOL, DAI] {
        let pid = f.s.register_position(BORROWER, 0, a(bad)).unwrap();
        f.s.set_position_address(pid, a("0x00000000000000000000000000000000000000a9")).unwrap();
        let p = f.s.sign_action(BORROWER, pid, Action::ApproveGateway { amount: ETH }, gas(), f.now).unwrap();
        f.land(&p);
        let e = err(f.s.sign_action(BORROWER, pid, Action::WithdrawEth { amount: ETH }, gas(), f.now));
        assert!(e.contains("market contract"), "{bad}: {e}");
    }
}

#[test]
fn gateway_actions_are_the_position_owners_only() {
    let mut f = gw();
    for act in [Action::DepositEth { amount: ETH }, Action::ApproveGateway { amount: ETH }, Action::WithdrawEth { amount: ETH }] {
        assert!(err(f.s.sign_action(STEWARDS[0], f.pid, act, gas(), f.now)).contains("only the position owner"));
    }
}

// ── the per-market settings ──

#[test]
fn only_the_owner_sets_a_markets_gateway_and_l1_fee_cap() {
    let mut f = F::with_market(weth_market());
    assert!(err(f.s.set_market_ext(BORROWER, 0, ext())).contains("owner"));
    assert!(err(f.s.set_market_ext(OWNER, 7, ext())).contains("no such market"));
    f.s.set_market_ext(OWNER, 0, ext()).unwrap();
    assert_eq!(f.s.market_ext_of(0), ext());
}

#[test]
fn a_gateway_needs_wrapped_native_collateral_on_the_markets_own_chain() {
    let mut f = F::new(); // LINK collateral
    assert!(err(f.s.set_market_ext(OWNER, 0, ext())).contains("wrapped-native"));
    // WETH's Ethereum address on a Base market is not Base's WETH
    let mut s = Stead::new(OWNER, REPORTER);
    s.add_market(OWNER, Market { chain_id: 84532, ..weth_market() }).unwrap();
    assert!(err(s.set_market_ext(OWNER, 0, ext())).contains("wrapped-native"));
    // Base Sepolia's own WETH is accepted
    s.add_market(OWNER, Market { chain_id: 84532, collateral: a("0x4200000000000000000000000000000000000006"), ..weth_market() }).unwrap();
    s.set_market_ext(OWNER, 1, ext()).unwrap();
}

#[test]
fn a_gateway_and_its_atoken_are_set_together_and_are_their_own_contracts() {
    let mut f = F::with_market(weth_market());
    assert!(err(f.s.set_market_ext(OWNER, 0, MarketExt { a_collateral: None, ..ext() })).contains("together"));
    assert!(err(f.s.set_market_ext(OWNER, 0, MarketExt { gateway: None, ..ext() })).contains("together"));
    for bad in [POOL, WETH, DAI] {
        assert!(err(f.s.set_market_ext(OWNER, 0, MarketExt { gateway: Some(a(bad)), ..ext() })).contains("own contracts"), "gateway {bad}");
        assert!(err(f.s.set_market_ext(OWNER, 0, MarketExt { a_collateral: Some(a(bad)), ..ext() })).contains("own contracts"), "aToken {bad}");
    }
    assert!(err(f.s.set_market_ext(OWNER, 0, MarketExt { a_collateral: Some(a(GATEWAY)), ..ext() })).contains("own contracts"));
    assert!(err(f.s.set_market_ext(OWNER, 0, MarketExt { gateway: Some(EvmAddr::default()), ..ext() })).contains("zero"));
}

#[test]
fn the_l1_fee_cap_is_bounded() {
    let mut f = F::new(); // an L1 fee cap alone needs no gateway
    f.s.set_market_ext(OWNER, 0, MarketExt { l1_fee_cap: MAX_L1_FEE_CAP_WEI, ..Default::default() }).unwrap();
    assert!(err(f.s.set_market_ext(OWNER, 0, MarketExt { l1_fee_cap: MAX_L1_FEE_CAP_WEI + 1, ..Default::default() })).contains("l1_fee_cap"));
}

#[test]
fn the_new_chains_wrapped_native_tokens_are_the_ones_in_aaves_address_book() {
    let w = |chain: u64| WRAPPED_NATIVE.iter().find(|(c, _)| *c == chain).map(|(_, a)| a.to_lowercase());
    assert_eq!(w(8453).as_deref(), Some("0x4200000000000000000000000000000000000006"));
    assert_eq!(w(10).as_deref(), Some("0x4200000000000000000000000000000000000006"));
    assert_eq!(w(84532).as_deref(), Some("0x4200000000000000000000000000000000000006"));
    assert_eq!(w(42161).as_deref(), Some("0x82af49447d8a07e3bd95bd0d56f35241523fbab1"));
}

// ── home addresses ──

#[test]
fn a_home_address_is_recorded_per_account_and_never_zero() {
    let mut s = Stead::new(OWNER, REPORTER);
    let h = a("0x00000000000000000000000000000000000000d1");
    assert_eq!(s.home_of(BORROWER), None);
    s.set_home(BORROWER, h).unwrap();
    assert_eq!(s.home_of(BORROWER), Some(h));
    assert_eq!(s.home_of(STEWARDS[0]), None, "one account's home is not another's");
    assert!(err(s.set_home(STEWARDS[0], EvmAddr::default())).contains("zero"));
    assert_eq!(HOME_PATH, "stead-home", "the path is part of every home address: never change it");
}

// ── migration ──

#[test]
fn the_deployed_layout_migrates_with_nothing_lost_and_the_new_settings_empty() {
    // the previous layout is today's minus the three new maps at the end (each an empty map: 4 zero bytes)
    let mut f = F::with_market(weth_market());
    f.rescue_with(&[(2, 150, None)]);
    f.s.set_limits(OWNER, Limits { max_collateral_base: 700 * E8, borrowers: [BORROWER.to_string()].into() }).unwrap();
    let now = borsh::to_vec(&f.s).unwrap();
    let old_bytes = &now[..now.len() - 12];
    let old: SteadV6 = borsh::from_slice(old_bytes).expect("the previous layout decodes");
    let new: Stead = old.into();
    assert_eq!(new.limits, f.s.limits, "limits carried over");
    assert_eq!(new.positions, f.s.positions);
    assert_eq!(new.rescues, f.s.rescues);
    assert_eq!(new.claims, f.s.claims);
    assert!(new.market_ext.is_empty() && new.homes.is_empty() && new.gateway_allowance.is_empty());
    assert_eq!(borsh::to_vec(&new).unwrap(), now, "and re-encodes to today's layout");
}
