# Shared setup for fork scripts. Loads ../.env (gitignored) and the public address book.
set -euo pipefail
FORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$FORK_DIR/.." && pwd)"
# shellcheck disable=SC1091
[ -f "$REPO_DIR/.env" ] && set -a && . "$REPO_DIR/.env" && set +a
. "$FORK_DIR/addresses.sh"
FORK_RPC_URL="${FORK_RPC_URL:-http://127.0.0.1:8545}"
FORK_CHAIN_ID="${FORK_CHAIN_ID:-31337}"
STATE_DIR="$FORK_DIR/state"; mkdir -p "$STATE_DIR"
