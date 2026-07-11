# Copilot Session Continuity Instructions

Use this file to resume work without re-discovering recent context.

## Current Project State (2026-07-11)

- Runtime settings are strict source-of-truth from DB (`RuntimeSetting`), loaded before app module usage.
- Startup must fail on missing required runtime keys.
- Scanner universe: low-cap (≤$150M) perp tokens from Bitunix, market-cap-gated via CoinPaprika.
- Weekly capitulation detection system fully implemented and active (see section below).
- Capitulation scan CLI (`capitulation-scan-cli.ts`) now includes a `📆 WEEKLY CAPITULATION REVERSALS` section after the overextended-drop board.

## Recent High-Impact Changes (2026-07-11)

### 1. Weekly Capitulation Reversal Section — `capitulation-scan-cli.ts`
- Added `WeeklyCapitulationSetup` type and `printWeeklyCapitulationSetups()` function.
- Aggregates daily candles into weekly closes (every 7 daily bars).
- Flags tokens with **weekly RSI < 38** + weekly stoch K crossing above D.
- Status: `REVERSAL_READY` (weekly cross-up + daily confluence) or `REVERSAL_WATCH` (oversold, no cross yet).
- Called after `printOverextendedDropSetups` in the main scan output.

### 2. Weekly Capitulation Monitor System — new files + DB tables
Three new source files added:
- `apps/api/src/weekly-cap-universe.ts` — builds and persists ≤$50M universe; computes weekly+daily RSI/stoch, ATL distance; only refreshes when data is stale (>12h) or `--force` passed.
- `apps/api/src/weekly-cap-monitor.ts` — 15-minute batch poller; checks price change, 15m volume, order book depth, funding rate; upserts into `WeeklyCapMonitor` table; alert levels: NORMAL → WATCH (>2%) → ALERT (>2% + vol ≥$1M + bid depth).
- `apps/api/src/weekly-cap-cli.ts` — CLI dispatcher with commands: `refresh`, `report`, `check`, `monitor`.

Migration applied:
- `apps/api/prisma/migrations/20260711222600_add_weekly_cap_tables/migration.sql`

New Prisma models: `WeeklyCapToken`, `WeeklyCapMonitor`.

### 3. Weekly Cap Commands
```bash
npm run weekly-cap:refresh        # seed/force-rebuild universe + indicators
npm run weekly-cap:check          # single monitor cycle + show report
npm run weekly-cap -- report      # show latest DB state (instant, no fetches)
npm run weekly-cap:monitor        # start continuous 15m service (runs forever)
```
First-time setup on new machine: run `npm run weekly-cap:refresh` to seed the DB.

### 4. Scanner universe inclusive defaults
- `scanner-burst-universe.ts`: cap gate ≤$150M, no default strict percentile/volume gates, no hard symbol cap.
- Universe typically yields 300–400 tokens.

### 5. Earlier changes still active (2026-05-31)
- `VIOLENT_MOVE_LONG_STOCH_UP` / `VIOLENT_MOVE_VOLATILITY_COOLDOWN` signal types in `trade-engine.ts`.
- Migration: `20260531114500_add_violent_move_runtime_settings`.
- HTF entry blocker in `trade-engine.ts`: considers 12h/1d trend + MACD + stoch; blocks on high conflict score.

## Key Pattern: Weekly Capitulation Explosive Movers

Tokens that produce +30-50% violent moves share this fingerprint:
- Weekly RSI < 35 (deep oversold from weeks of decline)
- Weekly stoch K crossing up from near-zero (<20)
- Daily RSI in 35–50 range (mid-recovery, NOT yet daily oversold)
- Daily stoch cross-up also triggering
- Near multi-month/ATL low (≤10% from ATL)
- Very low pre-pump volume (token was ignored/illiquid)

Examples confirmed: SXT-PERP (pumped +40% 2026-07-11), PUNDIX-PERP (REVERSAL_READY same day).

## Scanner Commands Reference

```bash
npm run entry-scan                        # full capitulation scan with log file
npm run scan:report -- --market perp      # DB report (no live scan)
npm run scan:universe                     # universe diagnostics
npm run weekly-cap:refresh                # rebuild weekly cap universe
npm run weekly-cap:check                  # one-shot monitor cycle + report
npm run weekly-cap:monitor                # continuous 15m service
npm run backfill:candles                  # backfill market candles
```

## Backfill and Data Commands

- Correct backfill command: `npm run backfill:candles`
- There is no `backfill:pending` script.
- Focused backfill: `BACKFILL_INCLUDE_SYMBOLS=OM,AI,SXT,PUNDIX npm run backfill:candles`

## Operational Guardrails

- Do not introduce fallback behavior that masks missing runtime settings.
- Surface unresolved or incomplete states explicitly in reports.
- Do not run `npm run build` unless the user explicitly asks.
- Do not add fallback text generation for trade-advice/chat responses — LLM-only.
- If LLM output is unavailable, return explicit error state; no template prose substitution.

## Known Gaps / Next Steps

1. Alias normalization for US-PERP / US-PREP market-cap symbol mapping not yet implemented.
2. Persist Telegram READY/CAUTION alert events to DB for first-class historical reporting.
3. Add optional 3d/1w HTF gate if reversal risk still leaks through.
4. Weekly cap monitor: consider adding Telegram alert when `ALERT` level first triggered.
5. When user asks for historical token-specific reports, verify symbol presence in `MarketCandle` before replaying.

## Validation Checklist After API Changes

1. `npm run typecheck --workspace @strata/api`
2. If runtime keys were added, include migration and apply with Prisma deploy.
3. If reporting logic changed, verify outputs classify states explicitly (no ambiguous unresolved labels).
4. If new Prisma models added, run `npx prisma migrate dev --name <desc>` and apply.
