import { ATR, EMA, MACD, RSI, Stochastic } from "technicalindicators";
import type { MarketRegime } from "./regime-engine.js";
import type { EntryTiming } from "./entry-timing.js";

export type MarketType = "perp" | "spot";

export type ScanParams = {
  query?: string;
  market: MarketType;
  limitTokens: number;
  includeSymbols?: string[];
  symbols?: string[];
};

export type RsiStatus = "OVERBOUGHT" | "OVERSOLD" | "NEUTRAL";

export type SignalType =
  | "STRONG SHORT"
  | "STRONG LONG"
  | "CONTINUATION SHORT"
  | "CONTINUATION LONG"
  | "REVERSAL SHORT"
  | "REVERSAL LONG"
  | "NO SIGNAL"
  | "NO SIGNAL (NEAR SUPPORT FLOOR)"
  | "NO SIGNAL (NEAR RESISTANCE)";
export type CandlestickPatternName =
  | "BULLISH_ENGULFING"
  | "BEARISH_ENGULFING"
  | "HAMMER"
  | "SHOOTING_STAR"
  | "MORNING_STAR"
  | "EVENING_STAR";

export type CandlestickPatternSignal = {
  bullishPatterns: CandlestickPatternName[];
  bearishPatterns: CandlestickPatternName[];
  bullishScore: number;
  bearishScore: number;
};


export type SignalCategory = "STRONG" | "CONTINUATION" | "REVERSAL" | "SCORE_BASED";

export type SignalBadge = {
  type: SignalType;
  classes: string;
};

export type TrendDirection = "UP" | "DOWN" | "MIXED";

export type TimeframeTrend = {
  direction: TrendDirection;
  arrow: "▲" | "▼" | "•";
  overbought: boolean;
  oversold: boolean;
};

export type TimeframeRsi = {
  interval: "3d" | "5d" | "1w" | "2w" | "1m" | "1d" | "12h" | "4h" | "1h" | "15m";
  rsi: number;
  macdHist: number;
  stochRsi: number;
  stochK: number;
  stochD: number;
  prevStochK: number;
  prevStochD: number;
  trend: TimeframeTrend;
};

export type TokenRsiResult = {
  symbol: string;
  market: MarketType;
  entryTiming: EntryTiming | null;
  maxLeverage?: number;
  rsi: number;
  close: number;
  volume24h: number;
  volatilityPct: number;
  change24hPct?: number;
  tradeContext: {
    volatilityPct: number;
    volume24h: number;
    volatilityPercentile: number;
    liquidityPercentile: number;
    passedVolatility: boolean;
    passedLiquidity: boolean;
    passedOrderBook: boolean;
    orderBookSpreadPct: number;
    orderBookCombinedDepthUsd: number;
    orderBookImbalance: number;
    orderBookReferenceNotionalUsd: number;
    orderBookDepthBps: number;
    passedStructure: boolean;
    passedMicroTrend: boolean;
    ema20: number;
    emaSlope: number;
    atr1h: number;
    atr4h: number;
    atr: number;
    trendPersistence4h: number;
    regime: MarketRegime;
    atrExpansion: number;
    rangeCompression: number;
    higherTimeframeTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
    structureState: "TRENDING" | "BREAKOUT" | "BREAKDOWN" | "REVERSAL" | "CHOP";
    trendlineBreakout: boolean;
    trendlineBreakdown: boolean;
    candlestick?: CandlestickPatternSignal;
    counterTrendContext?: {
      status: "TREND_ALIGNED" | "COUNTER_TREND" | "CHOP_NO_TREND";
      macroTrend: "UP" | "DOWN" | "MIXED";
      intermediaryTrend: "UP" | "DOWN" | "MIXED";
      triggerDirection: "UP" | "DOWN" | "MIXED";
      isCounterTrend: boolean;
      confidenceMultiplier: number;
    };
    dumpReversalContext?: {
      inDumpZone: boolean;
      dumpDrop: number;
      dumpConfidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
      reactionDetected: boolean;
      reactionStrength: number;
      structureShiftConfirmed: boolean;
      highestLowAfterDump: number | null;
      lowestDumpPrice: number | null;
      bounceHigh: number | null;
      phase: "DUMP_IN_PROGRESS" | "REACTION_FORMING" | "STRUCTURE_CONFIRMED" | "NORMAL";
      stateMessage: string;
      confidenceMultiplier: number;
    };
  };
  confluence: {
    score: number;
    bias: "SHORT" | "LONG" | null;
    maxScore: number;
  };
  levels: {
    localSupport: number;
    localResistance: number;
    nearSupportFloor: boolean;
    nearResistance: boolean;
    supportDistancePct: number;
    resistanceDistancePct: number;
  };
  status: RsiStatus;
  signal: SignalBadge;
  signalCategory: SignalCategory;
  timeframes: {
    daily: TimeframeRsi | null;
    twelveh: TimeframeRsi | null;
    macro: TimeframeRsi;
    intermediary: TimeframeRsi;
    microTrigger: TimeframeRsi;
  };
  higherTimeframes?: {
    threeDay: TimeframeRsi | null;
    fiveDay: TimeframeRsi | null;
    oneWeek: TimeframeRsi | null;
    twoWeek: TimeframeRsi | null;
    oneMonth: TimeframeRsi | null;
  };
};

