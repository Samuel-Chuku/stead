# Stead stewards and keeper

TypeScript processes around the Stead contract on NEAR testnet (`steadfi.testnet`) and a local Sepolia fork (anvil, chain id 31337).

> **Unverified demo mode.** On the local fork, health factors, top-ups, repays and buy-backs are reported by a **TEMPORARY trusted reporter** (the keeper). Verified OutLayer reads replace those reads with OutLayer-verified proofs on Sepolia. Every run prints this label.

| Process | What it does |
|---|---|
| `keeper` | Reporter + relayer + housekeeping. Reports each position's Aave health; broadcasts the MPC-signed txs the contract stores and confirms the position nonce; confirms steward top-ups, settlement repays and buy-backs by reading fork logs itself; closes auctions, expires missed top-ups, signs settlement legs. |
| `steward <name>` | One rule-based steward bot: `patient`, `swift`, `deep` or `pool`. Watches auctions, bids by its strategy, supplies the top-up when it wins, settles its claim when it expires (or early), takes over stalled settlements. |

## Strategies (rule-based)
Each steward computes the borrower's own health factor **net of open claims** before bidding, and the margin above the early-settle level drives what it does:
- **swift** bids first, at a fixed spread.
- **patient** bids in the last 12 s; accepts thin margins, priced higher the thinner the margin.
- **deep** bids only with a comfortable margin and a top-up over $500, at a low premium, full amount.
- **pool** bids a partial amount (40 %) to join coalitions; same margin filter as deep.

## Setup
1. Node ≥ 22, Foundry (`anvil`, `cast`, `forge`), and in `stewards/`: `npm ci`.
2. `.env` at the repo root (copy `.env.example`): `NEAR_*`, `FORK_UPSTREAM_RPC_URL`, `FORK_RPC_URL`.
3. NEAR testnet accounts with keys in `~/.near-credentials/testnet/`: the contract owner, `reporter.<contract>`, `borrower.<contract>`, and the four stewards `<name>.<contract>`.
4. EVM keys: **fork-only** demo keys for the stewards and the borrower, in `.env` as `STEWARD_<NAME>_EVM_KEY` and `BORROWER_EVM_KEY` (never printed). They hold nothing outside the local fork.

## Run
```
npm run keeper                # long-running keeper
npm run steward -- patient    # one long-running steward
```
