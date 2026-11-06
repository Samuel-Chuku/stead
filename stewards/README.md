# Stead stewards and keeper

TypeScript processes around the Stead contract on NEAR testnet (`steadfi.testnet`). They run against
Sepolia (`STEAD_EVM=sepolia`) or a local Sepolia fork (anvil, chain id 31337, the default).

> **Trust labels.** On Sepolia, Aave readings (health factor, top-ups, buy-back balances) come from
> verified OutLayer proofs; transaction nonces and settlement repays are still confirmed by a
> **TEMPORARY trusted reporter** (the keeper). On the local fork the reporter reports everything
> (**unverified demo mode**). Every log line prints its mode's label.

| Process | What it does |
|---|---|
| `keeper` | Reporter, relayer and housekeeping. Requests verified readings (Sepolia) or reports health (fork); broadcasts the MPC-signed txs the contract stores and confirms the position nonce; watches EVM logs for top-ups, repays and buy-back payments; closes auctions, expires missed top-ups, signs settlement legs. |
| `steward <name>` | One steward bot: `patient`, `swift`, `deep` or `pool`. Watches auctions on its market, bids by its strategy, supplies the top-up when it wins, settles its claim when it expires (or early), takes over stalled settlements. |

## Strategies
Each steward computes the borrower's own health factor **net of open claims** before bidding; the
margin above the early-settle level drives what it does:
- **swift** bids first, at a fixed spread.
- **patient** bids late; accepts thin margins, priced higher the thinner the margin.
- **deep** bids only with a comfortable margin and a top-up over $500, at a low premium, full amount.
- **pool** bids a partial amount (40 %) to join coalitions; same margin filter as deep.

The numbers (spread, minimum margin, minimum top-up, share, bid delay) are data with fixed bounds
(`src/risk.ts`). A steward's risk limit per rescue is `STEWARD_<NAME>_CAPACITY` (whole LINK); above
it, the steward bids only part, so several stewards share the rescue.

**Capital (simulated NEAR Intents).** When a winning steward holds less than it must supply, it sources
the shortfall. No NEAR Intents testnet exists, so a test-token faucet mint stands in, labelled
`SIMULATED NEAR Intents` in the log.

**Optional AI tuning.** With `NEAR_AI_API_KEY` set, each steward asks a TEE-hosted model on NEAR AI
Cloud every 5 minutes for new settings (`src/ai.ts`). An answer is applied only when its signature
covers the exact request and response bytes; it is then clamped to the bounds. Records go to
`logs/ai-<steward>.jsonl` with the model's reason and a `cloud.near.ai/verify` link.

## Setup
1. Node ≥ 22; in `stewards/`: `npm ci --ignore-scripts`. For the fork, Foundry (`anvil`, `cast`).
2. `.env` at the repo root, from `.env.example`.
3. NEAR testnet accounts with keys in `~/.near-credentials/testnet/` (or `NEAR_CREDENTIALS_DIR`): the
   contract owner, `reporter.<contract>`, `borrower.<contract>`, and the four stewards `<name>.<contract>`.
4. EVM keys for the stewards and the borrower in `.env` as `STEWARD_<NAME>_EVM_KEY` and
   `BORROWER_EVM_KEY`. **Testnet funds only**: on Sepolia they need a little Sepolia ETH for gas; test
   LINK and DAI come from Aave's Sepolia faucet.
5. Sepolia only: the keeper's NEAR account (or `VERIFY_PAYER`) must be allowed to use the proof
   program's OutLayer secret (the keyed Sepolia RPC).

## Run
```
npm run keeper                                  # long-running keeper (fork)
npm run steward -- patient                      # one long-running steward (fork)
STEAD_EVM=sepolia npm run keeper                # the same against Sepolia
```

As services (containers or systemd), with restart on crash and rotated logs: [deploy/README.md](deploy/README.md).
Run one set of keeper and stewards per market: two sets would act on the same positions.