export type SkippedToken = {
  symbol: string;
  reason: "INSUFFICIENT_CANDLES" | "EMPTY_RSI" | "FETCH_ERROR" | "NON_CRYPTO_FILTERED";
  details?: string;
};

export const SUPPORTED_INTERVALS_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "3d": 259_200_000,
  "5d": 432_000_000,
  "1w": 604_800_000,
  "2w": 1_209_600_000,
  "1M": 2_592_000_000
};

export type HigherTimeframeInterval = "3d" | "5d" | "1w" | "2w" | "1m";

export const HIGHER_TIMEFRAME_BUCKETS: Record<HigherTimeframeInterval, number> = {
  "3d": 3,
  "5d": 5,
  "1w": 7,
  "2w": 14,
  "1m": 30
};

type OhlcLike = {
  o: number;
  h: number;
  l: number;
  c: number;
};

function bodySize(candle: OhlcLike): number {
  return Math.abs(candle.c - candle.o);
}

function candleRange(candle: OhlcLike): number {
  return Math.max(0, candle.h - candle.l);
}

function upperWick(candle: OhlcLike): number {
  return Math.max(0, candle.h - Math.max(candle.o, candle.c));
}

function lowerWick(candle: OhlcLike): number {
  return Math.max(0, Math.min(candle.o, candle.c) - candle.l);
}

function isBullishEngulfing(previous: OhlcLike, current: OhlcLike): boolean {
  return previous.c < previous.o && current.c > current.o && current.o <= previous.c && current.c >= previous.o;
}

function isBearishEngulfing(previous: OhlcLike, current: OhlcLike): boolean {
  return previous.c > previous.o && current.c < current.o && current.o >= previous.c && current.c <= previous.o;
}

function isHammer(candle: OhlcLike): boolean {
  const body = bodySize(candle);
  const range = candleRange(candle);
  if (range <= 0 || body <= 0) {
    return false;
  }

  const lw = lowerWick(candle);
  const uw = upperWick(candle);
  return lw >= body * 2 && uw <= body * 0.6;
}

function isShootingStar(candle: OhlcLike): boolean {
  const body = bodySize(candle);
  const range = candleRange(candle);
  if (range <= 0 || body <= 0) {
    return false;
  }

  const lw = lowerWick(candle);
  const uw = upperWick(candle);
  return uw >= body * 2 && lw <= body * 0.6;
}

function isSmallBody(candle: OhlcLike): boolean {
  const range = candleRange(candle);
  if (range <= 0) {
    return false;
  }
  return bodySize(candle) / range <= 0.35;
}

function isMorningStar(c1: OhlcLike, c2: OhlcLike, c3: OhlcLike): boolean {
  const c1Bear = c1.c < c1.o;
  const c3Bull = c3.c > c3.o;
  const c2Small = isSmallBody(c2);
  const c1Mid = c1.o - bodySize(c1) * 0.5;
  return c1Bear && c2Small && c3Bull && c3.c >= c1Mid;
}

