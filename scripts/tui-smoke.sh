#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${LAOHUANG_SMOKE_SESSION:-laohuang-smoke-$$}"
SMOKE_COMMAND="${LAOHUANG_SMOKE_COMMAND:-node apps/cli/dist/bin.js}"
SMOKE_SLEEP="${LAOHUANG_SMOKE_SLEEP:-1}"
SMOKE_STEP_SLEEP="${LAOHUANG_SMOKE_STEP_SLEEP:-0.2}"
SMOKE_HOLD="${LAOHUANG_SMOKE_HOLD:-2}"
STATUS_FILE="$(mktemp -t laohuang-tui-smoke.XXXXXX)"
SMOKE_CONFIG_ROOT="$(mktemp -d -t laohuang-tui-config.XXXXXX)"
INTERACTIVE_SMOKE=1

if [[ -n "${LAOHUANG_SMOKE_COMMAND:-}" ]]; then
  INTERACTIVE_SMOKE=0
fi

cd "$ROOT_DIR"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for terminal smoke tests" >&2
  exit 1
fi

cleanup() {
  tmux kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
  rm -f "$STATUS_FILE"
  rm -rf "$SMOKE_CONFIG_ROOT"
}
trap cleanup EXIT

if [[ "${LAOHUANG_SMOKE_SKIP_BUILD:-0}" != "1" ]]; then
  npm run build
fi

if [[ "$INTERACTIVE_SMOKE" == "1" ]]; then
  mkdir -p "$SMOKE_CONFIG_ROOT/laohuang"
  chmod 700 "$SMOKE_CONFIG_ROOT/laohuang"
  printf '%s\n' \
    '{"version":1,"active_profile":"default","profiles":{"default":{"provider":"deepseek","model":"deepseek-v4-flash","base_url":null}}}' \
    > "$SMOKE_CONFIG_ROOT/laohuang/config.json"
  printf '%s\n' \
    '{"version":2,"providers":{"deepseek":{"type":"api_key","key":"offline-smoke-placeholder"}}}' \
    > "$SMOKE_CONFIG_ROOT/laohuang/credentials.json"
  chmod 600 \
    "$SMOKE_CONFIG_ROOT/laohuang/config.json" \
    "$SMOKE_CONFIG_ROOT/laohuang/credentials.json"
  smoke_config_quoted="$(printf "%q" "$SMOKE_CONFIG_ROOT")"
  SMOKE_COMMAND="XDG_CONFIG_HOME=$smoke_config_quoted $SMOKE_COMMAND"
fi

validate_capture() {
  local label="$1"
  local capture="$2"
  local prompt_count

  if printf '%s\n' "$capture" | grep -Eq '[╭╮╰╯│]'; then
    echo "terminal smoke ($label): global frame glyph detected" >&2
    return 1
  fi
  if printf '%s\n' "$capture" | grep -Eq '^[[:space:]]+[0-9]+[.)][[:space:]]'; then
    echo "terminal smoke ($label): numbered interactive list detected" >&2
    return 1
  fi
  if printf '%s\n' "$capture" | grep -Eq '\[\?[0-9;]*[[:alpha:]]|\[>[0-9;]+[[:alpha:]]|_pi:'; then
    echo "terminal smoke ($label): terminal negotiation fragment detected" >&2
    return 1
  fi
  prompt_count="$(printf '%s\n' "$capture" | grep -o '❯' | wc -l | tr -d ' ' || true)"
  if [[ "${prompt_count:-0}" -gt 1 ]]; then
    echo "terminal smoke ($label): duplicated prompt detected" >&2
    return 1
  fi
}

capture_and_validate() {
  local label="$1"
  local expected="${2:-}"
  local capture
  capture="$(tmux capture-pane -t "$SESSION_NAME" -p -S -200)"
  validate_capture "$label" "$capture"
  printf '%s\n' "$capture"
  if [[ -n "$expected" ]] && ! printf '%s\n' "$capture" | grep -F "$expected" >/dev/null; then
    echo "terminal smoke ($label): expected surface was not rendered" >&2
    return 1
  fi
}

status_file_quoted="$(printf "%q" "$STATUS_FILE")"
smoke_hold_quoted="$(printf "%q" "$SMOKE_HOLD")"
tmux new-session -d -s "$SESSION_NAME" -x 80 -y 24 \
  bash -lc "{ $SMOKE_COMMAND; }; status=\$?; printf '%s' \"\$status\" > $status_file_quoted; sleep $smoke_hold_quoted"
sleep "$SMOKE_SLEEP"

if [[ "$INTERACTIVE_SMOKE" == "1" ]]; then
  capture_and_validate "startup"
  tmux send-keys -t "$SESSION_NAME" "/"
  sleep "$SMOKE_STEP_SLEEP"
  capture_and_validate "slash completion"
  tmux send-keys -t "$SESSION_NAME" Escape
  sleep 0.1
  tmux send-keys -t "$SESSION_NAME" BSpace
  sleep 0.1
  tmux send-keys -t "$SESSION_NAME" "/help" Enter
  sleep "$SMOKE_STEP_SLEEP"
  capture_and_validate "help" "/model [provider|model] [model]"
  tmux send-keys -t "$SESSION_NAME" "abc"
  sleep "$SMOKE_STEP_SLEEP"
  capture_and_validate "ascii input"
  tmux send-keys -t "$SESSION_NAME" Escape
  sleep 0.1
  tmux send-keys -t "$SESSION_NAME" BSpace BSpace BSpace
  tmux send-keys -t "$SESSION_NAME" "/exit" Enter
  for _ in {1..20}; do
    if [[ -s "$STATUS_FILE" ]]; then
      break
    fi
    sleep 0.1
  done
  if [[ ! -s "$STATUS_FILE" ]]; then
    echo "terminal smoke: CLI did not exit cleanly" >&2
    exit 1
  fi
else
  capture_and_validate "custom command"
fi

if [[ -s "$STATUS_FILE" ]]; then
  smoke_status="$(<"$STATUS_FILE")"
  if [[ "$smoke_status" != "0" ]]; then
    exit "$smoke_status"
  fi
fi
