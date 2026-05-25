#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR/apps/api"
LOG_DIR="$ROOT_DIR/data/logs"

mkdir -p "$LOG_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/backfill-$STAMP.log"

cd "$API_DIR"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting candle refresh" | tee -a "$LOG_FILE"
BACKFILL_FAIL_ON_ERRORS=true npm run backfill:candles 2>&1 | tee -a "$LOG_FILE"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] candle refresh completed" | tee -a "$LOG_FILE"
