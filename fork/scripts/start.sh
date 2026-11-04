#!/usr/bin/env bash
# Start an anvil fork of Sepolia on chain id 31337 (so fork-signed txs can't replay on Sepolia).
. "$(dirname "$0")/common.sh"
: "${FORK_UPSTREAM_RPC_URL:?set FORK_UPSTREAM_RPC_URL in .env}"
if cast chain-id -r "$FORK_RPC_URL" >/dev/null 2>&1; then echo "fork already running at $FORK_RPC_URL"; exit 0; fi
args=(--fork-url "$FORK_UPSTREAM_RPC_URL" --chain-id "$FORK_CHAIN_ID" --port "${FORK_RPC_URL##*:}" --silent --retries 20 --fork-retry-backoff 2000 --timeout 30000)
# Pin a block a few behind head: the public upstream is load-balanced and the newest block
# is often missing on some backends ("block not found" at genesis).
FORK_BLOCK="${FORK_BLOCK:-$(( $(cast block-number -r "$FORK_UPSTREAM_RPC_URL") - 5 ))}"
args+=(--fork-block-number "$FORK_BLOCK")
nohup anvil "${args[@]}" > "$STATE_DIR/anvil.log" 2>&1 &
echo $! > "$STATE_DIR/anvil.pid"
up=0; for _ in $(seq 1 60); do cast chain-id -r "$FORK_RPC_URL" >/dev/null 2>&1 && { up=1; break; }; kill -0 "$(cat "$STATE_DIR/anvil.pid")" 2>/dev/null || break; sleep 1; done
[ "$up" = 1 ] || { echo "fork failed to start; last log lines:"; tail -5 "$STATE_DIR/anvil.log"; exit 1; }
echo "fork up: chain $(cast chain-id -r "$FORK_RPC_URL"), block $(cast block-number -r "$FORK_RPC_URL"), pid $(cat "$STATE_DIR/anvil.pid")"
