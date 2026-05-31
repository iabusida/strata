# Signal and Simulation Business Logic

This document reflects the current production-grade implementation in the API and web dashboard.

Last updated: 2026-05-31

## 1) Core Objective

The engine combines:
- Regime-aware signal gating
- ATR-normalized TP/SL
- Time-based stale-trade exits
- Safer reversal validation
- Correlation-aware portfolio limits
- Runtime slippage modeling (bypassable via `IGNORE_SLIPPAGE_GUARD`)
- Risk-adjusted component scoring
- EV-first candidate ranking
- Adaptive feedback from recent outcomes
- Extended forensic persistence
- Early drawdown protection with configurable SL cap
- Manual trade controls (reset, open, reopen, remove)

## 2) Market Regime Engine

Module:
- apps/api/src/regime-engine.ts

Regime outputs:
- TRENDING
- CHOPPY
- EXPANSION
- LOW_VOL

Inputs per symbol:
- atr1h
- atr4h
- recentHigh1h
- recentLow1h
- volatilityPct
- 4h stochastic persistence (count of recent candles with K>D or K<D)

Rules:
- volatilityPct < 1.2 -> LOW_VOL
- rangeCompression < 0.015 -> CHOPPY
- atrExpansion > 1.3 -> EXPANSION
- trendPersistence >= 3 -> TRENDING
- else -> CHOPPY

Attached in trade context:
- regime
- atrExpansion
- rangeCompression
- trendPersistence4h

## 3) Timeframes and Indicators

Per symbol:
- 1d, 12h, 4h, 1h, 15m

Indicator set:
- RSI(14)
- MACD histogram (12, 26, 9)
- Stoch RSI K/D (14, 3, 3)
- EMA20 on micro trend
- EMA slope (ema20 current - ema20 previous)
- ATR(14) on 1h and 4h

## 4) Signal Families

Directional:
- STRONG LONG / STRONG SHORT
- CONTINUATION LONG / CONTINUATION SHORT
- REVERSAL LONG / REVERSAL SHORT

Non-directional:
- NO SIGNAL
- NO SIGNAL (NEAR SUPPORT FLOOR)
- NO SIGNAL (NEAR RESISTANCE)

## 5) Regime Influence on Eligibility

Directional signals are additionally filtered by regime:
- TRENDING: blocks weak reversal behavior and favors STRONG/CONTINUATION
- CHOPPY: blocks STRONG continuation-style impulse entries
- EXPANSION: blocks continuation setups, favors STRONG and selective reversal
- LOW_VOL: directional entries are neutralized to NO SIGNAL

Regime also feeds candidate scoring (regime alignment component).

## 6) Reversal Safety Upgrade

Before allowing reversal:
- Block reversal if 4h trend is strongly persistent (>=3) and no 1h structure break
- Require 1h lower high for short reversal
- Require 1h higher low for long reversal

If any reversal protection fails, signal is forced to NO SIGNAL.

## 7) Micro Trend Filter Upgrade

Old rule:
- price vs EMA20 only

New rule:
- LONG requires: price > EMA20 and emaSlope > 0
- SHORT requires: price < EMA20 and emaSlope < 0

## 8) Volatility and Liquidity Percentile Filters

Scanner computes cross-section percentiles each cycle:
- volatilityPercentile
- liquidityPercentile

Pass criteria:
- volatilityPercentile >= 40
- liquidityPercentile >= 40

These pass/fail flags are attached to tradeContext and used by the trade engine.

## 9) ATR-Based TP/SL Normalization

Fixed percent TP/SL was replaced with ATR-derived absolute distances.

Using ATR(1h,14):
- BTC/ETH:
  - TP = entry + ATR * 1.5
  - SL = entry - ATR * 1.0
- Major alts:
  - TP = entry + ATR * 2.0
  - SL = entry - ATR * 1.2
- Other alts:
  - TP = entry + ATR * 2.5
  - SL = entry - ATR * 1.5

Short mirrors are applied symmetrically.

## 10) Time-Based Exit Rules

On each monitor cycle:
- REVERSAL trades: if elapsed > 90m and pnl < 2% -> close at market
- STRONG trades: if elapsed > 240m and pnl < 3% -> close at market
- Any trade: if elapsed > 360m -> close at market

