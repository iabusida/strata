import { EMA, MACD, RSI, Stochastic } from "technicalindicators";

export type MarketType = "perp" | "spot";

export type ScanParams = {
  query?: string;
  market: MarketType;
  limitTokens: number;
};

export type RsiStatus = "OVERBOUGHT" | "OVERSOLD" | "NEUTRAL";

export type SignalType =
  | "STRONG SHORT"
  | "STRONG LONG"
  | "CONTINUATION SHORT"
  | "CONTINUATION LONG"
  | "NO SIGNAL"
  | "NO SIGNAL (NEAR SUPPORT FLOOR)"
  | "NO SIGNAL (NEAR RESISTANCE)";

export type SignalCategory = "STRONG" | "CONTINUATION" | "SCORE_BASED";

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
  interval: "4h" | "1h" | "15m";
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
  rsi: number;
  close: number;
  volume24h: number;
  volatilityPct: number;
  tradeContext: {
    volatilityPct: number;
    volume24h: number;
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
    higherTimeframeTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
    structureState: "TRENDING" | "BREAKOUT" | "CHOP";
  };
  confluence: {
    score: number;
    bias: "SHORT" | "LONG";
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
    macro: TimeframeRsi;
    intermediary: TimeframeRsi;
    microTrigger: TimeframeRsi;
  };
};

export type SkippedToken = {
  symbol: string;
  reason: "INSUFFICIENT_CANDLES" | "EMPTY_RSI" | "FETCH_ERROR";
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
  "1w": 604_800_000,
  "1M": 2_592_000_000
};

const RSI_PERIOD = 14;
const STOCH_RSI_PERIOD = 14;
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

