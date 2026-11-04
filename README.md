# Stead

A liquidation rescue market on NEAR. A NEAR contract controls Aave V3 positions through NEAR chain signatures. When a position nears liquidation, **stewards** bid to top up its collateral. The lowest premium wins, capped below Aave's liquidation penalty. The rescue becomes a **claim NFT** the borrower can buy back within 24 hours.

**Invariant:** a borrower is never worse off than they would have been after an Aave liquidation.

Built for the NEAR HACKATHON (deadline 2026-11-14). Status: **in development**.

## Layout
| Path | What |
|---|---|
| `contract/` | NEAR contract (Rust, near-sdk 5.30.0, omni-transaction 0.5.0): a thin `#[near]` wrapper |
| `contract/core/` | `stead-core`: every rule (allow-list, nonce tracker, claim lock, auction, claims, settlement) as plain Rust |
| `stewards/` | Steward bots: `patient`, `swift`, `deep`, `pool` (TypeScript) |
| `fork/` | Local Sepolia fork with a mock price oracle (anvil, chain id 31337) |
| `web/` | Front end (later batch) |

## Provenance: what came from the feasibility spike
Eligible work counts from Oct 19. These files were written during the pre-hackathon spike (Oct 29) and copied in unchanged on Nov 4 (the repo's first commit). Everything else in the repo is new.

| File | From the spike | Notes |
|---|---|---|
| `contract/src/lib.rs` | `contract/src/lib.rs` | Spike contract: `sign_evm_tx` + claim rule. **Rewritten Nov 4** as the Stead wrapper; kept from the spike: the MPC request shape, gas/deposit constants, build-then-hash flow. `git diff $(git rev-list --max-parents=0 HEAD) -- contract/src/lib.rs` shows the change. |
| `contract/Cargo.toml`, `contract/Cargo.lock` | same | Dependency pins (Nov 4: crate renamed `stead`, workspace with `core/` added; same near-sdk / omni-transaction pins) |
| `fork/src/MockAggregator.sol` | `fork/src/MockAggregator.sol` | 10-line settable price feed |

## Honest limits (current)
- **Trusted reporter (TEMPORARY, local-fork demo):** a NEAR contract can't read EVM state, so health factors and EVM payments are reported by an operator-run reporter. Verified OutLayer reads replace it with OutLayer-verified reads on Sepolia.
- **Liquidation baseline:** an Aave liquidation would cost the borrower 5–10 % of the repaid debt (50 % close, or 100 % at HF ≤ 0.95 / under $2,000 on Aave v3.3+). Stead caps premiums at the **lower** figure. Sepolia's Pool is v3.0 (`POOL_REVISION() = 1`).
- **Scope:** one market pair, LINK collateral / DAI debt.
- **Local fork:** Gates 2–3 run on a local Sepolia fork (chain 31337) so prices can be moved. Sepolia's own Aave oracle is fixed and admin-only.
- **NEAR Intents:** no testnet exists. Steward capital movement is simulated on testnet and marked as such.
