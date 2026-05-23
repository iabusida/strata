# Signal and Simulation Business Logic

This document describes the current production logic for signal generation, candidate ranking, and trade simulation.

## 1) Indicator Inputs

For each symbol, the engine computes three timeframe snapshots:
- 4h (macro)
- 1h (intermediary)
- 15m (micro trigger)

Per timeframe it computes:
- RSI(14)
- MACD histogram (12, 26, 9)
- Stoch RSI K/D from RSI values (14, 3, 3)
- Previous candle Stoch K/D (for crossover direction)

## 2) Crossover Definitions

- Bearish crossover:
  - previous K >= previous D
  - current K < current D

- Bullish crossover:
  - previous K <= previous D
  - current K > current D

Cross checks are direction-sensitive and require previous-candle context.

## 3) Signal Types and Priority

Signal types:
- STRONG LONG
- STRONG SHORT
- CONTINUATION LONG
- CONTINUATION SHORT
- NO SIGNAL
- NO SIGNAL (NEAR SUPPORT FLOOR)
- NO SIGNAL (NEAR RESISTANCE)

Priority order:
1. STRONG
2. CONTINUATION
3. NO SIGNAL

## 4) STRONG Signal Rules (Unchanged)

### STRONG SHORT
All conditions must be true:
1. Macro (4h):
   - stochK < stochD
   - macdHist < 0
2. Intermediary (1h):
   - stochK >= 70
   - rsi >= 55
3. Micro trigger (15m):
   - stochK < stochD
   - bearish crossover confirmed with previous candle
   - stochK > 50

### STRONG LONG
All conditions must be true:
1. Macro (4h):
   - stochK > stochD
   - macdHist > 0
2. Intermediary (1h):
   - stochK <= 30
   - rsi <= 45
3. Micro trigger (15m):
   - stochK > stochD
   - bullish crossover confirmed with previous candle
   - stochK < 50

## 5) CONTINUATION Signal Rules

### CONTINUATION SHORT
All conditions must be true:
1. Macro (4h):
   - stochK < stochD
   - macdHist < 0
2. Intermediary (1h):
   - stochK in [30, 65]
   - rsi in [45, 60]
3. Micro trigger (15m):
   - bearish crossover confirmed with previous candle
   - stochK < 50

### CONTINUATION LONG
All conditions must be true:
1. Macro (4h):
   - stochK > stochD
   - macdHist > 0
2. Intermediary (1h):
   - stochK in [35, 70]
   - rsi in [45, 65]
3. Micro trigger (15m):
   - bullish crossover confirmed with previous candle
   - stochK > 50

## 6) Support / Resistance Guards (Symmetric)

Support/resistance are computed from a rolling 1h window:
- localSupport = min(low)
- localResistance = max(high)

Shared cushion:
- priceCushion = currentPrice * 0.005 (0.5%)

### Short guard
- supportDistance = currentPrice - localSupport
- If signal is STRONG SHORT or CONTINUATION SHORT and supportDistance < priceCushion:
  - signal => NO SIGNAL (NEAR SUPPORT FLOOR)

### Long guard
- resistanceDistance = localResistance - currentPrice
- If signal is STRONG LONG or CONTINUATION LONG and resistanceDistance < priceCushion:
  - signal => NO SIGNAL (NEAR RESISTANCE)

## 7) Confluence Score (0-10)

The engine computes a weighted score and bias:
- +3 macro alignment
- +3 intermediary zone condition
- +2 micro crossover condition
- +2 if volume24h > average market volume in scanned set

Output:
- score (0 to 10)
- bias (LONG or SHORT)

Notes:
- the confluence score contributes to trade qualification and trade ranking
- the confluence bias is stored for analysis, but it no longer creates trades by itself when `signal.type` is `NO SIGNAL`

## 8) Trade Entry Qualification

