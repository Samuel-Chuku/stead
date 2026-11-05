//! Minimal unsigned 256-bit integer for Aave's ray/wad math (no extra crates).
//! Little-endian u64 limbs. Overflow in add/mul panics: the inputs here are bounded
//! (ray × ray ≈ 1e54 ≪ 2^256), so an overflow means a bug or a hostile value.
use std::cmp::Ordering;
use std::fmt;

#[derive(Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct U256(pub [u64; 4]);

impl U256 {
    pub const ZERO: U256 = U256([0; 4]);
    pub const MAX: U256 = U256([u64::MAX; 4]);

    pub fn from_u128(v: u128) -> Self {
        U256([v as u64, (v >> 64) as u64, 0, 0])
    }
    pub fn pow10(n: u32) -> Self {
        let mut r = U256::from_u128(1);
        for _ in 0..n {
            r = r * U256::from_u128(10);
        }
        r
    }
    /// Big-endian bytes, up to 32 (shorter is left-padded).
    pub fn from_be_slice(b: &[u8]) -> Option<Self> {
        if b.len() > 32 {
            return None;
        }
        let mut buf = [0u8; 32];
        buf[32 - b.len()..].copy_from_slice(b);
        let mut l = [0u64; 4];
        for i in 0..4 {
            l[3 - i] = u64::from_be_bytes(buf[i * 8..i * 8 + 8].try_into().unwrap());
        }
        Some(U256(l))
    }
    pub fn to_be_bytes(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for i in 0..4 {
            out[i * 8..i * 8 + 8].copy_from_slice(&self.0[3 - i].to_be_bytes());
        }
        out
    }
    pub fn from_hex(s: &str) -> Option<Self> {
        let s = s.trim_start_matches("0x");
        let s = if s.len() % 2 == 1 { format!("0{s}") } else { s.to_string() };
        let b = hex::decode(s).ok()?;
        let b: Vec<u8> = b.iter().copied().skip_while(|x| *x == 0).collect();
        Self::from_be_slice(&b)
    }
    pub fn is_zero(&self) -> bool {
        self.0 == [0; 4]
    }
    pub fn bits(&self) -> u32 {
        for i in (0..4).rev() {
            if self.0[i] != 0 {
                return i as u32 * 64 + 64 - self.0[i].leading_zeros();
            }
        }
        0
    }
    pub fn bit(&self, i: u32) -> bool {
        (self.0[(i / 64) as usize] >> (i % 64)) & 1 == 1
    }
    pub fn low_u128(&self) -> u128 {
        self.0[0] as u128 | ((self.0[1] as u128) << 64)
    }
    pub fn high_u128(&self) -> u128 {
        self.0[2] as u128 | ((self.0[3] as u128) << 64)
    }
    pub fn to_u128(&self) -> Option<u128> {
        if self.0[2] == 0 && self.0[3] == 0 {
            Some(self.low_u128())
        } else {
            None
        }
    }
    pub fn shl(&self, n: u32) -> Self {
        let mut r = [0u64; 4];
        let (w, b) = ((n / 64) as usize, n % 64);
        for i in (0..4).rev() {
            if i >= w {
                let mut v = self.0[i - w] << b;
                if b > 0 && i - w > 0 {
                    v |= self.0[i - w - 1] >> (64 - b);
                }
                r[i] = v;
            }
        }
        U256(r)
    }
    pub fn shr(&self, n: u32) -> Self {
        let mut r = [0u64; 4];
        let (w, b) = ((n / 64) as usize, n % 64);
        for i in 0..4 {
            if i + w < 4 {
                let mut v = self.0[i + w] >> b;
                if b > 0 && i + w + 1 < 4 {
                    v |= self.0[i + w + 1] << (64 - b);
                }
                r[i] = v;
            }
        }
        U256(r)
    }
    /// Lowest `n` bits.
    pub fn mask(&self, n: u32) -> Self {
        if n >= 256 {
            return *self;
        }
        let mut r = *self;
        for i in 0..4u32 {
            let lo = i * 64;
            if lo >= n {
                r.0[i as usize] = 0;
            } else if lo + 64 > n {
                r.0[i as usize] &= (1u64 << (n - lo)) - 1;
            }
        }
        r
    }
    pub fn checked_add(&self, o: &Self) -> Option<Self> {
        let mut r = [0u64; 4];
        let mut c = 0u128;
        for i in 0..4 {
            let s = self.0[i] as u128 + o.0[i] as u128 + c;
            r[i] = s as u64;
            c = s >> 64;
        }
        (c == 0).then_some(U256(r))
    }
    pub fn checked_sub(&self, o: &Self) -> Option<Self> {
        if self < o {
            return None;
        }
        let mut r = [0u64; 4];
        let mut b = 0i128;
        for i in 0..4 {
            let d = self.0[i] as i128 - o.0[i] as i128 - b;
            if d < 0 {
                r[i] = (d + (1i128 << 64)) as u64;
                b = 1;
            } else {
                r[i] = d as u64;
                b = 0;
            }
        }
        Some(U256(r))
    }
    pub fn checked_mul(&self, o: &Self) -> Option<Self> {
        let mut r = [0u128; 8];
        for i in 0..4 {
            let mut c = 0u128;
            for j in 0..4 {
                let cur = r[i + j] + (self.0[i] as u128) * (o.0[j] as u128) + c;
                r[i + j] = cur & 0xffff_ffff_ffff_ffff;
                c = cur >> 64;
            }
            r[i + 4] += c;
        }
        if r[4..].iter().any(|x| *x != 0) {
            return None;
        }
        Some(U256([r[0] as u64, r[1] as u64, r[2] as u64, r[3] as u64]))
    }
    /// (quotient, remainder); panics on division by zero.
    pub fn div_rem(&self, d: &Self) -> (Self, Self) {
        assert!(!d.is_zero(), "division by zero");
        if self < d {
            return (U256::ZERO, *self);
        }
        let mut q = U256::ZERO;
        let mut r = U256::ZERO;
        for i in (0..self.bits()).rev() {
            r = r.shl(1);
            if self.bit(i) {
                r.0[0] |= 1;
            }
            if r >= *d {
                r = r.checked_sub(d).unwrap();
                q.0[(i / 64) as usize] |= 1 << (i % 64);
            }
        }
        (q, r)
    }
}

