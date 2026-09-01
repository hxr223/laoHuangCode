#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${LAOHUANG_SMOKE_SESSION:-laohuang-smoke-$$}"
SMOKE_COMMAND="${LAOHUANG_SMOKE_COMMAND:-node apps/cli/dist/bin.js}"
SMOKE_TIMEOUT_SECONDS="${LAOHUANG_SMOKE_TIMEOUT_SECONDS:-5}"
SMOKE_POLL_INTERVAL="${LAOHUANG_SMOKE_POLL_INTERVAL:-0.1}"
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

  if [[ "$INTERACTIVE_SMOKE" == "1" ]] &&
    ! printf '%s\n' "$capture" | grep -Eq '[╭╮╰╯│]'; then
    echo "terminal smoke ($label): framed tui surface missing" >&2
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
  prompt_count="$(printf '%s\n' "$capture" | grep -o '│> ' | wc -l | tr -d ' ' || true)"
  if [[ "${prompt_count:-0}" -gt 1 ]]; then
    echo "terminal smoke ($label): duplicated prompt detected" >&2
    return 1
  fi
}

capture_and_validate() {
  local label="$1"
  local expected="${2:-}"
  local forbidden="${3:-}"
  local capture
  local deadline=$((SECONDS + SMOKE_TIMEOUT_SECONDS))

  while true; do
    capture="$(tmux capture-pane -t "$SESSION_NAME" -p -S -200)"
    if { [[ -z "$expected" ]] || printf '%s\n' "$capture" | grep -F "$expected" >/dev/null; } &&
      { [[ -z "$forbidden" ]] || ! printf '%s\n' "$capture" | grep -F "$forbidden" >/dev/null; }; then
      validate_capture "$label" "$capture"
      printf '%s\n' "$capture"
      return 0
    fi
    if (( SECONDS >= deadline )); then
      break
    fi
    sleep "$SMOKE_POLL_INTERVAL"
  done

  printf '%s\n' "$capture" >&2
  echo "terminal smoke ($label): timed out waiting for expected surface" >&2
  return 1
}

status_file_quoted="$(printf "%q" "$STATUS_FILE")"
smoke_hold_quoted="$(printf "%q" "$SMOKE_HOLD")"
tmux new-session -d -s "$SESSION_NAME" -x 80 -y 24 \
  bash -lc "{ $SMOKE_COMMAND; }; status=\$?; printf '%s' \"\$status\" > $status_file_quoted; sleep $smoke_hold_quoted"

if [[ "$INTERACTIVE_SMOKE" == "1" ]]; then
  capture_and_validate "startup" "Welcome to LaoHuang Code!"
  tmux send-keys -t "$SESSION_NAME" "/"
  capture_and_validate "slash completion" "› /apikey"
  tmux send-keys -t "$SESSION_NAME" Escape
  capture_and_validate "dismiss slash completion" "│> /" "› /apikey"
  tmux send-keys -t "$SESSION_NAME" BSpace
  tmux send-keys -t "$SESSION_NAME" "/help" Enter
  capture_and_validate "help" "/model [provider|model] [model]"
  tmux send-keys -t "$SESSION_NAME" "abc"
  capture_and_validate "ascii input" "│> abc"
  tmux send-keys -t "$SESSION_NAME" BSpace BSpace BSpace
  tmux send-keys -t "$SESSION_NAME" "/exit" Enter
  exit_deadline=$((SECONDS + SMOKE_TIMEOUT_SECONDS))
  while [[ ! -s "$STATUS_FILE" ]] && (( SECONDS < exit_deadline )); do
    sleep "$SMOKE_POLL_INTERVAL"
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