A trade is eligible when:
- signal is STRONG (STRONG LONG or STRONG SHORT), OR
- confluence score >= threshold for the asset class

Implication:
- STRONG signals can open without needing the score threshold
- CONTINUATION and SCORE_BASED entries still require the score threshold

Score thresholds:
- BTC / ETH (large-cap): score >= 8
- all other symbols (alt): score >= 7

Before any trade can be opened, system-level safety guardrails must pass (see Section 17).

Signal category stored per trade:
- STRONG
- CONTINUATION
- SCORE_BASED

Critical rule:
- trades are never opened from `NO SIGNAL`
- a directional signal must exist (`STRONG LONG`, `STRONG SHORT`, `CONTINUATION LONG`, or `CONTINUATION SHORT`)
- confluence bias is no longer used as a fallback execution direction when the signal is non-directional

Duplicate prevention (unchanged):
- no second OPEN trade for same token+direction
- no re-open for same token+direction within 15 minutes

## 9) Candidate Ranking and Selection

When multiple symbols qualify but capital only allows a subset of positions, the engine ranks all valid candidates locally inside the trade engine.

Non-goal:
- upstream scan ordering is not trusted for trade selection
- the engine does not rely on 24h volume ordering to decide what to open

Required candidate inputs:
- price
- volatility metric (`volatilityPct`, used as ATR-like expected move proxy)
- signalStrength (normalized 0 to 1)
- higherTimeframeTrend (`BULLISH`, `BEARISH`, `NEUTRAL`)
- structureState (`TRENDING`, `BREAKOUT`, `CHOP`)
- tpPercent (asset-aware TP target)

### 9.1 Signal Strength

Signal strength is normalized to 0..1:
- STRONG signals: floor to 0.95
- CONTINUATION signals: floor to 0.75
- otherwise: normalized from confluence score / maxScore

### 9.2 TP Feasibility

Formula:
- `requiredMove = tpPercent / 100`
- `expectedMove = volatilityPct / 100`
- `tpFeasibility = expectedMove / requiredMove`

Clamp:
- if `tpFeasibility > 1` => `tpFeasibility = 1`
- if `tpFeasibility < 0` => `tpFeasibility = 0`

Hard filter:
- if `tpFeasibility < 0.6`, exclude the candidate completely

Purpose:
- rejects trades that are unlikely to reach their configured TP within the asset's current volatility regime

### 9.3 Higher-Timeframe Trend

Derived from 4h + 1h directional alignment:
- both UP => `BULLISH`
- both DOWN => `BEARISH`
- otherwise => `NEUTRAL`

### 9.4 Structure State

Derived from direction alignment across macro/intermediary/micro trigger:
- `TRENDING`: at least two of the three timeframes align with trade direction
- `BREAKOUT`: micro trigger aligns with direction, or signal is continuation
- `CHOP`: otherwise

### 9.5 Structure Confidence

Rules:
- if higherTimeframeTrend aligns with trade direction AND structureState == `TRENDING` => `1.0`
- else if structureState == `BREAKOUT` => `0.7`
- else if structureState == `CHOP` => `0.3`
- else => `0.5`

### 9.6 Final Weighted Score

Formula:
- `score = (0.5 * signalStrength) + (0.3 * tpFeasibility) + (0.2 * structureConfidence)`

Extreme-volatility penalty:
- if `expectedMove > 0.25`, then `score *= 0.85`

### 9.7 Selection Order

Selection pipeline:
1. qualify by signal + score threshold
2. require a directional signal
3. apply volatility and liquidity hard gates
4. apply TP-feasibility hard filter (`>= 0.6`)
5. sort remaining candidates by weighted score descending
6. open the top candidate(s) allowed by current capital and active-trade limits

Tie-breakers:
- higher signalStrength
- higher tpFeasibility
- higher structureConfidence
- then symbol name for stable ordering

Selection logging:
- symbol
- weighted score
- signalStrength
- tpFeasibility
- structureConfidence

