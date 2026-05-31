# Copilot Session Continuity Instructions

Use this file to resume work without re-discovering recent context.

## Current Project State

- Runtime settings are strict source-of-truth from DB (`RuntimeSetting`), loaded before app module usage.
- Startup must fail on missing required runtime keys.
- API trade engine includes:
  - sentiment-shift early exit support
  - violent-move alert detection and cooldown caution logic
  - higher-timeframe momentum conflict gate strengthened with 12h/1d reversal pressure
- Dashboard includes runtime setting visibility and operational stats enhancements.

## Recent High-Impact Changes (2026-05-31)

1. Violent-move alert feature added in `apps/api/src/trade-engine.ts`:
- READY signal type: `VIOLENT_MOVE_LONG_STOCH_UP`
- CAUTION signal type: `VIOLENT_MOVE_VOLATILITY_COOLDOWN`

2. Strict runtime settings keys added in `apps/api/src/runtime-settings.ts`.

3. Migration added and applied:
- `apps/api/prisma/migrations/20260531114500_add_violent_move_runtime_settings/migration.sql`

4. HTF entry blocker strengthened in `apps/api/src/trade-engine.ts`:
- Considers 12h/1d trend, MACD, stochastic opposition
- Adds 12h/1d exhaustion rollover pressure
- Blocks entries when HTF conflict score exceeds threshold

## Backfill and Data Commands

- Correct backfill command:
  - `npm run backfill:candles`
- There is no `backfill:pending` script.
- Focused backfill example:
  - `BACKFILL_INCLUDE_SYMBOLS=OM,AI,AIXBT,MANA,MANTA npm run backfill:candles`

## Operational Guardrails

- Do not introduce fallback behavior that masks missing runtime settings.
- Surface unresolved or incomplete states explicitly in reports.
- Do not run `npm run build` unless the user explicitly asks.

## Known Gaps / Next Steps

1. Persist Telegram READY/CAUTION alert events to DB for first-class historical reporting.
2. Add optional 3d/1w HTF gate if reversal risk still leaks through.
3. Add symbol alias normalization for reporting/backfill requests (for example MANTRA naming differences by venue).
4. When user asks for historical token-specific reports, verify symbol presence in `MarketCandle` before replaying.

## Validation Checklist After API Changes

1. `npm run typecheck --workspace @hype/api`
2. If runtime keys were added, include migration and apply with Prisma deploy.
3. If reporting logic changed, verify outputs classify states explicitly (no ambiguous unresolved labels).
