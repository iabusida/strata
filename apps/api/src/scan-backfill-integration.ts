import { PrismaClient, CandleInterval } from "@prisma/client";
import {
  getBackfillStatus,
  getPendingTokens,
  markBackfillStarted,
  markBackfillSuccess,
  markBackfillFailed,
  markBackfillNoData
} from "./backfill-token-tracking.js";

const INTERVALS: Array<"15m" | "1h" | "4h" | "12h" | "1d"> = ["15m", "1h", "4h", "12h", "1d"];
const BACKFILL_LOOKBACK_DAYS = 90;
const BACKFILL_BATCH_SIZE = 10;

const intervalMap: Record<"15m" | "1h" | "4h" | "12h" | "1d", CandleInterval> = {
  "15m": CandleInterval.M15,
  "1h": CandleInterval.H1,
  "4h": CandleInterval.H4,
  "12h": CandleInterval.H12,
  "1d": CandleInterval.D1
};

function toBaseCoin(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  return upper.endsWith("-PERP") ? upper.slice(0, -5) : upper;
}

/**
 * Check if we have a complete set of candles for the given symbol and interval.
 * Returns the count of candles if complete, 0 otherwise.
 */
export async function checkCandleCompleteness(
  prisma: PrismaClient,
  symbol: string,
  interval: "15m" | "1h" | "4h" | "12h" | "1d"
): Promise<number> {
  const baseCoin = toBaseCoin(symbol);
  const intervalEnum = intervalMap[interval];
  
  const now = Date.now();
  const lookbackMs = BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(now - lookbackMs);

  const count = await prisma.marketCandle.count({
    where: {
      symbol: baseCoin,
      interval: intervalEnum,
      timestamp: {
        gte: cutoffDate
      }
    }
  });

  return count;
}

/**
 * Check if a symbol has complete data for all intervals over the lookback period.
 * Returns true if all intervals have data, false otherwise.
 */
export async function isSymbolDataComplete(prisma: PrismaClient, symbol: string): Promise<boolean> {
  const baseCoin = toBaseCoin(symbol);
  
  for (const interval of INTERVALS) {
    const count = await checkCandleCompleteness(prisma, baseCoin, interval);
    if (count === 0) {
      return false;
    }
  }

  return true;
}

/**
 * Get the oldest candle timestamp for a symbol across all intervals.
 */
export async function getOldestCandleTimestamp(prisma: PrismaClient, symbol: string): Promise<Date | null> {
  const baseCoin = toBaseCoin(symbol);

  const oldest = await prisma.marketCandle.findFirst({
    where: {
      symbol: baseCoin
    },
    select: { timestamp: true },
    orderBy: { timestamp: "asc" },
    take: 1
  });

  return oldest?.timestamp ?? null;
}

/**
 * Get the newest candle timestamp for a symbol across all intervals.
 */
export async function getNewestCandleTimestamp(prisma: PrismaClient, symbol: string): Promise<Date | null> {
  const baseCoin = toBaseCoin(symbol);

  const newest = await prisma.marketCandle.findFirst({
    where: {
      symbol: baseCoin
    },
    select: { timestamp: true },
    orderBy: { timestamp: "desc" },
    take: 1
  });

  return newest?.timestamp ?? null;
}

/**
 * Count total candles for a symbol across all intervals.
 */
export async function getTotalCandles(prisma: PrismaClient, symbol: string): Promise<number> {
  const baseCoin = toBaseCoin(symbol);

  return prisma.marketCandle.count({
    where: {
      symbol: baseCoin
    }
  });
}

/**
 * Get a batch of symbols that need backfilling (up to batchSize).
 * Returns array of symbols ready to backfill.
 */
export async function getBackfillBatch(prisma: PrismaClient, batchSize: number = BACKFILL_BATCH_SIZE): Promise<string[]> {
  const pending = await getPendingTokens(prisma, batchSize);
  return pending;
}

/**
 * Execute backfill for a single symbol via HTTP request to the backfill:candles script.
 * This is called as a side-effect from scan-service when needed.
 */
export async function executeBackfillForSymbol(
  prisma: PrismaClient,
  symbol: string,
  triggerCallback?: (symbol: string) => Promise<void>
): Promise<{ success: boolean; error?: string; candleCount: number }> {
  const baseCoin = toBaseCoin(symbol);

  try {
    // Mark as in-progress
    await markBackfillStarted(prisma, baseCoin);

    // Execute backfill via callback (caller will invoke the actual backfill script)
    if (triggerCallback) {
      await triggerCallback(baseCoin);
    }

    // Check how many candles we have now
    const totalCandles = await getTotalCandles(prisma, baseCoin);
    const oldestTimestamp = await getOldestCandleTimestamp(prisma, baseCoin);

    if (totalCandles === 0 || !oldestTimestamp) {
      // No data available
      await markBackfillNoData(prisma, baseCoin);
      return {
        success: false,
        error: "No candle data returned from upstream",
        candleCount: 0
      };
    }

    // Mark as complete if we have substantial data
    await markBackfillSuccess(prisma, baseCoin, totalCandles, oldestTimestamp);

    return {
      success: true,
      candleCount: totalCandles
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await markBackfillFailed(prisma, baseCoin, errorMsg);
    return {
      success: false,
      error: errorMsg,
      candleCount: 0
    };
  }
}

/**
 * Check if a symbol needs backfilling and return its status.
 * If needs backfilling returns { needsBackfill: true, reason: "..." }
 * If complete returns { needsBackfill: false, reason: "..." }
 */
export async function checkBackfillNeed(
  prisma: PrismaClient,
  symbol: string
): Promise<{ needsBackfill: boolean; reason: string }> {
  const baseCoin = toBaseCoin(symbol);
  const tracking = await getBackfillStatus(prisma, baseCoin);

  // If already marked complete, don't backfill
  if (tracking?.status === "COMPLETED") {
    return {
      needsBackfill: false,
      reason: `Already backfilled (${tracking.candleCount} candles, data from ${tracking.dataAvailableFrom?.toISOString() ?? "unknown"})`
    };
  }

  // If marked NO_DATA or SKIPPED, don't try
  if (tracking?.status === "NO_DATA") {
    return {
      needsBackfill: false,
      reason: "Marked as NO_DATA (token too new or no historical data available)"
    };
  }

  if (tracking?.status === "SKIPPED") {
    return {
      needsBackfill: false,
      reason: `Skipped: ${tracking.lastError ?? "user request"}`
    };
  }

  // Check actual data completeness
  const isComplete = await isSymbolDataComplete(prisma, baseCoin);
  if (isComplete) {
    return {
      needsBackfill: false,
      reason: "Data is complete (90+ days available)"
    };
  }

  // Needs backfill
  const totalCandles = await getTotalCandles(prisma, baseCoin);
  return {
    needsBackfill: true,
    reason: `Incomplete (${totalCandles} candles so far, needs 90+ days of complete history)`
  };
}