function isEveningStar(c1: OhlcLike, c2: OhlcLike, c3: OhlcLike): boolean {
  const c1Bull = c1.c > c1.o;
  const c3Bear = c3.c < c3.o;
  const c2Small = isSmallBody(c2);
  const c1Mid = c1.o + bodySize(c1) * 0.5;
  return c1Bull && c2Small && c3Bear && c3.c <= c1Mid;
}

export function detectCandlestickPatternSignal(candles: OhlcLike[]): CandlestickPatternSignal {
  const bullishPatterns: CandlestickPatternName[] = [];
  const bearishPatterns: CandlestickPatternName[] = [];

  if (candles.length < 2) {
    return { bullishPatterns, bearishPatterns, bullishScore: 0, bearishScore: 0 };
  }

  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const third = candles.length >= 3 ? candles[candles.length - 3] : null;

  if (isBullishEngulfing(previous, current)) {
    bullishPatterns.push("BULLISH_ENGULFING");
  }
  if (isBearishEngulfing(previous, current)) {
    bearishPatterns.push("BEARISH_ENGULFING");
  }
  if (isHammer(current)) {
    bullishPatterns.push("HAMMER");
  }
  if (isShootingStar(current)) {
    bearishPatterns.push("SHOOTING_STAR");
  }
  if (third && isMorningStar(third, previous, current)) {
    bullishPatterns.push("MORNING_STAR");
  }
  if (third && isEveningStar(third, previous, current)) {
    bearishPatterns.push("EVENING_STAR");
  }

  return {
    bullishPatterns,
    bearishPatterns,
    bullishScore: Number(Math.min(2, bullishPatterns.length * 0.5).toFixed(3)),
    bearishScore: Number(Math.min(2, bearishPatterns.length * 0.5).toFixed(3))
  };
}

const RSI_PERIOD = 14;
const STOCH_RSI_PERIOD = 14;
const STOCH_RSI_STOCH_PERIOD = 14; // lookback window for min/max over RSI values (matches TradingView)
const STOCH_RSI_K_PERIOD = 3;
const STOCH_RSI_D_PERIOD = 3;

export function classifyRsi(rsi: number, overbought: number = 70, oversold: number = 30): RsiStatus {
  if (rsi >= overbought) {
    return "OVERBOUGHT";
  }

  if (rsi <= oversold) {
    return "OVERSOLD";
  }

  return "NEUTRAL";
}

export function calculateLatestRsi(closes: number[], period: number = RSI_PERIOD): number | null {
  if (closes.length < period + 1) {
    return null;
  }

  const values = RSI.calculate({ period, values: closes });
  const latest = values.at(-1);

  return typeof latest === "number" ? latest : null;
}

export function calculateLatestMacdHistogram(closes: number[]): number | null {
  if (closes.length < 35) {
    return null;
  }

  const values = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });

  const latest = values.at(-1);
  if (!latest || typeof latest.histogram !== "number") {
    return null;
  }

  return Number(latest.histogram.toFixed(4));
}

export function calculateLatestEma(closes: number[], period: number): number | null {
  if (closes.length < period + 1) {
    return null;
  }

  const values = EMA.calculate({ period, values: closes });
  const latest = values.at(-1);
  return typeof latest === "number" ? Number(latest.toFixed(6)) : null;
}

export function aggregateClosesByBucket(closes: number[], bucketSize: number): number[] {
  if (bucketSize <= 1) {
    return closes.slice();
  }

  if (closes.length < bucketSize) {
    return [];
  }

  const remainder = closes.length % bucketSize;
  const start = remainder === 0 ? 0 : remainder;
  const aggregated: number[] = [];

  for (let i = start; i + bucketSize <= closes.length; i += bucketSize) {
    const bucket = closes.slice(i, i + bucketSize);
    aggregated.push(bucket[bucket.length - 1]);
  }

  return aggregated;
}

