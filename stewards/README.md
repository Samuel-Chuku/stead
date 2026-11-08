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
| `steward <name>` | One steward bot: `patient`, `swift`, `deep`, `pool` or `hedged`. Watches auctions on its market, bids by its strategy, supplies the top-up when it wins, settles its claim when it expires (or early), takes over stalled settlements. |

## Strategies
Each steward computes the borrower's own health factor **net of open claims** before bidding; the
margin above the early-settle level drives what it does:
- **swift** bids first, at a fixed spread.
- **patient** bids late; accepts thin margins, priced higher the thinner the margin.
- **deep** bids only with a comfortable margin and a top-up over $500, at a low premium, full amount.
- **pool** bids a partial amount (40 %) to join coalitions; same margin filter as deep.
- **hedged**: shorts the top-up asset while a claim is open, so it can bid the lowest premiums.
  Mechanics shown on testnet; neutrality shown by replaying 2026 price paths.
  Its bid is deep's floor minus the price-risk premium it no longer carries, plus the expected
  funding and fees for a 24 h hold (about 63 bps for LINK). The short is placed after its own top-up
  and sized to the units it is still owed, so every exit closes it. Venue: Orderly **testnet** only
  (`scripts/orderly.ts setup` creates the account; if the venue can't take the hedge, it bids unhedged).

The numbers (spread, minimum margin, minimum top-up, share, bid delay) are data with fixed bounds
(`src/risk.ts`). A steward's risk limit per rescue is `STEWARD_<NAME>_CAPACITY` (whole LINK); above
it, the steward bids only part, so several stewards share the rescue.

**Capital (NEAR Intents: real quote, simulated delivery).** When a winning steward holds less than it
must supply, it sources the shortfall. It asks the NEAR Intents 1Click API for a **dry** quote (nothing is
deposited) for the same asset on Ethereum mainnet, paid in USDC on NEAR, and logs the price and time
(about 130–165 bps all-in, ~19 s, without a partner key). No NEAR Intents testnet exists, so a test-token
faucet mint then delivers the tokens, labelled `SIMULATED delivery` in the log. `STEWARD_INTENTS_ACCOUNT`
sets the refund account named in the quote (default `stead-steward.near`; a dry quote moves nothing).

**Optional AI tuning** (`src/ai.ts`). Off unless an API key is set. Every 5 minutes a steward asks a
model for new settings, from any OpenAI-compatible endpoint:

| Setting | Default | |
|---|---|---|
| `AI_BASE_URL` | `https://cloud-api.near.ai/v1` | OpenAI, OpenRouter, Groq, Together, a local Ollama… |
| `AI_API_KEY` | | the provider's key (`NEAR_AI_API_KEY` also works, for NEAR AI only) |
| `AI_MODEL` / `AI_FALLBACK_MODEL` | `z-ai/glm-5.3-flash` / `Qwen/Qwen3.6-35B-A3B-FP8` on NEAR AI | |
| `AI_REQUIRE_SIGNATURE` | `true` | apply an answer only with a valid response signature |

NEAR AI Cloud signs each response: the answer is applied only when the signature covers the exact
request and response bytes. Other providers sign nothing, so their answers are logged and never applied
unless you set `AI_REQUIRE_SIGNATURE=false`; every adjustment is then labelled **UNVERIFIED**. Either way
the result is clamped to the bounds and the contract caps every premium. Records go to
`logs/ai-<steward>.jsonl`. Our own stewards run NEAR AI with the signature required.

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

## Run your own steward

Anyone can join the Sepolia market of `steadfi.testnet` (market 2) and compete with our four. Testnet
funds only.

1. **A NEAR testnet account** with a full-access key in `~/.near-credentials/testnet/<account>.json`
   (`near account create-account sponsor-by-faucet-service <name>.testnet …`). It needs about 0.5 NEAR:
   0.005 to register, and a 0.1 NEAR bond per bid, returned after the auction (or after your top-up
   if you win).
2. **A Sepolia wallet** (a new key, nothing else on it) with about 0.005 Sepolia ETH for gas. Test LINK
   and DAI come from Aave's Sepolia faucet: `STEWARD_FUND_ON_START=true` mints them and approves the
   Pool on the first start.
3. **A `.env`** at the repo root:
   ```
   STEAD_EVM=sepolia
   STEWARD_ACCOUNT=<name>.testnet
   STEWARD_EVM_KEY=0x…                # the Sepolia wallet; claims are paid out to it
   STEWARD_FUND_ON_START=true
   # optional: STEWARD_CAPACITY=20 (whole LINK per rescue)
   # optional: STEWARD_SETTINGS={"spreadBps":250,"bidDelayS":10}   clamped to src/risk.ts bounds
   ```
4. **Start it** with a strategy (`swift`, `patient`, `deep` or `pool`) as the starting point:
   ```
   cd stewards && npm ci --ignore-scripts && npm run steward -- deep
   ```
   or in a container, from the repo root:
   ```
   docker build -f stewards/deploy/Dockerfile -t stead-bots .
   docker run -d --restart always --name my-steward -v "$PWD/.env:/app/.env:ro" \
     -v ~/.near-credentials/testnet:/secrets/near:ro -e NEAR_CREDENTIALS_DIR=/secrets/near \
     stead-bots scripts/steward.ts deep
   ```

On first start the bot calls `register_steward` (deposit 0.005 NEAR, payout = your Sepolia wallet);
`STEWARD_AUTO_REGISTER=false` stops it from spending the deposit.

- **What you'll see.** Each auction it watches, its decision and why; a bid, a win, the top-up on
  Sepolia, then a claim NFT in your NEAR account.
- **How you get paid.** When the borrower buys back, the contract pays your Sepolia wallet exactly the
  owed amount. If not, your bot settles when the window ends and withdraws the owed LINK.
- **What you risk.** Claims are owed in LINK, so a falling LINK price is your risk. A winner that misses
  its top-up deadline loses its 0.1 NEAR bond.
- **The owner's power.** The contract owner can remove a steward. That stops its new bids only; open
  claims, bonds and payouts are untouched.
