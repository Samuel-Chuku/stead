//! Fixed-point maths. Amounts in Aave base currency (USD, 8 decimals) are called `base`.
//! Health factors are WAD (1e18), as Aave reports them. Ratios are bps (1e4).
//! Rounding always favours the borrower (the invariant): top-ups and repayments round up,
//! premiums and collateral paid out round down.

pub const BPS: u128 = 10_000;
pub const WAD: u128 = 1_000_000_000_000_000_000;

fn pow10(d: u8) -> u128 {
    10u128.pow(d as u32)
}

fn ceil_div(a: u128, b: u128) -> u128 {
    a / b + u128::from(a % b != 0)
}

/// Floor(a · b / c) with a 256-bit intermediate (two 18-decimal amounts overflow u128).
/// Panics if c = 0 or the result exceeds u128 (never when b ≤ c, the pro-rata case).
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    assert!(c > 0, "mul_div by zero");
    const M: u128 = u64::MAX as u128;
    let (a1, a0, b1, b0) = (a >> 64, a & M, b >> 64, b & M);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & M) + (p10 & M);
    let lo = (p00 & M) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    assert!(hi < c, "mul_div overflow");
    // Long division of (hi, lo) by c, bit by bit; r < c throughout
    let (mut r, mut q) = (hi, 0u128);
    for i in (0..128).rev() {
        let carry = r >> 127;
        r = (r << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || r >= c {
            r = r.wrapping_sub(c);
            q |= 1;
        }
    }
    q
}

/// Aave HF = C · LT / D (WAD). No debt → u128::MAX.
pub fn hf_wad(collateral_base: u128, debt_base: u128, lt_bps: u128) -> u128 {
    if debt_base == 0 {
        return u128::MAX;
    }
    collateral_base * lt_bps * (WAD / BPS) / debt_base
}

/// Is `hf_wad` below a bps threshold (e.g. 11_500 for 1.15)?
pub fn hf_below(hf_wad: u128, threshold_bps: u128) -> bool {
    hf_wad < threshold_bps * (WAD / BPS)
}

/// Collateral (base) that takes the position to `target_bps`: ceil(target · D / LT) − C.
pub fn topup_base(collateral_base: u128, debt_base: u128, lt_bps: u128, target_bps: u128) -> u128 {
    ceil_div(target_bps * debt_base, lt_bps).saturating_sub(collateral_base)
}

pub fn base_to_units_floor(base: u128, price_base: u128, decimals: u8) -> u128 {
    base * pow10(decimals) / price_base
}

pub fn base_to_units_ceil(base: u128, price_base: u128, decimals: u8) -> u128 {
    ceil_div(base * pow10(decimals), price_base)
}

pub fn units_to_base(units: u128, price_base: u128, decimals: u8) -> u128 {
    units * price_base / pow10(decimals)
}

pub fn units_to_base_ceil(units: u128, price_base: u128, decimals: u8) -> u128 {
    ceil_div(units * price_base, pow10(decimals))
}

/// The conservative Aave-liquidation baseline every premium is capped by:
/// Liquidation bonus × 50 % close × debt. The real cost can be up to 2× this (100 % close
/// at HF ≤ 0.95, or under $2,000 on Aave v3.3+); capping at the lower figure is the safe side.
pub fn premium_cap_base(debt_base: u128, liq_bonus_bps: u128) -> u128 {
    debt_base * liq_bonus_bps / BPS / 2
}

/// The premium in units of the supplied asset, fixed when the auction closes (rounds down).
pub fn premium_units(share_units: u128, premium_bps: u128) -> u128 {
    share_units * premium_bps / BPS
}

/// Settlement B repayment: R = (h·D − LT·(C − O)) / (h − LT), clamped to [0, D].
/// Returns (R, full_close). Rounds R up so the post-settlement HF is ≥ target.
pub fn settlement_repay_base(c: u128, d: u128, owed: u128, lt_bps: u128, target_bps: u128) -> (u128, bool) {
    assert!(target_bps > lt_bps, "target_hf must exceed LT");
    if c <= owed {
        return (d, true);
    }
    let lhs = target_bps * d;
    let rhs = lt_bps * (c - owed);
    if lhs <= rhs {
        return (0, false);
    }
    let r = ceil_div(lhs - rhs, target_bps - lt_bps);
    if r >= d {
        (d, true)
    } else {
        (r, false)
    }
}
