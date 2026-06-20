import {
  AssetType,
  CandleInterval,
  OptionSide,
} from "@prisma/client";
import multiAssetMarketData, {
  type CandleData,
} from "./multi-asset-market-data.js";
import { prisma } from "../prisma-client.js";

export interface DerivativeCandleInput {
  symbol: string;
  venue: string;
  underlyingSymbol: string;
  interval: CandleInterval;
  candles: Array<{
    timestamp: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  contractSize?: number;
  tickSize?: number;
  metadata?: Record<string, unknown>;
}

export interface OptionCandleInput extends DerivativeCandleInput {
  strike?: number;
  expiration?: Date;
  optionSide?: OptionSide;
}

function toCandleRows(
  assetType: AssetType,
  symbol: string,
  interval: CandleInterval,
  candles: DerivativeCandleInput["candles"]
): CandleData[] {
  return candles.map((candle) => ({
    symbol,
    assetType,
    interval,
    timestamp: candle.timestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }));
}

export async function ingestFuturesCandles(
  input: DerivativeCandleInput
): Promise<{ insertedCandles: number }> {
  await prisma.derivativeInstrument.upsert({
    where: { symbol: input.symbol },
    update: {
      venue: input.venue,
      underlyingSymbol: input.underlyingSymbol,
      contractSize: input.contractSize,
      tickSize: input.tickSize,
      metadata: (input.metadata ?? {}) as any,
      assetType: AssetType.FUTURE,
    },
    create: {
      symbol: input.symbol,
      venue: input.venue,
      underlyingSymbol: input.underlyingSymbol,
      contractSize: input.contractSize,
      tickSize: input.tickSize,
      metadata: (input.metadata ?? {}) as any,
      assetType: AssetType.FUTURE,
    },
  });

  const rows = toCandleRows(
    AssetType.FUTURE,
    input.symbol,
    input.interval,
    input.candles
  );

  await multiAssetMarketData.upsertCandles(rows);
  return { insertedCandles: rows.length };
}

export async function ingestOptionsCandles(
  input: OptionCandleInput
): Promise<{ insertedCandles: number }> {
  await prisma.derivativeInstrument.upsert({
    where: { symbol: input.symbol },
    update: {
      venue: input.venue,
      underlyingSymbol: input.underlyingSymbol,
      expiration: input.expiration,
      strike: input.strike,
      optionSide: input.optionSide,
      contractSize: input.contractSize,
      tickSize: input.tickSize,
      metadata: (input.metadata ?? {}) as any,
      assetType: AssetType.OPTION,
    },
    create: {
      symbol: input.symbol,
      venue: input.venue,
      underlyingSymbol: input.underlyingSymbol,
      expiration: input.expiration,
      strike: input.strike,
      optionSide: input.optionSide,
      contractSize: input.contractSize,
      tickSize: input.tickSize,
      metadata: (input.metadata ?? {}) as any,
      assetType: AssetType.OPTION,
    },
  });

  const rows = toCandleRows(
    AssetType.OPTION,
    input.symbol,
    input.interval,
    input.candles
  );

  await multiAssetMarketData.upsertCandles(rows);
  return { insertedCandles: rows.length };
}
