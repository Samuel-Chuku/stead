//! OutLayer entry point: reads `{"position": "0x…", "block": null}` on stdin, prints the verified
//! result (≤ 900 bytes of JSON) on stdout. RPC set: six public Sepolia voters plus an optional
//! keyed one from the `SEPOLIA_RPC_URL` secret (never printed).
fn main() {
    let mut s = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).expect("stdin");
    let input: stead_verifier::Input = match serde_json::from_str(&s) {
        Ok(i) => i,
        Err(e) => return println!("{{\"err\":\"bad input: {e}\"}}"),
    };
    let mut cfg = stead_verifier::sepolia_config();
    if let Ok(k) = std::env::var("SEPOLIA_RPC_URL") {
        if !k.is_empty() {
            // first: it gives the head and the first proof; it votes like any other
            cfg.header_rpcs.insert(0, k.clone());
            cfg.proof_rpcs.insert(0, k.clone());
            cfg.keyed = Some(k);
        }
    }
    #[cfg(target_os = "wasi")]
    let rpc = stead_verifier::wasi::WasiRpc;
    #[cfg(not(target_os = "wasi"))]
    let rpc = stead_verifier::CurlRpc;
    match stead_verifier::verify_position(&rpc, &cfg, &input) {
        Ok(o) => println!("{}", serde_json::to_string(&o).unwrap()),
        Err(e) => println!("{}", serde_json::json!({ "err": e })),
    }
}
