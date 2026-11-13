//! Sweeping a position's leftover native ETH (gas money) to its payout. One test per rule; each
//! fails if its rule is broken.
mod common;
use common::*;

fn err<T: std::fmt::Debug>(r: Result<T, String>) -> String {
    r.expect_err("expected a refusal")
}

const ETH_CENT: u128 = 10_000_000_000_000_000; // 0.01 ETH in wei

fn sweep(amount: u128) -> Action {
    Action::SweepEth { amount }
}

// ── a tiny RLP decoder, independent of the encoder under test ──

#[derive(Debug, Clone, PartialEq)]
enum Rlp {
    Bytes(Vec<u8>),
    List(Vec<Rlp>),
}

impl Rlp {
    fn bytes(&self) -> &[u8] {
        match self {
            Rlp::Bytes(b) => b,
            Rlp::List(_) => panic!("expected a byte string"),
        }
    }
    fn list(&self) -> &[Rlp] {
        match self {
            Rlp::List(l) => l,
            Rlp::Bytes(_) => panic!("expected a list"),
        }
    }
    /// An RLP integer: no leading zero byte allowed (0 is the empty string).
    fn uint(&self) -> u128 {
        let b = self.bytes();
        assert!(b.first() != Some(&0), "integer with a leading zero byte: {b:?}");
        assert!(b.len() <= 16);
        b.iter().fold(0u128, |acc, x| (acc << 8) | *x as u128)
    }
}

fn be_len(b: &[u8]) -> usize {
    assert!(b.first() != Some(&0), "length with a leading zero");
    b.iter().fold(0usize, |acc, x| (acc << 8) | *x as usize)
}

/// Decode one item; returns it and the bytes consumed. Rejects non-canonical forms.
fn rlp_item(d: &[u8]) -> (Rlp, usize) {
    let p = d[0] as usize;
    match p {
        0x00..=0x7f => (Rlp::Bytes(vec![d[0]]), 1),
        0x80..=0xb7 => {
            let n = p - 0x80;
            if n == 1 {
                assert!(d[1] >= 0x80, "single byte below 0x80 must encode as itself");
            }
            (Rlp::Bytes(d[1..1 + n].to_vec()), 1 + n)
        }
        0xb8..=0xbf => {
            let ll = p - 0xb7;
            let n = be_len(&d[1..1 + ll]);
            assert!(n > 55);
            (Rlp::Bytes(d[1 + ll..1 + ll + n].to_vec()), 1 + ll + n)
        }
        0xc0..=0xf7 => {
            let n = p - 0xc0;
            (Rlp::List(rlp_list(&d[1..1 + n])), 1 + n)
        }
        _ => {
            let ll = p - 0xf7;
            let n = be_len(&d[1..1 + ll]);
            assert!(n > 55);
            (Rlp::List(rlp_list(&d[1 + ll..1 + ll + n])), 1 + ll + n)
        }
    }
}

fn rlp_list(mut d: &[u8]) -> Vec<Rlp> {
    let mut out = vec![];
    while !d.is_empty() {
        let (it, used) = rlp_item(d);
        out.push(it);
        d = &d[used..];
    }
    out
}

/// A typed EIP-1559 envelope: 0x02 ‖ rlp(list). Returns the list's items.
fn decode_1559(raw: &[u8]) -> Vec<Rlp> {
    assert_eq!(raw[0], 0x02, "EIP-1559 type byte");
    let (item, used) = rlp_item(&raw[1..]);
    assert_eq!(used, raw.len() - 1, "no trailing bytes");
    item.list().to_vec()
}

/// The unsigned bytes the MPC network signs (the keccak of these), as the wrapper builds them.
fn unsigned(plan: &SignPlan) -> Vec<u8> {
    plan.tx.to_evm(plan.value).build_for_signing()
}

// ── recipient ──