## 10) Risk-Based Position Sizing

Fixed stake is removed. Capital is account-aware, fee-aware, and capped by current balance.

Starting balance:
- initialCapitalUsd = 378

Constants:
- tradingFeeRate = 0.05% per side
- riskPerTrade = 0.02 (2%)
- slDistancePct = 0.02 (2% price move)

Allocation formula:
- maxActiveTrades = 1 if accountBalance < 1000, else 3
- remainingSlots = max(1, maxActiveTrades - openTradesCount)
- totalFeesReserve = accountBalance × tradingFeeRate × 2 × remainingSlots
- availableAfterFees = accountBalance - totalFeesReserve
- perTradeBudget = availableAfterFees / remainingSlots
- riskUsd = perTradeBudget × riskPerTrade
- positionSizeUsd = riskUsd / slDistancePct
- positionSizeUsd = min(positionSizeUsd, perTradeBudget)

Effect:
- positionSizeUsd never exceeds accountBalance
- small accounts are protected by single-position mode
- opening and closing fees are included in realized balance

## 11) TP/SL Profile (Asset-Aware)

- Leverage: 5x
- SL return: -10%

Take-profit return:
- BTC / ETH (large-cap): +12%
- all other symbols (alt): +15%

Price move conversion:
- large-cap TP move = 12% / 5 = 2.4%
- alt TP move = 15% / 5 = 3%
- SL move = 10% / 5 = 2%

### LONG
- tpPrice = entryPrice * (1 + (takeProfitPct / leverage / 100))
- slPrice = entryPrice * 0.98

### SHORT
- tpPrice = entryPrice * (1 - (takeProfitPct / leverage / 100))
- slPrice = entryPrice * 1.02

Stored per trade:
- `assetType` = `LARGE_CAP` or `ALT`
- `takeProfitPct` = applied TP value for that trade

## 12) Trade Monitoring and Close Conditions

Monitoring cadence:
- trade monitor loop runs every 1 minute
- latest OHLC is fetched per open-trade symbol

Close logic uses candle high/low (not close):

### LONG
- WIN if high >= tpPrice
- LOSS if low <= slPrice

### SHORT
- WIN if low <= tpPrice
- LOSS if high >= slPrice

If both TP and SL are touched in one candle:
- deterministic tie-breaker by candle-open distance
- whichever level is closer to candle open wins
- exact tie defaults to LOSS

## 13) Live Trade Metrics (Per OPEN Trade)

Updated every monitoring cycle:
- currentPnlPct
- currentPnlUsd
- positionValueUsd
- distanceToTP
- distanceToSL
- maxDrawdown

Pnl formula:

### LONG
- currentPnlPct = ((currentPrice - entryPrice) / entryPrice) * leverage * 100

### SHORT
- currentPnlPct = ((entryPrice - currentPrice) / entryPrice) * leverage * 100

Position value:

### LONG
- positionValueUsd = positionSizeUsd * (currentPrice / entryPrice)

### SHORT
- positionValueUsd = positionSizeUsd * (entryPrice / currentPrice)

## 14) PnL, Balance, and Performance Tracking

Realized account model:
- accountBalance tracks realized balance only
- opening fee is deducted when a trade is opened
- closing fee is deducted when a trade is closed

On trade close:
- resultPct = +takeProfitPct (WIN) or -10 (LOSS)
- resultUsd = positionSizeUsd * (resultPct / 100)
- netClosePnlUsd = resultUsd - closeFeeUsd
- accountBalance = accountBalance + netClosePnlUsd

Live equity model:
- unrealizedPnlUsd = sum(currentPnlUsd for all OPEN trades)
- equityUsd = accountBalance + unrealizedPnlUsd
- totalPnlUsd = (accountBalance - initialCapitalUsd) + unrealizedPnlUsd
- totalPnlPct = (totalPnlUsd / initialCapitalUsd) * 100