Existing TP/SL and drawdown exits remain active.

## 11) Order Book Slippage Model

Runtime opening computes observed slippage:
- simulatedSlippagePct = (orderNotionalUsd / depthUsdAt10bps) * 100

Guard rule when active:
- reject trade if `simulatedSlippagePct > MAX_SLIPPAGE_PCT` (default `0.2`)

Entry price behavior:
- When slippage guard is active: effective entry includes directional slippage adjustment
  - LONG entry uses positive slippage adjustment
  - SHORT entry uses negative slippage adjustment
- When `IGNORE_SLIPPAGE_GUARD=true`: observed slippage is still measured/logged, but applied slippage is forced to `0` for effective entry pricing

Effective entry is persisted and used to derive TP/SL distances.

## 12) Correlation Control

Cluster map:
- L1: BTC, ETH
- L2: SOL, AVAX, NEAR, SUI, ADA
- DEFI: LINK, AAVE, UNI
- OTHER: rest

Portfolio rule:
- max 2 active trades per cluster

Trades violating cluster cap are rejected before open.

## 13) Scoring Rewrite (Risk-Adjusted)

Candidate score is now component-based and normalized to 0-10.

Core components:
- regimeAlignment
- riskReward
- volatilityPotential
- liquidityQuality
- distanceFromSupportResistance
- signalTypeBonus

Penalty:
- riskReward < 1.5 receives a heavy negative adjustment

Adaptive penalties may also apply:
- tightened reversal thresholds
- choppy-frequency reduction
- symbol down-rank when underperforming

## 14) EV-First Ranking

Ranking priority:
1. Highest expectedValue
2. Higher liquidity quality
3. Higher structure confidence

Expected value source:
- if enough historical stats by signal family: use historical EV
- otherwise fallback EV:
  - winProb = score / 10
  - EV = winProb * tpDistance - (1 - winProb) * slDistance

## 15) Adaptive Feedback Loop

The engine aggregates rolling outcomes over 50 settled trades:
- win rate by signal type
- win rate by regime
- win rate by symbol
- win rate by volatility bucket

Behavioral adaptation:
- reversal win rate < 40% -> tighten reversal entries
- weak CHOPPY performance -> reduce choppy participation
- persistent symbol underperformance -> down-rank symbol

## 16) Forensic Persistence Extension

Persisted trade records now include:
- regime
- cluster
- atr
- tpDistance
- slDistance
- expectedValue
- slippageEstimate
- effectiveEntryPrice

entry_context_json and close_context_json include these values for postmortem analysis.

Schema migration remains backward compatible using additive columns and defaults.

## 17) Order of Runtime Guardrails

Before opening trades, the engine evaluates in order:
1. Kill switch drawdown (≥15% balance loss from peak → halt all entries)
2. Blocked UTC session window
3. Global trade throttle
4. Loss streak tracking
5. Cooldown gate (1 hour) only when loss streak reaches `MAX_LOSS_STREAK` (default: 3)
6. Daily drawdown cap
7. Concurrent risk cap
8. Max active slots
9. Duplicate side guard (no same-direction trades on same symbol)
10. Cluster cap (max 2 active per cluster)
11. Runtime order book + slippage checks (bypassable via `IGNORE_SLIPPAGE_GUARD=true`)

## 18) Slippage Guard

The execution engine validates order book quality before allowing entry.

Default rule: reject if `simulatedSlippagePct > 0.2` (0.2%).

To bypass completely (e.g. for low-liquidity alts or manual trades):
```
IGNORE_SLIPPAGE_GUARD=true
```

When the guard is bypassed, TP viability checks also skip slippage cost deduction so entry is not blocked on that basis either.

`MAX_SLIPPAGE_PCT` is only evaluated when the guard is active.

## 19) Early Drawdown Protection

If an open trade's ROE drops to `EARLY_DRAWDOWN_EXIT_PCT` (default: `-6%`) before hitting the configured stop-loss, the engine closes the trade early with reason `EARLY_DRAWDOWN_PROTECTION`.

