import "./env.js";
import { PrismaClient, CandleInterval } from "@prisma/client";
import { fetchStockCandles, getPopularStockSymbols, type YahooCandle } from "./yahoo-finance-service.js";
import {
  markBackfillStarted,
  markBackfillSuccess,
  markBackfillFailed,
  markBackfillNoData,
  initializeOrUpdateStatus
} from "./backfill-token-tracking.js";

type Interval = "15m" | "1h" | "4h" | "12h" | "1d";

const ALL_INTERVALS: Interval[] = ["15m", "1h", "4h", "12h", "1d"];

function resolveIntervals(): Interval[] {
  const raw = process.env.BACKFILL_INTERVALS;
  if (!raw || raw.trim().length === 0) {
    return ALL_INTERVALS;
  }

  const requested = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

  const valid = requested.filter((item): item is Interval =>
    (ALL_INTERVALS as string[]).includes(item)
  );

  const invalid = requested.filter((item) => !(ALL_INTERVALS as string[]).includes(item));
  if (invalid.length > 0) {
    throw new Error(
      `BACKFILL_INTERVALS contains unsupported values: ${invalid.join(", ")}. Allowed: ${ALL_INTERVALS.join(", ")}`
    );
  }

  if (valid.length === 0) {
    throw new Error("BACKFILL_INTERVALS resolved to zero valid intervals");
  }

  return ALL_INTERVALS.filter((item) => valid.includes(item));
}

const INTERVALS: Interval[] = resolveIntervals();
const INSERT_BATCH_SIZE = 1000;

const intervalMap: Record<Interval, CandleInterval> = {
  "15m": CandleInterval.M15,
  "1h": CandleInterval.H1,
  "4h": CandleInterval.H4,
  "12h": CandleInterval.H12,
  "1d": CandleInterval.D1
};

function resolveLookbackDays(): number {
  const raw = process.env.BACKFILL_LOOKBACK_DAYS ?? process.env.BACKFILL_LOOK_DAYS;
  if (!raw) {
    return 90;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("BACKFILL_LOOKBACK_DAYS must be a positive number when provided");
  }

  return Math.floor(parsed);
}

function resolveSymbolLimit(): number | null {
  const raw = process.env.BACKFILL_SYMBOL_LIMIT;
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("BACKFILL_SYMBOL_LIMIT must be a positive number when provided");
  }

  return Math.floor(parsed);
}

function resolveSymbolOffset(): number {
  const raw = process.env.BACKFILL_SYMBOL_OFFSET;
  if (!raw) {
    return 0;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("BACKFILL_SYMBOL_OFFSET must be a non-negative number when provided");
  }

  return Math.floor(parsed);
}

function resolveIncludeSymbols(): Set<string> {
  const raw = process.env.BACKFILL_INCLUDE_SYMBOLS;
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter((item) => item.length > 0)
  );
}

function resolveFailOnErrors(): boolean {
  const raw = process.env.BACKFILL_FAIL_ON_ERRORS;
  if (!raw) {
    return false;
  }

  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function persistStockCandles(
  prisma: PrismaClient,
  symbol: string,
  interval: Interval,
  candles: YahooCandle[]
): Promise<void> {
  if (candles.length === 0) {
    return;
  }

  const dbInterval = intervalMap[interval];
  for (let i = 0; i < candles.length; i += INSERT_BATCH_SIZE) {
    const chunk = candles.slice(i, i + INSERT_BATCH_SIZE);
    await prisma.marketCandle.createMany({
      data: chunk.map((c) => ({
        symbol,
        assetType: "STOCK",
        interval: dbInterval,
        timestamp: new Date(c.timestamp),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      })),
      skipDuplicates: true
    });
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const lookbackDays = resolveLookbackDays();
  const symbolLimit = resolveSymbolLimit();
  const symbolOffset = resolveSymbolOffset();
  const includeSymbols = resolveIncludeSymbols();
  const failOnErrors = resolveFailOnErrors();

  const endTime = Date.now();
  const startTime = endTime - (lookbackDays * 24 * 60 * 60 * 1000);

  console.log(`[backfill:stocks] lookback days: ${lookbackDays}`);
  console.log(`[backfill:stocks] intervals: ${INTERVALS.join(", ")}`);

  // Get stock symbols to backfill
  let symbols = getPopularStockSymbols();
  const selectedSymbolsPreFilter = symbolLimit
    ? symbols.slice(symbolOffset, symbolOffset + symbolLimit)
    : symbols.slice(symbolOffset);
  const selectedSymbols = includeSymbols.size > 0
    ? selectedSymbolsPreFilter.filter((symbol) => includeSymbols.has(symbol))
    : selectedSymbolsPreFilter;

  console.log(
    `[backfill:stocks] symbols in universe: ${symbols.length}, offset: ${symbolOffset}, selected: ${selectedSymbols.length}, includeFilter: ${includeSymbols.size}`
  );

  const failures: Array<{ symbol: string; interval: Interval; error: string }> = [];
  let totalRowsFetched = 0;

  try {
    for (const symbol of selectedSymbols) {
      await initializeOrUpdateStatus(prisma, symbol, "PENDING");
      await markBackfillStarted(prisma, symbol);

      let symbolTotalCandles = 0;
      let symbolHasData = false;
      const symbolFailures: string[] = [];

      for (const interval of INTERVALS) {
        try {
          console.log(`[${symbol}] Fetching ${interval} candles...`);
          const candles = await fetchStockCandles(symbol, interval, startTime, endTime);

          if (candles.length === 0) {
            console.log(`[${symbol}] No data for ${interval}`);
            continue;
          }

          await persistStockCandles(prisma, symbol, interval, candles);
          symbolTotalCandles += candles.length;
          symbolHasData = true;
          totalRowsFetched += candles.length;
          console.log(`[${symbol}] Persisted ${candles.length} ${interval} candles`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          symbolFailures.push(`${interval}: ${message}`);
          failures.push({ symbol, interval, error: message });
          console.error(`[${symbol}] Error fetching ${interval} candles:`, message);
        }

        // Respect rate limits
        await sleep(300);
      }

      if (symbolHasData) {
        await markBackfillSuccess(prisma, symbol, symbolTotalCandles);
        console.log(`[${symbol}] ✅ Backfill complete: ${symbolTotalCandles} total candles`);
      } else {
        await markBackfillNoData(prisma, symbol);
        console.log(`[${symbol}] ⚠️  No data found for any interval`);
      }

      if (symbolFailures.length > 0) {
        const failureStr = symbolFailures.join(", ");
        await markBackfillFailed(prisma, symbol, `Some intervals failed: ${failureStr}`);
      }

      // Pause between symbols
      await sleep(500);
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\n[backfill:stocks] Total rows fetched: ${totalRowsFetched}`);
  if (failures.length > 0) {
    console.log(`\n[backfill:stocks] Failures (${failures.length}):`);
    for (const { symbol, interval, error } of failures) {
      console.log(`  ${symbol} ${interval}: ${error}`);
    }
    if (failOnErrors) {
      process.exit(1);
    }
  } else {
    console.log(`\n[backfill:stocks] ✅ All symbols backfilled successfully`);
  }
}

main().catch(err => {
  console.error("[backfill:stocks] Fatal error:", err);
  process.exit(1);
});
