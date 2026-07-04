/**
 * Capitulation Bounce Scan API Endpoint
 * 
 * Scans Bitunix perpetual contracts for tokens trading 5-10% above all-time lows
 * Useful for mean-reversion bounce setups
 */

import { analyzeCapitulationCandidate, processCapitulationResults, type CapitulationScanResult } from "./fibonacci-capitulation-scan.js";
import { fetchRecentCandles, fetchActiveBitunixPerpSymbols, fetchAllFundingRates, fetchPerpContexts } from "./bitunix-service.js";

const CAPITULATION_SCAN_CONFIG = {
  // 0 means "scan all active symbols". Set CAPITULATION_SCAN_MAX_SYMBOLS to cap.
  maxSymbols: Math.max(0, Number.parseInt(process.env.CAPITULATION_SCAN_MAX_SYMBOLS ?? "0", 10) || 0),
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
    const allSymbols = Array.from(symbolsSet);
    const symbols = CAPITULATION_SCAN_CONFIG.maxSymbols > 0
      ? allSymbols.slice(0, CAPITULATION_SCAN_CONFIG.maxSymbols)
      : allSymbols;
    
    if (symbols.length === 0) {
      console.warn("[capitulation-scan] no active symbols found");
      return {
        scannedAt: startAt,
        bounceZoneCandidates: [],
        nearBounceZone: [],
        ultraCapitulationCandidates: [],
        topNextRunCandidates: [],
        totalScanned: 0,
        skipped: [],
      };
    }

    const capText = CAPITULATION_SCAN_CONFIG.maxSymbols > 0
      ? ` (capped from ${allSymbols.length})`
      : "";
    console.log(`[capitulation-scan] scanning ${symbols.length} symbols for capitulation bounces...${capText}`);

    // Fetch all funding rates in one batch call upfront
    console.log("[capitulation-scan] fetching funding rates...");
    const fundingRates = await fetchAllFundingRates().catch(() => new Map<string, number>());
    console.log(`[capitulation-scan] got funding rates for ${fundingRates.size} symbols`);

    console.log("[capitulation-scan] fetching perp contexts...");
    const perpContexts = await fetchPerpContexts(symbols).catch(() => new Map());
    console.log(`[capitulation-scan] got contexts for ${perpContexts.size} symbols`);

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
            const fundingRate = fundingRates.get(symbol) ?? 0;
            const context = perpContexts.get(symbol);
            const candidate = analyzeCapitulationCandidate(symbol, prismaCandles, currentPrice, fundingRate, {
              dayNotionalVolumeUsd: context?.dayNtlVolume ?? null,
              openInterestDeltaPct: null,
              orderbookImbalance: null,
              orderbookDelta: null,
            });

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
  if (
    result.bounceZoneCandidates.length === 0 &&
    result.nearBounceZone.length === 0 &&
    result.ultraCapitulationCandidates.length === 0
  ) {
    return "📊 Capitulation Transition Scan\n\nNo transition candidates found (CAPITULATION→RECOVERY→ACCUMULATION→PRE_PUMP).";
  }

  const lines = ["📊 <b>Capitulation Transition Scan</b>"];
  lines.push(`Scanned: ${result.totalScanned} tokens`);
  lines.push("");

  // Bounce zone (5-10% above ATL)
  if (result.bounceZoneCandidates.length > 0) {
    lines.push("🎯 <b>CAPITULATION ZONE (5-10% above ATL)</b>");
    for (const candidate of result.bounceZoneCandidates.slice(0, 10)) {
      const icon = candidate.rsi14 < 30 ? "🔥" : "⚠️";
      const stageIcon = candidate.stage === "PRE_PUMP"
        ? "🚀"
        : candidate.stage === "ACCUMULATION"
        ? "🌱"
        : candidate.stage === "CAPITULATION"
        ? "🧊"
        : candidate.stage === "DEAD_CAPITULATION"
        ? "💀"
        : "";
      const fundStr = candidate.fundingRate < -0.0001
        ? ` | 🟢 Fund ${(candidate.fundingRate * 100).toFixed(4)}%`
        : candidate.fundingRate > 0.0003
        ? ` | 🔴 Fund ${(candidate.fundingRate * 100).toFixed(4)}%`
        : "";
      lines.push(
        `${icon}${stageIcon} <b>${candidate.symbol}</b> +${candidate.distanceFromZeroFib.toFixed(1)}% | CS ${candidate.capitulationScore} RS ${candidate.recoveryScore} AS ${candidate.accumulationScore} PP ${candidate.prePumpScore} | ΔS ${candidate.deltaScore24h >= 0 ? "+" : ""}${candidate.deltaScore24h.toFixed(1)}${fundStr} | ${candidate.stage}`
      );
    }
  }

  // Near bounce zone (3-15%)
  if (result.nearBounceZone.length > 0) {
    lines.push("");
    lines.push("👀 <b>NEAR ZONE (3-15% above ATL)</b>");
    for (const candidate of result.nearBounceZone.slice(0, 10)) {
      const stageIcon = candidate.stage === "PRE_PUMP" ? "🚀" : candidate.stage === "ACCUMULATION" ? "🌱" : "";
      lines.push(
        `${stageIcon} <b>${candidate.symbol}</b> +${candidate.distanceFromZeroFib.toFixed(1)}% | RS ${candidate.recoveryScore} AS ${candidate.accumulationScore} PP ${candidate.prePumpScore} | ΔVol ${(candidate.deltaVolumePct * 100).toFixed(1)}% | ${candidate.stage}`
      );
    }
  }

  // Ultra capitulation (0-3%)
  if (result.ultraCapitulationCandidates.length > 0) {
    lines.push("");
    lines.push("🧊 <b>ULTRA CAPITULATION (0-3% above ATL)</b>");
    for (const candidate of result.ultraCapitulationCandidates.slice(0, 10)) {
      const stageIcon = candidate.stage === "PRE_PUMP" ? "🚀" : candidate.stage === "ACCUMULATION" ? "🌱" : candidate.stage === "DEAD_CAPITULATION" ? "💀" : "";
      lines.push(
        `${stageIcon} <b>${candidate.symbol}</b> +${candidate.distanceFromZeroFib.toFixed(1)}% | CS ${candidate.capitulationScore} RS ${candidate.recoveryScore} AS ${candidate.accumulationScore} | ${candidate.stage}`
      );
    }
  }

  // Ordered top next-run list
  if (result.topNextRunCandidates.length > 0) {
    lines.push("");
    lines.push("🚀 <b>HIGH CONVICTION NEXT-RUN CANDIDATES</b>");
    for (const [idx, candidate] of result.topNextRunCandidates.slice(0, 10).entries()) {
      lines.push(
        `${idx + 1}. <b>${candidate.symbol}</b> | Conf ${candidate.confluenceScore}/10 | RS ${candidate.recoveryScore} AS ${candidate.accumulationScore} PP ${candidate.prePumpScore} | ΔS ${candidate.deltaScore24h >= 0 ? "+" : ""}${candidate.deltaScore24h.toFixed(1)} | ${candidate.stage}`
      );
    }
  }

  lines.push("");
  lines.push(`[📈 Bitunix] ${new Date(result.scannedAt).toISOString()}`);

  return lines.join("\n");
}