export function buildTimeframeRsiFromCloses(closes: number[], interval: TimeframeRsi["interval"]): TimeframeRsi | null {
  if (closes.length < 35) {
    return null;
  }

  const rsi = calculateLatestRsi(closes);
  if (rsi === null) {
    return null;
  }

  const macdHist = calculateLatestMacdHistogram(closes);
  if (macdHist === null) {
    return null;
  }

  const stoch = calculateStochasticRsi(closes, 14, 14, 3, 3);
  if (stoch === null) {
    return null;
  }

  return {
    interval,
    rsi: Number(rsi.toFixed(2)),
    macdHist,
    stochRsi: stoch.stochRsi,
    stochK: stoch.k,
    stochD: stoch.d,
    prevStochK: stoch.prevK,
    prevStochD: stoch.prevD,
    trend: translateTimeframeTrend(
      stoch.k,
      stoch.d,
      stoch.prevK,
      stoch.prevD,
      Number(rsi.toFixed(2))
    )
  };
}

export function buildHigherTimeframeRsiFromCloses(
  closes: number[],
  interval: HigherTimeframeInterval
): TimeframeRsi | null {
  return buildTimeframeRsiFromCloses(aggregateClosesByBucket(closes, HIGHER_TIMEFRAME_BUCKETS[interval]), interval);
}

export function calculateLatestAtr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): number | null {
  if (highs.length < period + 1 || lows.length < period + 1 || closes.length < period + 1) {
    return null;
  }

  const values = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period
  });
  const latest = values.at(-1);
  return typeof latest === "number" ? Number(latest.toFixed(6)) : null;
}

export function calculateStochasticRsiSeries(
  closes: number[],
  rsiPeriod: number = STOCH_RSI_PERIOD,
  stochPeriod: number = STOCH_RSI_STOCH_PERIOD,
  kPeriod: number = STOCH_RSI_K_PERIOD,
  dPeriod: number = STOCH_RSI_D_PERIOD
): Array<{ k: number; d: number }> {
  const minLen = rsiPeriod + stochPeriod + kPeriod + dPeriod + 5;
  if (closes.length < minLen) {
    return [];
  }

  // Step 1: calculate full RSI series
  const rsiValues = RSI.calculate({ period: rsiPeriod, values: closes });
  if (rsiValues.length < stochPeriod + kPeriod + dPeriod) {
    return [];
  }

  // Step 2: rolling min/max over stochPeriod to produce raw StochRSI values (0-100 scale)
  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const minRsi = Math.min(...window);
    const maxRsi = Math.max(...window);
    const range = maxRsi - minRsi;
    rawK.push(range === 0 ? 0 : ((rsiValues[i] - minRsi) / range) * 100);
  }

  if (rawK.length < kPeriod + dPeriod) {
    return [];
  }

  // Step 3: smooth K with kPeriod SMA
  const smoothK: number[] = [];
  for (let i = kPeriod - 1; i < rawK.length; i++) {
    const slice = rawK.slice(i - kPeriod + 1, i + 1);
    smoothK.push(slice.reduce((a, b) => a + b, 0) / kPeriod);
  }

  if (smoothK.length < dPeriod) {
    return [];
  }

  // Step 4: smooth D with dPeriod SMA over smoothed K
  const result: Array<{ k: number; d: number }> = [];
  for (let i = dPeriod - 1; i < smoothK.length; i++) {
    const slice = smoothK.slice(i - dPeriod + 1, i + 1);
    const d = slice.reduce((a, b) => a + b, 0) / dPeriod;
    result.push({
      k: Number(smoothK[i].toFixed(2)),
      d: Number(d.toFixed(2))
    });
  }

  return result;
}

export function calculateStochasticRsi(
  closes: number[],
  rsiPeriod: number = STOCH_RSI_PERIOD,
  stochPeriod: number = STOCH_RSI_STOCH_PERIOD,
  kPeriod: number = STOCH_RSI_K_PERIOD,
  dPeriod: number = STOCH_RSI_D_PERIOD
): { stochRsi: number; k: number; d: number; prevK: number; prevD: number } | null {
  const series = calculateStochasticRsiSeries(closes, rsiPeriod, stochPeriod, kPeriod, dPeriod);
  if (series.length < 2) {
    return null;
  }

  const latest = series[series.length - 1];
  const previous = series[series.length - 2];

  const stochRsi = Number(((latest.k + latest.d) / 2).toFixed(2));
  return {
    stochRsi,
    k: latest.k,
    d: latest.d,
    prevK: previous.k,
    prevD: previous.d
  };
}

