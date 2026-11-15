# Stead

Stead is a liquidation rescue market on NEAR for Aave V3 positions on Ethereum.
An Aave liquidation charges the borrower the liquidation bonus; with Stead, steward agents compete to
top up the position's collateral instead, for a premium the contract caps below that bonus.

## Check it in 5 minutes

| Do | See |
|---|---|
| `cd contract && cargo test -p stead-core` | **132 passed**, 0 failed |
| `cd stewards && npm ci && npm test` | **402 passed** in 34 files, with no `.env`, keys or network |
| Open [app.usestead.xyz/?demo=#/live](https://app.usestead.xyz/?demo=#/live) and press **One steward** | an auction opens on a verified HF 1.14, stewards bid, the winner tops up, the claim is bought back; every step links its transaction (about 5 min, testnet) |
| `curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"steadfi.testnet","method_name":"get_rescues","args_base64":"eyJmcm9tIjowLCJsaW1pdCI6NTB9"}}'` | JSON of every rescue on the main testnet contract (the result bytes are JSON) |
| The mainnet run | [Mainnet](#mainnet-real-funds-2026-11-14) under Recorded runs: rescue 81, every NEAR and Ethereum transaction linked and re-checked on chain |

The hosted demo ([app.usestead.xyz](https://app.usestead.xyz), its bots and feeds) stays up through
judging, until at least 2026-11-18.

**Invariant:** a borrower is never worse off than they would have been after an Aave liquidation.

- The contract holds the position: every EVM transaction is built on NEAR and signed by NEAR's MPC
  network (`v1.signer` on mainnet, `v1.signer-prod.testnet` on testnet), from a fixed allow-list of calls.
- Decisions rest on **verified reads**: an OutLayer program (TEE) proves the position's Aave state from
  Ethereum storage proofs, with at least three RPCs, and a majority of those that answer, agreeing on the block.
- The winner gets a **claim NFT** owed in the units it supplied (WETH, LINK, WBTC), not USD, plus a
  fixed-unit premium, so a rescue costs the borrower only its premium. The borrower buys it back
  within 24 hours, or it settles at the oracle price.
- Stewards are agents with their own strategies; each can tune its risk with a model on NEAR AI Cloud,
  and a guard applies a change only if its reasoning matches the steward's own data.

**Protect a position yourself** ([app.usestead.xyz/#/try](https://app.usestead.xyz/#/try), testnet, about
12 minutes): connect a NEAR testnet wallet, open a protected position, watch the rescue, try to withdraw
while the claim is open (the contract refuses on chain), then buy back or let it settle. Test funds are
sponsored. Mainnet is not open to the public: the contract has not been audited.

## What runs where

All four run the same source. The size cap and the borrower allow-list are owner settings,
off by default (0 and empty), so the testnet contracts are unaffected by them.

| Account | Chains | What it's for | Money |
|---|---|---|---|
| [`steadfi.testnet`](https://testnet.nearblocks.io/address/steadfi.testnet) | NEAR testnet, Ethereum Sepolia | The main deployment: market 2 (LINK/DAI), the 24-hour buy-back, verified reads; the bots run on it 24/7 | testnet tokens only |
| [`sepolia-demo.steadfi.testnet`](https://testnet.nearblocks.io/address/sepolia-demo.steadfi.testnet) | NEAR testnet, Ethereum Sepolia | The same code with a 5-minute buy-back window, so a demo shows both endings in one sitting; LINK and WBTC markets | testnet tokens only |
| `stead-mainnet-dry.testnet` | NEAR testnet, a local copy of Ethereum mainnet | Rehearsals of the mainnet runs with the exact market, caps, gas profile and balances | none (local copy) |
| [`app.usestead.near`](https://nearblocks.io/address/app.usestead.near) | NEAR mainnet, Ethereum mainnet | Real rescues on Aave V3 Ethereum (WETH collateral, USDC debt). Three completed, each won by `deep` at 150 bps: rescue 78 settled at the oracle price, rescues 80 and 81 bought back. Three earlier attempts had bids but no top-up proven (0 and 1: the winner held less WETH than it bid; 79: the winner's supply ran out of gas); both steward bugs are fixed, and rescue 80 rescued 79's position right after | real and capped: at most $150 of collateral per position and a borrower allow-list; not open to the public, because the contract has not been audited |

The contract code is the same on all three NEAR accounts: SHA-256 of the wasm
`f0c0a62067ccd6a1748ac9837e7604d64948d4fb20b28fc51a62af9cd77a5d62` (see [Reproduce](#reproduce)). On
mainnet the proof program is `291b2cd482b9bfad2bb17f9c6efa73f549af015934f0cc900c467e3ca7206990` and the
three stewards (`deep`, `patient`, `swift` `.usestead.near`) and the keeper run on our server.

Why a separate mainnet contract instead of a mainnet market on `steadfi.testnet`: real funds should only
answer to mainnet keys and the mainnet MPC network (`v1.signer`). A testnet signer can be reset, and
testnet accounts aren't meant to hold value. Position 2 on `app.usestead.near` is still open after rescue
81 (its collateral is ours and capped); the contract's full-access key is deleted once every position is
closed, and that DeleteKey transaction will be linked under [Recorded runs](#recorded-runs).

### What else is on the site

- **[app.usestead.xyz](https://app.usestead.xyz)**: the live board. **LIVE** follows any open rescue on
  the testnet contracts, 6 s behind the chain. **DEMO** starts a real rescue from the page: a demo
  borrower borrows below 1.15 on Aave Sepolia, the keeper's proven reading opens the auction, and the
  stewards bid, top up and are paid back. Pick **one steward** (about 5 minutes) or a **pooled rescue**,
  a top-up larger than any one steward's capacity, shared from the lowest premium up (about 9 minutes).
  **REPLAY** plays recorded rescues 8, 10 and 11.
- **Rescues, Positions, Claims, Stewards, Proofs**: every record read from the contracts, every step
  linked to its transaction.
- **On mainnet**: the real rescues on `app.usestead.near`, read from the contract with their full flow,
  and real Aave V3 liquidations on Ethereum in the last 24 hours, each beside what a Stead rescue would
  have cost the same borrower.
- The read-only feeds behind the site: `https://live.usestead.xyz/live.json` (open rescues),
  `/records.json` (the list pages), `/mainnet.json` (the mainnet panel), `/demo/status`.

Demo runs are limited to one of each kind at a time, two minutes apart, one per visitor every ten
minutes, and paced so the test funds last through judging.

## How to test

Each step: do this, see that. Steps 1–3 need only Node 22 and this repository: no keys, no accounts.

1. **Replay borrowers and stewards on real 2026 prices.** `cd stewards && npm ci && npx tsx scripts/evidence.ts --no-sweep`.
   See `evidence/README.md` rewritten: for LINK, BTC and ETH, how often a position that falls through
   the trigger would have been liquidated within 7 days without Stead, the loss with and without Stead
   per rescue, and every recorded live transaction re-read on chain (✓ per row).
2. **See what Stead would do for real positions today.** `npx tsx scripts/mainnet-watch.ts`. See a table of
   real Aave V3 Ethereum positions near the trigger: the top-up Stead would need, the premium cap, the
   stewards' bids and the saving against an Aave liquidation. Public reads only.
   `npx tsx scripts/mainnet-panel.ts --once` writes the same as JSON for the front end, plus
   the last 24 hours of real Aave liquidations beside what a Stead rescue of each position would have
   charged (`--serve 8787` keeps it running and serves `/mainnet.json`).
3. **Read the live contracts.** No CLI needed; any NEAR RPC works:
   `curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"steadfi.testnet","method_name":"get_rescues","args_base64":"eyJmcm9tIjowLCJsaW1pdCI6NTB9"}}'`.
   See every rescue so far (the result bytes are JSON): state, bids, winners, claims, settlement legs.
   `cd stewards && npx tsx scripts/rescue-log.ts --rescue 8` rebuilds one rescue's full event log from
   the chains (the contract's events on NEAR testnet, the transfers on Sepolia), each event with its
   transaction; the front end's live board replays that file (`web/public/replays/`).
   `npx tsx scripts/rescue-path.ts` runs that rescue's position along a real 2026 hourly price path
   for the rescue page's cost chart (testnet prices don't move; the window is chosen by a fixed rule).
   `npx tsx scripts/site-stats.ts` reads the homepage totals from the contracts' own rescue records
   (finished rescues on Sepolia; fork runs are counted apart).
4. **Run a steward.** Any NEAR testnet account can join with `register_steward` (0.005 NEAR) and bid
   with the same bots we run: [stewards/README.md](stewards/README.md).
5. **Stage a price fall.** The local fork (`fork/scripts/start.sh`, anvil) has a settable LINK price;
   the steward README shows the full rescue, buy-back and settlement on it.

## Reproduce

Every default test runs on a fresh clone with no `.env`, no keys and no network (checked with networking
switched off). Anything that needs an RPC, OutLayer or keys is opt-in and skips cleanly.

| Command | Expected |
|---|---|
| `cd contract && cargo test -p stead-core` | **132 passed**, 0 failed: rules 68, settlement and liquidation watch 24, leftover-gas sweep 11, owner limits 10, stewards 10, OutLayer request and output parsing 4 (one a real Ethereum mainnet proof), invariant sweeps 3, migration dry-runs 2 (they print `skipped` unless `STEAD_STATE_FILE` points at a downloaded contract state) |
| `cd verifier && cargo test` | **25 passed, 2 ignored**: the proof program against recorded Sepolia and Ethereum mainnet RPC answers (`tests/fixtures/`), including the market's own reserve prices; the 2 ignored are the live recorders, opt-in: `cargo test -- --ignored` |
| `cd stewards && npm ci && npm test` | **402 passed** in 34 files, with no `.env`, keys or network: strategies, hedging, polling, settlement repay, bidding within the wallet's balance, gas headroom on Ethereum writes, NEAR Intents quotes, AI tuning and its guard, the replay model, the run evidence trail and its on-chain checker, the read-only mainnet feed, the rescue event log rebuilt from the chains, the live feed, the live board, the demo runner's rules, the list pages, the rescue page and its cost chart, the homepage totals, the sponsored faucet's limits, the mainnet position dashboard's rules (what each action may sign, payouts, the pause before a NEAR signature, the positions list), the mainnet rescues read from the contract, the undercut rule |
| `cd contract && cargo near build non-reproducible-wasm --no-abi` | `target/near/stead.wasm`; SHA-256 `f0c0a62067ccd6a1748ac9837e7604d64948d4fb20b28fc51a62af9cd77a5d62`, the code deployed on `steadfi.testnet`, `sepolia-demo.steadfi.testnet` and `app.usestead.near` (`view_account` shows its code hash in base58: `HCoEB9cjsybpY22ccH8x1nCykW337x4UGD8qsyPnQnJD` on mainnet) |

Run from the workspace root, `cargo test` would also try to build the NEAR contract crate for the host,
which near-sdk refuses; the rules live in `stead-core`, hence `-p stead-core`.

### Each signing rule and the test that fails if it breaks

The contract signs an EVM transaction only from a fixed allow-list. Tests are in `contract/core/tests/`.

| Rule | Test(s) |
|---|---|
| Only Aave Pool `supply` / `borrow` / `repay` / `withdraw` and token `approve` to the Pool, with pinned arguments | `rules.rs`: `allow_list_targets_and_pinned_arguments` |
| A debt transfer goes only to the borrower's payout, and only of the debt asset, never an aToken | `rules.rs`: `transfer_is_only_ever_the_debt_asset_never_an_atoken` |
| Gas limit and fee caps per market | `rules.rs`: `gas_caps_enforced` |
| One transaction in flight per position; a stuck one is replaced only by a zero-value nonce burn or one capped replacement | `rules.rs`: `pre_sign_attack_one_tx_in_flight`, `nonce_burn_after_timeout_even_during_a_claim`, `one_capped_replacement_per_tx`, `signed_tx_is_public_and_failed_mpc_rolls_back` |
| While a claim is open the borrower may only repay or supply | `rules.rs`: `claim_lock_from_auction_open_to_close` |
| …and not even those while a buy-back balance is held in the position | `rules.rs`: `held_balance_blocks_borrower_repay_and_supply_while_claim_open` |
| Borrower actions wait for queued payouts | `rules.rs`: `borrower_actions_wait_for_queued_payouts` |
| Settlement withdrawals only from a settling rescue, each after a fresh reading, principal first, premiums last | `rules.rs`: `settlement_b_full_flow_and_buyback_closes_on_commit`, `settlement_withdraw_cannot_be_burned_and_failed_leg_can_be_resigned`, `settlement_needs_a_reading_taken_after_the_topup`; `watch.rs` (premium legs last, abort and reduce rules) |
| Payouts are queued by the contract only: exactly the owed amount to the claim owner, refunds to the borrower, at-par reimbursements to a repaying steward | `rules.rs`: `every_payout_goes_only_to_a_registered_payout`, `settlement_pays_steward_exactly_owed_units`, `stray_repay_is_reimbursed_at_par_and_borrower_is_no_worse_off`, `buyback_commits_first_then_settlement_is_refused` |
| Every recipient is a registered payout; a payout change is delayed and blocked during a claim | `rules.rs`: `every_payout_goes_only_to_a_registered_payout`, `payout_change_delayed_and_blocked_during_claim` |
| No borrower supply above the size cap (when set) | `limits.rs`: `no_supply_above_the_cap` |
| MPC signatures encode r and s without leading zeros | `rules.rs`: `signed_raw_encodes_r_and_s_without_leading_zeros` |
| **The invariant:** the borrower is never worse off than after an Aave liquidation | `rules.rs`: `premium_cap_exact_boundary`, `stacked_rescues_cumulative_cap_and_oldest_first`, `claim_is_fixed_in_supplied_units`; `invariant.rs`: `invariant_property_sweep` (random price paths, every path checked) |

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

Every transaction below is re-read on chain by the evidence harness (`cd stewards && npx tsx
scripts/evidence.ts`, results in [evidence/README.md](evidence/README.md)). A scripted run with real funds
records its own trail as it goes, in `evidence/mainnet/` (the dashboard run below had its trail rebuilt from the explorers): every NEAR call by every actor (borrower,
stewards, keeper) and every Ethereum transaction sent from the run's own addresses, plus the
contract's final state. The harness checks each transaction's sender, target or method and outcome
against the trail, re-reads the contract's positions, rescues and claims, and writes
`evidence/live-checked.json` for the front end.

### Mainnet, real funds (2026-11-14)

Contract [`app.usestead.near`](https://nearblocks.io/address/app.usestead.near), market 0: Aave V3
Ethereum, WETH collateral, USDC debt. Position 2's Ethereum address
[`0x3f3ddb3f…44e8`](https://etherscan.io/address/0x3f3ddb3f32447fcd4168ff1d088fd415b61644e8) is derived
by NEAR's MPC network; only the contract can sign for it. This run was driven from the mainnet
dashboard, so its trail
([`evidence/mainnet/2026-11-14T12-36-rescue-81.json`](evidence/mainnet/2026-11-14T12-36-rescue-81.json))
was rebuilt after the run from NearBlocks and Blockscout; the harness re-checks all 28 transactions on
chain ([evidence/README.md §4](evidence/README.md)).

| Step | Evidence |
|---|---|
| The borrower registers position 2 | NEAR [`CyqXxmDn…`](https://nearblocks.io/txns/CyqXxmDnJ3bdpTZtEX9zZse5F7aYVkeEjk4cL7bcQ6XN) |
| The borrower's wallet sends 0.03 WETH to the position; the contract approves and supplies it to Aave (MPC-signed) | Ethereum [`0x1b238e7b…`](https://etherscan.io/tx/0x1b238e7be02ecaf15c887a554c902329b0d86041b151acf93dbab52d8c8717ff), [`0xbf8f3953…`](https://etherscan.io/tx/0xbf8f395358d9621b71a8a1a26e4cc81051bc6c34626818aa46799eb4835806d2), [`0xe055a2c6…`](https://etherscan.io/tx/0xe055a2c6716753a38329023e5de15167e3b490115cea76a8ea257fa304867bb9) |
| The contract borrows 42 USDC: health factor 1.146, under the 1.15 trigger; the USDC goes to the borrower's payout | NEAR [`3Q4m9Jev…`](https://nearblocks.io/txns/3Q4m9Jev23SWvmAmyLFFu3CzfYv1ETcoxc3yPmBvtfs6); Ethereum [`0x85a1d8a6…`](https://etherscan.io/tx/0x85a1d8a648e232d904b941511f20a61cb1ac74a2b615ab00de2d28112a1408cf), [`0x25c22583…`](https://etherscan.io/tx/0x25c22583b3fca7a0def8340e5fcab5e2863f6263b35a7a3ce64a616885a75ec3) |
| An OutLayer-verified reading (HF 1.146) opens auction 81, premium cap 593 bps | NEAR [`HFpBeiKB…`](https://nearblocks.io/txns/HFpBeiKBQfPmgVZtwrTw3YWww7Txd9GPfP81aVxiivok) |
| Bids: `swift` 400 bps then 280 (its floor), `deep` 150, `patient` 253 | NEAR [`E29rEu9z…`](https://nearblocks.io/txns/E29rEu9zqE7sQszgEu7uAUaiWcoUWZhYvhP8a5HLYmMA), [`3sFLqnMa…`](https://nearblocks.io/txns/3sFLqnMa1FVKNnfj5zExhJZ9EbZnj2N6uK7gwE21Z9Lu), [`BJH6QJbR…`](https://nearblocks.io/txns/BJH6QJbRwyKUo2gUuZRGfVT4K7u6gaHnvMGVqLLfLza6), [`226pDQST…`](https://nearblocks.io/txns/226pDQSTHLobEqjSsVcDrmdFwofAG8T4tNWKeRQ7eu4r) |
| `deep` closes the auction and wins at 150 bps | NEAR [`4rT3AtTR…`](https://nearblocks.io/txns/4rT3AtTRq9mkT1CyJJV5SxJus7vvTUUGeMheMZdd4YC7) |
| `deep` supplies 0.009268 WETH to Aave on the position's behalf | Ethereum [`0xe2f3616f…`](https://etherscan.io/tx/0xe2f3616f2d23ba27770acab6d0bb8d5b3f180724261c37043217b8484babf6b4) |
| A verified reading proves the top-up (HF 1.50); claim NFT `2-0-0` minted to `deep`, owed 0.009407 WETH | NEAR [`6Xt4psYm…`](https://nearblocks.io/txns/6Xt4psYmjb1tSh8d95FvQrgXGQP3fTN2R1oGnCD6Ugz6) |
| The borrower pays exactly 0.00940684 WETH into the position; a verified reading proves it and the buy-back commits | Ethereum [`0x549c293e…`](https://etherscan.io/tx/0x549c293ee072211154e9090d2b2ee6f4eabdb4d01ddf50b0ebddcbff54345173); NEAR [`HvpHzHzV…`](https://nearblocks.io/txns/HvpHzHzV5QjBJnyrunZaf666VGcFMTSetgGysWacybAA) |
| The contract signs and pays `deep` exactly what it is owed | NEAR [`3MoiF9FK…`](https://nearblocks.io/txns/3MoiF9FKeytfbe4C6W8eyQbV4nx6A5vRmtBGuvJPefQm); Ethereum [`0xe5212b4c…`](https://etherscan.io/tx/0xe5212b4c3c2e9a03c46de534f3c86e3e4679cdbf79c2008b122c9a9e518749d8) |

**The borrower's cost:** `deep`'s premium, $0.27 (the contract's `premium_base` 26,544,627 at 8
decimals: 150 bps of the $17.70 top-up). **Against an Aave liquidation:** $1.05, the contract's premium
cap for this rescue (593 bps of the same top-up), which is Aave's liquidation penalty on this position:
50 % close factor × 5 % WETH bonus × $41.99 debt.

The other completed mainnet rescues, read from the contract (`get_rescue` on `app.usestead.near`):
rescue 78 on position 0, settled at the oracle price after the buy-back window ended (`deep` repaid
30.46 USDC of the debt and was paid 0.028569 WETH in two legs); rescue 80 on position 1, bought back
with USDC the borrower had left at the position. Both won by `deep` at 150 bps.

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
position 1). Its buy-back window was **3 minutes, a demo setting** (5 minutes since 2026-11-11, so a
visitor has time to choose; the main contract keeps 24 h), so
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

**Pooled verified rescue on Sepolia** (2026-11-08, demo contract, position 4, rescue 9). Each steward
was limited to 25 LINK per rescue, so the 63.16 LINK top-up needed a coalition. A verified HF 1.1400
opened the auction; `deep` 150 bps, `hedged` 150 and `patient` 268 won (25 + 25 + 13.16 LINK), `swift`
at 400 lost. One verified reading proved all three top-ups and minted claims `4-0-0`, `4-0-1`, `4-0-2`.
The borrower paid 1,928.8073 DAI into the position once
([`0x59a0d5ea…1a1`](https://sepolia.etherscan.io/tx/0x59a0d5ea0a3096d979fdc58f3e692e55f8ed74917b875ddfa073b37fec9861a1));
the owners received exactly 761.25, 761.25 and 405.3073 DAI, and 1 DAI was refunded. A second pooled
rescue on the same position (rescue 10) had four members.

**Pooled rescue** (local Sepolia fork, position 10, rescue 14). `deep` could supply 20 LINK and
`patient` 15, so the 31.58 LINK top-up went to both: `deep` 20.00 at 150 bps and `patient` 11.58 at
268 bps. Two claim NFTs. One buy-back payment of 881.69 DAI; the owners received exactly 555.4080 and
325.2828 DAI.

**Settlement on the fork** (position 6). LINK falls from $30 to $27.36, `deep` rescues at 150 bps and is
bought back; LINK then falls to $20.79, a second rescue is not bought back, and `deep` settles: repays
876.95 DAI and withdraws 84.349 LINK. The borrower's cost was the premium, 0.6233 LINK ($12.96 at the
trigger), against $90 for an Aave liquidation.

The fork runs use a reporter instead of verified reads (see limits).

## Evidence: does a rescue pay for the borrower?

A rescue costs a premium; an Aave liquidation costs the bonus on half the debt (LINK 7 %, WBTC and
WETH 5 % on Aave V3 Ethereum). On real 2026 prices, for a $10,000 loan that a falling price pushes
through the trigger, followed for 7 days ([details and every row](evidence/README.md); REPLAY, not live):

| | Liquidated within 7 days: without → with Stead | Mean loss: without / with (150 bps) | With the hedged steward bidding (modelled) | Break-even premium | 95th-percentile loss: without / with |
|---|---|---|---|---|---|
| LINK | 24 % → 0 % | $84 / $74 | $31 | 172 bps | $350 / $79 |
| BTC | 40 % → 0 % | $110 / $61 | $41 | 270 bps | $375 / $64 |
| ETH | 33 % → 1 % | $105 / $64 | $34 | 247 bps | $438 / $65 |

The same replay with a position at the trigger **every day, calm days included**, shows Stead costing
more on average (LINK $35 without, $74 with): most of those rescues come on days the price would have
recovered. Real positions reach the trigger because the price is falling, which is the case above.

## Owner settings and their limits

The contract's code is fixed once its full-access key is deleted. The owner account can still tune a few
settings, only within limits written into the code, and every change is logged with the old and new
values. A change applies to rescues that start after it: a claim keeps the buy-back deadline it opened
with, and a running auction keeps its terms.

| Setting | Limit in the code |
|---|---|
| Buy-back window | 3 minutes to 7 days |
| Auction window | 15 s to 10 min |
| Top-up deadline | 60 s to 1 h |
| Position size cap (no auction, no borrower supply above it) | off, or at most $1,000 of collateral |
| Borrower allow-list (who may open a position) | off, or a list; never touches existing positions |

On the testnet contracts the cap and the allow-list are off. Each steward's own limits (how much it puts
into one rescue, the smallest rescue it takes, its spread) are set by whoever runs it, in its own bot.

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

- **Gas spikes on mainnet.** The mainnet market caps the fee of every contract-signed transaction at
  1 gwei, so a position can never spend much on gas, and a market's caps can't be raised after it is
  added. While Ethereum's base fee is above the cap, the position's transactions (repays, payouts,
  settlement legs) wait, and the keeper broadcasts them again until the fee falls back under it. A
  production market would set the cap with that trade-off in mind.
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
- **Scope.** Collateral LINK or WBTC, debt DAI (Sepolia). Aave eMode positions are not taken.
- **A falling price is the steward's risk.** Claims are owed in LINK. In a timed model of the verified
  path (simulated, not measured on-chain; one fresh reading before each settlement withdrawal), every
  steward whose top-up lands is repaid in full at constant falls up to **10 % per minute**. Faster than
  about 12 %/min the rescue can't land before Aave liquidates: no steward money is at risk then, but
  there is no rescue either. If a settling steward goes silent and another takes over after 3 minutes,
  up to **5 %/min**; if nobody takes over, the fallback only protects in slow markets (≤ 0.5 %/min).
- **NEAR Intents delivery is simulated on testnets; the quote is real.** NEAR Intents has no testnet.
  When a steward lacks the asset, it asks the real 1Click API for a **dry** quote (nothing deposited)
  for the same asset on Ethereum mainnet, paid in USDC on NEAR, and logs it (e.g. 31.58 LINK for 344.49
  USDC, about 134 bps all-in, ~19 s). A faucet mint then delivers the test tokens, and the log says so.
  On Ethereum mainnet the delivery is real: USDC on NEAR is swapped through 1Click and delivered as ETH,
  capped per swap, with the steward's own capital as the fallback if it arrives late.
- **Sepolia prices are fixed.** Its Aave oracle is admin-only, so on Sepolia a borrow moves the health
  factor; price falls are staged on the fork.
- **Bids are public.** NEAR contract state and transaction arguments are public, so every steward can
  see the others' premiums. Undercutting is what lowers the borrower's premium, but open bids also let
  a steward wait and undercut the best bid by a hair at the last moment, which discourages honest early
  bids.

## When something outside Stead fails

Stead leans on services it doesn't run. When one of them fails, a rescue is delayed; nobody's money
or bond is lost because of it.

- **OutLayer fails or is slow.** A proof request that fails is refunded by OutLayer and asked again.
  A top-up is confirmed by the first proof that shows the collateral increase, whenever it lands, and a
  rescue on a verified market can only be expired by a proof from after the deadline that shows no
  top-up, or by anyone after a 15-minute grace. So a steward that topped up in time keeps its bond
  through an outage. Seen once on testnet (2026-11-11): about 7 minutes of failed executions; the
  rescue's claim opened late, nothing was lost.
- **The keeper stops.** It's only one caller among many: anyone can ask for a verified reading
  (`request_verified`, paying OutLayer's fee) or send the next queued payout (`pay_next`). The contract
  checks the proof or the queue, not who called. Until the temporary reporter's nonce confirmations are
  replaced by proofs, a stopped keeper does hold up the borrower's own signed transactions.
- **A public RPC throttles or drops.** Bots back off and retry; the site's pages fall back to a second
  public RPC. Decisions never rest on a single RPC: a proof needs at least three that agree.
- **A NEAR Intents solver is late (mainnet).** The steward tops up from its own capital after 60 s; a
  late delivery arrives as ETH in its wallet and isn't lost.
- **Ethereum is congested.** Transactions wait longer; each position's transactions still land in
  nonce order; a stuck settlement leg can be re-signed with a higher fee, and a stuck borrower
  transaction cancelled after 10 minutes (a zero-value transaction takes its nonce).

## Roadmap

Planned, not built.

- **Sealed bids in a TEE.** Stead already uses OutLayer (Intel TDX, attestation published by
  OutLayer) for verified readings. An OutLayer program would generate an auction key inside the TEE and
  publish its public key; each steward posts its bid encrypted to that key, with its bond, in one
  transaction; when the window closes the contract hands the encrypted bids to the program, which
  decrypts them inside the TEE and returns only the winning bids. The contract still checks the cap
  and the borrower's guarantee on chain for those bids, so a faulty result can't make the borrower worse
  off, and losing bids are never revealed. If the TEE doesn't answer in time, stewards can reveal their
  own bids so a rescue never stalls.
- **Stablecoin top-ups.** A top-up in a stablecoin doesn't fall with the collateral, which lowers the
  steward's risk and the premium. The claim format (`{asset, amount, premium}`) already supports it. A
  steward could borrow USDC on RHEA Lending (NEAR) and supply it as Aave collateral on the position's
  chain.
- **Capital-efficient stewards via RHEA Lending.** Steward capital earns yield in RHEA Lending while
  idle. The steward keeps a ready buffer for one rescue on the target chain and pays the top-up from it;
  after a win it borrows against its RHEA deposit and routes the asset through NEAR Intents to refill the
  buffer, the just-in-time pattern RHEA's lending-backed Intents solvers use. Lower idle cost means
  lower premiums for borrowers. Capital parked in RHEA Lending carries that protocol's risk.
- **Protect positions people already have.** Stead protects positions at an address only the contract
  signs for, so an existing Aave position has to move in first. A migration would do it in one
  transaction: a flash loan repays the old loan, the collateral moves into a new protected position, and
  the debt is re-borrowed there.
- **Opening mainnet.** The mainnet contract starts closed on purpose: a $150 size cap and an allow-list
  with only our borrower, for the recorded runs (three completed rescues). Both are owner settings, bounded in the code. After
  the runs: a modest cap with the allow-list off, so anyone can protect a position; then higher caps as
  independent stewards bring capital (registration is open; the five running today are example
  strategies) and after a contract audit.
- **More positions on mainnet.** Any Aave V3 position (outside eMode) can be protected: a Stead market
  is only a configuration (the pool, the collateral and debt assets, the gas and rescue parameters),
  added by the owner without new contract code, and a steward serves whichever market it is pointed at. Mainnet runs one market today (WETH collateral, USDC
  debt, Aave V3 Ethereum); adding the other collateral and debt pairs is part of the post-hackathon plan.
- **Other DeFi lending markets.** A market is a lending pool, its two assets and its parameters; Aave V3 on
  any EVM chain is a configuration, and other lenders need their own action encoding.
- **Stead markets for RHEA Lending.** RHEA Lending lives on NEAR, so a Stead market there could read
  the health factor directly by cross-contract view: no chain signatures, no proofs, and top-ups
  attributable on chain.

## The other entry

Samuel Chuku, who built Stead, is also a contributor to **ProofStream on NEAR**, a separate NEAR HACKATHON entry: milestone payouts for open-source work, released by verified GitHub facts and two independent AI reviews. The two share no code, accounts or keys.
- **ProofStream repository:** https://github.com/Samuel-Chuku/proofstream-near
- **Website:** https://near.proofstream.site

## Repository

| Path | What |
|---|---|
| `contract/` | NEAR contract (Rust, near-sdk 5.30.0, omni-transaction 0.5.0): a thin `#[near]` wrapper |
| `contract/core/` | `stead-core`: every rule (allow-list, nonces, claim lock, auction, claims, escrow, settlement) as plain Rust |
| `verifier/` | The OutLayer proof program: block-header agreement, storage proofs, Aave health factor from raw storage |
| `stewards/` | Keeper and steward bots (TypeScript); `deploy/` holds the container and systemd setup |
| `fork/` | Local Sepolia fork with a settable price feed (anvil, chain id 31337) |
| `evidence/` | Replays on real 2026 prices, stress-test output, recorded runs re-read on chain (`stewards/scripts/evidence.ts`) |
| `web/` | Front end (TypeScript, Vite): the live board (LIVE, DEMO, REPLAY), the list pages, how it works, the mainnet panel, and the position dashboards for testnet and mainnet (NEAR wallets through NEAR Connector, an optional Ethereum wallet) |

## Built with

- **Contract:** near-sdk 5.30.0, omni-transaction 0.5.0 (EVM transaction building), borsh, serde.
- **Proof program:** rlp, tiny-keccak, serde; runs on OutLayer.
- **Bots and scripts:** viem 2.57.7, near-api-js 7.3.1; tests with vitest; Foundry's anvil for the local fork.
- **Front end:** TypeScript, Vite 8, viem 2.57.7, @hot-labs/near-connect 0.12.0 (NEAR wallets), the ethereumjs VM for in-browser simulation, qrcode-generator 1.4.4.
- **NEAR services:** chain signatures (MPC `v1.signer` on mainnet, `v1.signer-prod.testnet` on testnet), OutLayer (TEE-verified reads), NEAR Intents 1Click (steward capital), NEAR AI Cloud (steward risk tuning, on for the mainnet and testnet stewards).
- **AI-assisted code:** the team designed the idea, the framework, the rescue economics and the front end; an AI coding assistant (Claude Code) helped write the code under the team's direction and review.

## Provenance: what came from the feasibility spike

Eligible work counts from Oct 19. These files were written during the pre-hackathon spike (Oct 29)
and copied in unchanged on Nov 4 (the repo's first commit). Everything else in the repo is new.

| File | From the spike | Notes |
|---|---|---|
| `contract/src/lib.rs` | `contract/src/lib.rs` | Spike contract: `sign_evm_tx` + claim rule. **Rewritten Nov 4** as the Stead wrapper; kept from the spike: the MPC request shape, gas/deposit constants, build-then-hash flow. `git diff $(git rev-list --max-parents=0 HEAD) -- contract/src/lib.rs` shows the change. |
| `contract/Cargo.toml`, `contract/Cargo.lock` | same | Dependency pins (Nov 4: crate renamed `stead`, workspace with `core/` added; same near-sdk / omni-transaction pins) |
| `fork/src/MockAggregator.sol` | `fork/src/MockAggregator.sol` | 10-line settable price feed |
