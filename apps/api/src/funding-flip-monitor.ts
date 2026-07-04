/**
 * Funding Flip Monitor
 * 
 * Continuously monitors funding rate changes to detect runners before breakout.
 * Runs independently to catch mid-scan funding swings (e.g., VANRY-style liquidation cascades).
 * 
 * Alerts on tokens showing:
 * - Swing from positive → negative funding (shorts getting liquidated)
 * - Magnitude > 0.5% = HIGH PROBABILITY runner incoming
 */

import { fetchAllFundingRates } from "./bitunix-service.js";
import { prisma } from "./prisma-client.js";
import { sendTelegramMessage } from "./telegram-service.js";
import { logger } from "./logger.js";

interface FundingFlip {
  symbol: string;
  previousFunding: number;
  currentFunding: number;
  swing: number; // negative = flip to shorts paying
  swingPct: number;
  timestamp: Date;
  intensity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

async function getFundingSnapshot(): Promise<Map<string, number>> {
  const rates = await fetchAllFundingRates();
  return rates;
}

async function getPreviousFundingRates(): Promise<Map<string, number>> {
  // Get latest funding rates from DB (within last 2 hours)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const snapshots = await prisma.fundingRateSnapshot.findMany({
    where: {
      createdAt: { gte: twoHoursAgo }
    },
    orderBy: { createdAt: "desc" },
    take: 578 // one set per symbol
  });

  const map = new Map<string, number>();
  for (const snapshot of snapshots) {
    if (!map.has(snapshot.symbol)) {
      map.set(snapshot.symbol, snapshot.fundingRate);
    }
  }
  return map;
}

async function storeFundingSnapshot(rates: Map<string, number>): Promise<void> {
  const data = Array.from(rates.entries()).map(([symbol, fundingRate]) => ({
    symbol,
    fundingRate,
    createdAt: new Date()
  }));

  await prisma.fundingRateSnapshot.createMany({
    data,
    skipDuplicates: true
  });

  logger.info(`[funding-flip-monitor] stored ${data.length} funding rate snapshots`);
}

async function detectFundingFlips(
  previous: Map<string, number>,
  current: Map<string, number>
): Promise<FundingFlip[]> {
  const flips: FundingFlip[] = [];

  for (const [symbol, currentRate] of current.entries()) {
    const previousRate = previous.get(symbol) ?? 0;

    // Only care about flips from positive to negative (shorts getting liquidated)
    if (previousRate > 0 && currentRate < 0) {
      const swing = currentRate - previousRate;
      const swingPct = Math.abs(swing);

      let intensity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" = "LOW";
      if (swingPct > 2) intensity = "CRITICAL";
      else if (swingPct > 1) intensity = "HIGH";
      else if (swingPct > 0.5) intensity = "MEDIUM";

      flips.push({
        symbol,
        previousFunding: previousRate,
        currentFunding: currentRate,
        swing,
        swingPct,
        timestamp: new Date(),
        intensity
      });
    }
  }

  return flips;
}

function formatFlipAlert(flips: FundingFlip[]): string {
  if (flips.length === 0) {
    return "";
  }

  // Sort by intensity and swing magnitude
  const sorted = flips.sort((a, b) => {
    const intensityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    if (intensityOrder[a.intensity] !== intensityOrder[b.intensity]) {
      return intensityOrder[a.intensity] - intensityOrder[b.intensity];
    }
    return b.swingPct - a.swingPct;
  });

  const critical = sorted.filter(f => f.intensity === "CRITICAL");
  const high = sorted.filter(f => f.intensity === "HIGH");

  let alert = "";

  if (critical.length > 0) {
    alert += "🚨 **CRITICAL FUNDING FLIPS DETECTED** 🚨\n\n";
    alert += "💰 **RECOMMENDATION: LONG ENTRY (10x leverage, 3-4% scalp)**\n";
    alert += "   Risk: Shorts liquidating = bullish pressure + volume spike incoming\n";
    alert += "   ETA: 2-6 hours to +20-40% move\n";
    alert += "   Target: +3-4% quick scalp OR hold runners for +10-20%\n\n";
    
    for (const flip of critical.slice(0, 5)) {
      alert += `**${flip.symbol}**\n`;
      alert += `  Previous: ${(flip.previousFunding * 100).toFixed(4)}% → Current: ${(flip.currentFunding * 100).toFixed(4)}%\n`;
      alert += `  Swing: ${(flip.swingPct * 100).toFixed(2)}% (SHORTS LIQUIDATING)\n`;
      alert += `  Entry: Market or 0.5-1% above current price\n`;
      alert += `  Stop: 3% below entry\n\n`;
    }
  }

  if (high.length > 0) {
    alert += high.length > 0 && critical.length > 0 ? "\n" : "";
    alert += "⚠️ **HIGH FUNDING FLIPS - CONDITIONAL LONG** ⚠️\n";
    alert += "   Recommendation: Enter if RSI < 40, volume > 1h avg\n\n";
    for (const flip of high.slice(0, 3)) {
      alert += `${flip.symbol}: ${(flip.swingPct * 100).toFixed(2)}% swing → 20%+ potential\n`;
    }
  }

  return alert;
}

async function monitorFundingFlips(): Promise<void> {
  logger.info("[funding-flip-monitor] starting continuous funding monitor");

  const pollIntervalMs = parseInt(process.env.FUNDING_FLIP_POLL_INTERVAL_MS ?? "3600000"); // default 1 hour

  // Run continuously
  while (true) {
    try {
      logger.info("[funding-flip-monitor] fetching funding rates...");

      const current = await getFundingSnapshot();
      const previous = await getPreviousFundingRates();

      await storeFundingSnapshot(current);

      const flips = await detectFundingFlips(previous, current);

      if (flips.length > 0) {
        logger.warn(`[funding-flip-monitor] detected ${flips.length} funding flips`, {
          flips: flips.map(f => ({
            symbol: f.symbol,
            swing: f.swingPct,
            intensity: f.intensity
          }))
        });

        const alert = formatFlipAlert(flips);
        if (alert) {
          await sendTelegramMessage(alert);
          logger.info("[funding-flip-monitor] sent funding flip alert to Telegram");
        }
      } else {
        logger.info("[funding-flip-monitor] no significant funding flips detected");
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    } catch (error) {
      logger.error("[funding-flip-monitor] error in monitoring loop", { error });
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute retry
    }
  }
}

// Main entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  monitorFundingFlips().catch(err => {
    logger.error("[funding-flip-monitor] fatal error", { error: err });
    process.exit(1);
  });
}

export { monitorFundingFlips, detectFundingFlips, formatFlipAlert, FundingFlip };
