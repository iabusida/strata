#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR/apps/api"
LOG_DIR="$ROOT_DIR/data/logs"

mkdir -p "$LOG_DIR"

SYNC_LOOKBACK_DAYS="${SYNC_LOOKBACK_DAYS:-7}"
EXPORT_LOOKBACK_DAYS="${EXPORT_LOOKBACK_DAYS:-90}"
EXPORT_JSON_PATH="${EXPORT_JSON_PATH:-hl-candles-db-universe.json}"
BACKFILL_FAIL_ON_ERRORS="${BACKFILL_FAIL_ON_ERRORS:-false}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/sync-$STAMP.log"

cd "$API_DIR"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting incremental candle sync" | tee -a "$LOG_FILE"
BACKFILL_LOOKBACK_DAYS="$SYNC_LOOKBACK_DAYS" BACKFILL_FAIL_ON_ERRORS="$BACKFILL_FAIL_ON_ERRORS" npm run backfill:candles 2>&1 | tee -a "$LOG_FILE"
EXPORT_LOOKBACK_DAYS="$EXPORT_LOOKBACK_DAYS" EXPORT_JSON_PATH="$EXPORT_JSON_PATH" npm run export:candles 2>&1 | tee -a "$LOG_FILE"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] incremental candle sync completed" | tee -a "$LOG_FILE"
