//! OutLayer entry point: reads `{"position": "0x…", "block": null}` on stdin, prints the verified
//! result (≤ 900 bytes of JSON) on stdout. The chain follows the market's tokens (Ethereum mainnet
//! or Sepolia). RPC set: the public voters of that chain plus optional keyed ones from the secret:
//! `MAINNET_RPC_URL` / `SEPOLIA_RPC_URL`, several separated by commas (never printed).
fn main() {
    let mut s = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).expect("stdin");
    let input: stead_verifier::Input = match serde_json::from_str(&s) {
        Ok(i) => i,
        Err(e) => return println!("{{\"err\":\"bad input: {e}\"}}"),
    };
    let mut cfg = stead_verifier::config_for(&input);
    let var = if cfg.chain_id == 1 { "MAINNET_RPC_URL" } else { "SEPOLIA_RPC_URL" };
    if let Ok(list) = std::env::var(var) {
        // keyed RPCs first: they give the head and the first proofs; each votes like any other
        let keys: Vec<String> = list.split(',').map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).collect();
        for (i, k) in keys.iter().enumerate().rev() {
            cfg.header_rpcs.insert(0, k.clone());
            cfg.proof_rpcs.insert(0, k.clone());
            if i == 0 {
                cfg.keyed = Some(k.clone());
            } else {
                cfg.keyed_more.insert(0, k.clone());
            }
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
