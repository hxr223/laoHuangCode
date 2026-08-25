#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${LAOHUANG_SMOKE_SESSION:-laohuang-smoke-$$}"
SMOKE_COMMAND="${LAOHUANG_SMOKE_COMMAND:-node apps/cli/dist/bin.js --version}"
SMOKE_SLEEP="${LAOHUANG_SMOKE_SLEEP:-1}"
SMOKE_HOLD="${LAOHUANG_SMOKE_HOLD:-2}"
STATUS_FILE="$(mktemp -t laohuang-tui-smoke.XXXXXX)"

cd "$ROOT_DIR"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for terminal smoke tests" >&2
  exit 1
fi

cleanup() {
  tmux kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
  rm -f "$STATUS_FILE"
}
trap cleanup EXIT

if [[ "${LAOHUANG_SMOKE_SKIP_BUILD:-0}" != "1" ]]; then
  npm run build
fi

status_file_quoted="$(printf "%q" "$STATUS_FILE")"
smoke_hold_quoted="$(printf "%q" "$SMOKE_HOLD")"
tmux new-session -d -s "$SESSION_NAME" -x 80 -y 24 \
  bash -lc "{ $SMOKE_COMMAND; }; status=\$?; printf '%s' \"\$status\" > $status_file_quoted; sleep $smoke_hold_quoted"
sleep "$SMOKE_SLEEP"
tmux capture-pane -t "$SESSION_NAME" -p

if [[ -s "$STATUS_FILE" ]]; then
  smoke_status="$(<"$STATUS_FILE")"
  if [[ "$smoke_status" != "0" ]]; then
    exit "$smoke_status"
  fi
fi