Loss cap behavior (`CAP_EARLY_DRAWDOWN_TO_SL=true`, default):
- Even if the mark price at the time of early close reflects a worse loss than the stop-loss, the recorded result is capped at `-stopLossPct`.
- This prevents brief price spikes from inflating the simulated loss beyond what a real stop-loss order would have filled.
- If the market close is between `EARLY_DRAWDOWN_EXIT_PCT` and `-stopLossPct` (for example `-6.57%` with stop-loss `-10%`), the recorded result remains the market result (it is not forced to `-10%`).

Relevant env vars:
- `EARLY_DRAWDOWN_EXIT_PCT` — ROE % threshold (default: `-6`)
- `CAP_EARLY_DRAWDOWN_TO_SL` — cap recorded loss at SL level (default: `true`)

## 20) Trade Lifecycle and Cooldown

Cooldown is **not applied after every close**.

Current runtime behavior:
- The engine increments a loss streak counter on each loss and resets it on wins.
- A **1-hour cooldown** starts only when the streak reaches `MAX_LOSS_STREAK` (default: 3).
- The cooldown window starts at the loss `closeTime`.
- The next qualifying signal found after cooldown expiration opens automatically.
- Cooldown can also be cleared manually via `POST /api/trades/clear-cooldown`.

Time-based exits also apply during an active trade (see Section 10).

## 21) Balance Reconciliation

Account balance is reconciled from the ledger on every write operation (not derived from running totals). Reconciliation steps:
1. Start from `SIM_INITIAL_CAPITAL_USD`
2. Deduct open fees for all currently active trades
3. Add `resultUsd - closeFeeUsd` for each closed trade

This prevents drift from manual operations (remove, reset, reopen).

## 22) Manual Trade Controls (Admin Endpoints)

These endpoints bypass normal strategy gates and are intended for operator use only.

### `POST /api/trades/reopen-last`
Re-opens the most recently closed trade using a fresh mark price from the API.
```json
{ "symbol": "NEAR-PERP" }   // optional — defaults to latest closed
```

### `POST /api/trades/remove-closed`
Removes a specific closed trade record and reconciles balance.
```json
{ "symbol": "NEAR-PERP" }
// or
{ "id": "NEAR-PERP-SHORT-..." }
```

### `POST /api/trades/reset`
Full in-memory runtime reset:
- Clears all active and closed trades
- Resets balance to `SIM_INITIAL_CAPITAL_USD`
- Clears cooldown, kill switch, loss streak

No body required.

### `POST /api/trades/open-manual`
Opens a trade immediately, bypassing all strategy and execution gates.
- `entryPrice` is optional; falls back to live mark price if omitted or if rate-limited (429).
```json
{
  "symbol": "NEAR-PERP",
  "direction": "SHORT",
  "signalType": "MANUAL SHORT",   // optional
  "entryPrice": 2.7915            // optional override
}
```

### `POST /api/trades/clear-cooldown`
Clears active cooldown without resetting balance, history, or open/closed trades.

No body required.

### `POST /api/trades/evaluate-now`
Runs immediate entry evaluation against the latest in-memory snapshot (without forcing a fresh external scan).

No body required.

All write endpoints push updated state to WebSocket subscribers immediately via `syncLatestTradeSimulation()`.

## 23) API Endpoints Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/tokens` | Token list (query, market) |
| `GET` | `/api/rsi` | Multi-timeframe RSI scan |
| `GET` | `/api/trades` | Current simulation snapshot |
| `GET` | `/api/state` | Raw latest scan state |
| `POST` | `/api/trades/close-symbol` | Force close active trade by symbol |
| `POST` | `/api/trades/reopen-last` | Reopen latest closed trade |
| `POST` | `/api/trades/remove-closed` | Remove a closed trade record |
| `POST` | `/api/trades/reset` | Full runtime reset |
| `POST` | `/api/trades/clear-cooldown` | Clear active cooldown only |
| `POST` | `/api/trades/evaluate-now` | Evaluate entries now from latest cached snapshot |
| `POST` | `/api/trades/open-manual` | Open trade manually with optional price override |

WebSocket: `ws://localhost:8787/ws/state` — broadcasts full service state on every scan cycle and after each manual write operation.

