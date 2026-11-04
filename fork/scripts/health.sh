#!/usr/bin/env bash
# Usage: health.sh <evm address>   prints Aave getUserAccountData on the fork.
. "$(dirname "$0")/common.sh"
a="${1:?usage: health.sh <address>}"
cast call "$AAVE_POOL" 'getUserAccountData(address)(uint256,uint256,uint256,uint256,uint256,uint256)' "$a" -r "$FORK_RPC_URL" | python3 -c '
import sys; v=[int(l.split()[0]) for l in sys.stdin]
print(f"collateral ${v[0]/1e8:,.2f}  debt ${v[1]/1e8:,.2f}  LT {v[3]/1e4:.2%}  HF {v[5]/1e18:.4f}")'
