# Backfill Token Tracking & Integrated Data Pipeline

This system provides automatic, gradual data backfilling integrated into the normal scan operations. Instead of batch processing all 180+ tokens at once, backfill happens incrementally as part of the continuous scan loop.

## How It Works

### Automatic Integration with Scan Service

When the scan service runs its normal signal scan cycles:

1. **Scan Phase** (every 5 minutes):
   - Scans a rotating chunk of ~30 tokens
   - Simultaneously checks if each token has 90+ days of historical data
   - If data is missing, background backfill is triggered

2. **Backfill Phase** (runs in parallel, doesn't block scan):
   - Fetches historical candles from Hyperliquid for tokens missing data
   - Persists directly to the database (PostgreSQL)
   - Marks tokens as `COMPLETED` (success) or `NO_DATA` (unavailable)
   - Process: ~10 tokens per cycle × multiple daily cycles = gradual fill-in

3. **Update Phase** (on-demand):
   - Once a token reaches 90 days, it's marked `COMPLETED`
   - Future scans for that token only fetch the latest candles to stay current
   - No re-backfilling needed

### No JSON Files

All candle data is stored in the `MarketCandle` table. The database is the single source of truth for:
- Historical candles (90 days)
- Real-time updates (latest candles from each scan)
- Backfill status per symbol

## Expected Timeline

With ~230 tokens and processing ~10 per scan cycle:

- **Hour 1**: First 30 tokens get checked, backfill triggered for those lacking data
- **Hour 2-4**: First batch of backfills complete, tokens marked as COMPLETED or NO_DATA
- **Hour 8**: ~100 tokens backfilled
- **Day 1**: ~200-230 tokens backfilled (assuming network/rate limits permit)
- **Day 2+**: Gradual fill-in of remaining tokens + continuous real-time updates

### No Blocking

The backfill happens in the background:
- Scans continue at full speed
- Signal detection isn't delayed
- Telegram alerts send unaffected
- Database grows over time, no rush

## Database Schema

Tracks backfill status for each symbol:

- **symbol** (unique): Token symbol (e.g., `BTC`, `NEAR`)
- **status** (enum): One of:
  - `PENDING` - Not yet backfilled
  - `IN_PROGRESS` - Currently being backfilled
  - `COMPLETED` - Successfully backfilled 90 days of data
  - `NO_DATA` - Token is too new or delisted; no historical data available
  - `SKIPPED` - User marked as skipped (cannot obtain data or not needed)

- **lastAttemptedAt** - When the last backfill attempt was made
- **lastSuccessAt** - When the last successful backfill completed
- **lastError** - Most recent error message (if any)
- **dataAvailableFrom** - Earliest timestamp of available candle data
- **candleCount** - Total candles successfully backfilled
- **createdAt** / **updatedAt** - Timestamps

## CLI Commands

### Check Status for a Symbol

```bash
cd apps/api
npm run backfill:status status BTC
```

Output:
```json
{
  "symbol": "BTC",
  "status": "COMPLETED",
  "lastAttemptedAt": "2026-05-25T10:30:00.000Z",
  "lastSuccessAt": "2026-05-25T10:30:00.000Z",
  "lastError": null,
  "dataAvailableFrom": "2026-02-25T00:00:00.000Z",
  "candleCount": 4320,
  "createdAt": "2026-05-20T12:00:00.000Z",
  "updatedAt": "2026-05-25T10:30:00.000Z"
}
```

### View Overall Summary

```bash
npm run backfill:status summary
```

Output:
```
Backfill Status Summary:
{
  "PENDING": 45,
  "IN_PROGRESS": 0,
  "COMPLETED": 181,
  "NO_DATA": 4,
  "SKIPPED": 0
}
```

### List Pending Symbols

```bash
npm run backfill:status pending      # Show first 50
npm run backfill:status pending 100  # Show first 100
```

### List Completed Symbols

```bash
npm run backfill:status completed      # Show last 50
npm run backfill:status completed 20   # Show last 20
```

### Mark Symbol as Skipped

Use this for tokens that are too new or don't have historical data available:

```bash
npm run backfill:status skip NEWTOKEN "Token listed < 7 days ago"
npm run backfill:status skip DELISTED "Token no longer trading"
```

### Initialize Tracking for Multiple Symbols

```bash
npm run backfill:status init BTC ETH SOL ARB NEAR
```

## Workflow

### Initial Setup

1. **Create migration** (one-time):
   ```bash
   cd apps/api
   npm run prisma:migrate
   ```
   This applies the `add_backfill_token_tracking` migration.

2. **Initialize universe** (one-time):
   ```bash
   npm run fetch:data  # Fetch all 230+ symbols to populate cache
   npm run backfill:status init BTC ETH SOL ...  # Initialize first batch
   ```

### During Backfill Campaign

1. **Check what's pending**:
   ```bash
   npm run backfill:status pending 50
   ```

2. **Backfill a subset**:
   ```bash
   BACKFILL_INCLUDE_SYMBOLS=ARB,LDO,NEAR,COMP npm run backfill:candles
   ```

3. **Mark new/unavailable tokens**:
   ```bash
   npm run backfill:status skip NEWTOK1
   npm run backfill:status skip NEWTOK2 "Insufficient 90d history"
   ```

4. **Check progress**:
   ```bash
   npm run backfill:status summary
   ```

## Integration with Backfill Script

The backfill-market-candles.ts script can be updated to:
1. Auto-initialize new symbols from the exchange universe
2. Auto-mark symbols as `NO_DATA` if they return zero candles
3. Auto-track progress in the database

Example enhancement (future):
```typescript
// Mark successful backfill
await markBackfillSuccess(prisma, symbol, candleCount, oldestTimestamp);

// Mark failed symbol (no data)
if (candleCount === 0) {
  await markBackfillNoData(prisma, symbol);
} else if (error) {
  await markBackfillFailed(prisma, symbol, error.message);
}
```

## Database Queries

### Find all completed symbols

```sql
SELECT symbol FROM "BackfillToken" WHERE status = 'COMPLETED' ORDER BY symbol;
```

### Find recent failures

```sql
SELECT symbol, "lastError", "lastAttemptedAt" 
FROM "BackfillToken" 
WHERE status IN ('PENDING', 'IN_PROGRESS')
ORDER BY "lastAttemptedAt" DESC NULLS LAST
LIMIT 20;
```

### Count by status

```sql
SELECT status, COUNT(*) as count FROM "BackfillToken" GROUP BY status;
```

### Mark tokens older than a date as skipped

```sql
UPDATE "BackfillToken" 
SET status = 'SKIPPED', "lastError" = 'Too old, user selected'
WHERE "createdAt" < NOW() - INTERVAL '30 days' 
  AND status = 'PENDING';
```

## Best Practices

1. **Initialize once**: Run `init` to set up tracking, then manage via CLI or code
2. **Mark early**: Use `skip` for tokens you determine have no historical data
3. **Batch backfills**: Use `BACKFILL_INCLUDE_SYMBOLS` to target pending symbols
4. **Monitor summary**: Check `summary` periodically to track overall progress
5. **Clean up errors**: Review failures and re-attempt or skip as needed

## Code Integration

### New Modules

- **[scan-backfill-integration.ts](apps/api/src/scan-backfill-integration.ts)**
  - `checkCandleCompleteness()` - Check if a symbol has 90+ days of data
  - `isSymbolDataComplete()` - Check completeness across all intervals
  - `checkBackfillNeed()` - Determine if backfill is needed for a symbol
  - `getBackfillBatch()` - Get next batch of symbols needing backfill
  - `executeBackfillForSymbol()` - Execute backfill (can be triggered manually)

- **[backfill-token-tracking.ts](apps/api/src/backfill-token-tracking.ts)**
  - Database query/update helpers
  - Status getters/setters
  - Summary functions

- **[backfill-status-cli.ts](apps/api/src/backfill-status-cli.ts)**
  - Command-line management tool
  - View/update backfill tracking

### Modified Modules

- **[scan-service.ts](apps/api/src/scan-service.ts)**
  - Added `triggerBackfillCheckForSymbols()` function
  - Integrated into `runSignalCycle()` to check backfill needs for each chunk
  - Backfill check runs asynchronously in the background

- **[backfill-market-candles.ts](apps/api/src/backfill-market-candles.ts)**
  - Now marks tokens as `COMPLETED` or `NO_DATA` after processing
  - Updates `BackfillToken` tracking table with results
  - Still supports JSON export for backward compatibility

### Data Flow

```
┌─────────────────────────┐
│  scan-service (5m)      │
│  - Scan chunk of ~30    │
│  - Check backfill need  │
└────────────┬────────────┘
             │
             ├─→ (async) triggerBackfillCheckForSymbols()
             │            ├─→ checkBackfillNeed() for each symbol
             │            └─→ Log pending symbols
             │
             └─→ Continue normal signal scanning
                (no blocking)

┌──────────────────────────────────┐
│  Backfill Execution (manual)     │
│  npm run backfill:candles        │
│  BACKFILL_INCLUDE_SYMBOLS=...    │
└────────────┬─────────────────────┘
             │
             ├─→ markBackfillStarted()
             ├─→ fetchCandles() for each interval
             ├─→ persistCandles() to MarketCandle table
             ├─→ markBackfillSuccess() or markBackfillNoData()
             └─→ Update BackfillToken status

┌──────────────────────────────────────┐
│  Scan Service Uses Latest Data       │
│  scanRsi() calls                     │
└────────┬─────────────────────────────┘
         │
         └─→ Fetches complete candles from DB
             (90d history + real-time)
             No re-backfilling needed
```

### Starting Fresh

1. Apply migration:
   ```bash
   cd apps/api
   npm run prisma:migrate
   ```

2. Initialize tracking:
   ```bash
   npm run backfill:status init BTC ETH SOL ARB ...
   ```

3. Start scan service (normal operations):
   ```bash
   npm run dev
   ```

4. Monitor progress:
   ```bash
   # Check which need backfilling
   npm run backfill:status pending 20
   
   # Trigger manual backfill (10 at a time)
   npm run backfill:pending
   
   # Check overall progress
   npm run backfill:info
   ```

The system will gradually fill in all missing data over time, prioritizing symbols as they appear in scan rotations.
