#!/usr/bin/env bash
. "$(dirname "$0")/common.sh"
if [ -f "$STATE_DIR/anvil.pid" ]; then kill "$(cat "$STATE_DIR/anvil.pid")" 2>/dev/null && echo "fork stopped"; rm -f "$STATE_DIR/anvil.pid" "$STATE_DIR/mock.addr"; else echo "no fork pid file"; fi
