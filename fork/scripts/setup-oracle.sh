#!/usr/bin/env bash
# Point the forked AaveOracle's LINK source at a MockAggregator we control. Idempotent.
. "$(dirname "$0")/common.sh"
if [ -f "$STATE_DIR/mock.addr" ] && [ "$(cast call "$AAVE_ORACLE" 'getSourceOfAsset(address)(address)' "$LINK" -r "$FORK_RPC_URL")" = "$(cast to-check-sum-address "$(cat "$STATE_DIR/mock.addr")")" ]; then
  echo "mock oracle already installed: $(cat "$STATE_DIR/mock.addr")"; exit 0; fi
start_price=$(cast call "$AAVE_ORACLE" 'getAssetPrice(address)(uint256)' "$LINK" -r "$FORK_RPC_URL" | awk '{print $1}')
mock=$(cd "$FORK_DIR" && forge create src/MockAggregator.sol:MockAggregator --unlocked --from "$FORK_ADMIN" \
  -r "$FORK_RPC_URL" --broadcast --constructor-args "$start_price" 2>&1 | awk '/Deployed to:/{print $3}')
[ -n "$mock" ] || { echo "MockAggregator deploy failed"; exit 1; }
cast rpc anvil_impersonateAccount "$AAVE_ACL_ADMIN" -r "$FORK_RPC_URL" >/dev/null
cast rpc anvil_setBalance "$AAVE_ACL_ADMIN" 0x56BC75E2D63100000 -r "$FORK_RPC_URL" >/dev/null
is_admin=$(cast call "$AAVE_ACL_MANAGER" 'isPoolAdmin(address)(bool)' "$FORK_ADMIN" -r "$FORK_RPC_URL")
[ "$is_admin" = "true" ] || cast send "$AAVE_ACL_MANAGER" 'addPoolAdmin(address)' "$FORK_ADMIN" --unlocked --from "$AAVE_ACL_ADMIN" -r "$FORK_RPC_URL" >/dev/null
cast rpc anvil_stopImpersonatingAccount "$AAVE_ACL_ADMIN" -r "$FORK_RPC_URL" >/dev/null
cast send "$AAVE_ORACLE" 'setAssetSources(address[],address[])' "[$LINK]" "[$mock]" --unlocked --from "$FORK_ADMIN" -r "$FORK_RPC_URL" >/dev/null
echo "$mock" > "$STATE_DIR/mock.addr"
echo "mock oracle $mock installed for LINK at price $(cast call "$AAVE_ORACLE" 'getAssetPrice(address)(uint256)' "$LINK" -r "$FORK_RPC_URL")"
