#!/bin/bash

# Automatic backfill script - runs pending tokens through backfill pipeline
# This script is invoked by cron to gradually fill in missing historical data

set -o errexit

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$PROJECT_ROOT/apps/api"

# Cron shells are minimal; seed common paths and load NVM if available.
export PATH="$HOME/.nvm/versions/node/current/bin:$HOME/.nvm/versions/node/*/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  nvm use --silent default >/dev/null 2>&1 || true
fi

NPM_CMD="$(command -v npm || true)"
if [[ -z "$NPM_CMD" ]]; then
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: npm not found in PATH ($PATH)"
  exit 1
fi

# Log file
LOG_FILE="$PROJECT_ROOT/logs/backfill-auto.log"
mkdir -p "$(dirname "$LOG_FILE")"

{
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] Starting automatic backfill cycle"
  
  cd "$API_DIR"
  
  # Get current pending count
  PENDING_COUNT=$($NPM_CMD run backfill:status pending 1000 2>&1 | grep -o '[A-Z][A-Z0-9]*' | wc -l || echo "unknown")
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] Current pending symbols: $PENDING_COUNT"
  
  # Run backfill for next batch
  # This will backfill roughly 10 tokens at a time via BACKFILL_INCLUDE_SYMBOLS
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] Running backfill batch (up to 10 symbols)..."
  $NPM_CMD run backfill:pending 2>&1 | grep -E "^\[|COMPLETED|NO_DATA|marked as" || true
  
  # Show updated status
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] Backfill cycle complete"
  $NPM_CMD run backfill:status summary 2>&1 | tail -10
  
} >> "$LOG_FILE" 2>&1

echo "[$(date +'%Y-%m-%d %H:%M:%S')] Automatic backfill cycle finished" >> "$LOG_FILE"
