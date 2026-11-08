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
    let (old, mpc): (SteadV5, String) = borsh::from_slice(&bytes).expect("decodes with the previous layout");
    let before = serde_json_count(&old);
    let removed = old.removed_stewards.clone();
    let watch = old.watch.clone();
    let claims = old.claims.clone();
    let new: Stead = old.into();
    assert_eq!(new.limits, Limits::default(), "limits start off");
    assert_eq!(new.removed_stewards, removed, "removed stewards carried over");
    assert_eq!(new.watch, watch, "watch carried over");
    assert_eq!(new.claims, claims, "claims carried over");
    let again = borsh::to_vec(&(&new, &mpc)).unwrap();
    let (back, mpc2): (Stead, String) = borsh::from_slice(&again).unwrap();
    assert_eq!(mpc2, mpc);
    assert_eq!(back.stewards, new.stewards);
    println!("ok: {before} · mpc {mpc} · {} bytes old → {} bytes new", bytes.len(), again.len());
}

fn serde_json_count(s: &SteadV5) -> String {
    format!("positions {} rescues {} claims {} stewards {:?}", s.positions.len(), s.rescues.len(), s.claims.len(), s.stewards)
}