export function translateTimeframeTrend(
  currentK: number,
  currentD: number,
  previousK: number,
  previousD: number,
  rsi: number
): TimeframeTrend {
  const kRising = currentK > previousK;
  const dRising = currentD > previousD;
  const kFalling = currentK < previousK;
  const dFalling = currentD < previousD;

  const isUp = currentK > currentD && kRising && dRising;
  const isDown = currentK < currentD && kFalling && dFalling;

  let direction: TrendDirection = "MIXED";
  let arrow: "▲" | "▼" | "•" = "•";

  if (isUp) {
    direction = "UP";
    arrow = "▲";
  } else if (isDown) {
    direction = "DOWN";
    arrow = "▼";
  }

  return {
    direction,
    arrow,
    overbought: rsi >= 70,
    oversold: rsi <= 30
  };
}

export function isBearishCross(previousK: number, previousD: number, currentK: number, currentD: number): boolean {
  return previousK >= previousD && currentK < currentD;
}

export function isBullishCross(previousK: number, previousD: number, currentK: number, currentD: number): boolean {
  return previousK <= previousD && currentK > currentD;
}

export function determineSignal(
  macro: TimeframeRsi,
  intermediary: TimeframeRsi,
  microTrigger: TimeframeRsi,
  context?: {
    daily?: TimeframeRsi | null;
    twelveh?: TimeframeRsi | null;
  }
): SignalType {
  const bearishMomentumAligned =
    microTrigger.stochK < microTrigger.stochD &&
    microTrigger.stochK <= microTrigger.prevStochK;
  const bullishMomentumAligned =
    microTrigger.stochK > microTrigger.stochD &&
    microTrigger.stochK >= microTrigger.prevStochK;

  // STRONG SHORT: macro bear bias + 1h top-zone bounce + fresh 15m bearish cross above midline
  const macroShortTrend = macro.stochK < macro.stochD && macro.macdHist < 0;
  const intermediaryShortBounce = intermediary.stochK >= 65 && intermediary.rsi >= 52;
  const microShortTrigger =
    bearishMomentumAligned &&
    isBearishCross(
      microTrigger.prevStochK,
      microTrigger.prevStochD,
      microTrigger.stochK,
      microTrigger.stochD
    );

  if (macroShortTrend && intermediaryShortBounce && microShortTrigger) {
    return "STRONG SHORT";
  }

  // STRONG LONG: macro bull bias + 1h floor pullback + fresh 15m bullish cross below midline
  const macroLongTrend = macro.stochK > macro.stochD && macro.macdHist > 0;
  const intermediaryLongPullback = intermediary.stochK <= 35 && intermediary.rsi <= 48;
  const microLongTrigger =
    bullishMomentumAligned &&
    isBullishCross(
      microTrigger.prevStochK,
      microTrigger.prevStochD,
      microTrigger.stochK,
      microTrigger.stochD
    );

  if (macroLongTrend && intermediaryLongPullback && microLongTrigger) {
    return "STRONG LONG";
  }

  // CONTINUATION SHORT: same macro bear bias + intermediary mid-band + fresh 15m bearish cross below midline
  const continuationShortMacro = macro.stochK < macro.stochD && macro.macdHist < 0;
  const continuationShortIntermediary =
    intermediary.stochK >= 25 && intermediary.stochK <= 70 && intermediary.rsi >= 42 && intermediary.rsi <= 62;
  const continuationShortMicro =
    bearishMomentumAligned &&
    isBearishCross(
      microTrigger.prevStochK,
      microTrigger.prevStochD,
      microTrigger.stochK,
      microTrigger.stochD
    );

  if (continuationShortMacro && continuationShortIntermediary && continuationShortMicro) {
    return "CONTINUATION SHORT";
  }

  // CONTINUATION LONG: same macro bull bias + intermediary mid-band + fresh 15m bullish cross above midline
  const continuationLongMacro = macro.stochK > macro.stochD && macro.macdHist > 0;
  const continuationLongIntermediary =
    intermediary.stochK >= 30 && intermediary.stochK <= 75 && intermediary.rsi >= 42 && intermediary.rsi <= 68;
  const continuationLongMicro =
    bullishMomentumAligned &&
    isBullishCross(
      microTrigger.prevStochK,
      microTrigger.prevStochD,
      microTrigger.stochK,
      microTrigger.stochD
    );

  if (continuationLongMacro && continuationLongIntermediary && continuationLongMicro) {
    return "CONTINUATION LONG";
  }

  const dailyBias = evaluateDailyReversalBias(context?.daily ?? null);

  const macroExtendedShort =
    macro.rsi >= 60 &&
    macro.macdHist <= 0 &&
    (macro.stochK >= 50 || (context?.twelveh?.rsi ?? 0) >= 60 || (context?.twelveh?.stochK ?? 0) >= 65);

  const macroExtendedLong =
    macro.rsi <= 46 &&
    macro.macdHist >= 0 &&
    (macro.stochK <= 50 || (context?.twelveh?.rsi ?? 100) <= 40 || (context?.twelveh?.stochK ?? 100) <= 35);

  const oneHourMomentumDecay =
    intermediary.rsi >= 50 &&
    intermediary.stochK >= 60 &&
    intermediary.stochK < intermediary.prevStochK;

  const oneHourMomentumRecovery =
    intermediary.rsi <= 50 &&
    intermediary.stochK <= 40 &&
    intermediary.stochK > intermediary.prevStochK;

  const microBearishRollover =
    microTrigger.stochK < microTrigger.stochD &&
    microTrigger.prevStochK >= microTrigger.prevStochD &&
    microTrigger.stochK > 40;

  const microBullishRollover =
    microTrigger.stochK > microTrigger.stochD &&
    microTrigger.prevStochK <= microTrigger.prevStochD &&
    microTrigger.stochK < 60;

  if (dailyBias === "SHORT" && macroExtendedShort && oneHourMomentumDecay && microBearishRollover) {
    return "REVERSAL SHORT";
  }

  if (dailyBias === "LONG" && macroExtendedLong && oneHourMomentumRecovery && microBullishRollover) {
    return "REVERSAL LONG";
  }

  return "NO SIGNAL";
}

