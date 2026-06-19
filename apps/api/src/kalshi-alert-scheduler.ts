/**
 * Kalshi BTC Alert Scheduler
 * Sends hourly BTC sentiment alerts via Telegram
 * Runs 5 minutes before every hour (:55)
 */

import * as kalshiSignal from "./kalshi-signal-analyzer.js";
import type { KalshiSignal } from "./kalshi-signal-analyzer.js";
import * as kalshi from "./kalshi-service.js";
import type { KalshiMarket } from "./kalshi-service.js";
import { sendTelegramMessage } from "./telegram-service.js";
import { fetchLatestOhlc } from "./market-data-service.js";

export interface KalshiAlertSchedulerState {
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  totalRuns: number;
}

const state: KalshiAlertSchedulerState = {
  enabled: false,
  nextRunAt: null,
  lastRunAt: null,
  lastError: null,
  totalRuns: 0,
};

let schedulerTimer: NodeJS.Timeout | null = null;

/**
 * Format Kalshi BTC signal for Telegram with markets and recommendation
 */
export function formatKalshiBtcAlert(
  signal: KalshiSignal,
  btcPrice: number | null,
  markets: KalshiMarket[],
  recommendation: string
): string {
  const signalEmojiMap: Record<string, string> = {
    READY: "🟢",
    CAUTION: "🟡",
    BLOCKED: "🔴",
  };
  const signalEmoji = signalEmojiMap[signal.signal] || "⚪";

  const sentimentEmojiMap: Record<string, string> = {
    bullish: "📈",
    bearish: "📉",
    neutral: "➡️",
  };
  const sentimentEmoji = sentimentEmojiMap[signal.marketSentiment] || "➡️";

  const lines = [
    `<b>📊 KALSHI BTC SENTIMENT ALERT</b>`,
    ``,
    `${signalEmoji} <b>Signal:</b> <code>${signal.signal}</code>`,
    `<b>Confidence:</b> ${signal.confidence}%`,
    `${sentimentEmoji} <b>Sentiment:</b> ${signal.marketSentiment.toUpperCase()}`,
    ``,
  ];

  // Add live BTC price if available
  if (btcPrice) {
    lines.push(`<b>💰 BTC Live Price:</b> $${btcPrice.toFixed(2)}`);
    lines.push(``);
  }

  // Add market options with YES/NO probabilities
  lines.push(`<b>📈 Market Options (${markets.length} active):</b>`);

  // Sort markets by liquidity and show top ones
  const topMarkets = markets
    .filter((m) => m.status === "active" && (m.yes_bid_dollars || m.yes_ask_dollars))
    .sort((a, b) => {
      const liquidityA = Number(a.liquidity_dollars) || 0;
      const liquidityB = Number(b.liquidity_dollars) || 0;
      return liquidityB - liquidityA;
    })
    .slice(0, 10); // Show top 10 by liquidity

  for (const market of topMarkets) {
    const yesBid = Number(market.yes_bid_dollars) || 0;
    const yesAsk = Number(market.yes_ask_dollars) || 0;
    const yesProb = yesBid && yesAsk ? Math.round(((yesBid + yesAsk) / 2) * 100) : Math.round((yesAsk || yesBid) * 100);
    const noProb = 100 - yesProb;

    // Truncate title for readability
    const marketTitle = market.title.length > 45 ? market.title.substring(0, 42) + "..." : market.title;

    lines.push(
      `• <code>${marketTitle}</code>`,
      `  YES: ${yesProb}% | NO: ${noProb}%`
    );
  }

  lines.push(``);

  // Add recommendation
  lines.push(`<b>🎯 Recommended Voting Choice:</b>`);
  lines.push(`${recommendation}`);
  lines.push(``);

  // Add summary stats
  lines.push(`<b>📊 Market Analysis:</b>`);
  lines.push(`• Average YES Probability: ${signal.marketData.avgYesProbability}%`);
  lines.push(`• Average NO Probability: ${signal.marketData.avgNoProbability}%`);
  lines.push(`• Consensus Strength: ${signal.marketData.consensusStrength}/100`);
  lines.push(``);

  lines.push(`<b>Reasoning:</b>`);
  lines.push(`${signal.reasoning}`);
  lines.push(``);

  lines.push(`<i>⏰ ${signal.timestamp}</i>`);

  return lines.join("\n");
}

/**
 * Generate voting recommendation based on market sentiment
 */
