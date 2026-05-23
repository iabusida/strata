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
```

## API Endpoints

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
  - Price
- **Skipped Symbols**: Display reasons for any tokens that couldn't be scanned
- **Active Trades Table**: Live position metrics with production fields (mark price, ROE, margin, funding) updated every 5 seconds

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

## Order Book Quality Gates

Order book is used as execution-quality protection, not directional prediction.

If order book checks fail, UI shows `ORDERBOOK FAIL` and the engine blocks entry.

Default thresholds:
- `ORDERBOOK_DEPTH_BPS=10`
- `ORDERBOOK_REFERENCE_NOTIONAL_USD=2000`
- `ORDERBOOK_MIN_DEPTH_MULTIPLIER=2`
- `ORDERBOOK_MAX_SPREAD_PCT_LARGE=0.03`
- `ORDERBOOK_MAX_SPREAD_PCT_ALT=0.06`
- `ORDERBOOK_MAX_AGAINST_IMBALANCE=0.25`

## Production Position Read Fields

Open simulated trades now include production-style readouts in the dashboard:
- mark price
- ROE %
- size (base units)
- margin used
- funding rate
- funding accrued (estimate)
- estimated liquidation price
- open interest (USD)