export function calculateStochasticRsi(
  closes: number[],
  rsiPeriod: number = STOCH_RSI_PERIOD,
  kPeriod: number = STOCH_RSI_K_PERIOD,
  dPeriod: number = STOCH_RSI_D_PERIOD
): { stochRsi: number; k: number; d: number; prevK: number; prevD: number } | null {
  if (closes.length < rsiPeriod + kPeriod + dPeriod + 10) {
    return null;
  }

  const rsiValues = RSI.calculate({ period: rsiPeriod, values: closes });
  if (rsiValues.length < kPeriod + dPeriod) {
    return null;
  }

  const stochValues = Stochastic.calculate({
    high: rsiValues.map((v) => v),
    close: rsiValues.map((v) => v),
    low: rsiValues.map((v) => v),
    period: kPeriod,
    signalPeriod: dPeriod
  });

  if (stochValues.length < 2) {
    return null;
  }

  const latest = stochValues.at(-1);
  const previous = stochValues.at(-2);
  if (!latest || !previous) {
    return null;
  }

  const stochRsi = Number(((latest.k + latest.d) / 2).toFixed(2));
  return {
    stochRsi,
    k: Number(latest.k.toFixed(2)),
    d: Number(latest.d.toFixed(2)),
    prevK: Number(previous.k.toFixed(2)),
    prevD: Number(previous.d.toFixed(2))
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
  microTrigger: TimeframeRsi
): SignalType {
  // STRONG SHORT: macro bear bias + 1h top-zone bounce + fresh 15m bearish cross above midline
  const macroShortTrend = macro.stochK < macro.stochD && macro.macdHist < 0;
  const intermediaryShortBounce = intermediary.stochK >= 70 && intermediary.rsi >= 55;
  const microShortTrigger =
    microTrigger.stochK < microTrigger.stochD &&
    isBearishCross(
      microTrigger.prevStochK,
      microTrigger.prevStochD,
      microTrigger.stochK,
      microTrigger.stochD
    ) &&
    microTrigger.stochK > 50;

  if (macroShortTrend && intermediaryShortBounce && microShortTrigger) {
    return "STRONG SHORT";
  }

  // STRONG LONG: macro bull bias + 1h floor pullback + fresh 15m bullish cross below midline
  const macroLongTrend = macro.stochK > macro.stochD && macro.macdHist > 0;
  const intermediaryLongPullback = intermediary.stochK <= 30 && intermediary.rsi <= 45;
  const microLongTrigger =
    microTrigger.stochK > microTrigger.stochD &&
    isBullishCross(
      microTrigger.prevStochK,
      microTrigger.prevStochD,
      microTrigger.stochK,
      microTrigger.stochD
    ) &&
    microTrigger.stochK < 50;

  if (macroLongTrend && intermediaryLongPullback && microLongTrigger) {
    return "STRONG LONG";
  }

  // CONTINUATION SHORT: same macro bear bias + intermediary mid-band + fresh 15m bearish cross below midline
  const continuationShortMacro = macro.stochK < macro.stochD && macro.macdHist < 0;
  const continuationShortIntermediary =
    intermediary.stochK >= 30 && intermediary.stochK <= 65 && intermediary.rsi >= 45 && intermediary.rsi <= 60;
  const continuationShortMicro =
    microTrigger.stochK < microTrigger.stochD &&
    isBearishCross(
      microTrigger.prevStochK,
      microTrigger.prevStochD,
      microTrigger.stochK,
      microTrigger.stochD
    ) &&
    microTrigger.stochK < 50;

  if (continuationShortMacro && continuationShortIntermediary && continuationShortMicro) {
    return "CONTINUATION SHORT";
  }

  // CONTINUATION LONG: same macro bull bias + intermediary mid-band + fresh 15m bullish cross above midline
  const continuationLongMacro = macro.stochK > macro.stochD && macro.macdHist > 0;
  const continuationLongIntermediary =
    intermediary.stochK >= 35 && intermediary.stochK <= 70 && intermediary.rsi >= 45 && intermediary.rsi <= 65;
  const continuationLongMicro =
    microTrigger.stochK > microTrigger.stochD &&
    isBullishCross(
      microTrigger.prevStochK,
      microTrigger.prevStochD,
      microTrigger.stochK,
      microTrigger.stochD
    ) &&
    microTrigger.stochK > 50;

  if (continuationLongMacro && continuationLongIntermediary && continuationLongMicro) {
    return "CONTINUATION LONG";
  }

  return "NO SIGNAL";
}

export function getSignalCategory(signal: SignalType): SignalCategory {
  if (signal === "STRONG SHORT" || signal === "STRONG LONG") {
    return "STRONG";
  }

  if (signal === "CONTINUATION SHORT" || signal === "CONTINUATION LONG") {
    return "CONTINUATION";
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

  if ((signal === "STRONG SHORT" || signal === "CONTINUATION SHORT") && nearSupportFloor) {
    return {
      adjustedSignal: "NO SIGNAL (NEAR SUPPORT FLOOR)",
      nearSupportFloor: true,
      nearResistance,
      supportDistancePct,
      resistanceDistancePct
    };
  }

  if ((signal === "STRONG LONG" || signal === "CONTINUATION LONG") && nearResistance) {
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
  macro: TimeframeRsi;
  intermediary: TimeframeRsi;
  microTrigger: TimeframeRsi;
  volume24h: number;
  averageMarketVolume: number;
  volatilityPct: number;
}): { score: number; bias: "SHORT" | "LONG"; maxScore: number } {
  const { macro, intermediary, microTrigger, volume24h, averageMarketVolume, volatilityPct } = params;

  let shortScore = 0;
  let longScore = 0;

  // Macro alignment
  if (macro.macdHist < 0 && macro.stochK < macro.stochD) shortScore += 3;
  if (macro.macdHist > 0 && macro.stochK > macro.stochD) longScore += 3;

  // Intermediary exhaustion/pullback zone
  if (intermediary.stochK >= 75) shortScore += 3;
  if (intermediary.stochK <= 25) longScore += 3;

  // Micro cross direction with previous candle confirmation
  if (
    microTrigger.stochK < microTrigger.stochD &&
    microTrigger.prevStochK >= microTrigger.prevStochD
  ) {
    shortScore += 2;
  }
  if (
    microTrigger.stochK > microTrigger.stochD &&
    microTrigger.prevStochK <= microTrigger.prevStochD
  ) {
    longScore += 2;
  }

  // Relative liquidity boost
  if (volume24h > averageMarketVolume && averageMarketVolume > 0 && volatilityPct > 1.2) {
    shortScore += 2;
    longScore += 2;
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
