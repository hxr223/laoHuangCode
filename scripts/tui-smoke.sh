#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${LAOHUANG_SMOKE_SESSION:-laohuang-smoke-$$}"
SMOKE_COMMAND="${LAOHUANG_SMOKE_COMMAND:-node dist/cli.js --version}"
SMOKE_SLEEP="${LAOHUANG_SMOKE_SLEEP:-1}"

cd "$ROOT_DIR"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for terminal smoke tests" >&2
  exit 1
fi

cleanup() {
  tmux kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ "${LAOHUANG_SMOKE_SKIP_BUILD:-0}" != "1" ]]; then
  npm run build
fi

tmux new-session -d -s "$SESSION_NAME" -x 80 -y 24 "$SMOKE_COMMAND"
sleep "$SMOKE_SLEEP"
tmux capture-pane -t "$SESSION_NAME" -p