export function evaluateDailyReversalBias(daily: TimeframeRsi | null): "SHORT" | "LONG" | null {
  // Detect extreme 1D overbought conditions that suggest reversal SHORT
  if (daily && daily.rsi >= 75 && daily.stochK >= 85) {
    return "SHORT";
  }

  // Detect extreme 1D oversold conditions that suggest reversal LONG
  if (daily && daily.rsi <= 25 && daily.stochK <= 15) {
    return "LONG";
  }

  return null;
}

export function getSignalCategory(signal: SignalType): SignalCategory {
  if (signal === "STRONG SHORT" || signal === "STRONG LONG") {
    return "STRONG";
  }

  if (signal === "CONTINUATION SHORT" || signal === "CONTINUATION LONG") {
    return "CONTINUATION";
  }

  if (signal === "REVERSAL SHORT" || signal === "REVERSAL LONG") {
    return "REVERSAL";
  }

  return "SCORE_BASED";
}

export function calculateSupportResistance(candles: Array<{ h: string | number; l: string | number }>): {
  localSupport: number;
  localResistance: number;
} {
  const lows = candles
    .map((candle) => Number(candle.l))
    .filter((value) => Number.isFinite(value));
  const highs = candles
    .map((candle) => Number(candle.h))
    .filter((value) => Number.isFinite(value));

  return {
    localSupport: lows.length > 0 ? Math.min(...lows) : 0,
    localResistance: highs.length > 0 ? Math.max(...highs) : 0
  };
}

