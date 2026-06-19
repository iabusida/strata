# Hyperliquid Three-Timeframe RSI Scanner (TypeScript + Node.js + Next.js)

This project scans Hyperliquid markets with a multi-timeframe trend alignment system and simulates trade selection with asset-aware TP targets and capital-constrained candidate ranking:

- **Macro (4h)**: Identifies long-term trend direction via Stochastic RSI
- **Intermediary (1h)**: Confirms momentum extremes with RSI/Stochastic RSI overbought/oversold
- **Micro Trigger (15m)**: Detects fresh Stochastic RSI crossovers for precise entry signals

The system generates directional signals, computes confluence scores, hard-filters weak setups by TP feasibility, and selects trades using a weighted ranking model rather than volume order.

## Stack

- API: Node.js + Express + TypeScript
- Market data & RSI/Stochastic RSI: [hyperliquid](https://www.npmjs.com/package/hyperliquid) SDK + `technicalindicators`
- Frontend: Next.js + TypeScript + Tailwind CSS

## Project Structure

- `apps/api`: Backend service (Hyperliquid integration, RSI scan engine, REST API, CLI)
- `apps/web`: Next.js dashboard for visual signal exploration
- `docs/signal-and-simulation-logic.md`: current production signal, ranking, and trade-simulation rules

## Quick Start

1. Install dependencies

```bash
npm install
```

2. (Optional) Set environment variables

```bash
cp .env.example .env
```

3. Run API + frontend concurrently

```bash
npm run dev
```

Or run with automatic port cleanup (recommended):

```bash
npm run dev:clean
```

- API: `http://localhost:8787`
- Web: `http://localhost:3000`

## Useful Commands

```bash
# Run only API
npm run dev:api

# Run only frontend
npm run dev:web

# Clean-start both services (kills stale :8787 and :3000 listeners)
npm run dev:clean

# CLI RSI scan with multiframe alignment
npm run scan -- --query BTC --market perp --limitTokens 20 --onlySignals true

# Type checking
npm run typecheck

# Refresh simulation candles (strict mode, fails on partial backfill errors)
npm run refresh:data

# Incremental candle sync for scheduled jobs (default: fetch last 7 days, export last 90 days)
npm run sync:data
```

## Keeping Data Fresh

Live scanning signals do not read from `hl-candles*.json`. They are fetched directly from Hyperliquid during each scan.

Schedule data refresh only if you rely on simulator inputs or offline analysis files.

Recommended workflow:
- Run a full 90-day backfill once.
- After that, run incremental syncs that fetch only recent candles and then re-export a 90-day simulation file from the database.

Recommended cadence:
- Every 2-4 hours for active tuning.
- Daily for lower-frequency strategy review.

Example cron (every 4 hours):

```bash
0 */4 * * * cd /Users/islam/dev/hype-trading && npm run sync:data
```

Sync logs are written to `data/logs/sync-YYYYMMDD-HHMMSS.log`.

Useful env overrides for scheduled sync:
- `SYNC_LOOKBACK_DAYS=7`
- `EXPORT_LOOKBACK_DAYS=90`
- `EXPORT_JSON_PATH=hl-candles-db-universe.json`

## Automatic Historical Data Backfill

The system automatically backfills missing 90-day historical data for all tokens. This happens in the background during normal scan operations and via scheduled cron jobs.

**How it works:**
1. During each scan cycle, the system checks if tokens have 90+ days of data
2. Tokens missing data are marked for backfilling
3. A cron job runs every 2 hours to backfill pending tokens (typically 10 at a time)
4. Once a token has complete data, it's marked COMPLETED and future scans only fetch real-time updates

**Installation:**
```bash
cd apps/api
bash scripts/install-backfill-cron.sh
```

This installs a cron job that runs every 2 hours: `0 */2 * * * /bin/bash /Users/islam/dev/hype-trading/scripts/backfill-auto.sh`

**Monitoring backfill progress:**
```bash
cd apps/api

# Quick status summary
npm run backfill:info

# Show which tokens still need backfilling
npm run backfill:status pending 20

# View detailed status of a token
npm run backfill:status status BTC

# Check cron logs
tail -f logs/backfill-auto.log
```

**Manual backfill trigger**:
```bash
npm run backfill:candles
```

Targeted backfill (recommended for focused replay requests):
```bash
BACKFILL_INCLUDE_SYMBOLS=OM,AI,AIXBT,MANA,MANTA npm run backfill:candles
```

**Mark tokens as unavailable** (too new, no historical data):
```bash
npm run backfill:status skip NEWTOKEN "Listed < 7 days ago"
```

Backfill logs are written to `logs/backfill-auto.log`.

## Session Handoff (2026-05-31)

Recent strategy/runtime changes to preserve context for the next session:

- Violent-move Telegram alerts were added in the trade engine:
  - READY: `VIOLENT_MOVE_LONG_STOCH_UP`
  - CAUTION: `VIOLENT_MOVE_VOLATILITY_COOLDOWN`
- New strict runtime keys were introduced and seeded via migration:
  - `apps/api/prisma/migrations/20260531114500_add_violent_move_runtime_settings/migration.sql`
- Trade entry guard was strengthened to reject lower-timeframe continuation entries when 12h/1d reversal pressure is detected.
- Historical replay findings (last 72h with current thresholds):
  - 494 violent-move READY events
  - 0 CAUTION-triggered exits
  - Most outcomes resolve as `NO_CAUTION_WITHIN_WINDOW` (not unresolved)
- Symbol naming caveat: expected names like AIA/MANTRA may differ from exchange symbols; use `BACKFILL_INCLUDE_SYMBOLS` with exchange symbols.

Suggested first checks next session:

1. Confirm symbol mapping for requested assets (for example MANTRA -> `OM` where applicable).
2. Re-run replay after targeted backfill for requested symbols.
3. If needed, extend HTF guard to include 3d/1w bias gating.

## API Endpoints

### `GET /api/v1/forecast/:symbol/:interval?`

Halal-safe momentum forecast endpoint for analysis only.

- No betting or trade recommendation fields are returned.
- Response includes directional bias and percentage probabilities for `up`, `down`, and `sideways`.

Path/query params:

- `symbol`: asset symbol, e.g. `BTC`, `AAPL`
- `interval` (optional path): `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`, `2w`, `1m`
- `assetType` (optional query): `CRYPTO` (default) or `STOCK`

Interval normalization at API boundary:

- `5m` -> `M15` (fallback to available 15m candle granularity)
- `15m` -> `M15`
- `30m` -> `M15` aggregated by 2
- `1h` -> `H1`
- `2h` -> `H1` aggregated by 2
- `4h` -> `H4`
- `6h` -> `H1` aggregated by 6
- `8h` -> `H1` aggregated by 8
- `12h` -> `H12`
- `1d` -> `D1`
- `3d` -> `D1` aggregated by 3
- `1w` -> `D1` aggregated by 7
- `2w` -> `D1` aggregated by 14
- `1m` -> `D1` aggregated by rolling 30 days

Example:

```bash
curl "http://localhost:8787/api/v1/forecast/BTC/15m?assetType=CRYPTO"
```

Sample response fields:

- `symbol`, `assetType`, `intervalRequested`, `intervalUsed`
- `candlesUsed`, `latestPrice`
- `forecast.directionBias`
- `forecast.probabilitiesPct.up|down|sideways`
- `forecast.momentumScore`
- `notes` (explicit analysis-only framing)

### `GET /api/v1/kalshi/predict/:symbol`

Deprecated and intentionally disabled.

- Returns HTTP `410 Gone`
- Use `/api/v1/forecast/:symbol/:interval?` instead

### `GET /health`

Basic health check.

### `GET /api/tokens`

Query params:

- `query` (optional): search string
- `market` (optional): `perp` or `spot` (default: `perp`)

Example:

```bash
curl "http://localhost:8787/api/tokens?market=perp&query=SOL"
```

### `GET /api/rsi`

Query params:

- `query` (optional): token name filter
- `market`: `perp` or `spot` (default: `perp`)
- `limitTokens`: number of tokens to scan (default: `25`)
- `onlySignals`: `true`/`false` — show only STRONG SHORT/LONG (default: `false`)

Example:

```bash
curl "http://localhost:8787/api/rsi?market=perp&limitTokens=40&onlySignals=true"
```

Response includes:

- `results`: array of tokens with signal badge, multi-timeframe RSI/Stochastic RSI data
- `signal`: `{ type: directional signal label or NO SIGNAL, classes: "<tailwind classes>" }`
- `timeframes`: macro (4h), intermediary (1h), microTrigger (15m) data
- `signalCounts`: count of each signal type
- `skipped`: unresolved symbols with reasons

### Trade/Admin endpoints

- `GET /api/trades` - current trade simulation snapshot
- `GET /api/state` - latest scanner state payload
- `POST /api/trades/close-symbol` - force close active trade by symbol
- `POST /api/trades/reopen-last` - reopen latest closed trade
- `POST /api/trades/remove-closed` - remove a closed trade and reconcile balance
- `POST /api/trades/reset` - full runtime reset
- `POST /api/trades/clear-cooldown` - clear active cooldown only
- `POST /api/trades/evaluate-now` - evaluate entries immediately from latest cached snapshot
- `POST /api/trades/open-manual` - open trade manually with optional `entryPrice`

## Signal Verification Logic

For the full production rules, see `docs/signal-and-simulation-logic.md`.

### STRONG SHORT

Triggered when all three conditions are met:

1. **4h Stochastic RSI in Bearish Regime**: K-line > D-line and both K,D > 50
2. **1h Overbought**: RSI >= 70 OR Stochastic RSI K >= 70
3. **15m Fresh Bearish Cross**: K-line crossing above D-line at top of range (both K,D > 50)

### STRONG LONG

Triggered when all three conditions are met:

1. **4h Stochastic RSI in Bullish Regime**: K-line < D-line and both K,D < 50
2. **1h Oversold**: RSI <= 30 OR Stochastic RSI K <= 30
3. **15m Fresh Bullish Cross**: K-line crossing below D-line at bottom of range (both K,D < 50)

## Frontend Dashboard

The Next.js UI displays:

- **Filters**: Query, market (perp/spot), token limit, signal filtering
- **Stats**: Count of STRONG SHORT, STRONG LONG, and total results
- **Results Table**: 8 columns:
  - Token symbol
  - RSI Status (OVERBOUGHT, OVERSOLD, NEUTRAL)
  - **System Signal** (directional signal labels when present, or NO SIGNAL in gray)
  - 1h RSI value
  - Macro (4h) Stochastic K/D
  - Intermediary (1h) Stochastic K/D
  - Micro Trigger (15m) Stochastic K/D
  - Price (refreshed every 1 minute via trade cycle)
- **Skipped Symbols**: Display reasons for any tokens that couldn't be scanned
- **Active Trades Table**: Live position metrics with production fields (mark price, ROE, margin, funding) updated every 5 seconds
- **Recent Closed Trades Table**: Includes close reason (e.g. TP_HIT_SHORT, EARLY_DRAWDOWN_PROTECTION) and a **Reopen** action button per row

## Trade Selection Summary

Trade opening is not random and is not based on upstream volume ordering.

Current production behavior:
- BTC / ETH use a 12% TP target; other assets use 15%
- large-cap score threshold is 8; alt threshold is 7
- `NO SIGNAL` rows cannot open trades even if score is high
- candidates with low TP feasibility are excluded before ranking
- remaining candidates are ranked by weighted score:
  - 50% signal strength
  - 30% TP feasibility
  - 20% structure confidence
- order book execution gates must pass before opening:
  - spread threshold
  - nearby depth threshold
  - directional imbalance threshold
- slippage guard can be bypassed with `IGNORE_SLIPPAGE_GUARD=true`
- when bypassed, observed slippage is still measured/logged, but applied entry slippage is forced to zero
- TP viability check also skips slippage cost when guard is bypassed

## Trade Lifecycle

### Entry Cooldown

Cooldown is **not** applied after every close.

Current runtime behavior:
- Loss streak increments on each loss and resets on wins
- A **1-hour cooldown** starts only when loss streak reaches `MAX_LOSS_STREAK` (default: 3)
- Cooldown starts from the loss `closeTime`
- Next qualifying signal after cooldown expiry opens automatically
- Cooldown can be manually cleared with `POST /api/trades/clear-cooldown`

### Early Drawdown Protection

If an open trade's ROE drops below `-6%` before reaching the normal stop-loss, the engine closes it early via `EARLY_DRAWDOWN_PROTECTION`.

With `CAP_EARLY_DRAWDOWN_TO_SL=true` (default), the recorded loss is capped at the trade's configured stop-loss percentage, preventing overshoot from brief price spikes from inflating the simulated loss.

If the market close is between `EARLY_DRAWDOWN_EXIT_PCT` and `-stopLossPct` (for example `-6.57%` with stop-loss `-10%`), the recorded result remains the market result (it is not forced to `-10%`).

Relevant env vars:
- `EARLY_DRAWDOWN_EXIT_PCT` — ROE threshold that triggers early close (default: `-6`)
- `CAP_EARLY_DRAWDOWN_TO_SL=true` — caps early drawdown result to stop-loss equivalent

### Manual Trade Controls

Several admin endpoints allow overriding the normal trade lifecycle:

```bash
# Reopen the most recently closed trade (fresh price from API)
curl -X POST http://localhost:8787/api/trades/reopen-last -H "Content-Type: application/json" -d '{"symbol":"NEAR-PERP"}'

# Remove a specific closed trade record and reconcile balance
curl -X POST http://localhost:8787/api/trades/remove-closed -H "Content-Type: application/json" -d '{"symbol":"NEAR-PERP"}'

# Full runtime reset: clear all trades, balance, cooldown, kill switch
curl -X POST http://localhost:8787/api/trades/reset

# Clear cooldown only (keep trades/balance/history)
curl -X POST http://localhost:8787/api/trades/clear-cooldown

# Evaluate entries now using latest cached scan rows
curl -X POST http://localhost:8787/api/trades/evaluate-now

# Open a trade manually, bypassing all strategy gates
# entryPrice is optional — falls back to live mark price
curl -X POST http://localhost:8787/api/trades/open-manual \
  -H "Content-Type: application/json" \
  -d '{"symbol":"NEAR-PERP","direction":"SHORT","entryPrice":2.7915}'
```

## Order Book Quality Gates

Order book is used as execution-quality protection, not directional prediction.

If order book checks fail, UI shows `ORDERBOOK FAIL` and the engine blocks entry.

Default thresholds:
- `ORDERBOOK_DEPTH_BPS=10`
- `ORDERBOOK_REFERENCE_NOTIONAL_USD=2000`
- `ORDERBOOK_MIN_DEPTH_MULTIPLIER=2`
- `ORDERBOOK_MAX_SPREAD_PCT_LARGE=0.03`
- `ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT=0.08`
- `ORDERBOOK_MAX_SPREAD_PCT_ALT=0.06`
- `ORDERBOOK_MAX_AGAINST_IMBALANCE=0.25`
- `ORDERBOOK_MAX_AGAINST_IMBALANCE_MAJOR_ALT=0.35`

Major alt volume tier:
- `MIN_VOLUME_USD_MAJOR_ALT=20000000`
- `MAJOR_ALT_SYMBOLS=SOL,BNB,XRP,DOGE,ADA,TON,AVAX,LINK,DOT,LTC,TRX,BCH,APT,ARB,OP,INJ,ONDO,SUI,NEAR`

## Production Position Read Fields

Open simulated trades include production-style readouts in the dashboard:
- mark price
- ROE %
- size (base units)
- margin used
- funding rate
- funding accrued (estimate)
- estimated liquidation price
- open interest (USD)

## Key Environment Variables

| Variable | Default | Description |
|---|---|---|
| `IGNORE_SLIPPAGE_GUARD` | `false` | Bypass the slippage execution gate entirely |
| `MAX_SLIPPAGE_PCT` | `0.2` | Max allowed slippage % (only used when guard is active) |
| `CAP_EARLY_DRAWDOWN_TO_SL` | `true` | Cap early drawdown exit loss at the stop-loss % ceiling |
| `EARLY_DRAWDOWN_EXIT_PCT` | `-6` | ROE % at which early drawdown protection fires |
| `SIM_INITIAL_CAPITAL_USD` | `500` | Starting balance for the simulation account |
| `TAKE_PROFIT_PCT` | `10` | Default TP target in ROE % |
| `STOP_LOSS_PCT` | `10` | Default SL in ROE % |
| `SCORE_ENTRY_THRESHOLD` | `5` | Minimum score to qualify for entry |
| `ENTRY_TIMING_MAX` | `MID` | Latest acceptable entry timing phase |
| `SCAN_PRIORITY_SYMBOLS` | see .env | Tokens always included regardless of universe rotation |
