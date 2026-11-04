#!/usr/bin/env bash
# Usage: warp.sh <seconds>   advance fork time (EVM side only; the NEAR clock can't be warped).
. "$(dirname "$0")/common.sh"
s="${1:?usage: warp.sh <seconds>}"
before=$(cast block latest -f timestamp -r "$FORK_RPC_URL")
cast rpc evm_increaseTime "$s" -r "$FORK_RPC_URL" >/dev/null; cast rpc evm_mine -r "$FORK_RPC_URL" >/dev/null
echo "fork time $before -> $(cast block latest -f timestamp -r "$FORK_RPC_URL") (+$s s)"
