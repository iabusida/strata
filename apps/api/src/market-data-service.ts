import type { MarketType, ScanParams, SkippedToken, TokenRsiResult } from "./rsi.js";
import * as bitunix from "./bitunix-service.js";
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

function resolveProvider(): "HYPERLIQUID" | "OKX" | "BITUNIX" {
  const raw = String(process.env.MARKET_DATA_PROVIDER ?? "OKX").trim().toUpperCase();
  if (raw === "HYPERLIQUID" || raw === "OKX" || raw === "BITUNIX") {
    return raw;
  }

  throw new Error(`Invalid MARKET_DATA_PROVIDER: ${raw}`);
}

export const MARKET_DATA_PROVIDER = resolveProvider();

const provider: ProviderModule = MARKET_DATA_PROVIDER === "OKX"
  ? okx
  : MARKET_DATA_PROVIDER === "BITUNIX"
    ? (bitunix as ProviderModule)
    : (hyperliquid as ProviderModule);

export const fetchLatestOhlc = provider.fetchLatestOhlc;
export const fetchPerpContexts = provider.fetchPerpContexts;
export const fetchOrderBookExecutionRead = provider.fetchOrderBookExecutionRead;
export const searchTokens = provider.searchTokens;
export const scanRsi = provider.scanRsi;
