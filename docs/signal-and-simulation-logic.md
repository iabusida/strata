# Signal and Simulation Business Logic

This document reflects the current production-grade implementation in the API and web dashboard.

## 1) Core Objective

The engine now combines:
- Regime-aware signal gating
- ATR-normalized TP/SL
- Time-based stale-trade exits
- Safer reversal validation
- Correlation-aware portfolio limits
- Runtime slippage modeling
- Risk-adjusted component scoring
- EV-first candidate ranking
- Adaptive feedback from recent outcomes
- Extended forensic persistence

Existing signal type outputs and API shapes remain compatible.

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

Runtime opening now computes:
- simulatedSlippagePct = (orderNotionalUsd / depthUsdAt10bps) * 100

Rule:
- reject trade if simulatedSlippagePct > 0.2

Execution price adjustment:
- LONG entry uses positive slippage adjustment
- SHORT entry uses negative slippage adjustment

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

Before opening trades:
- kill switch drawdown
- blocked UTC session
- global trade throttle
- cooldown/loss streak
- daily drawdown cap
- concurrent risk cap
- max active slots
- duplicate side guard
- cluster cap
- runtime order book + slippage checks

## 18) Validation Utilities

Stress script:
- apps/api/src/signal-stress.ts

It covers deterministic STRONG/CONTINUATION/REVERSAL and confluence cases and should be run after signal-logic changes.