Tracked aggregate metrics include:
- total trades
- active trades
- wins / losses / win rate
- total simulated PnL (%)
- total simulated PnL (USD)
- total PnL (live, realized + unrealized)
- account balance
- equity
- unrealized PnL
- longWinRate
- shortWinRate
- avgTradeDuration
- tradesPerDay
- maxDrawdown
- equityCurve (balance over time)
- totalFeesPaidUsd
- breakdown by direction and by token

## 15) Market Condition Tag

Each trade stores marketCondition:
- TRENDING
- RANGING

The condition is derived from normalized 4h MACD histogram strength.

## 16) Service Cadence and Persistence

Background service behavior:
- immediate first scan on API startup
- full signal scan every 5 minutes
- trade-monitor refresh every 1 minute
- state persisted to SQLite

Persistence includes scan snapshots, trade stats snapshots, and closed trades for post-analysis.

Runtime persistence (restart recovery):
- SQLite also stores live simulation runtime state in dedicated tables:
   - trades
   - account_state
   - metrics_snapshot
- On startup, engine hydrates in-memory state from SQLite:
   - restores OPEN trades
   - restores account balance and daily start balance
   - restores recent closed trades and summary metrics
- If no runtime state exists, engine initializes with 378 USD baseline.
- Save-on-change model:
   - after trade open
   - after trade close
   - after each live PnL update cycle
   - after any balance-changing event (fees, close PnL)
- In-memory state remains primary for performance; SQLite is recovery source.

Stored trade context includes:
- entryType
- entryScore
- riskPctUsed
- assetType
- takeProfitPct
- volatilityPct
- volume24h
- passedVolatility
- passedLiquidity

## 17) System-Level Safety Guardrails

These guardrails are enforced at execution level only. They do not alter signal generation, scoring, indicator math, leverage, or TP/SL behavior.

### 17.1 Max Concurrent Risk (Global Exposure Cap)

Constants:
- riskPerTrade = 0.02
- maxConcurrentRisk = 0.06

Tracked:
- openTrades (currently active trades)
- currentOpenRisk = openTrades.length * riskPerTrade

Rule before opening a trade:
- if (currentOpenRisk + riskPerTrade) > maxConcurrentRisk => block entry

Practical effect with current constants:
- risk cap allows up to 3 concurrent open trades,
- but runtime account protection applies:
   - if accountBalance < 1000 => maxActiveTrades = 1
   - else => maxActiveTrades = 3

### 17.2 Daily Stop Loss

Constant:
- maxDailyDrawdownPct = 0.06

Tracked:
- dailyStartBalance (captured at start of each UTC day)
- currentBalance
- dailyPnLPct = (currentBalance - dailyStartBalance) / dailyStartBalance

Reset behavior:
- at first evaluation of a new UTC day, dailyStartBalance is reset to current account balance

Rule before opening a trade:
- if dailyPnLPct <= -0.06 => block entry for the day until reset

### 17.3 Loss Streak Cooldown

Constants:
- maxLossStreak = 3
- cooldownDurationMinutes = 60

Tracked:
- lossStreakCount
- cooldownUntilTimestamp

On trade close:
- LOSS => lossStreakCount += 1
- WIN => lossStreakCount = 0
- if lossStreakCount >= 3:
   - cooldownUntilTimestamp = now + 60 minutes
   - lossStreakCount = 0

Rule before opening a trade:
- if currentTime < cooldownUntilTimestamp => block entry

### 17.4 Mandatory Guardrail Check Order

When evaluating new trade entry, checks are applied in this order:
1. Cooldown check
2. Daily drawdown check
3. Max concurrent risk check
4. Existing duplicate-trade checks
5. Open trade only if all pass

### 17.5 Non-Goals (Explicit)

Guardrails do not change:
- signal generation logic
- scoring logic
- TP/SL logic
- leverage
- indicator calculations
