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
- **Buy-back race (open):** a buy-back is paid straight to the steward's wallet and then confirmed. A payment mined *before* a settlement repay wins (the reporter handles events in on-chain order); one mined *after* it is refused by the contract, but the money has already reached the steward. Pay only while the claim is open and no settlement has started. An escrowed buy-back through the position address would close this; it's pending a decision.
- **Claims are owed in the asset the steward supplied** (LINK here), not in USD: the borrower returns the same units plus a fixed-unit premium, so the rescue's only cost is the premium at any price. A falling price is the steward's risk.
- **How fast a fall Stead survives (simulated, not measured on-chain):** in a timed model of the verified path (a reading every 12 s, a 45 s auction, 2–3 min from crossing to confirmed settlement), every steward whose top-up lands is repaid in full at constant falls up to **10 % per minute**. Faster than about 12 %/min, the auction and top-up can't land before Aave liquidates; no steward money is at risk then, but there is no rescue either. If a settling steward goes silent, the fallback only protects in slow markets (≤ 0.5 %/min).
- **Early settlement watches the borrower's own health factor** (net of what open claims are owed), not Aave's, which the stewards' top-ups hold up. Default threshold 1.10.
- **Next step: stablecoin top-ups.** A stewards' top-up in a stablecoin doesn't fall with the collateral, so the steward's risk (and the premium) shrinks. The claim format (`{asset, amount, premium}`) already supports it; the demo stays LINK/DAI because the health-factor proof covers that pair.
- **Local fork:** Gates 2–3 run on a local Sepolia fork (chain 31337) so prices can be moved. Sepolia's own Aave oracle is fixed and admin-only.
- **NEAR Intents:** no testnet exists. Steward capital movement is simulated on testnet and marked as such.