function generateVotingRecommendation(signal: KalshiSignal): string {
  const avgYesProb = signal.marketData.avgYesProbability;
  const consensusStrength = signal.marketData.consensusStrength;

  if (signal.signal === "READY") {
    return `<b>✅ VOTE YES</b>\nMarkets show strong bullish consensus (${avgYesProb}% probability). High conviction recommendation.`;
  } else if (signal.signal === "BLOCKED") {
    return `<b>❌ VOTE NO</b>\nMarkets show strong bearish consensus (${avgYesProb}% probability). High conviction recommendation.`;
  } else if (signal.marketSentiment === "bullish") {
    return `<b>✅ LEAN YES</b>\nMild bullish bias (${avgYesProb}% probability). Consider voting YES with caution.`;
  } else if (signal.marketSentiment === "bearish") {
    return `<b>❌ LEAN NO</b>\nMild bearish bias (${avgYesProb}% probability). Consider voting NO with caution.`;
  } else {
    return `<b>⏸️ HOLD / RESEARCH</b>\nMarkets are evenly split (50-50). Insufficient conviction. Research more before voting.`;
  }
}

/**
 * Generate and send Kalshi BTC alert
 */
export async function sendKalshiBtcAlert(): Promise<void> {
  try {
    console.log("[Kalshi Alert] Generating BTC signal...");
    const signal = await kalshiSignal.generateKalshiSignal("BTC");

    // Fetch live BTC price
    let btcPrice: number | null = null;
    try {
      const ohlc = await fetchLatestOhlc("BTC");
      if (ohlc) {
        btcPrice = ohlc.close;
        console.log(`[Kalshi Alert] BTC live price: $${btcPrice.toFixed(2)}`);
      }
    } catch (priceError) {
      console.warn("[Kalshi Alert] Failed to fetch BTC price, continuing without it:", priceError);
    }

    // Fetch all active markets
    console.log("[Kalshi Alert] Fetching market options...");
    const markets = await kalshi.fetchAllMarkets(100);

    // Generate recommendation
    const recommendation = generateVotingRecommendation(signal);

    // Format alert with all data
    const message = formatKalshiBtcAlert(signal, btcPrice, markets, recommendation);
    console.log("[Kalshi Alert] Sending to Telegram...");

    // Send to default chat (default parameter in sendTelegramMessage)
    await sendTelegramMessage(message);

    console.log("[Kalshi Alert] Alert sent successfully");
    state.lastRunAt = new Date().toISOString();
    state.lastError = null;
    state.totalRuns++;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("[Kalshi Alert] Error:", errorMsg);
    state.lastError = errorMsg;
  }
}

/**
 * Calculate milliseconds until next :55 minute mark
 */
function getMillisecondsUntilNextAlert(): number {
  const now = new Date();
  const minute = now.getMinutes();
  const second = now.getSeconds();
  const millisecond = now.getMilliseconds();

  let minutesUntilAlert: number;

  if (minute < 55) {
    minutesUntilAlert = 55 - minute;
  } else {
    // If already past :55, schedule for next hour's :55
    minutesUntilAlert = 60 - minute + 55;
  }

  // Convert to milliseconds and subtract current second + millisecond
  const currentSecondMs = second * 1000 + millisecond;
  return minutesUntilAlert * 60 * 1000 - currentSecondMs;
}

/**
 * Schedule the next alert
 */
function scheduleNextAlert(): void {
  if (!state.enabled) return;

  const delay = getMillisecondsUntilNextAlert();
  const runAt = new Date(Date.now() + delay).toISOString();

  state.nextRunAt = runAt;

  if (schedulerTimer) clearTimeout(schedulerTimer);

  console.log(
    `[Kalshi Alert] Scheduled for ${runAt} (in ${Math.round(delay / 60000)} min)`
  );

  schedulerTimer = setTimeout(() => {
    sendKalshiBtcAlert().finally(() => scheduleNextAlert());
  }, delay);
}

/**
 * Start the Kalshi alert scheduler
 */
export function startKalshiAlertScheduler(): void {
  if (state.enabled) {
    console.log("[Kalshi Alert] Scheduler already running");
    return;
  }

  const enabled = String(process.env.KALSHI_ALERT_ENABLED ?? "true").toLowerCase() === "true";
  if (!enabled) {
    console.log("[Kalshi Alert] Scheduler disabled via KALSHI_ALERT_ENABLED=false");
    return;
  }

  console.log("[Kalshi Alert] Starting scheduler (alerts at :55 every hour)");
  state.enabled = true;
  scheduleNextAlert();
}

/**
 * Stop the Kalshi alert scheduler
 */
export function stopKalshiAlertScheduler(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  state.enabled = false;
  state.nextRunAt = null;
  console.log("[Kalshi Alert] Scheduler stopped");
}

/**
 * Get scheduler status
 */
export function getKalshiAlertSchedulerStatus(): KalshiAlertSchedulerState {
  return { ...state };
}