export function applySupportFloorGuard(
  signal: SignalType,
  currentMarkPrice: number,
  localSupport: number,
  localResistance: number,
  cushionPct: number = 0.005
): {
  adjustedSignal: SignalType;
  nearSupportFloor: boolean;
  nearResistance: boolean;
  supportDistancePct: number;
  resistanceDistancePct: number;
} {
  if (!Number.isFinite(currentMarkPrice) || currentMarkPrice <= 0 || !Number.isFinite(localSupport) || localSupport <= 0) {
    return {
      adjustedSignal: signal,
      nearSupportFloor: false,
      nearResistance: false,
      supportDistancePct: 0,
      resistanceDistancePct: 0
    };
  }

  const priceCushion = currentMarkPrice * cushionPct;
  const supportDistance = currentMarkPrice - localSupport;
  const supportDistancePct = Number(((supportDistance / currentMarkPrice) * 100).toFixed(3));
  const nearSupportFloor = supportDistance < priceCushion;
  const resistanceDistance = localResistance - currentMarkPrice;
  const resistanceDistancePct = Number(((resistanceDistance / currentMarkPrice) * 100).toFixed(3));
  const nearResistance = Number.isFinite(localResistance) && localResistance > 0 && resistanceDistance < priceCushion;

  if (
    (signal === "STRONG SHORT" || signal === "CONTINUATION SHORT" || signal === "REVERSAL SHORT") &&
    nearSupportFloor
  ) {
    return {
      adjustedSignal: "NO SIGNAL (NEAR SUPPORT FLOOR)",
      nearSupportFloor: true,
      nearResistance,
      supportDistancePct,
      resistanceDistancePct
    };
  }

  if (
    (signal === "STRONG LONG" || signal === "CONTINUATION LONG" || signal === "REVERSAL LONG") &&
    nearResistance
  ) {
    return {
      adjustedSignal: "NO SIGNAL (NEAR RESISTANCE)",
      nearSupportFloor,
      nearResistance: true,
      supportDistancePct,
      resistanceDistancePct
    };
  }

  return {
    adjustedSignal: signal,
    nearSupportFloor,
    nearResistance,
    supportDistancePct,
    resistanceDistancePct
  };
}

