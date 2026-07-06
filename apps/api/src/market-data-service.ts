import type { MarketType, ScanParams, SkippedToken, TokenRsiResult } from "./rsi.js";
import * as bitunix from "./bitunix-service.js";
import * as coinbaseProvider from "./coinbase-provider.js";
import * as hyperliquid from "./hyperliquid-service.js";
import * as okx from "./okx-service.js";

export type LatestOhlc = {
  open: number;
  high: number;
  low: number;
  close: number;
  time: number;
};

export type PerpAssetContext = {
  symbol: string;
  fundingRate: number;
  markPrice: number;
  oraclePrice: number;
  midPrice: number;
  openInterest: number;
  openInterestUsd: number;
  dayNtlVolume: number;
  maxLeverage?: number;
};

export type OrderBookExecutionRead = {
  symbol: string;
  bestBid: number;
  bestAsk: number;
  markPrice: number;
  spreadPct: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  combinedDepthUsd: number;
  imbalance: number;
  depthBps: number;
  dayNtlVolume?: number;
  imbalanceAvg30s?: number;
  imbalanceAvg1m?: number;
  imbalanceAvg5m?: number;
  imbalanceAvg15m?: number;
  imbalanceStability?: number;
  depthStability?: number;
  spreadStability?: number;
  liquidityStabilityScore?: number;
  liquidityStabilityLabel?: "LOW" | "MEDIUM" | "HIGH";
  bidDepthTrendPct?: number;
  obsScoreRolling?: number;
  absorptionScore?: number;
  distributionScore?: number;
  askWallScore?: number;
  askWallLabel?: "STRONG_ASK_WALL" | "MODERATE_ASK_WALL" | "WEAK_ASK_WALL";
  bidWallScore?: number;
  bidWallLabel?: "STRONG_SUPPORT" | "MODERATE_SUPPORT" | "WEAK_SUPPORT";
  shortSqueezeFuelScore?: number;
  supportDefenseScore?: number;
  priceConfirmationScore?: number;
  liquidityDivergence?: "BULLISH" | "BEARISH" | "NONE";
  liquidityRegime?: "BUYER_DOMINATED" | "SELLER_DOMINATED" | "POTENTIAL_ABSORPTION" | "ABSORPTION" | "DISTRIBUTION" | "SHORT_FUEL" | "NEUTRAL";
  finalLiquidityScore?: number;
  actionRecommendation?: "BUY" | "WAIT" | "SELL";
  actionConfidencePct?: number;
  actionEvidencePositive?: string[];
  actionEvidenceWarnings?: string[];
  actionMissingConditions?: string[];
  actionPrimaryBlocker?: string;
  actionReason?: string;
};

export type ScanResult = {
  analyzedAt: string;
  params: ScanParams;
  results: TokenRsiResult[];
  skipped: SkippedToken[];
};

type ProviderModule = {
  fetchLatestOhlc(symbol: string, interval?: "1m" | "5m" | "15m" | "1h" | "4h"): Promise<LatestOhlc | null>;
  fetchPerpContexts(symbols: string[]): Promise<Map<string, PerpAssetContext>>;
  fetchOrderBookExecutionRead(symbol: string): Promise<OrderBookExecutionRead | null>;
  searchTokens(query: string | undefined, market: MarketType): Promise<string[]>;
  scanRsi(params: ScanParams): Promise<ScanResult>;
};

function resolveProvider(): "HYPERLIQUID" | "OKX" | "BITUNIX" | "COINBASE" {
  const raw = String(process.env.MARKET_DATA_PROVIDER ?? "OKX").trim().toUpperCase();
  if (raw === "HYPERLIQUID" || raw === "OKX" || raw === "BITUNIX" || raw === "COINBASE") {
    return raw as any;
  }

  throw new Error(`Invalid MARKET_DATA_PROVIDER: ${raw}. Supported: HYPERLIQUID, OKX, BITUNIX, COINBASE`);
}

export const MARKET_DATA_PROVIDER = resolveProvider();

// Route market data through provider
const defaultProvider: ProviderModule = MARKET_DATA_PROVIDER === "OKX"
  ? okx
  : MARKET_DATA_PROVIDER === "BITUNIX"
    ? (bitunix as ProviderModule)
    : MARKET_DATA_PROVIDER === "COINBASE"
      ? coinbaseProvider
      : (hyperliquid as ProviderModule); // HYPERLIQUID

function resolveProviderForMarket(market: MarketType): ProviderModule {
  // If explicitly using Bitunix, use it for both spot and perp for data consistency
  if (MARKET_DATA_PROVIDER === "BITUNIX") {
    return defaultProvider;
  }

  // Otherwise, use Coinbase for spot to avoid perp symbol/value bleed
  if (market === "spot") {
    return coinbaseProvider;
  }

  return defaultProvider;
}

export const fetchLatestOhlc = defaultProvider.fetchLatestOhlc;
export const fetchPerpContexts = defaultProvider.fetchPerpContexts;
export const fetchOrderBookExecutionRead = defaultProvider.fetchOrderBookExecutionRead;

export async function searchTokens(query: string | undefined, market: MarketType): Promise<string[]> {
  return await resolveProviderForMarket(market).searchTokens(query, market);
}

export async function scanRsi(params: ScanParams): Promise<ScanResult> {
  return await resolveProviderForMarket(params.market).scanRsi(params);
}
