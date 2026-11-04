//! Stead core: every protocol rule, with no NEAR SDK dependency.
//!
//! The `#[near]` contract (`contract/src/lib.rs`) is a thin wrapper: it passes the caller,
//! the block time and attached deposits in, and turns the returned plans into MPC sign
//! requests and NEAR transfers. Keeping the rules here lets them run natively.

pub mod evm;
pub mod math;
pub mod state;

pub use evm::{Action, AmountArg, EvmAddr, GasArgs, TokenSide, TxFields};
pub use state::*;

/// Serialise numbers as JSON strings (u128 and ns timestamps don't fit a JS number).
pub mod as_str {
    use serde::{Deserialize, Deserializer, Serializer};
    use std::{fmt::Display, str::FromStr};

    pub fn serialize<T: Display, S: Serializer>(v: &T, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(v)
    }

    pub fn deserialize<'de, T, D>(d: D) -> Result<T, D::Error>
    where
        T: FromStr,
        T::Err: Display,
        D: Deserializer<'de>,
    {
        String::deserialize(d)?.parse().map_err(serde::de::Error::custom)
    }
}

/// Every rule failure is a `Refused` with a stable message; the wrapper panics with it.
pub type R<T> = Result<T, String>;

#[macro_export]
macro_rules! ensure {
    ($cond:expr, $($msg:tt)+) => {
        if !$cond {
            return Err(format!($($msg)+));
        }
    };
}