## 24) Frontend Dashboard

The Next.js dashboard (`apps/web/components/dashboard.tsx`) displays:

### Active Trades Table
Updated every 5 seconds via WebSocket. Columns:
- Token, Direction, Size
- Asset Type, Entry Type
- Entry Timing
- TP %, Entry, Mark
- Position Value, ROE %, PnL USD
- Liq. Price (est.), Margin
- Funding Rate, Funding PnL
- TP/SL prices, Dist TP %, Dist SL %
- Stake, Progress bar, Status, Time in Trade, Opened

### Recent Closed Trades Table
Columns:
- Token, Direction, Result %, Result USD
- Reason (human-readable close reason: TP_HIT_SHORT → "TP Hit Short", EARLY_DRAWDOWN_PROTECTION → "Early Drawdown Protection", etc.)
- Time to Close, Max DD, Closed At
- Action (**Reopen** button — calls `POST /api/trades/reopen-last`)

### Multi-Timeframe Alignment Results Table
Prices in this table refresh every 1 minute via the trade cycle (not only on 5-minute signal scans). Columns:
- Token, 24h Volume, Volatility
- Readiness %, Signal, Entry Timing, Trend Map
- Score, Price

### Key Environment Variables

| Variable | Default | Description |
|---|---|---|
| `IGNORE_SLIPPAGE_GUARD` | `false` | Bypass slippage execution gate entirely |
| `MAX_SLIPPAGE_PCT` | `0.2` | Max allowed slippage % (only evaluated when guard is active) |
| `CAP_EARLY_DRAWDOWN_TO_SL` | `true` | Cap early drawdown exit loss at the stop-loss % ceiling |
| `EARLY_REVERSAL_EV_TOLERANCE` | `0.01` | Minimum EV allowed for reversal entries |
| `SIM_INITIAL_CAPITAL_USD` | `500` | Starting balance for the simulation account |
| `TAKE_PROFIT_PCT` | `10` | Default TP in ROE % |
| `STOP_LOSS_PCT` | `10` | Default SL in ROE % |
| `SCORE_ENTRY_THRESHOLD` | `5` | Minimum score to qualify for entry |
| `ENTRY_TIMING_MAX` | `MID` | Latest acceptable entry timing phase |
| `SIM_ENTRY_TIMING_MAX` | `MID` | Entry timing override for sim trades |
| `SCAN_PRIORITY_SYMBOLS` | see .env | Tokens always included regardless of universe rotation |
| `SCAN_BLOCK_SYMBOLS` | empty | Tokens excluded from all scans and sim entries |

## 25) Validation Utilities

Stress script:
- `apps/api/src/signal-stress.ts`

It covers deterministic STRONG/CONTINUATION/REVERSAL and confluence cases and should be run after signal-logic changes.

## 26) Session Continuity Notes (2026-05-31)

### Higher-timeframe reversal protection was strengthened

Entry rejection now includes broader higher-timeframe conflict checks, not only 4h/1h macro conflict.

Added to entry blocker:
- 12h trend/MACD/stochastic against entry direction
- 1d trend/MACD/stochastic against entry direction
- 12h and 1d exhaustion rollover pressure signals

Implementation:
- `apps/api/src/trade-engine.ts`
  - `evaluateHigherTimeframeMomentumConflict(...)`
  - HTF gate usage in `openTradesFromSignals(...)`

### Violent-move alerting state

Telegram alert flow exists for:
- READY: `VIOLENT_MOVE_LONG_STOCH_UP`
- CAUTION: `VIOLENT_MOVE_VOLATILITY_COOLDOWN`

Runtime settings for this feature are strict-required and seeded via migration:
- `apps/api/prisma/migrations/20260531114500_add_violent_move_runtime_settings/migration.sql`

### Current known gap

Alert events are emitted, but not yet persisted as first-class historical event rows. Historical analysis currently reconstructs outcomes from candle history.

### Suggested next steps

1. Add persisted alert-event history (READY/CAUTION with symbol, timestamp, price).
2. Add optional 3d/1w bias gate if reversals still slip through.
3. Normalize symbol aliases in reporting/backfill tooling (for example MANTRA naming differences by venue).