#[test]
fn sweep_eth_pays_only_the_registered_payout() {
    let mut f = F::new();
    let plan = f.sign_ok(sweep(ETH_CENT));
    assert_eq!(plan.tx.to, a(PAYOUT), "to = the registered payout");
    assert!(plan.tx.data.is_empty(), "a plain transfer: no calldata");
    assert_eq!(plan.value, ETH_CENT);
    assert_eq!(plan.tx.chain_id, 31337, "chain pinned to the market");

    // the request has no recipient field: an extra "to" in the JSON is ignored, never used
    let act: Action = serde_json::from_str(r#"{"type":"sweep_eth","amount":"5","to":"0x00000000000000000000000000000000000000e9"}"#).unwrap();
    assert_eq!(act, sweep(5));
    let plan = f.sign_ok(act);
    assert_eq!(plan.tx.to, a(PAYOUT));

    // after a (delayed) payout change, the sweep follows the new registered payout
    let new = a("0x00000000000000000000000000000000000000e1");
    f.s.request_payout_change(BORROWER, f.pid, new, f.now).unwrap();
    f.now += 24 * 3600 * SEC;
    f.s.apply_payout_change(f.pid, f.now).unwrap();
    let plan = f.sign_ok(sweep(1));
    assert_eq!(plan.tx.to, new);
    for addr in [a(POOL), a(LINK), a(DAI), a(A_LINK), a(POS_ADDR)] {
        assert_ne!(plan.tx.to, addr);
    }
}

#[test]
fn sweep_eth_refused_when_payout_is_a_market_contract() {
    for target in [POOL, LINK, DAI] {
        let mut f = F::new();
        let pid = f.s.register_position("bob.testnet", 0, a(target)).unwrap();
        f.s.set_position_address(pid, a("0x00000000000000000000000000000000000000a2")).unwrap();
        let e = err(f.s.sign_action("bob.testnet", pid, sweep(1), gas(), f.now));
        assert!(e.contains("market contract"), "{target}: {e}");
        assert!(f.s.position(pid).unwrap().pending.is_none(), "a refusal changes nothing");
    }
}

// ── the same locks as withdraw / transfer ──

#[test]
fn sweep_eth_refused_while_claim_open() {
    let mut f = F::new();
    let rid = f.report(2_850_000_000).unwrap();
    let check = |f: &mut F, stage: &str| {
        let e = err(f.s.sign_action(BORROWER, f.pid, sweep(1), gas(), f.now));
        assert!(e.starts_with("claim open"), "{stage}: {e}");
    };
    check(&mut f, "auction");
    f.s.bid(STEWARDS[0], rid, 300, f.s.rescue(rid).unwrap().topup_units, BOND, f.now).unwrap();
    f.tick(46);
    f.s.close_auction(rid, f.now).unwrap();
    check(&mut f, "top-up pending");
    let t = f.s.rescue(rid).unwrap().topup_units;
    f.link += t;
    f.s.confirm_topup(REPORTER, rid, STEWARDS[0], t, "0xt", f.block + 1, f.now).unwrap();
    check(&mut f, "claim open");
    // the buy-back is paid and committed: its payout is queued, so still refused
    f.pay_escrow(0, 2000 * E18).unwrap();
    let e = err(f.s.sign_action(BORROWER, f.pid, sweep(1), gas(), f.now));
    assert!(e.contains("pay_next"), "queued payouts: {e}");
    f.run_payouts();
    // every claim closed and the held balance refunded: allowed again
    let plan = f.sign_ok(sweep(1));
    assert_eq!(plan.tx.to, a(PAYOUT));
}

#[test]
fn sweep_eth_refused_while_held_balance_is_refunded() {
    let mut f = F::new();
    f.rescue_with(&[(0, 300, None)]);
    f.pay_escrow(0, 10 * E18).unwrap();
    // a path that closed the rescue without refunding (the state this lock guards against)
    let rid = *f.s.position(f.pid).unwrap().open_rescues.first().unwrap();
    f.s.positions.get_mut(&f.pid).unwrap().open_rescues.retain(|x| *x != rid);
    for c in f.s.claims.values_mut() {
        c.status = ClaimStatus::Settled;
    }
    assert!(err(f.s.sign_action(BORROWER, f.pid, sweep(1), gas(), f.now)).contains("being refunded"));
    f.report(f.price);
    f.run_payouts();
    f.sign_ok(sweep(1));
}

#[test]
fn sweep_eth_refused_while_paused_or_a_tx_is_in_flight() {
    let mut f = F::new();
    f.s.set_paused(OWNER, true).unwrap();
    assert!(err(f.s.sign_action(BORROWER, f.pid, sweep(1), gas(), f.now)).contains("paused"));
    f.s.set_paused(OWNER, false).unwrap();
    let p = f.s.sign_action(BORROWER, f.pid, sweep(1), gas(), f.now).unwrap();
    assert!(err(f.s.sign_action(BORROWER, f.pid, sweep(1), gas(), f.now)).contains("tx in flight"));
    f.land(&p);
    let p2 = f.sign_ok(sweep(1));
    assert_eq!(p2.tx.nonce, p.tx.nonce + 1, "one nonce at a time");
}

// ── who, how much, gas ──

#[test]
fn sweep_eth_owner_only() {
    let mut f = F::new();
    for c in ["mallory.testnet", REPORTER, OWNER, STEWARDS[0]] {
        assert!(err(f.s.sign_action(c, f.pid, sweep(1), gas(), f.now)).contains("only the position owner"), "{c}");
    }
    assert!(f.s.position(f.pid).unwrap().pending.is_none());
}

#[test]
fn sweep_eth_zero_refused_and_gas_capped() {
    let mut f = F::new();
    assert!(err(f.s.sign_action(BORROWER, f.pid, sweep(0), gas(), f.now)).contains("zero amount"));
    let mut g = gas();
    g.gas_limit = TRANSFER_GAS - 1;
    assert!(err(f.s.sign_action(BORROWER, f.pid, sweep(1), g, f.now)).contains("gas_limit"), "below a plain transfer");
    g.gas_limit = market().gas_limit_cap + 1;
    assert!(err(f.s.sign_action(BORROWER, f.pid, sweep(1), g, f.now)).contains("gas_limit"), "above the market cap");
    let mut g = gas();
    g.max_fee_per_gas = market().max_fee_cap + 1;
    assert!(err(f.s.sign_action(BORROWER, f.pid, sweep(1), g, f.now)).contains("above cap"));
    // exactly a plain transfer, and the market cap (a contract-wallet payout), both accepted
    for limit in [TRANSFER_GAS, market().gas_limit_cap] {
        let g = GasArgs { gas_limit: limit, ..gas() };
        let p = f.s.sign_action(BORROWER, f.pid, sweep(1), g, f.now).unwrap();
        assert_eq!(p.tx.gas.gas_limit, limit);
        f.land(&p);
    }
}

// ── encoding ──

/// The unsigned EIP-1559 tx for a 0.01 ETH sweep at nonce 0 on chain 31337 (gas 300,000, max fee
/// 20 gwei, priority 1 gwei) to the fixture payout. The same bytes are rebuilt with viem in the
/// stewards' tests, so the encoding is checked by an independent implementation.
pub const SWEEP_UNSIGNED_HEX: &str = "02f2827a6980843b9aca008504a817c800830493e09400000000000000000000000000000000000000b0872386f26fc1000080c0";
/// The same tx signed with v = 1, r = 0x00‖0x7b×31 (a leading zero, trimmed), s = 0x15×32.
pub const SWEEP_SIGNED_HEX: &str = "02f874827a6980843b9aca008504a817c800830493e09400000000000000000000000000000000000000b0872386f26fc1000080c0019f7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7ba01515151515151515151515151515151515151515151515151515151515151515";

#[test]
fn sweep_eth_tx_vector_decodes() {
    let mut f = F::new();
    let plan = f.s.sign_action(BORROWER, f.pid, sweep(ETH_CENT), gas(), f.now).unwrap();
    let raw = unsigned(&plan);
    let it = decode_1559(&raw);
    assert_eq!(it.len(), 9, "chainId nonce maxPriority maxFee gas to value data accessList");
    assert_eq!(it[0].uint(), 31337, "chainId");
    assert_eq!(it[1].uint(), 0, "nonce");
    assert_eq!(it[2].uint(), 1_000_000_000, "max priority fee");
    assert_eq!(it[3].uint(), 20_000_000_000, "max fee");
    assert_eq!(it[4].uint(), 300_000, "gas limit");
    assert_eq!(it[5].bytes(), &a(PAYOUT).0, "to = payout");
    assert_eq!(it[6].uint(), ETH_CENT, "value");
    assert_eq!(it[7].bytes(), &[] as &[u8], "no calldata");
    assert!(it[8].list().is_empty(), "no access list");
    assert_eq!(hex::encode(&raw), SWEEP_UNSIGNED_HEX);

    // the wrapper builds the hash from the plan, and the signed tx from the stored pending tx:
    // both must carry the same value
    let pending = f.s.position(f.pid).unwrap().pending.clone().unwrap();
    assert_eq!(pending.kind, TxKind::SweepEth { value: ETH_CENT });
    assert_eq!(pending.kind.value(), plan.value);
    assert_eq!(pending.tx, plan.tx);
    let mut r = vec![0u8; 32];
    r[1..].copy_from_slice(&[0x7b; 31]);
    let s = vec![0x15; 32];
    let signed = signed_raw(&pending.tx, pending.kind.value(), 1, &r, &s);
    let st = decode_1559(&signed);
    assert_eq!(st.len(), 12);
    assert_eq!(&st[..9], &it[..], "the signed tx carries exactly the fields that were signed");
    assert_eq!(st[9].uint(), 1, "v");
    assert_eq!(st[10].bytes(), &[0x7b; 31], "r minimal");
    assert_eq!(st[11].bytes(), &[0x15; 32]);
    assert_eq!(hex::encode(&signed), SWEEP_SIGNED_HEX);

    // the value is a minimal integer whatever its size
    for (v, enc) in [(1u128, vec![0x01u8]), (0x80, vec![0x81, 0x80]), (0x0100, vec![0x82, 0x01, 0x00]), (u128::MAX, [vec![0x90], vec![0xff; 16]].concat())] {
        let b = plan.tx.to_evm(v).build_for_signing();
        let it = decode_1559(&b);
        assert_eq!(it[6].uint(), v);
        let at = b.windows(enc.len()).position(|w| w == enc.as_slice());
        assert!(at.is_some(), "{v:#x} encodes as {enc:02x?}");
    }
}

// ── nonce flow ──

#[test]
fn sweep_eth_burnable_and_replacement_keeps_value() {
    let mut f = F::new();
    let p = f.s.sign_action(BORROWER, f.pid, sweep(ETH_CENT), gas(), f.now).unwrap();
    f.s.on_signed(f.pid, p.tx.nonce, Some(vec![1])).unwrap();
    // a fee bump: owner only, same nonce, recipient, calldata and value
    let g = p.tx.gas;
    assert!(err(f.s.replace_pending("mallory.testnet", f.pid, g.max_fee_per_gas * 2, g.max_priority_fee_per_gas * 2)).contains("owner"));
    let r = f.s.replace_pending(BORROWER, f.pid, g.max_fee_per_gas * 2, g.max_priority_fee_per_gas * 2).unwrap();
    assert_eq!((r.tx.nonce, r.tx.to, r.tx.data.clone(), r.value), (p.tx.nonce, p.tx.to, p.tx.data.clone(), ETH_CENT));
    assert_eq!(f.s.position(f.pid).unwrap().pending.as_ref().unwrap().kind.value(), ETH_CENT);
    f.s.on_signed(f.pid, p.tx.nonce, Some(vec![2])).unwrap();
    // the sweep can't be mined (amount + fee > balance): after the timeout anyone burns the nonce
    assert!(err(f.s.burn_nonce("anyone.testnet", f.pid, gas(), f.now)).contains("too early"));
    f.tick(601);
    let burn = f.s.burn_nonce("anyone.testnet", f.pid, gas(), f.now).unwrap();
    assert_eq!(burn.tx.nonce, p.tx.nonce, "same nonce");
    assert_eq!(burn.tx.to, a(POS_ADDR), "self-transfer");
    assert_eq!(burn.value, 0, "the burn carries no value");
    assert!(burn.tx.data.is_empty());
    assert_eq!(f.s.position(f.pid).unwrap().pending.as_ref().unwrap().kind, TxKind::NonceBurn);
    f.land(&burn);
    // the nonce is cleared: a corrected sweep goes out at the next nonce
    let again = f.sign_ok(sweep(ETH_CENT / 2));
    assert_eq!(again.tx.nonce, p.tx.nonce + 1);
}

// ── the invariant's books never see ETH ──

#[test]
fn sweep_eth_changes_no_rescue_books() {
    let mut f = F::new();
    // a full rescue and buy-back first, so the books are not empty
    f.rescue_with(&[(0, 300, None)]);
    let cl = f.s.claims.values().next().unwrap().clone();
    f.pay_escrow(cl.owed_units, 0).unwrap();
    f.run_payouts();
    f.report(f.price);
    let snap = |f: &F| {
        let p = f.s.position(f.pid).unwrap();
        (
            // every book except the event-ordering block (any landed tx moves it)
            {
                let b = f.s.book(f.pid);
                serde_json::to_string(&(b.escrow, b.outflows, b.stray_repays)).unwrap()
            },
            serde_json::to_string(&f.s.claims).unwrap(),
            serde_json::to_string(&f.s.rescues).unwrap(),
            (p.premium_cap_base, p.premium_used_base, p.open_rescues.clone(), p.active_auction, p.payout),
        )
    };
    let before = snap(&f);
    let plan = f.sign_ok(sweep(ETH_CENT));
    assert_eq!(plan.value, ETH_CENT);
    assert_eq!(snap(&f), before, "escrow, payouts, claims, rescues and premium caps untouched");
}

// ── storage layout ──

/// Stored pending txs keep their borsh encoding: the new kinds are appended last.
#[test]
fn tx_kind_borsh_indices_are_stable() {
    let idx = |k: TxKind| borsh::to_vec(&k).unwrap()[0];
    assert_eq!(idx(TxKind::Borrower { action: "x".into() }), 0);
    assert_eq!(idx(TxKind::NonceBurn), 1);
    assert_eq!(idx(TxKind::Settlement { rescue_id: 0, leg: 0 }), 2);
    assert_eq!(idx(TxKind::Outflow), 3);
    assert_eq!(borsh::to_vec(&TxKind::SweepEth { value: 7 }).unwrap(), [vec![4u8], 7u128.to_le_bytes().to_vec()].concat());
    let aidx = |x: Action| borsh::to_vec(&x).unwrap()[0];
    assert_eq!(aidx(Action::Approve { token: TokenSide::Collateral, amount: AmountArg::Max }), 0);
    assert_eq!(aidx(Action::TransferDebt { amount: 1 }), 5);
    assert_eq!(aidx(sweep(1)), 6);
    // JSON shapes the keeper and the pages read
    assert_eq!(serde_json::to_value(TxKind::SweepEth { value: 7 }).unwrap(), serde_json::json!({"type": "sweep_eth", "value": "7"}));
    assert_eq!(serde_json::to_value(sweep(7)).unwrap(), serde_json::json!({"type": "sweep_eth", "amount": "7"}));
}
