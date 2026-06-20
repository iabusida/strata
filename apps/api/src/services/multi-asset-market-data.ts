import { CandleInterval } from "@prisma/client";
import type { AssetType } from "@prisma/client";
import { prisma } from "../prisma-client.js";

export interface CandleData {
  symbol: string;
  assetType: AssetType;
  interval: CandleInterval;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleQuery {
  symbol: string;
  assetType?: AssetType;
  interval: CandleInterval;
  limit?: number;
}

export class MultiAssetMarketData {
  /**
   * Fetch candles for a symbol across all asset types
   */
  async getCandles(query: CandleQuery): Promise<CandleData[]> {
    const { symbol, assetType, interval, limit = 120 } = query;

    const candles = await prisma.marketCandle.findMany({
      where: {
        symbol,
        interval,
        ...(assetType && { assetType }),
      },
      orderBy: { timestamp: "desc" },
      take: limit,
    });

    return candles.reverse();
  }

  /**
   * Get latest candle for a symbol
   */
  async getLatestCandle(
    symbol: string,
    assetType: AssetType,
    interval: CandleInterval
  ): Promise<CandleData | null> {
    const candle = await prisma.marketCandle.findFirst({
      where: {
        symbol,
        assetType,
        interval,
      },
      orderBy: { timestamp: "desc" },
    });

    return candle || null;
  }

  /**
   * Insert or update candles (for backfill + live feed)
   */
  async upsertCandles(candles: CandleData[]): Promise<void> {
    for (const candle of candles) {
      // Use the composite key that matches Prisma's @@unique constraint
      const compositeKey = `${candle.symbol}_${candle.assetType}_${candle.interval}_${candle.timestamp.getTime()}`;
      
      await prisma.marketCandle.upsert({
        where: {
          // Prisma composite unique - need to use each field
          symbol_assetType_interval_timestamp: {
            symbol: candle.symbol,
            assetType: candle.assetType,
            interval: candle.interval,
            timestamp: candle.timestamp,
          },
        } as any, // Use any to work around Prisma type generation
        update: {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        },
        create: candle,
      });
    }
  }

  /**
   * Get universe of symbols by asset type
   */
  async getSymbolsByAssetType(assetType: AssetType): Promise<string[]> {
    const rows = await prisma.marketCandle.findMany({
      where: { assetType },
      select: { symbol: true },
      distinct: ["symbol"],
    });

    return rows.map((r) => r.symbol);
  }

  /**
   * Get trading stats for a symbol
   */
  async getSymbolStats(
    symbol: string,
    assetType: AssetType,
    interval: CandleInterval,
    periods: number = 120
  ): Promise<{
    high: number;
    low: number;
    avg: number;
    latest: number;
  }> {
    const candles = await this.getCandles({
      symbol,
      assetType,
      interval,
      limit: periods,
    });

    if (candles.length === 0) {
      return { high: 0, low: 0, avg: 0, latest: 0 };
    }

    const closes = candles.map((c) => c.close);
    const high = Math.max(...closes);
    const low = Math.min(...closes);
    const avg = closes.reduce((a, b) => a + b, 0) / closes.length;
    const latest = closes[closes.length - 1];

    return { high, low, avg, latest };
  }
}

export default new MultiAssetMarketData();
