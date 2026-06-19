/**
 * Kalshi Signal Analysis
 * Generates trading signals based on Kalshi prediction market sentiment
 */

import * as kalshi from "./kalshi-service.js";

export interface KalshiSignal {
  symbol: string;
  signal: "READY" | "CAUTION" | "BLOCKED";
  confidence: number; // 0-100
  reasoning: string;
  marketSentiment: "bullish" | "bearish" | "neutral";
  marketData: {
    totalMarkets: number;
    avgYesProbability: number;
    avgNoProbability: number;
    consensusStrength: number; // How strong the consensus is (0-100)
  };
  timestamp: string;
}

/**
 * Analyze Kalshi market sentiment for a given symbol
 */
export async function analyzeKalshiSentiment(symbol: string): Promise<KalshiSignal> {
  const markets = await kalshi.fetchAllMarkets(100);

  if (markets.length === 0) {
    return {
      symbol,
      signal: "BLOCKED",
      confidence: 0,
      reasoning: "No Kalshi markets available for sentiment analysis",
      marketSentiment: "neutral",
      marketData: {
        totalMarkets: 0,
        avgYesProbability: 0,
        avgNoProbability: 0,
        consensusStrength: 0,
      },
      timestamp: new Date().toISOString(),
    };
  }

  // Calculate average YES probability across all markets
  let totalYesProb = 0;
  let validMarkets = 0;

  for (const market of markets) {
    const yesBid = Number(market.yes_bid_dollars) || 0;
    const yesAsk = Number(market.yes_ask_dollars) || 0;

    if (yesBid > 0 || yesAsk > 0) {
      const midPrice = yesBid && yesAsk ? (yesBid + yesAsk) / 2 : yesAsk || yesBid;
      totalYesProb += midPrice;
      validMarkets++;
    }
  }

  const avgYesProb = validMarkets > 0 ? totalYesProb / validMarkets : 0.5;
  const avgNoProb = 1 - avgYesProb;

  // Determine consensus strength (how far from 50-50)
  const consensusStrength = Math.abs(avgYesProb - 0.5) * 200; // 0-100 scale

  // Determine sentiment
  let sentiment: "bullish" | "bearish" | "neutral";
  if (avgYesProb > 0.65) {
    sentiment = "bullish";
  } else if (avgYesProb < 0.35) {
    sentiment = "bearish";
  } else {
    sentiment = "neutral";
  }

  // Generate signal based on sentiment strength
  let signal: "READY" | "CAUTION" | "BLOCKED" = "CAUTION";
  let confidence = 0;
  let reasoning = "";

  if (sentiment === "bullish" && consensusStrength > 40) {
    signal = "READY";
    confidence = Math.min(95, 50 + consensusStrength);
    reasoning = `Strong bullish consensus in prediction markets (${Math.round(avgYesProb * 100)}% YES probability). Market expects positive movement.`;
  } else if (sentiment === "bearish" && consensusStrength > 40) {
    signal = "BLOCKED";
    confidence = Math.min(95, 50 + consensusStrength);
    reasoning = `Strong bearish consensus in prediction markets (${Math.round(avgYesProb * 100)}% YES probability). Market expects negative movement.`;
  } else if (sentiment === "bullish") {
    signal = "CAUTION";
    confidence = 50 + consensusStrength / 2;
    reasoning = `Mild bullish sentiment (${Math.round(avgYesProb * 100)}% YES). Consensus is weak; await stronger conviction.`;
  } else if (sentiment === "bearish") {
    signal = "CAUTION";
    confidence = 50 + consensusStrength / 2;
    reasoning = `Mild bearish sentiment (${Math.round(avgYesProb * 100)}% YES). Consensus is weak; await stronger conviction.`;
  } else {
    signal = "CAUTION";
    confidence = 40;
    reasoning = `Market sentiment is neutral (50-50 split). Insufficient conviction from prediction markets.`;
  }

  return {
    symbol,
    signal,
    confidence: Math.round(confidence),
    reasoning,
    marketSentiment: sentiment,
    marketData: {
      totalMarkets: markets.length,
      avgYesProbability: Math.round(avgYesProb * 100),
      avgNoProbability: Math.round(avgNoProb * 100),
      consensusStrength: Math.round(consensusStrength),
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Generate combined signal using current market data + Kalshi sentiment
 */
export async function generateKalshiSignal(symbol: string = "BTC"): Promise<KalshiSignal> {
  // For now, just use Kalshi sentiment
  // In the future, combine with technical indicators from trade-engine
  return analyzeKalshiSentiment(symbol);
}