export function computeConfluenceScore(params: {
  daily: TimeframeRsi | null;
  twelveh: TimeframeRsi | null;
  macro: TimeframeRsi;
  intermediary: TimeframeRsi;
  microTrigger: TimeframeRsi;
  signalType?: SignalType;
  volume24h: number;
  averageMarketVolume: number;
  volatilityPct: number;
  trendlineBreakout?: boolean;
  trendlineBreakdown?: boolean;
  candlestickSignal?: CandlestickPatternSignal;
  candlestickInfluenceMultiplier?: number;
}): { score: number; bias: "SHORT" | "LONG" | null; maxScore: number } {
  const {
    daily,
    twelveh,
    macro,
    intermediary,
    microTrigger,
    signalType,
    volume24h,
    averageMarketVolume,
    volatilityPct,
    trendlineBreakout = false,
    trendlineBreakdown = false,
    candlestickSignal,
    candlestickInfluenceMultiplier = 1
  } = params;

  let shortScore = 0;
  let longScore = 0;

  // Macro alignment
  if (macro.macdHist < 0 && macro.stochK < macro.stochD) shortScore += 2.5;
  if (macro.macdHist > 0 && macro.stochK > macro.stochD) longScore += 2.5;

  // Intermediary exhaustion/pullback zone
  if (intermediary.stochK >= 75) shortScore += 2;
  if (intermediary.stochK <= 25) longScore += 2;

  // Micro cross direction with previous candle confirmation
  if (
    microTrigger.stochK < microTrigger.stochD &&
    microTrigger.prevStochK >= microTrigger.prevStochD
  ) {
    shortScore += 1.5;
  }
  if (
    microTrigger.stochK > microTrigger.stochD &&
    microTrigger.prevStochK <= microTrigger.prevStochD
  ) {
    longScore += 1.5;
  }

  // Daily exhaustion bias for reversal setups.
  if (daily && daily.rsi >= 80 && daily.stochK >= 90) shortScore += 2.5;
  if (daily && daily.rsi <= 20 && daily.stochK <= 10) longScore += 2.5;

  // 12h stretch helps confirm the same side of exhaustion.
  if (twelveh && twelveh.rsi >= 65 && twelveh.stochK >= 70) shortScore += 1.5;
  if (twelveh && twelveh.rsi <= 35 && twelveh.stochK <= 30) longScore += 1.5;

  // 1h momentum decay/recovery is a useful reversal tell.
  if (intermediary.rsi >= 55 && intermediary.stochK < intermediary.prevStochK) shortScore += 1;
  if (intermediary.rsi <= 45 && intermediary.stochK > intermediary.prevStochK) longScore += 1;

  // Relative liquidity boost
  if (volume24h > averageMarketVolume && averageMarketVolume > 0 && volatilityPct > 1.2) {
    shortScore += 1;
    longScore += 1;
  }

  if (signalType === "REVERSAL SHORT") shortScore += 1.5;
  if (signalType === "REVERSAL LONG") longScore += 1.5;
  if (signalType === "STRONG SHORT") shortScore += 0.5;
  if (signalType === "STRONG LONG") longScore += 0.5;

  // Trendline pattern confirmation — high-conviction structural boost.
  if (trendlineBreakout) longScore += 2;
  if (trendlineBreakdown) shortScore += 2;

  if (candlestickSignal) {
    const multiplier = Math.max(0, candlestickInfluenceMultiplier);
    longScore += candlestickSignal.bullishScore * multiplier;
    shortScore += candlestickSignal.bearishScore * multiplier;
  }

  shortScore = Math.min(10, Number(shortScore.toFixed(3)));
  longScore = Math.min(10, Number(longScore.toFixed(3)));

  const dominantScore = Math.max(shortScore, longScore);
  if (dominantScore < 4) {
    return { score: dominantScore, bias: null, maxScore: 10 };
  }

  if (shortScore === longScore) {
    if (signalType?.includes("SHORT")) {
      return { score: shortScore, bias: "SHORT", maxScore: 10 };
    }
    if (signalType?.includes("LONG")) {
      return { score: longScore, bias: "LONG", maxScore: 10 };
    }
  }

  if (shortScore >= longScore) {
    return { score: shortScore, bias: "SHORT", maxScore: 10 };
  }

  return { score: longScore, bias: "LONG", maxScore: 10 };
}

export function getSignalBadge(signal: SignalType): SignalBadge {
  if (signal === "STRONG SHORT") {
    return {
      type: "STRONG SHORT",
      classes: "bg-red-600/20 text-red-400 border border-red-500/30 animate-pulse"
    };
  }

  if (signal === "STRONG LONG") {
    return {
      type: "STRONG LONG",
      classes: "bg-green-600/20 text-green-400 border border-green-500/30 animate-pulse"
    };
  }

  if (signal === "CONTINUATION SHORT") {
    return {
      type: "CONTINUATION SHORT",
      classes: "bg-red-600/10 text-red-300 border border-red-500/20"
    };
  }

  if (signal === "CONTINUATION LONG") {
    return {
      type: "CONTINUATION LONG",
      classes: "bg-green-600/10 text-green-300 border border-green-500/20"
    };
  }

  if (signal === "REVERSAL SHORT") {
    return {
      type: "REVERSAL SHORT",
      classes: "bg-rose-600/15 text-rose-300 border border-rose-500/30"
    };
  }

  if (signal === "REVERSAL LONG") {
    return {
      type: "REVERSAL LONG",
      classes: "bg-emerald-600/15 text-emerald-300 border border-emerald-500/30"
    };
  }

  if (signal === "NO SIGNAL (NEAR SUPPORT FLOOR)") {
    return {
      type: "NO SIGNAL (NEAR SUPPORT FLOOR)",
      classes: "bg-amber-600/20 text-amber-300 border border-amber-400/30"
    };
  }

  if (signal === "NO SIGNAL (NEAR RESISTANCE)") {
    return {
      type: "NO SIGNAL (NEAR RESISTANCE)",
      classes: "bg-orange-600/20 text-orange-300 border border-orange-400/30"
    };
  }

  return {
    type: "NO SIGNAL",
    classes: "bg-slate-800 text-slate-400"
  };
}
