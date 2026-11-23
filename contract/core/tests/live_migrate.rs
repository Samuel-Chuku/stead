//! Dry-run of the deployed contract's migration: decode a downloaded state blob (STEAD_STATE_FILE)
//! with the previous layout, convert it, and check nothing was lost. Skipped without the file.
use stead_core::*;

#[test]
fn live_state_migrates() {
    let Ok(path) = std::env::var("STEAD_STATE_FILE") else {
        println!("skipped: set STEAD_STATE_FILE to a downloaded contract state to dry-run the migration");
        return;
    };
    let bytes = std::fs::read(path).unwrap();
    let (old, mpc): (SteadV6, String) = borsh::from_slice(&bytes).expect("decodes with the previous layout");
    let before = serde_json_count(&old);
    let removed = old.removed_stewards.clone();
    let watch = old.watch.clone();
    let claims = old.claims.clone();
    let new: Stead = old.into();
    assert!(new.market_ext.is_empty() && new.homes.is_empty(), "multi-chain settings start empty");
    assert_eq!(new.removed_stewards, removed, "removed stewards carried over");
    assert_eq!(new.watch, watch, "watch carried over");
    assert_eq!(new.claims, claims, "claims carried over");
    let again = borsh::to_vec(&(&new, &mpc)).unwrap();
    let (back, mpc2): (Stead, String) = borsh::from_slice(&again).unwrap();
    assert_eq!(mpc2, mpc);
    assert_eq!(back.stewards, new.stewards);
    println!("ok: {before} · mpc {mpc} · {} bytes old → {} bytes new", bytes.len(), again.len());
}

fn serde_json_count(s: &SteadV6) -> String {
    format!("positions {} rescues {} claims {} stewards {:?}", s.positions.len(), s.rescues.len(), s.claims.len(), s.stewards)
}

/// A code-only upgrade must read the deployed state as it is: decode a downloaded state blob
/// (STEAD_LIVE_STATE) with this code's layout and write it back byte for byte. Skipped without the file.
#[test]
fn live_state_decodes_with_this_code() {
    let Ok(path) = std::env::var("STEAD_LIVE_STATE") else {
        println!("skipped: set STEAD_LIVE_STATE to a downloaded contract state to check a code-only upgrade");
        return;
    };
    let bytes = std::fs::read(path).unwrap();
    let (s, mpc): (Stead, String) = borsh::from_slice(&bytes).expect("decodes with this code's layout, no trailing bytes");
    assert_eq!(borsh::to_vec(&(&s, &mpc)).unwrap(), bytes, "re-encodes to the same bytes");
    let pending = s.positions.values().filter(|p| p.pending.is_some()).count();
    println!("ok: positions {} ({pending} with a pending tx) rescues {} claims {} · mpc {mpc} · {} bytes", s.positions.len(), s.rescues.len(), s.claims.len(), bytes.len());
}
