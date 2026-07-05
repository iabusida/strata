#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/logs/local-api-stack"

stop_process() {
  local name="$1"
  local pid_file="$RUNTIME_DIR/${name}.pid"

  if [[ ! -f "$pid_file" ]]; then
    echo "[local-api-stack] ${name} not running (no pid file)"
    return
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"

  if [[ -z "$pid" ]]; then
    echo "[local-api-stack] ${name} pid missing; cleaning pid file"
    rm -f "$pid_file"
    return
  fi

  if kill -0 "$pid" 2>/dev/null; then
    echo "[local-api-stack] stopping ${name} (pid ${pid})"
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      echo "[local-api-stack] force-stopping ${name} (pid ${pid})"
      kill -9 "$pid" 2>/dev/null || true
    fi
  else
    echo "[local-api-stack] ${name} already stopped"
  fi

  rm -f "$pid_file"
}

stop_process "funding-flip-monitor"
stop_process "runner-liquidity-monitor"
stop_process "api-server"

echo "[local-api-stack] all services stopped"
