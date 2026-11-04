#!/usr/bin/env bash
# Usage: set-price.sh <usd>   e.g. set-price.sh 25.08   (8-decimal Chainlink format)
. "$(dirname "$0")/common.sh"
usd="${1:?usage: set-price.sh <usd>}"
[ -f "$STATE_DIR/mock.addr" ] || { echo "run setup-oracle.sh first"; exit 1; }
raw=$(python3 -c "from decimal import Decimal as D;print(int(D('$usd')*10**8))")
tx=$(cast send "$(cat "$STATE_DIR/mock.addr")" 'setAnswer(int256)' "$raw" --unlocked --from "$FORK_ADMIN" -r "$FORK_RPC_URL" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
echo "LINK = \$$usd (oracle $(cast call "$AAVE_ORACLE" 'getAssetPrice(address)(uint256)' "$LINK" -r "$FORK_RPC_URL" | awk '{print $1}')) tx $tx"
