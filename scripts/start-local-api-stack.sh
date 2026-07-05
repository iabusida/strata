#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/logs/local-api-stack"

mkdir -p "$RUNTIME_DIR"

start_process() {
  local name="$1"
  local command="$2"
  local pid_file="$RUNTIME_DIR/${name}.pid"
  local log_file="$RUNTIME_DIR/${name}.log"

  if [[ -f "$pid_file" ]]; then
    local existing_pid
    existing_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "[local-api-stack] ${name} already running (pid ${existing_pid})"
      return
    fi
    rm -f "$pid_file"
  fi

  echo "[local-api-stack] starting ${name}"
  nohup bash -lc "cd \"$ROOT_DIR\" && ${command}" >>"$log_file" 2>&1 &
  local new_pid=$!
  echo "$new_pid" >"$pid_file"
  echo "[local-api-stack] ${name} started (pid ${new_pid}, log ${log_file})"
}

start_process "api-server" "npm run start --workspace @strata/api"
start_process "runner-liquidity-monitor" "npm run monitor:runner-liquidity --workspace @strata/api"
start_process "funding-flip-monitor" "npm run monitor:funding-flips --workspace @strata/api"

echo "[local-api-stack] all services started"
echo "[local-api-stack] use ./scripts/stop-local-api-stack.sh to stop"
