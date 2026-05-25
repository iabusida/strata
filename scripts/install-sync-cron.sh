#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRON_FILE="$ROOT_DIR/ops/hype-trading.cron"

if [[ ! -f "$CRON_FILE" ]]; then
  echo "missing cron file: $CRON_FILE" >&2
  exit 1
fi

crontab "$CRON_FILE"
crontab -l
