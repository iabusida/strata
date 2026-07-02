/**
 * Capitulation Bounce Scan API Endpoint
 * 
 * Scans Bitunix perpetual contracts for tokens trading 5-10% above all-time lows
 * Useful for mean-reversion bounce setups
 */

import { analyzeCapitulationCandidate, processCapitulationResults, type CapitulationScanResult } from "./fibonacci-capitulation-scan.js";
import { fetchRecentCandles, fetchActiveBitunixPerpSymbols } from "./bitunix-service.js";

const CAPITULATION_SCAN_CONFIG = {
  maxSymbols: 100, // Limit concurrent scans
  candleInterval: "1d" as const, // 1 day candles
  maxCandlesPerSymbol: 1000, // Fetch up to 1000 days of data (~3 years)
  concurrency: 5, // Concurrent symbol scans
};

/**
 * Run full capitulation bounce scan on Bitunix
 * Returns tokens 5-10% above their all-time low
 */
export async function scanCapitulationBounces(): Promise<CapitulationScanResult> {
  const startAt = new Date();
  const candidates = [];
  const skipped = [];

  try {
    // Fetch all available trading pairs from Bitunix
    console.log("[capitulation-scan] fetching active symbols from Bitunix...");
    const symbolsSet = await fetchActiveBitunixPerpSymbols();
    const symbols = Array.from(symbolsSet).slice(0, CAPITULATION_SCAN_CONFIG.maxSymbols);
    
    if (symbols.length === 0) {
      console.warn("[capitulation-scan] no active symbols found");
      return {
        scannedAt: startAt,
        bounceZoneCandidates: [],
        nearBounceZone: [],
        totalScanned: 0,
        skipped: [],
      };
    }

    console.log(`[capitulation-scan] scanning ${symbols.length} symbols for capitulation bounces...`);

    // Process symbols in batches for concurrency control
    for (let i = 0; i < symbols.length; i += CAPITULATION_SCAN_CONFIG.concurrency) {
      const batch = symbols.slice(i, i + CAPITULATION_SCAN_CONFIG.concurrency);
      const batchResults = await Promise.allSettled(
        batch.map(async (symbol) => {
          try {
            console.log(`[capitulation-scan] fetching candles for ${symbol}...`);
            
            // Fetch maximum available 1d candles (going back to launch)
            const candles = await fetchRecentCandles(
              symbol,
              CAPITULATION_SCAN_CONFIG.candleInterval,
              CAPITULATION_SCAN_CONFIG.maxCandlesPerSymbol
            );

            if (!candles || candles.length < 10) {
              return {
                symbol,
                result: null,
                reason: "INSUFFICIENT_CANDLES",
              };
            }

            // Get current price (latest candle close)
            const currentPrice = Number(candles[candles.length - 1].close);

            // Convert to MarketCandle format
            const prismaCandles = candles.map((c) => ({
              symbol,
              interval: "1d",
              timestamp: new Date(c.timestamp * 1000),
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            })) as any;

            // Analyze for bounce setup
            const candidate = analyzeCapitulationCandidate(symbol, prismaCandles, currentPrice);

            return {
              symbol,
              result: candidate,
              reason: candidate ? "OK" : "INVALID_DATA",
            };
          } catch (error) {
            const reason = error instanceof Error ? error.message : "UNKNOWN_ERROR";
            console.error(`[capitulation-scan] error scanning ${symbol}: ${reason}`);
            return {
              symbol,
              result: null,
              reason,
            };
          }
        })
      );

      // Process batch results
      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          const { symbol, result: candidate, reason } = result.value;
          if (candidate) {
            candidates.push(candidate);
          } else {
            skipped.push({ symbol, reason });
          }
        } else {
          skipped.push({
            symbol: `batch-item-${i}`,
            reason: result.reason instanceof Error ? result.reason.message : "PROMISE_REJECTED",
          });
        }
      }

      // Small delay between batches to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log(
      `[capitulation-scan] completed: ${candidates.length} valid, ${skipped.length} skipped`
    );

    return processCapitulationResults(candidates, startAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[capitulation-scan] fatal error: ${message}`);
    throw error;
  }
}

/**
 * Format scan result for Telegram/API display
 */
export function formatCapitulationForTelegram(result: CapitulationScanResult): string {
  if (result.bounceZoneCandidates.length === 0 && result.nearBounceZone.length === 0) {
    return "📊 Capitulation Bounce Scan\n\nNo candidates found in bounce zone (5-10% above ATL)";
  }

  const lines = ["📊 <b>Capitulation Bounce Scan</b>"];
  lines.push(`Scanned: ${result.totalScanned} tokens`);
  lines.push("");

  // Bounce zone (5-10% above ATL)
  if (result.bounceZoneCandidates.length > 0) {
    lines.push("🎯 <b>BOUNCE ZONE (5-10% above ATL)</b>");
    for (const candidate of result.bounceZoneCandidates.slice(0, 10)) {
      const icon = candidate.rsi14 < 30 ? "🔥" : "⚠️";
      lines.push(
        `${icon} <b>${candidate.symbol}</b> +${candidate.distanceFromZeroFib.toFixed(1)}% | RSI ${candidate.rsi14.toFixed(0)} | Strength ${candidate.strength}/100`
      );
    }
  }

  // Near bounce zone (3-15%)
  if (result.nearBounceZone.length > 0) {
    lines.push("");
    lines.push("👀 <b>NEAR ZONE (3-15% above ATL)</b>");
    for (const candidate of result.nearBounceZone.slice(0, 10)) {
      lines.push(
        `<b>${candidate.symbol}</b> +${candidate.distanceFromZeroFib.toFixed(1)}% | Strength ${candidate.strength}/100`
      );
    }
  }

  lines.push("");
  lines.push(`[📈 Bitunix] ${new Date(result.scannedAt).toISOString()}`);

  return lines.join("\n");
}
