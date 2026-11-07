# Stead

**A liquidation rescue market on NEAR.**

A NEAR contract controls Aave V3 positions through NEAR chain signatures. When a position nears
liquidation, **stewards** bid to top up its collateral. The lowest premium wins, capped below what an
Aave liquidation would cost the borrower. The rescue becomes a **claim NFT** that the borrower can buy
back within 24 hours.

**Invariant:** a borrower is never worse off than they would have been after an Aave liquidation.

- The contract holds the position: every EVM transaction is built on NEAR and signed by the MPC network
  (`v1.signer-prod.testnet`), from a fixed allow-list of calls.
- Decisions on Sepolia rest on **verified reads**: an OutLayer program (TEE) proves the position's
  Aave state from Ethereum storage proofs, with at least three RPCs, and a majority of those that
  answer, agreeing on the block.
- Claims are owed in the units the steward supplied (LINK, WBTC), not USD, so a rescue costs the borrower
  only its premium.

Built for the NEAR HACKATHON (deadline 2026-11-14). **Testnets only** (NEAR testnet, Ethereum Sepolia).

| | |
|---|---|
| Contract | [`steadfi.testnet`](https://testnet.nearblocks.io/address/steadfi.testnet) (NEAR testnet) |
| Market | **2**: Sepolia Aave V3, LINK collateral, DAI debt, gas cap 670k per signed tx. Market 1 is legacy (its 500k cap is too low for a new account's first borrow); it holds only position 9's recorded run |
| Stewards and keeper | running 24/7 against market 2: `patient`, `swift`, `deep`, `pool` `.steadfi.testnet` |
| Proof program | OutLayer WASM, SHA-256 `5da1e8b95764fa98208aeb0f71611a3681c1024204d2bdbb5eb5e214f4ec75bc` ([source](verifier/)) |
| A verified rescue | position [`0x98deab0b…5b34`](https://sepolia.etherscan.io/address/0x98deab0b3751f5421aa3c32ac6b8dca0010e5b34) on Sepolia ([the run](#recorded-runs)) |

## How to test

<!-- To be written before submission: the end-to-end path a reviewer can run themselves. -->

## How a rescue works

1. **Watch.** The keeper asks OutLayer for a verified reading of each position. When the verified
   health factor falls below **1.15**, the contract opens a 45-second auction.
2. **Bid.** Stewards bid a premium in basis points for an amount of collateral. The lowest premium
   wins; several stewards can share one rescue when each can supply only part of it. Every premium is
   capped so that the total, valued at the trigger price, stays below Aave's liquidation penalty
   (50 % close factor × liquidation bonus × debt), counted across all open claims.
3. **Top up.** Each winner supplies its share to Aave on the position's behalf. Only a verified
   reading showing the collateral increase mints the winner a **claim NFT (NEP-171)**: owed the same
   units back, plus a fixed-unit premium. A missed deadline is also decided by a verified reading,
   one from a block after the deadline, so a top-up that landed in time but wasn't proven yet still
   counts. If no reading arrives within 15 minutes, anyone may expire the top-up directly.
4. **Buy back (24 h).** The borrower pays what's owed **into the position**, not to the steward. Once a
   verified reading proves the balance, the contract signs the payment of exactly the owed amount to
   the claim owner and refunds any excess to the borrower. While a claim is open the borrower can only
   repay or supply.
5. **Or settle.** If the claim isn't bought back in time, or the borrower's own health factor (net of
   what the claims are owed) falls below **1.10**, the claim owner deleverages the position at the
   oracle price: repays debt, withdraws its owed collateral. A stalled settler can be taken over after
   3 minutes. Buy-back and settlement are decided atomically on NEAR, whichever commits first. The
   withdrawals go out one at a time, each after a fresh reading: every claim's principal first, the
   premiums last.
6. **If Aave liquidates anyway.** While a claim is open, Stead signs no collateral withdrawal except
   settlement legs, so a verified reading showing less collateral than the highest seen (net of those
   legs) is proof of a liquidation. Every open claim then shrinks to the units supplied: the premium is
   forfeited, so the borrower never pays Aave's penalty and a premium. A settlement whose repay isn't
   confirmed yet goes back to open; after the repay, the unsent premium legs are dropped.

## Recorded runs

**Verified rescue on Sepolia** (2026-11-05, position 9, rescue 12, legacy market 1). Every Aave reading that drove a
decision came from the proof program.

| Step | Evidence |
|---|---|
| Borrower supplies 200 LINK, borrows to HF 1.17 (MPC-signed) | NEAR [`4afr4oEQ…`](https://testnet.nearblocks.io/txns/4afr4oEQ1gCAU9A4bhYQ9qQiQvYFw67ptSSsp2rtaK7j), [`Co8Uwtwj…`](https://testnet.nearblocks.io/txns/Co8UwtwjVpVxod5aqEeSALXyCHgbfTmQTei74YR2yVYw) |
| Borrows to HF 1.14 (Sepolia's Aave prices are fixed, so a borrow makes the fall) | NEAR [`ExPb3abu…`](https://testnet.nearblocks.io/txns/ExPb3abuakVqud2hVjK6X4WLsCn6koDybr37ztmLcQFp) |
| Auction opens on a verified HF 1.1400 at Sepolia block 12,070,552, four RPCs agreeing | contract event |
| `deep` bids 150 bps, `patient` 268 bps; `deep` wins and supplies 63.1574 LINK | |
| A verified HF 1.5000 at block 12,070,563 proves the top-up; claim NFT `9-0-0` minted to `deep` | |
| Borrower pays 1,924.1433 DAI into the position (1 DAI more than owed) | Sepolia [`0x92183653…88e6`](https://sepolia.etherscan.io/tx/0x9218365e5e7010dc50b41d85aab0382f6bf691f1c11264bb0844dacc52d188e6) |
| Claim owner receives exactly 1,923.1433 DAI; 1 DAI refunded to the borrower; NFT burned | position's transfers on Sepolia |

**Expiry settlement and buy-back on Sepolia** (2026-11-06, demo contract
[`sepolia-demo.steadfi.testnet`](https://testnet.nearblocks.io/address/sepolia-demo.steadfi.testnet),
position 1). Its buy-back window is **3 minutes, a demo setting** (the main contract keeps 24 h), so
both endings can be shown in one sitting. Readings verified as above; the stewards joined through
`register_steward`.

| Step | Evidence |
|---|---|
| Verified HF 1.14 opens an auction; `deep` 150 bps, `patient` 268, `swift` 400; `deep` supplies 63.1571 LINK | Sepolia [`0xe4915add…7ce86`](https://sepolia.etherscan.io/tx/0xe4915addb98fa9b9bb7dd32c3069e93f509862e7abe787bd488c225e01c7ce86) |
| No buy-back: the window ends, `deep` settles and repays 1,922.92 DAI | Sepolia [`0x9698a75b…51dac`](https://sepolia.etherscan.io/tx/0x9698a75be00a9fe089c2ee286d41c53513063e667fd96238c0e7ef22fba51dac) |
| `deep` withdraws 128.2017 LINK: the 64.1044 owed plus 64.097 for its repayment at the oracle price; position left at HF 1.50 | position's transfers on Sepolia |
| Second rescue on the same position, `deep` at 150 bps; the borrower pays 1,298.8990 DAI into the position within the window | Sepolia [`0x9959cd29…ea883`](https://sepolia.etherscan.io/tx/0x9959cd2956dca59f9feb6ba49eb3b905adad389751587d5968d620dc183ea883) |
| `deep` receives exactly 1,297.8990 DAI; the rest is refunded to the borrower | position's transfers on Sepolia |

Early settlement (the borrower's own HF falling below 1.10 while a claim is open) needs a price fall,
and Sepolia's Aave prices are fixed, so it is shown on the fork below.

**Pooled rescue** (local Sepolia fork, position 10, rescue 14). `deep` could supply 20 LINK and
`patient` 15, so the 31.58 LINK top-up went to both: `deep` 20.00 at 150 bps and `patient` 11.58 at
268 bps. Two claim NFTs. One buy-back payment of 881.69 DAI; the owners received exactly 555.4080 and
325.2828 DAI.

**Settlement on the fork** (position 6). LINK falls from $30 to $27.36, `deep` rescues at 150 bps and is
bought back; LINK then falls to $20.79, a second rescue is not bought back, and `deep` settles: repays
876.95 DAI and withdraws 84.349 LINK. The borrower's cost was the premium, 0.6233 LINK ($12.96 at the
trigger), against $90 for an Aave liquidation.

The fork runs use a reporter instead of verified reads (see limits).

## Running it

Stewards, keeper and deployment: **[stewards/README.md](stewards/README.md)**.

- **Sepolia** (`STEAD_EVM=sepolia`): Aave readings come from verified OutLayer proofs. The keeper's NEAR
  account pays about 0.0012 NEAR per reading. It reads every 30 s while a rescue is live, every minute
  near the trigger, and every 30 min otherwise.
- **Local fork** (default): a Sepolia fork on anvil (chain id 31337) with a settable LINK price, so
  price falls can be staged. Start it with `fork/scripts/start.sh`.

## Optional: AI risk tuning

A steward can ask a model to adjust its own risk settings (spread, minimum margin, minimum top-up,
share, bid timing). It's off unless an API key is set. Any OpenAI-compatible chat endpoint works:
`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_FALLBACK_MODEL`. The default is NEAR AI Cloud
(`z-ai/glm-5.3-flash`), whose TEE-hosted models sign each response.

- With `AI_REQUIRE_SIGNATURE` on (the default), an answer is applied only if its signature checks out.
  The signed text must carry the SHA-256 of the exact request and response bytes, and the EIP-191 signer
  must match the reported signing address. Our stewards always run this way, on NEAR AI.
- An operator using a provider that signs nothing can switch the requirement off. Every adjustment is
  then labelled UNVERIFIED in the log and the record.
- Either way, the settings are clamped to fixed bounds, and the contract's premium cap applies to every
  bid whatever the model says. A failed, slow or unsigned answer keeps the current settings.

## Honest limits

- **What is still trusted.** On Sepolia, health factors, top-ups, buy-back balances and settlement
  repays (from the drop in the position's scaled debt) are verified. A **temporary reporter** still
  confirms transaction nonces. On the local fork,
  the reporter reports everything ("unverified demo mode"). Every log line carries its mode's label.
- **Who paid.** A verified reading proves that a position's collateral grew, not who paid. Anyone can
  call Aave's `supply` on behalf of a position directly, so collateral added by someone else while a
  rescue waits for its top-up is credited to the winning steward. Don't add collateral to a position
  while an auction is open. A receipt proof of the steward's own transaction would close this; it isn't
  built.
- **Repays during a settlement.** The settlement repay is proven from the drop in the position's
  debt, which any repay causes. A borrower who repays the position directly on Aave while it settles is
  credited toward the settler's repay (the settler never gets more than the collateral it was owed for
  it). Don't repay a settling position on Aave directly. A receipt proof of the settler's own repay
  would close this.
- **Liquidation evidence between two readings.** A supply and a liquidation that both land between two
  verified readings can cancel out in the collateral, and then the premium isn't forfeited. Proving
  Aave's `LiquidationCall` event would close this.
- **A premium leg already signed.** If a liquidation is proven while a premium withdrawal is already
  in flight, that one premium is still paid (at most one claim's premium).
- **Verified readings lag.** The proof reads 3 blocks behind the head (about 36 s on Sepolia), and the
  contract refuses a reading older than the last event it has seen.
- **Liquidation baseline.** An Aave liquidation costs the borrower 5–10 % of the repaid debt (50 % close
  factor, or 100 % at HF ≤ 0.95 or under $2,000 on Aave v3.3+). Stead caps premiums at the **lower**
  figure. Sepolia's Pool is v3.0 (`POOL_REVISION() = 1`).
- **Who can be a steward.** Anyone, by calling `register_steward` with a 0.005 NEAR storage deposit.
  The contract owner can remove a steward: that stops its new bids only, never its open claims, bonds
  or payouts.
- **Scope.** One market pair: LINK collateral, DAI debt.
- **A falling price is the steward's risk.** Claims are owed in LINK. In a timed model of the verified
  path (simulated, not measured on-chain; one fresh reading before each settlement withdrawal), every
  steward whose top-up lands is repaid in full at constant falls up to **10 % per minute**. Faster than
  about 12 %/min the rescue can't land before Aave liquidates: no steward money is at risk then, but
  there is no rescue either. If a settling steward goes silent and another takes over after 3 minutes,
  up to **5 %/min**; if nobody takes over, the fallback only protects in slow markets (≤ 0.5 %/min).
- **NEAR Intents is simulated.** No testnet exists. When a steward lacks the asset, a faucet mint
  stands in for an Intents swap, and the log says so.
- **Sepolia prices are fixed.** Its Aave oracle is admin-only, so on Sepolia a borrow moves the health
  factor; price falls are staged on the fork.
- **Next: stablecoin top-ups.** A top-up in a stablecoin doesn't fall with the collateral, which
  lowers the steward's risk and the premium. The claim format (`{asset, amount, premium}`) already
  supports it.

## Repository

| Path | What |
|---|---|
| `contract/` | NEAR contract (Rust, near-sdk 5.30.0, omni-transaction 0.5.0): a thin `#[near]` wrapper |
| `contract/core/` | `stead-core`: every rule (allow-list, nonces, claim lock, auction, claims, escrow, settlement) as plain Rust |
| `verifier/` | The OutLayer proof program: block-header agreement, storage proofs, Aave health factor from raw storage |
| `stewards/` | Keeper and steward bots (TypeScript); `deploy/` holds the container and systemd setup |
| `fork/` | Local Sepolia fork with a settable price feed (anvil, chain id 31337) |
| `web/` | Front end (to come) |

## Provenance: what came from the feasibility spike

Eligible work counts from Oct 19. These files were written during the pre-hackathon spike (Oct 29)
and copied in unchanged on Nov 4 (the repo's first commit). Everything else in the repo is new.

| File | From the spike | Notes |
|---|---|---|
| `contract/src/lib.rs` | `contract/src/lib.rs` | Spike contract: `sign_evm_tx` + claim rule. **Rewritten Nov 4** as the Stead wrapper; kept from the spike: the MPC request shape, gas/deposit constants, build-then-hash flow. `git diff $(git rev-list --max-parents=0 HEAD) -- contract/src/lib.rs` shows the change. |
| `contract/Cargo.toml`, `contract/Cargo.lock` | same | Dependency pins (Nov 4: crate renamed `stead`, workspace with `core/` added; same near-sdk / omni-transaction pins) |
| `fork/src/MockAggregator.sol` | `fork/src/MockAggregator.sol` | 10-line settable price feed |
