/**
 * Funding Flip Monitor
 * 
 * Continuously monitors funding rate changes to detect runners before breakout.
 * Runs independently to catch mid-scan funding swings (e.g., VANRY-style liquidation cascades).
 * 
 * Alerts on:
 * 1. **Actual flips**: Swing from positive → negative funding (shorts liquidating)
 * 2. **Pre-flip setups**: High positive funding declining fast + RSI oversold (cascade incoming)
 */

import { fetchAllFundingRates, fetchRecentCandles } from "./bitunix-service.js";
import { prisma } from "./prisma-client.js";
import { sendTelegramMessage } from "./telegram-service.js";
import { logger } from "./logger.js";
import { calculateRsi } from "./simple-momentum-engine.js";

interface FundingFlip {
  symbol: string;
  previousFunding: number;
  currentFunding: number;
  swing: number; // negative = flip to shorts paying
  swingPct: number;
  timestamp: Date;
  intensity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

interface PreFlipSetup {
  symbol: string;
  currentFunding: number;
  previousFunding: number;
  fundingDeclineRatio: number; // how much it dropped (0.0050 -> 0.0025 = 50% = 0.5)
  rsi: number;
  timestamp: Date;
  riskLevel: "HIGH" | "CRITICAL"; // based on how much decline + RSI
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

async function detectPreFlipSetups(
  previous: Map<string, number>,
  current: Map<string, number>
): Promise<PreFlipSetup[]> {
  const setups: PreFlipSetup[] = [];

  // Fetch RSI for high-funding symbols to check if oversold
  const highFundingSymbols = Array.from(current.entries())
    .filter(([_, rate]) => rate > 0.0001) // Only positive funding
    .map(([symbol, _]) => symbol)
    .slice(0, 50); // Limit to 50 to avoid rate limits

  const rsiMap = new Map<string, number>();

  for (const symbol of highFundingSymbols) {
    try {
      const candles = await fetchRecentCandles(symbol, "1d", 30);
      if (candles && candles.length > 0) {
        const closes = candles.map(c => c.close).reverse(); // oldest first
        const rsi = calculateRsi(closes, 14);
        rsiMap.set(symbol, rsi);
      }
    } catch (err) {
      logger.debug(`[funding-flip-monitor] failed to fetch RSI for ${symbol}`, { error: err });
    }
  }

  // Check for pre-flip setups
  for (const [symbol, currentRate] of current.entries()) {
    const previousRate = previous.get(symbol) ?? 0;
    const rsi = rsiMap.get(symbol);

    // Pre-flip setup: High positive funding + declining + RSI oversold
    if (
      currentRate > 0.0001 && // Currently has positive funding
      previousRate > 0 && // Was positive before
      currentRate < previousRate && // Declined
      rsi !== undefined && rsi < 35 // RSI oversold
    ) {
      const fundingDeclineRatio = (previousRate - currentRate) / previousRate;

      // Only alert if significant decline
      if (fundingDeclineRatio > 0.3) {
        const riskLevel = fundingDeclineRatio > 0.7 && rsi < 25 ? "CRITICAL" : "HIGH";

        setups.push({
          symbol,
          currentFunding: currentRate,
          previousFunding: previousRate,
          fundingDeclineRatio,
          rsi,
          timestamp: new Date(),
          riskLevel
        });
      }
    }
  }

  return setups;
}

async function formatPreFlipAlert(setups: PreFlipSetup[]): Promise<string> {
  if (setups.length === 0) {
    return "";
  }

  // Sort by risk level and decline
  const sorted = setups.sort((a, b) => {
    const riskOrder = { CRITICAL: 0, HIGH: 1 };
    if (riskOrder[a.riskLevel] !== riskOrder[b.riskLevel]) {
      return riskOrder[a.riskLevel] - riskOrder[b.riskLevel];
    }
    return b.fundingDeclineRatio - a.fundingDeclineRatio;
  });

  const critical = sorted.filter(s => s.riskLevel === "CRITICAL");
  const high = sorted.filter(s => s.riskLevel === "HIGH");

  let alert = "";

  if (critical.length > 0) {
    alert += "⚡ **CRITICAL PRE-FLIP SETUPS** ⚡\n";
    alert += "Liquidation cascade likely in 1-2 hours\n\n";
    alert += "📋 **RECOMMENDATION: MARKET WATCH + PRE-POSITION**\n";
    alert += "   Setup: High funding crashing + oversold RSI\n";
    alert += "   Action: Ready quick entry when flip occurs\n";
    alert += "   Target: +3-4% on flip signal\n\n";

    for (const setup of critical.slice(0, 5)) {
      alert += `**${setup.symbol}**\n`;
      alert += `  Funding: ${(setup.previousFunding * 100).toFixed(4)}% → ${(setup.currentFunding * 100).toFixed(4)}%\n`;
      alert += `  Decline: -${(setup.fundingDeclineRatio * 100).toFixed(1)}% (funding crashing)\n`;
      alert += `  RSI: ${setup.rsi.toFixed(1)} (oversold, ready to break)\n`;
      alert += `  ⏰ ETA: 1-2 hours to flip\n\n`;
    }
  }

  if (high.length > 0) {
    alert += high.length > 0 && critical.length > 0 ? "\n" : "";
    alert += "⚠️ **HIGH PRE-FLIP SETUPS** ⚠️\n";
    alert += "Watch for flip signal\n\n";

    for (const setup of high.slice(0, 3)) {
      alert += `${setup.symbol}: Funding -${(setup.fundingDeclineRatio * 100).toFixed(0)}% | RSI ${setup.rsi.toFixed(0)}\n`;
    }
  }

  return alert;
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

function getDelayToNextBoundary(intervalMs: number): number {
  const nowMs = Date.now();
  const remainder = nowMs % intervalMs;
  return remainder === 0 ? intervalMs : intervalMs - remainder;
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
      const preFlips = await detectPreFlipSetups(previous, current);

      // Send flip alerts (highest priority)
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

      // Send pre-flip alerts (secondary)
      if (preFlips.length > 0) {
        logger.warn(`[funding-flip-monitor] detected ${preFlips.length} pre-flip setups`, {
          preFlips: preFlips.map(p => ({
            symbol: p.symbol,
            fundingDecline: p.fundingDeclineRatio,
            rsi: p.rsi,
            riskLevel: p.riskLevel
          }))
        });

        const preFlipAlert = await formatPreFlipAlert(preFlips);
        if (preFlipAlert) {
          await sendTelegramMessage(preFlipAlert);
          logger.info("[funding-flip-monitor] sent pre-flip setup alert to Telegram");
        }
      } else {
        logger.info("[funding-flip-monitor] no critical pre-flip setups detected");
      }

      // Align to interval boundaries (for 1h, this is the top of the hour)
      const delayMs = getDelayToNextBoundary(pollIntervalMs);
      const nextRun = new Date(Date.now() + delayMs).toISOString();
      logger.info(`[funding-flip-monitor] next run at ${nextRun}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
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

export { 
  monitorFundingFlips, 
  detectFundingFlips, 
  detectPreFlipSetups,
  formatFlipAlert, 
  formatPreFlipAlert,
  FundingFlip, 
  PreFlipSetup 
};
