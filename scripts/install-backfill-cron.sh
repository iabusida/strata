#!/bin/bash

# Install automatic backfill cron job for the hype-trading system
# This job runs every 4 hours to gradually backfill missing historical data

set -o errexit

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CRON_FILE="$PROJECT_ROOT/ops/hype-backfill.cron"

if [ ! -f "$CRON_FILE" ]; then
  echo "Error: $CRON_FILE not found"
  exit 1
fi

echo "Installing automatic backfill cron job..."
echo "  Job: Run backfill batch every 4 hours"
echo "  Script: $PROJECT_ROOT/scripts/backfill-auto.sh"
echo "  CronTab: $(cat "$CRON_FILE")"
echo ""

# Add to crontab (avoiding duplicates)
crontab -l 2>/dev/null | grep -v "backfill-auto.sh" | crontab - || true
(crontab -l 2>/dev/null; cat "$CRON_FILE") | crontab - || true

echo "✓ Backfill cron job installed successfully"
echo ""
echo "To view installed cron jobs:"
echo "  crontab -l"
echo ""
echo "To remove the cron job:"
echo "  crontab -e  # and manually delete the backfill-auto.sh line"
echo ""
echo "To check backfill logs:"
echo "  tail -f $PROJECT_ROOT/logs/backfill-auto.log"