impl Ord for U256 {
    fn cmp(&self, o: &Self) -> Ordering {
        for i in (0..4).rev() {
            match self.0[i].cmp(&o.0[i]) {
                Ordering::Equal => continue,
                x => return x,
            }
        }
        Ordering::Equal
    }
}
impl PartialOrd for U256 {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl std::ops::Add for U256 {
    type Output = U256;
    fn add(self, o: U256) -> U256 {
        self.checked_add(&o).expect("u256 add overflow")
    }
}
impl std::ops::Sub for U256 {
    type Output = U256;
    fn sub(self, o: U256) -> U256 {
        self.checked_sub(&o).expect("u256 sub underflow")
    }
}
impl std::ops::Mul for U256 {
    type Output = U256;
    fn mul(self, o: U256) -> U256 {
        self.checked_mul(&o).expect("u256 mul overflow")
    }
}
impl std::ops::Div for U256 {
    type Output = U256;
    fn div(self, o: U256) -> U256 {
        self.div_rem(&o).0
    }
}
impl From<u128> for U256 {
    fn from(v: u128) -> Self {
        U256::from_u128(v)
    }
}
impl fmt::Display for U256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_zero() {
            return write!(f, "0");
        }
        let mut digits = vec![];
        let mut v = *self;
        let ten19 = U256::from_u128(10_000_000_000_000_000_000);
        while !v.is_zero() {
            let (q, r) = v.div_rem(&ten19);
            digits.push(r.low_u128() as u64);
            v = q;
        }
        write!(f, "{}", digits.last().unwrap())?;
        for d in digits.iter().rev().skip(1) {
            write!(f, "{d:019}")?;
        }
        Ok(())
    }
}
impl fmt::Debug for U256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self}")
    }
}
