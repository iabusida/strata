import { z } from "zod";
import type { TokenRsiResult } from "./rsi.js";
import { detectDescendingTrendlineBreakout, detectAscendingTrendlineBreakdown } from "./trendline-engine.js";

export type AdviceSide = "LONG" | "SHORT";

export type TradeAdviceRequest = {
  message: string;
  market: "spot" | "perp";
  symbol: string;
  side: AdviceSide;
};

export type TradeAdviceContextRequest = {
  message: string;
  market: "spot" | "perp" | null;
  symbol: string;
  side: AdviceSide | null;
  sideAmbiguous: boolean;
};

export type TradeAdvicePayload = {
  symbol: string;
  side: AdviceSide;
  market: "spot" | "perp";
  analyzedAt: string;
  currentPrice: number;
  support: number;
  resistance: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  stopLoss: number;
  action: "WAIT" | "ENTER_ON_RETEST" | "INVALID_SETUP";
  entryTimeframe: "15m" | "1h" | "4h";
  setupType: "TREND_TRADE" | "COUNTER_TREND_BOUNCE" | "CHOP";
  trendlineStack: Array<{ timeframe: string; breakout: boolean; breakdown: boolean }>;
  trigger: string;
  invalidation: string;
  takeProfits: number[];
  confidence: number;
  timeframeSummary: string[];
  rationale: string[];
};

export type TradeAdviceResult = {
  ok: boolean;
  reply: string;
  advice?: TradeAdvicePayload;
  unresolved?: string;
};

export type TradeAdviceSnapshot = {
  analyzedAt?: string;
  results: TokenRsiResult[];
};

function formatTimeframeMap(summary: string[]): string {
  return summary.join(" | ");
}

function formatTradeLevels(advice: TradeAdvicePayload): string {
  return `Entry ${formatPrice(advice.entryZoneLow)}-${formatPrice(advice.entryZoneHigh)} | Stop ${formatPrice(advice.stopLoss)} | Targets ${advice.takeProfits.map((tp) => formatPrice(tp)).join(", ")}`;
}

const commonStopwords = new Set([
  "I",
  "IM",
  "I'M",
  "IT",
  "ITS",
  "ISNT",
  "AREN'T",
  "ARENT",
  "THINKING",
  "GOING",
  "BEEN",
  "BEING",
  "HAS",
  "HAVE",
  "HAD",
  "DO",
  "DOES",
  "DID",
  "UP",
  "DOWN",
  "LONG",
  "SHORT",
  "RIGHT",
  "NOW",
  "WHEN",
  "SHOULD",
  "ENTER",
  "WHAT",
  "IS",
  "THE",
  "OR",
  "WAIT",
  "WITH",
  "CURRENT",
  "PRICE",
  "A",
  "AN",
  "TO",
  "ON",
  "AT",
  "OF",
  "AND",
  "FOR",
  "IN",
  "MY",
  "OUR",
  "THIS",
  "THAT",
  "GOOD",
  "TIME",
  "BUY",
  "SELL",
  "TRADE",
  "SETUP",
  "PLEASE"
  ,"GO"
  ,"DATA"
  ,"FROM"
  ,"HERE"
  ,"THERE"
  ,"ABOVE"
  ,"BELOW"
  ,"AROUND"
  ,"LIKE"
  ,"LOOK"
  ,"CURRENTLY"
  ,"TODAY"
  ,"TOMORROW"
]);

const symbolAliases: Record<string, string> = {
  ETHEREUM: "ETH",
  ETHER: "ETH",
  BITCOIN: "BTC",
  SOLANA: "SOL",
  RIPPLE: "XRP",
  DOGECOIN: "DOGE",
  CHAINLINK: "LINK",
  AVALANCHE: "AVAX",
  POLYGON: "POL",
  CARDANO: "ADA"
};

function normalizeSymbol(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[-_/](USDT|USDC|USD|PERP|SWAP)$/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function inferSide(message: string): AdviceSide | null {
  const normalized = message.toLowerCase();
  const hasLong = /\blong\b|\bbuy\b/.test(normalized);
  const hasShort = /\bshort\b|\bsell\b/.test(normalized);

  if (hasLong && hasShort) return null;
  if (hasLong) return "LONG";
  if (hasShort) return "SHORT";
  return null;
}

function isQuestionStyleDirectionalProbe(message: string): boolean {
  const normalized = message.toLowerCase();
  if (!/[?]/.test(normalized) && !/\b(should|is it|time for|good time|worth|can i|do you like|what do you think)\b/.test(normalized)) {
    return false;
  }

  // Treat questions about a proposed direction as a request to evaluate the idea,
  // not as an instruction to force that side.
  return /\b(long|short|buy|sell)\b/.test(normalized)
    && /\b(setup|idea|entry|trade|position|time for|good time|worth|should|can i|do you like)\b/.test(normalized);
}

function inferSideState(message: string): { side: AdviceSide | null; ambiguous: boolean; hasDirectionalHint: boolean } {
  const normalized = message.toLowerCase();
  const hasLong = /\blong\b|\bbuy\b/.test(normalized);
  const hasShort = /\bshort\b|\bsell\b/.test(normalized);

  if (hasLong && hasShort) {
    return { side: null, ambiguous: true, hasDirectionalHint: true };
  }
  if (isQuestionStyleDirectionalProbe(message)) {
    return { side: null, ambiguous: true, hasDirectionalHint: true };
  }
  if (hasLong) {
    return { side: "LONG", ambiguous: false, hasDirectionalHint: true };
  }
  if (hasShort) {
    return { side: "SHORT", ambiguous: false, hasDirectionalHint: true };
  }

  return { side: null, ambiguous: false, hasDirectionalHint: false };
}

function inferSymbol(message: string, symbolUniverse?: Set<string>): string | null {
  const upper = message.toUpperCase();

  const isAllowed = (symbol: string): boolean => {
    if (!symbolUniverse || symbolUniverse.size === 0) {
      return true;
    }
    return symbolUniverse.has(symbol);
  };

  for (const [alias, symbol] of Object.entries(symbolAliases)) {
    if (upper.includes(alias) && isAllowed(symbol)) {
      return symbol;
    }
  }

  // Prefer explicit directional phrases first (for example: "buy SOL", "short BTC").
  const directionalMatch = message.match(/\b(?:buy|long|short|sell)\s+([A-Z]{2,10}(?:[-/](?:USDT|USDC|USD|PERP|SWAP))?)\b/i);
  if (directionalMatch?.[1]) {
    const directionalSymbol = normalizeSymbol(directionalMatch[1]);
    if (directionalSymbol.length >= 2 && !commonStopwords.has(directionalSymbol) && isAllowed(directionalSymbol)) {
      return directionalSymbol;
    }
  }

  const matches = message.match(/\b[A-Za-z]{2,10}(?:[-/](?:USDT|USDC|USD|PERP|SWAP))?\b/g) ?? [];
  const candidates: string[] = [];
  for (const match of matches) {
    const cleaned = normalizeSymbol(match);
    if (cleaned.length < 2) continue;
    if (commonStopwords.has(cleaned)) continue;
    if (!isAllowed(cleaned)) continue;
    candidates.push(cleaned);
  }

  if (candidates.length > 0) {
    // Natural-language prompts often mention the actionable ticker first, while
    // later uppercase words can be ordinary English (for example "it", "down").
    return candidates[0] ?? null;
  }

  return null;
}

function inferMarket(message: string): "spot" | "perp" {
  const normalized = message.toLowerCase();
  if (/\b(perp|perpetual|futures|swap)\b/.test(normalized)) {
    return "perp";
  }
  return "spot";
}

function inferMarketHint(message: string): "perp" | null {
  const normalized = message.toLowerCase();
  if (/\b(perp|perpetual|futures|swap)\b/.test(normalized)) {
    return "perp";
  }
  return null;
}

const adviceRequestSchema = z.object({
  message: z.string().trim().min(5),
  market: z.enum(["spot", "perp"]).optional()
});

function confidenceFromRow(row: TokenRsiResult, side: AdviceSide): number {
  let score = 50;
  const dailyTrend = row.timeframes.daily?.trend?.direction ?? "MIXED";
  const twelvehTrend = row.timeframes.twelveh?.trend?.direction ?? "MIXED";
  const interTrend = row.timeframes.intermediary?.trend?.direction ?? "MIXED";
  const macroTrend = row.timeframes.macro?.trend?.direction ?? "MIXED";
  const microTrend = row.timeframes.microTrigger?.trend?.direction ?? "MIXED";
  const signalType = String(row.signal?.type ?? "NO SIGNAL").toUpperCase();
  const close = Number(row.close);
  const ema20 = Number(row.tradeContext?.ema20);

  score += Math.round(weightedStackScore(row, side) * 2.2);
  score += Math.round(trendlineWeightScore(buildTrendlineStack(row), side) * 3.0);

  if (side === "LONG") {
    if (dailyTrend === "UP") score += 5;
    if (twelvehTrend === "UP") score += 5;
    if (dailyTrend === "DOWN") score -= 5;
    if (twelvehTrend === "DOWN") score -= 5;
    if (interTrend === "UP") score += 12;
    if (interTrend === "DOWN") score -= 12;
    if (macroTrend === "UP") score += 10;
    if (macroTrend === "DOWN") score -= 10;
    if (microTrend === "DOWN") score -= 4;
    if (signalType.includes("LONG")) score += 8;
    if (signalType.includes("SHORT")) score -= 8;
    if (Number.isFinite(close) && Number.isFinite(ema20) && close > ema20) score += 8;
    if (row.tradeContext?.structureState === "BREAKOUT") score += 4;
    if (row.tradeContext?.structureState === "BREAKDOWN") score -= 4;
  } else {
    if (dailyTrend === "DOWN") score += 5;
    if (twelvehTrend === "DOWN") score += 5;
    if (dailyTrend === "UP") score -= 5;
    if (twelvehTrend === "UP") score -= 5;
    if (interTrend === "DOWN") score += 12;
    if (interTrend === "UP") score -= 12;
    if (macroTrend === "DOWN") score += 10;
    if (macroTrend === "UP") score -= 10;
    if (microTrend === "UP") score -= 4;
    if (signalType.includes("SHORT")) score += 8;
    if (signalType.includes("LONG")) score -= 8;
    if (Number.isFinite(close) && Number.isFinite(ema20) && close < ema20) score += 8;
    if (row.tradeContext?.structureState === "BREAKDOWN") score += 4;
    if (row.tradeContext?.structureState === "BREAKOUT") score -= 4;
  }

  if (row.tradeContext?.passedLiquidity) score += 5;
  if (row.tradeContext?.passedVolatility) score += 5;

  return Math.max(10, Math.min(90, Math.round(score)));
}

function numberOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

function trendScore(direction: string | undefined, side: AdviceSide, weight: number): number {
  if (!direction || direction === "MIXED") {
    return 0;
  }

  const aligned = side === "LONG" ? direction === "UP" : direction === "DOWN";
  return aligned ? weight : -weight;
}

function buildTimeframeSummary(row: TokenRsiResult): string[] {
  const entries = [
    ["1d", row.timeframes.daily],
    ["12h", row.timeframes.twelveh],
    ["4h", row.timeframes.macro],
    ["1h", row.timeframes.intermediary],
    ["15m", row.timeframes.microTrigger]
  ] as const;

  const higherEntries = [
    ["3d", row.higherTimeframes?.threeDay],
    ["5d", row.higherTimeframes?.fiveDay],
    ["1w", row.higherTimeframes?.oneWeek],
    ["2w", row.higherTimeframes?.twoWeek],
    ["1m", row.higherTimeframes?.oneMonth]
  ] as const;

  return [...higherEntries, ...entries].map(([label, timeframe]) => {
    if (!timeframe) {
      return `${label}: n/a`;
    }

    return `${label}: ${timeframe.trend.direction} | RSI ${timeframe.rsi.toFixed(1)} | MACD ${formatSigned(timeframe.macdHist)}`;
  });
}

function weightedStackScore(row: TokenRsiResult, side: AdviceSide): number {
  return [
    trendScore(row.higherTimeframes?.oneMonth?.trend.direction, side, 5.0),
    trendScore(row.higherTimeframes?.twoWeek?.trend.direction, side, 4.5),
    trendScore(row.higherTimeframes?.oneWeek?.trend.direction, side, 4.0),
    trendScore(row.higherTimeframes?.fiveDay?.trend.direction, side, 3.5),
    trendScore(row.higherTimeframes?.threeDay?.trend.direction, side, 3.0),
    trendScore(row.timeframes.daily?.trend.direction, side, 2.5),
    trendScore(row.timeframes.twelveh?.trend.direction, side, 2.5),
    trendScore(row.timeframes.macro?.trend.direction, side, 2.0),
    trendScore(row.timeframes.intermediary?.trend.direction, side, 1.5),
    trendScore(row.timeframes.microTrigger?.trend.direction, side, 1.0)
  ].reduce((total, value) => total + value, 0);
}

function buildTrendlineStack(row: TokenRsiResult): Array<{ timeframe: string; breakout: boolean; breakdown: boolean }> {
  return [
    { timeframe: "1d", breakout: false, breakdown: false },
    { timeframe: "12h", breakout: false, breakdown: false },
    { timeframe: "4h", breakout: false, breakdown: false },
    { timeframe: "1h", breakout: row.tradeContext?.trendlineBreakout === true, breakdown: row.tradeContext?.trendlineBreakdown === true },
    { timeframe: "15m", breakout: false, breakdown: false }
  ];
}

function trendlineWeightScore(stack: Array<{ timeframe: string; breakout: boolean; breakdown: boolean }>, side: AdviceSide): number {
  let score = 0;
  const weights: Record<string, number> = { "1d": 2.5, "12h": 2.0, "4h": 1.5, "1h": 1.0, "15m": 0.5 };
  for (const item of stack) {
    const weight = weights[item.timeframe] ?? 0.5;
    if ((side === "LONG" && item.breakout) || (side === "SHORT" && item.breakdown)) {
      score += weight;
    }
  }
  return score;
}

function classifySetupType(row: TokenRsiResult, side: AdviceSide): TradeAdvicePayload["setupType"] {
  const month = row.higherTimeframes?.oneMonth?.trend.direction ?? "MIXED";
  const biweekly = row.higherTimeframes?.twoWeek?.trend.direction ?? "MIXED";
  const weekly = row.higherTimeframes?.oneWeek?.trend.direction ?? "MIXED";
  const fiveDay = row.higherTimeframes?.fiveDay?.trend.direction ?? "MIXED";
  const threeDay = row.higherTimeframes?.threeDay?.trend.direction ?? "MIXED";
  const daily = row.timeframes.daily?.trend.direction ?? "MIXED";
  const twelveh = row.timeframes.twelveh?.trend.direction ?? "MIXED";
  const macro = row.timeframes.macro?.trend.direction ?? "MIXED";
  const inter = row.timeframes.intermediary?.trend.direction ?? "MIXED";
  const micro = row.timeframes.microTrigger?.trend.direction ?? "MIXED";

  const longAligned = [daily, twelveh, macro, inter, micro].filter((direction) => direction === "UP").length;
  const shortAligned = [daily, twelveh, macro, inter, micro].filter((direction) => direction === "DOWN").length;

  if (longAligned >= 3 && side === "LONG") return "TREND_TRADE";
  if (shortAligned >= 3 && side === "SHORT") return "TREND_TRADE";

  const higherBiasLong = [month, biweekly, weekly, fiveDay, threeDay, daily, twelveh, macro].some((direction) => direction === "UP");
  const higherBiasShort = [month, biweekly, weekly, fiveDay, threeDay, daily, twelveh, macro].some((direction) => direction === "DOWN");

  if ((side === "LONG" && higherBiasShort) || (side === "SHORT" && higherBiasLong)) {
    return "COUNTER_TREND_BOUNCE";
  }

  if (row.tradeContext?.structureState === "CHOP" || longAligned + shortAligned < 2) {
    return "CHOP";
  }

  return "COUNTER_TREND_BOUNCE";
}

export function parseTradeAdviceRequest(input: unknown): { ok: true; data: TradeAdviceRequest } | { ok: false; error: string } {
  const context = parseTradeAdviceContextRequest(input);
  if (!context.ok) {
    return context;
  }
  if (!context.data.side) {
    return { ok: false, error: "Could not infer direction. Include LONG/BUY or SHORT/SELL." };
  }

  return {
    ok: true,
    data: {
      message: context.data.message,
      market: context.data.market ?? inferMarket(context.data.message),
      symbol: context.data.symbol,
      side: context.data.side
    }
  };
}

export function parseTradeAdviceContextRequest(
  input: unknown,
  options?: { symbolUniverse?: Iterable<string> }
): { ok: true; data: TradeAdviceContextRequest } | { ok: false; error: string } {
  const parsed = adviceRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid request body" };
  }

  const symbolUniverse = options?.symbolUniverse
    ? new Set(Array.from(options.symbolUniverse).map((item) => normalizeSymbol(String(item))).filter((item) => item.length >= 2))
    : undefined;

  const symbol = inferSymbol(parsed.data.message, symbolUniverse);
  if (!symbol) {
    return { ok: false, error: "Could not infer symbol. Mention token symbol like ETH or BTC." };
  }

  const sideState = inferSideState(parsed.data.message);
  if (!sideState.hasDirectionalHint && !sideState.ambiguous) {
    return { ok: false, error: "Could not infer direction. Include LONG/BUY or SHORT/SELL." };
  }

  return {
    ok: true,
    data: {
      message: parsed.data.message,
      market: parsed.data.market ?? inferMarketHint(parsed.data.message),
      symbol,
      side: sideState.side,
      sideAmbiguous: sideState.ambiguous
    }
  };
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(6);
}

export function buildTradeAdvice(options: {
  analyzedAt: string;
  row: TokenRsiResult;
  side: AdviceSide;
  market: "spot" | "perp";
}): TradeAdvicePayload {
  const { analyzedAt, row, side, market } = options;
  const currentPrice = Number(row.close);
  const support = Number(row.levels.localSupport);
  const resistance = Number(row.levels.localResistance);
  const atr1h = numberOr(row.tradeContext?.atr1h, Math.max(1, currentPrice * 0.008));
  const buffer = atr1h * 0.2;
  const timeframeSummary = buildTimeframeSummary(row);
  const stackScore = weightedStackScore(row, side);
  const trendlineStack = buildTrendlineStack(row);
  const confidence = confidenceFromRow(row, side);
  const setupType = classifySetupType(row, side);
  const entryTimeframe: TradeAdvicePayload["entryTimeframe"] = stackScore >= 4
    ? "4h"
    : stackScore >= 1
      ? "1h"
      : "15m";

  if (side === "LONG") {
    const reclaimLevel = resistance;
    const entryLow = reclaimLevel;
    const entryHigh = reclaimLevel + buffer;
    const action = currentPrice >= entryLow ? "ENTER_ON_RETEST" : "WAIT";
    const stopLoss = reclaimLevel - atr1h * 0.35;
    const takeProfits = [
      Number((entryHigh + atr1h * 0.6).toFixed(2)),
      Number((entryHigh + atr1h * 1.2).toFixed(2)),
      Number((entryHigh + atr1h * 2).toFixed(2))
    ];

    return {
      symbol: row.symbol,
      side,
      market,
      analyzedAt,
      currentPrice,
      support,
      resistance,
      entryZoneLow: entryLow,
      entryZoneHigh: entryHigh,
      stopLoss,
      action,
      entryTimeframe,
      setupType,
      trendlineStack,
      trigger: `Need 1h close above ${formatPrice(reclaimLevel)}, then pullback/retest that closes back above ${formatPrice(entryLow)}-${formatPrice(entryHigh)}.`,
      invalidation: `Invalidate if 1h closes back below ${formatPrice(stopLoss)} after reclaim.`,
      takeProfits,
      confidence,
      timeframeSummary,
      rationale: [
        `Local resistance is ${formatPrice(resistance)} and support is ${formatPrice(support)}.`,
        `ATR(1h) is ${formatPrice(atr1h)}, so entries and invalidation use volatility-adjusted buffers.`,
        `Timeframe stack: ${timeframeSummary.slice(0, 3).join(" · ")}.`,
        `1h trend is ${row.timeframes.intermediary.trend.direction}; 15m trend is ${row.timeframes.microTrigger.trend.direction}.`
      ]
    };
  }

  const sweepLevel = resistance;
  const entryLow = sweepLevel - buffer;
  const entryHigh = sweepLevel + buffer;
  const stopLoss = sweepLevel + atr1h * 0.35;
  const action = currentPrice <= entryHigh ? "ENTER_ON_RETEST" : "WAIT";
  const tp1 = Math.max(support, currentPrice - atr1h * 0.6);
  const tp2 = Math.max(support - atr1h * 0.4, currentPrice - atr1h * 1.2);
  const tp3 = Math.max(0, currentPrice - atr1h * 2.0);

  return {
    symbol: row.symbol,
    side,
    market,
    analyzedAt,
    currentPrice,
    support,
    resistance,
    entryZoneLow: entryLow,
    entryZoneHigh: entryHigh,
    stopLoss,
    action,
    entryTimeframe,
    setupType,
    trendlineStack,
    trigger: `Wait for rejection around ${formatPrice(entryLow)}-${formatPrice(entryHigh)} and a 1h close back below ${formatPrice(sweepLevel)}.`,
    invalidation: `Invalidate if 1h closes above ${formatPrice(stopLoss)} and holds.`,
    takeProfits: [Number(tp1.toFixed(2)), Number(tp2.toFixed(2)), Number(tp3.toFixed(2))],
    confidence,
    timeframeSummary,
    rationale: [
      `Local resistance is ${formatPrice(resistance)} and support is ${formatPrice(support)}.`,
      `ATR(1h) is ${formatPrice(atr1h)}, so take-profit spacing is volatility-aware.`,
      `Timeframe stack: ${timeframeSummary.slice(0, 3).join(" · ")}.`,
      `1h trend is ${row.timeframes.intermediary.trend.direction}; 15m trend is ${row.timeframes.microTrigger.trend.direction}.`
    ]
  };
}

function buildDeterministicReply(advice: TradeAdvicePayload): string {
  const confidenceTone = getConfidenceTone(advice.confidence);
  const sideLabel = advice.side === "LONG" ? "long" : "short";
  const callLine = advice.action === "WAIT"
    ? `${confidenceTone.waitPrefix} I would wait on ${advice.symbol} for now. The ${sideLabel} setup is close, but not confirmed yet.`
    : `${confidenceTone.enterPrefix} I like the ${sideLabel} setup on ${advice.symbol} if we get the confirmation.`;
  const setupLabel = advice.setupType.replace(/_/g, " ").toLowerCase();

  return [
    `${callLine} Current price is ${formatPrice(advice.currentPrice)} on ${advice.market.toUpperCase()}.`,
    `If you take it, plan entry around ${formatPrice(advice.entryZoneLow)} to ${formatPrice(advice.entryZoneHigh)}, with a stop near ${formatPrice(advice.stopLoss)}.`,
    `Take profit ladder: ${advice.takeProfits.map((tp) => formatPrice(tp)).join(" / ")}.`,
    `Confidence is ${advice.confidence}% with a ${setupLabel} structure on the ${advice.entryTimeframe} execution timeframe.`,
    `Trigger: ${advice.trigger}`,
    `Invalidation: ${advice.invalidation}`
  ].join(" ");
}

function getConfidenceTone(confidence: number): {
  waitPrefix: string;
  enterPrefix: string;
  summaryPrefix: string;
} {
  if (confidence >= 72) {
    return {
      waitPrefix: "I see a strong setup forming, but",
      enterPrefix: "This looks strong and fairly clean.",
      summaryPrefix: "Conviction is strong"
    };
  }

  if (confidence >= 58) {
    return {
      waitPrefix: "This is decent, but",
      enterPrefix: "This setup is workable with discipline.",
      summaryPrefix: "Conviction is moderate"
    };
  }

  return {
    waitPrefix: "I want to stay cautious here, so",
    enterPrefix: "This is a low-conviction setup, so size small if you take it.",
    summaryPrefix: "Conviction is light"
  };
}

export function buildComparisonReply(options: {
  symbol: string;
  longAdvice: TradeAdvicePayload;
  shortAdvice: TradeAdvicePayload;
  recommendedSide: "LONG" | "SHORT" | "WAIT";
}): string {
  const { symbol, longAdvice, shortAdvice, recommendedSide } = options;
  const selectedConfidence = recommendedSide === "LONG"
    ? longAdvice.confidence
    : recommendedSide === "SHORT"
      ? shortAdvice.confidence
      : Math.max(longAdvice.confidence, shortAdvice.confidence);
  const tone = getConfidenceTone(selectedConfidence);

  const longSummary = `Long idea: ${longAdvice.action}, ${longAdvice.confidence}% confidence on ${longAdvice.entryTimeframe}. ${formatTradeLevels(longAdvice)}.`;
  const shortSummary = `Short idea: ${shortAdvice.action}, ${shortAdvice.confidence}% confidence on ${shortAdvice.entryTimeframe}. ${formatTradeLevels(shortAdvice)}.`;
  const recommendation = recommendedSide === "WAIT"
    ? `${tone.waitPrefix} my call right now is to wait for cleaner alignment before taking directional risk.`
    : `${tone.enterPrefix} My call right now: ${recommendedSide}.`;

  return [
    `${symbol} is trading around ${formatPrice(longAdvice.currentPrice)} (${longAdvice.market}).`,
    `${recommendation}`,
    `${tone.summaryPrefix} at ${selectedConfidence}%.`,
    longSummary,
    shortSummary,
    `Timeframe map (1d to 15m): ${formatTimeframeMap(longAdvice.timeframeSummary)}.`
  ].join(" ");
}

type AzureLlmConfig = {
  provider: "local" | "hosted";
  endpoint: string;
  deployment: string;
  apiVersion: string;
  apiKey: string;
};

type DecisionMode = "WAIT" | "READY_LONG" | "READY_SHORT";

type DecisionWaitJson = {
  conditionLong: string[];
  conditionShort: string[];
  invalidationLong: string[];
  invalidationShort: string[];
  longEntry: string;
  longStop: string;
  longTargets: string;
  shortEntry: string;
  shortStop: string;
  shortTargets: string;
  disciplineLine: string;
};

type DecisionReadyJson = {
  entry: string[];
  stop: string[];
  targets: string[];
  optionalNote?: string[];
};

type AdviceLike = {
  side?: string;
  trigger?: string;
  invalidation?: string;
  entryZoneLow?: number;
  entryZoneHigh?: number;
  stopLoss?: number;
  takeProfits?: number[];
  action?: string;
};

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() || text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function toJoinedStringArray(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  const arr = toStringArray(value);
  return arr.join(" / ");
}

function renderWaitFromJson(raw: Record<string, unknown>): string {
  const json: DecisionWaitJson = {
    conditionLong: toStringArray(raw.conditionLong),
    conditionShort: toStringArray(raw.conditionShort),
    invalidationLong: toStringArray(raw.invalidationLong),
    invalidationShort: toStringArray(raw.invalidationShort),
    longEntry: String(raw.longEntry ?? "").trim(),
    longStop: String(raw.longStop ?? "").trim(),
    longTargets: toJoinedStringArray(raw.longTargets),
    shortEntry: String(raw.shortEntry ?? "").trim(),
    shortStop: String(raw.shortStop ?? "").trim(),
    shortTargets: toJoinedStringArray(raw.shortTargets),
    disciplineLine: String(raw.disciplineLine ?? "No confirmation = no trade.").trim() || "No confirmation = no trade."
  };

  const lines: string[] = [
    "ACTION: WAIT — NO TRADE",
    "",
    "This trade does NOT exist yet.",
    "Do nothing right now.",
    "",
    "CONDITION (LONG):",
    ...(json.conditionLong.length > 0 ? json.conditionLong.map((x) => `- ${x}`) : ["- No valid condition from provided data."]),
    "",
    "CONDITION (SHORT):",
    ...(json.conditionShort.length > 0 ? json.conditionShort.map((x) => `- ${x}`) : ["- No valid condition from provided data."]),
    "",
    "INVALIDATION (LONG):",
    ...(json.invalidationLong.length > 0 ? json.invalidationLong.map((x) => `- ${x}`) : ["- No valid invalidation from provided data."]),
    "",
    "INVALIDATION (SHORT):",
    ...(json.invalidationShort.length > 0 ? json.invalidationShort.map((x) => `- ${x}`) : ["- No valid invalidation from provided data."]),
    "",
    "IF CONFIRMED (THEN TRADE BECOMES VALID):",
    "",
    "LONG:",
    `- Entry: ${json.longEntry || "No valid entry from provided data."}`,
    `- Stop: ${json.longStop || "No valid stop from provided data."}`,
    `- Targets: ${json.longTargets || "No valid targets from provided data."}`,
    "",
    "SHORT:",
    `- Entry: ${json.shortEntry || "No valid entry from provided data."}`,
    `- Stop: ${json.shortStop || "No valid stop from provided data."}`,
    `- Targets: ${json.shortTargets || "No valid targets from provided data."}`,
    "",
    "🔒 TRADE PLAN (LOCKED UNTIL CONFIRMED)",
    "⚠️ Not active — only valid if conditions above are met",
    "",
    json.disciplineLine
  ];

  return lines.join("\n");
}

function renderReadyFromJson(mode: DecisionMode, raw: Record<string, unknown>): string {
  const json: DecisionReadyJson = {
    entry: toStringArray(raw.entry),
    stop: toStringArray(raw.stop),
    targets: toStringArray(raw.targets),
    optionalNote: toStringArray(raw.optionalNote)
  };
  const action = mode === "READY_SHORT" ? "ACTION: READY (SHORT)" : "ACTION: READY (LONG)";

  const lines: string[] = [
    action,
    "",
    "✅ ACTIVE TRADE",
    "",
    "ENTRY:",
    ...(json.entry.length > 0 ? json.entry.map((x) => `- ${x}`) : ["- No valid entry from provided data."]),
    "",
    "STOP:",
    ...(json.stop.length > 0 ? json.stop.map((x) => `- ${x}`) : ["- No valid stop from provided data."]),
    "",
    "TARGETS:",
    ...(json.targets.length > 0 ? json.targets.map((x) => `- ${x}`) : ["- No valid targets from provided data."]),
    "",
    "OPTIONAL NOTE:",
    ...(json.optionalNote && json.optionalNote.length > 0 ? json.optionalNote.slice(0, 2).map((x) => `- ${x}`) : ["- Trade is live. Execute with rules."])
  ];

  return lines.join("\n");
}

function toAdviceLike(value: unknown): AdviceLike | null {
  if (!value || typeof value !== "object") return null;
  return value as AdviceLike;
}

function formatLevel(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(6);
}

function formatRange(low?: number, high?: number): string {
  if (typeof low !== "number" || !Number.isFinite(low) || typeof high !== "number" || !Number.isFinite(high)) {
    return "n/a";
  }
  return `${formatLevel(low)}-${formatLevel(high)}`;
}

function summarizeCondition(trigger: string | undefined, fallback: string): string[] {
  const raw = String(trigger ?? "").trim();
  if (!raw) return [fallback];

  const cleaned = raw.replace(/^need\s+/i, "").replace(/\s+/g, " ").trim();
  const toSentence = (value: string): string => value.length > 0
    ? `${value.charAt(0).toUpperCase()}${value.slice(1)}`
    : value;
  const parts = cleaned.split(/\s+then\s+/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return [toSentence(parts[0]), toSentence(parts[1])];
  }
  return [toSentence(cleaned)];
}

function buildShortEntryFromTrigger(trigger: string | undefined, fallbackRange: string): string {
  const raw = String(trigger ?? "");
  const rejectionMatch = raw.match(/rejection\s+in\s+([0-9.]+\s*[-–]\s*[0-9.]+)/i);
  const closeBelowMatch = raw.match(/close\s+(?:back\s+)?below\s+([0-9.]+)/i);
  const rejection = rejectionMatch?.[1]?.replace(/\s+/g, "") ?? fallbackRange;
  const closeBelow = closeBelowMatch?.[1]?.trim();
  if (closeBelow) {
    return `rejection ${rejection} + close below ${closeBelow}`;
  }
  return `rejection ${rejection} + close below trigger`;
}

function getAdviceForMode(payload: unknown): { longAdvice: AdviceLike | null; shortAdvice: AdviceLike | null } {
  if (!payload || typeof payload !== "object") {
    return { longAdvice: null, shortAdvice: null };
  }

  const root = payload as Record<string, unknown>;
  const comparison = root.comparison as Record<string, unknown> | undefined;
  if (comparison) {
    return {
      longAdvice: toAdviceLike(comparison.longAdvice ?? comparison.long),
      shortAdvice: toAdviceLike(comparison.shortAdvice ?? comparison.short)
    };
  }

  const advice = toAdviceLike(root.advice);
  if (!advice) {
    return { longAdvice: null, shortAdvice: null };
  }

  if (String(advice.side ?? "").toUpperCase() === "SHORT") {
    return { longAdvice: null, shortAdvice: advice };
  }
  return { longAdvice: advice, shortAdvice: null };
}

function buildCanonicalWaitReplyFromPayload(payload: unknown): string {
  const { longAdvice, shortAdvice } = getAdviceForMode(payload);
  const longConditions = summarizeCondition(longAdvice?.trigger, "1h close above key resistance");
  const shortConditions = summarizeCondition(shortAdvice?.trigger, "1h close below key support after rejection");
  const longTargets = (longAdvice?.takeProfits ?? []).slice(0, 3).map((tp) => formatLevel(tp)).join(" / ") || "n/a";
  const shortTargets = (shortAdvice?.takeProfits ?? []).slice(0, 3).map((tp) => formatLevel(tp)).join(" / ") || "n/a";

  const longEntry = `${formatRange(longAdvice?.entryZoneLow, longAdvice?.entryZoneHigh)} after breakout + retest`;
  const shortEntry = buildShortEntryFromTrigger(
    shortAdvice?.trigger,
    formatRange(shortAdvice?.entryZoneLow, shortAdvice?.entryZoneHigh)
  );

  return [
    "ACTION: WAIT — NO TRADE",
    "",
    "This trade does NOT exist yet.",
    "Do nothing right now.",
    "",
    "CONDITION (LONG):",
    ...longConditions.map((item) => `- ${item}`),
    "",
    "CONDITION (SHORT):",
    ...shortConditions.map((item) => `- ${item}`),
    "",
    "INVALIDATION (LONG):",
    `- Below ${formatLevel(longAdvice?.stopLoss)}`,
    "",
    "INVALIDATION (SHORT):",
    `- Above ${formatLevel(shortAdvice?.stopLoss)}`,
    "",
    "IF CONFIRMED (THEN TRADE BECOMES VALID):",
    "",
    "LONG:",
    `- Entry: ${longEntry}`,
    `- Stop: ${formatLevel(longAdvice?.stopLoss)}`,
    `- Targets: ${longTargets}`,
    "",
    "SHORT:",
    `- Entry: ${shortEntry}`,
    `- Stop: ${formatLevel(shortAdvice?.stopLoss)}`,
    `- Targets: ${shortTargets}`,
    "",
    "🔒 TRADE PLAN (LOCKED UNTIL CONFIRMED)",
    "⚠️ Not active — only valid if conditions above are met",
    "",
    "No confirmation = no trade."
  ].join("\n");
}

function buildCanonicalReadyReplyFromPayload(mode: DecisionMode, payload: unknown): string {
  const { longAdvice, shortAdvice } = getAdviceForMode(payload);
  const active = mode === "READY_SHORT" ? shortAdvice : longAdvice;
  const action = mode === "READY_SHORT" ? "ACTION: READY (SHORT)" : "ACTION: READY (LONG)";
  const targets = (active?.takeProfits ?? []).slice(0, 3).map((tp) => formatLevel(tp)).join(" / ") || "n/a";
  const entryRange = formatRange(active?.entryZoneLow, active?.entryZoneHigh);
  const entryLine = String(active?.action ?? "").toUpperCase().includes("RETEST")
    ? `Enter on pullback / retest in ${entryRange}`
    : `Enter between ${entryRange}`;

  return [
    action,
    "",
    "✅ ACTIVE TRADE",
    "",
    "ENTRY:",
    `- ${entryLine}`,
    "",
    "STOP:",
    `- ${formatLevel(active?.stopLoss)}`,
    "",
    "TARGETS:",
    `- ${targets}`,
    "",
    "OPTIONAL NOTE:",
    mode === "READY_SHORT"
      ? "- Trade is live now. Execute on rejection follow-through only."
      : "- Trade is live now. Execute on pullback/retest within entry window."
  ].join("\n");
}

function resolveDecisionMode(userPayload: unknown): DecisionMode {
  if (!userPayload || typeof userPayload !== "object") {
    return "WAIT";
  }

  const root = userPayload as Record<string, unknown>;
  const comparison = root.comparison as Record<string, unknown> | undefined;
  if (comparison) {
    const recommendedSide = String(comparison.recommendedSide ?? "WAIT").toUpperCase();
    const longAdvice = comparison.long as Record<string, unknown> | null | undefined;
    const shortAdvice = comparison.short as Record<string, unknown> | null | undefined;
    const longAction = String(longAdvice?.action ?? "WAIT").toUpperCase();
    const shortAction = String(shortAdvice?.action ?? "WAIT").toUpperCase();

    if (recommendedSide === "LONG" && longAction !== "WAIT") {
      return "READY_LONG";
    }
    if (recommendedSide === "SHORT" && shortAction !== "WAIT") {
      return "READY_SHORT";
    }
    return "WAIT";
  }

  const advice = root.advice as Record<string, unknown> | undefined;
  if (!advice) {
    return "WAIT";
  }
  const action = String(advice.action ?? "WAIT").toUpperCase();
  const side = String(advice.side ?? "").toUpperCase();
  if (action === "WAIT") {
    return "WAIT";
  }
  if (side === "SHORT") {
    return "READY_SHORT";
  }
  return "READY_LONG";
}

function isStrictDecisionFormat(content: string, mode: DecisionMode): boolean {
  const text = String(content ?? "").trim();
  const actionMatch = text.match(/^ACTION:\s*(WAIT\s*[—-]\s*NO\s*TRADE|READY\s*\(LONG\)|READY\s*\(SHORT\))/i);
  if (!actionMatch) {
    return false;
  }
  const isWait = /WAIT\s*[—-]\s*NO\s*TRADE/i.test(actionMatch[1] ?? "");

  if (mode === "WAIT" && !isWait) {
    return false;
  }
  if (mode === "READY_LONG" && !/^READY\s*\(LONG\)$/i.test(actionMatch[1] ?? "")) {
    return false;
  }
  if (mode === "READY_SHORT" && !/^READY\s*\(SHORT\)$/i.test(actionMatch[1] ?? "")) {
    return false;
  }

  if (!isWait) {
    if (!text.includes("✅ ACTIVE TRADE")) {
      return false;
    }
    if (!/^ENTRY:\s*$/im.test(text) || !/^STOP:\s*$/im.test(text) || !/^TARGETS:\s*$/im.test(text)) {
      return false;
    }
    if (text.includes("This trade does NOT exist yet.") || text.includes("Do nothing right now.")) {
      return false;
    }
    if (text.includes("🔒 TRADE PLAN (LOCKED UNTIL CONFIRMED)") || text.includes("IF CONFIRMED (THEN TRADE BECOMES VALID)")) {
      return false;
    }

    return true;
  }

  const headings = [
    "CONDITION (LONG):",
    "CONDITION (SHORT):",
    "INVALIDATION (LONG):",
    "INVALIDATION (SHORT):",
    "IF CONFIRMED (THEN TRADE BECOMES VALID):"
  ];

  let lastIndex = -1;
  for (const heading of headings) {
    const index = text.indexOf(heading);
    if (index < 0 || index < lastIndex) {
      return false;
    }
    lastIndex = index;
  }

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "";
  if (!lastLine.endsWith(".")) {
    return false;
  }

  const confirmedIndex = text.indexOf("IF CONFIRMED (THEN TRADE BECOMES VALID):");
  const longIndex = text.indexOf("LONG:", confirmedIndex);
  const shortIndex = text.indexOf("SHORT:", confirmedIndex);
  if (confirmedIndex < 0 || longIndex < 0 || shortIndex < 0 || shortIndex < longIndex) {
    return false;
  }

  if (isWait) {
    if (!text.includes("This trade does NOT exist yet.")) {
      return false;
    }
    if (!text.includes("Do nothing right now.")) {
      return false;
    }
    if (!text.includes("🔒 TRADE PLAN (LOCKED UNTIL CONFIRMED)")) {
      return false;
    }
    if (!text.includes("⚠️ Not active — only valid if conditions above are met")) {
      return false;
    }

    const preConfirmed = text.slice(0, confirmedIndex);
    if (/^\s*-?\s*(ENTRY|STOP|TARGETS)\s*:/im.test(preConfirmed)) {
      return false;
    }
  }

  const confirmedSection = text.slice(confirmedIndex);
  if (!/LONG:\s*[\s\S]*-\s*Entry:\s*[\s\S]*-\s*Stop:\s*[\s\S]*-\s*Targets:/i.test(confirmedSection)) {
    return false;
  }
  if (!/SHORT:\s*[\s\S]*-\s*Entry:\s*[\s\S]*-\s*Stop:\s*[\s\S]*-\s*Targets:/i.test(confirmedSection)) {
    return false;
  }

  if (/^\s*Discipline line:\s*/im.test(text)) {
    return false;
  }

  return true;
}

function isStateSeparatedDecisionFormat(content: string, mode: DecisionMode): boolean {
  const text = String(content ?? "").trim();
  if (!text) return false;

  if (mode === "WAIT") {
    if (!/^ACTION:\s*WAIT\s*[—-]\s*NO\s*TRADE/i.test(text)) {
      return false;
    }
    if (!text.includes("This trade does NOT exist yet.") || !text.includes("Do nothing right now.")) {
      return false;
    }
    if (/^ACTION:\s*READY\s*\((LONG|SHORT)\)/im.test(text) || text.includes("✅ ACTIVE TRADE")) {
      return false;
    }

    const confirmedIndex = text.indexOf("IF CONFIRMED (THEN TRADE BECOMES VALID):");
    if (confirmedIndex < 0) {
      return false;
    }
    const preConfirmed = text.slice(0, confirmedIndex);
    if (/^\s*-?\s*(ENTRY|STOP|TARGETS)\s*:/im.test(preConfirmed)) {
      return false;
    }
    return true;
  }

  if (mode === "READY_LONG" && !/^ACTION:\s*READY\s*\(LONG\)/i.test(text)) {
    return false;
  }
  if (mode === "READY_SHORT" && !/^ACTION:\s*READY\s*\(SHORT\)/i.test(text)) {
    return false;
  }
  if (text.includes("This trade does NOT exist yet.") || text.includes("Do nothing right now.")) {
    return false;
  }
  if (text.includes("🔒 TRADE PLAN (LOCKED UNTIL CONFIRMED)") || text.includes("IF CONFIRMED (THEN TRADE BECOMES VALID)")) {
    return false;
  }
  return /^ENTRY:\s*$/im.test(text) && /^STOP:\s*$/im.test(text) && /^TARGETS:\s*$/im.test(text);
}

function getAzureLlmConfig(): AzureLlmConfig {
  const providerRaw = String(process.env.LLM_PROVIDER ?? "hosted").trim().toLowerCase();
  const provider: "local" | "hosted" = providerRaw === "local" ? "local" : "hosted";
  const endpoint = provider === "local"
    ? String(process.env.LOCAL_LLM_ENDPOINT ?? process.env.AZURE_OPENAI_ENDPOINT ?? "").trim()
    : String(process.env.AZURE_OPENAI_ENDPOINT ?? "").trim();
  const deployment = provider === "local"
    ? String(process.env.LOCAL_LLM_MODEL ?? process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? "").trim()
    : String(process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? "").trim();
  const apiVersion = String(process.env.AZURE_OPENAI_API_VERSION ?? "2024-12-01-preview").trim();
  const apiKey = String(process.env.AZURE_OPENAI_API_KEY ?? "").trim();

  if (!endpoint || !deployment) {
    throw new Error("LLM is not configured. Set endpoint and model/deployment for the selected provider.");
  }

  if (provider === "hosted" && !apiKey) {
    throw new Error("LLM is not configured. Set AZURE_OPENAI_API_KEY for hosted providers.");
  }

  return { provider, endpoint, deployment, apiVersion, apiKey };
}

async function renderLlmFromUserPayload(userPayload: unknown): Promise<string> {
  const config = getAzureLlmConfig();
  const timeoutMsRaw = Number.parseInt(String(process.env.LLM_TIMEOUT_MS ?? "60000"), 10);
  const llmTimeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 60000;

  {
    const normalizedEndpoint = config.endpoint.replace(/\/+$/, "");
    const usesV1StyleEndpoint = config.provider === "local"
      || /\/openai\/v1$/i.test(normalizedEndpoint)
      || /\/v1$/i.test(normalizedEndpoint);
    const url = config.provider === "local"
      ? `${normalizedEndpoint.replace(/\/v1$/i, "")}/v1/chat/completions`
      : usesV1StyleEndpoint
        ? `${normalizedEndpoint.replace(/\/v1$/i, "")}/v1/chat/completions`
        : `${normalizedEndpoint}/openai/deployments/${encodeURIComponent(config.deployment)}/chat/completions?api-version=${encodeURIComponent(config.apiVersion)}`;
    const isComparisonPayload = Boolean(
      userPayload
      && typeof userPayload === "object"
      && "comparison" in (userPayload as Record<string, unknown>)
    );
    const mode = resolveDecisionMode(userPayload);
    const systemPrompt = mode === "WAIT"
      ? "You are a strict trading DECISION ENGINE. Return only the final answer and nothing else. Required exact headings/order for WAIT mode:\nACTION: WAIT — NO TRADE\n\nThis trade does NOT exist yet.\nDo nothing right now.\n\nCONDITION (LONG):\n- <bullet>\n\nCONDITION (SHORT):\n- <bullet>\n\nINVALIDATION (LONG):\n- <bullet>\n\nINVALIDATION (SHORT):\n- <bullet>\n\nIF CONFIRMED (THEN TRADE BECOMES VALID):\n\nLONG:\n- Entry: <value>\n- Stop: <value>\n- Targets: <value>\n\nSHORT:\n- Entry: <value>\n- Stop: <value>\n- Targets: <value>\n\n🔒 TRADE PLAN (LOCKED UNTIL CONFIRMED)\n⚠️ Not active — only valid if conditions above are met\n\nNo confirmation = no trade.\n\nRules: use payload facts only; do not add any extra headings or explanatory text; never place Entry/Stop/Targets outside IF CONFIRMED."
      : mode === "READY_LONG"
        ? "You are a strict trading DECISION ENGINE. Return only the final answer and nothing else. Required exact headings/order for READY LONG mode:\nACTION: READY (LONG)\n\n✅ ACTIVE TRADE\n\nENTRY:\n- <execution instruction>\n\nSTOP:\n- <level>\n\nTARGETS:\n- <tp1> / <tp2> / <tp3>\n\nOPTIONAL NOTE:\n- <one short line>\n\nRules: use active language; do not include WAIT lines, locked notice, or IF CONFIRMED language."
        : "You are a strict trading DECISION ENGINE. Return only the final answer and nothing else. Required exact headings/order for READY SHORT mode:\nACTION: READY (SHORT)\n\n✅ ACTIVE TRADE\n\nENTRY:\n- <execution instruction>\n\nSTOP:\n- <level>\n\nTARGETS:\n- <tp1> / <tp2> / <tp3>\n\nOPTIONAL NOTE:\n- <one short line>\n\nRules: use active language; do not include WAIT lines, locked notice, or IF CONFIRMED language.";
    const requestBody: {
      temperature: number;
      model?: string;
      messages: Array<{ role: "system" | "user"; content: string }>;
    } = {
      temperature: isComparisonPayload ? 0 : 0.2,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: JSON.stringify(userPayload)
        }
      ]
    };

    if (usesV1StyleEndpoint || config.provider === "local") {
      requestBody.model = config.deployment;
    }

    const requestLlm = async (messages: Array<{ role: "system" | "user"; content: string }>, temperature: number): Promise<string> => {
      let lastError: unknown = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), llmTimeoutMs);

        try {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(config.apiKey ? { "api-key": config.apiKey } : {})
            },
            signal: controller.signal,
            body: JSON.stringify({
              temperature,
              ...(usesV1StyleEndpoint || config.provider === "local" ? { model: config.deployment } : {}),
              messages
            })
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(`LLM request failed (${response.status})${errorBody ? `: ${errorBody.slice(0, 300)}` : ""}`);
          }

          const payload = await response.json() as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = String(payload.choices?.[0]?.message?.content ?? "").trim();
          if (content.length === 0) {
            throw new Error("LLM returned an empty response");
          }

          return content;
        } catch (error) {
          lastError = error;
          const isAbort = error instanceof DOMException && error.name === "AbortError";
          if (!isAbort || attempt === 1) {
            throw error;
          }
        } finally {
          clearTimeout(timeout);
        }
      }

      throw (lastError instanceof Error ? lastError : new Error("LLM request failed"));
    };

    let content = await requestLlm(requestBody.messages, requestBody.temperature);
    if (content.length === 0) {
      throw new Error("LLM returned an empty response");
    }

    if (isComparisonPayload && !isStrictDecisionFormat(content, mode)) {
      for (let attempt = 0; attempt < 2 && !isStrictDecisionFormat(content, mode); attempt += 1) {
        const repaired = await requestLlm([
          {
            role: "system",
            content: mode === "WAIT"
              ? "Rewrite into strict WAIT template with exact headings only: ACTION: WAIT — NO TRADE; This trade does NOT exist yet.; Do nothing right now.; CONDITION (LONG):; CONDITION (SHORT):; INVALIDATION (LONG):; INVALIDATION (SHORT):; IF CONFIRMED (THEN TRADE BECOMES VALID):; LONG: with - Entry: - Stop: - Targets:; SHORT: with - Entry: - Stop: - Targets:; 🔒 TRADE PLAN (LOCKED UNTIL CONFIRMED); ⚠️ Not active — only valid if conditions above are met; final short discipline sentence. Return only final answer text."
              : mode === "READY_LONG"
                ? "Rewrite to exact READY LONG schema only: ACTION: READY (LONG); ✅ ACTIVE TRADE; ENTRY: bullets; STOP: bullets; TARGETS: bullets; OPTIONAL NOTE: bullets. Return only final answer text. Do not include WAIT, locked, or IF CONFIRMED text."
                : "Rewrite to exact READY SHORT schema only: ACTION: READY (SHORT); ✅ ACTIVE TRADE; ENTRY: bullets; STOP: bullets; TARGETS: bullets; OPTIONAL NOTE: bullets. Return only final answer text. Do not include WAIT, locked, or IF CONFIRMED text."
          },
          {
            role: "user",
            content: JSON.stringify({
              payload: userPayload,
              draft: content
            })
          }
        ], 0).catch(() => "");

        if (repaired.length > 0) {
          content = repaired;
        }
      }

      if (!isStrictDecisionFormat(content, mode)) {
        const regenerated = await requestLlm([
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: JSON.stringify(userPayload)
          }
        ], 0).catch(() => "");

        if (regenerated.length > 0) {
          content = regenerated;
        }

        if (!isStrictDecisionFormat(content, mode)) {
          const jsonRecovery = await requestLlm([
            {
              role: "system",
              content: mode === "WAIT"
                ? "Return JSON only. Use keys exactly: conditionLong (array), conditionShort (array), invalidationLong (array), invalidationShort (array), longEntry (string), longStop (string), longTargets (array or string), shortEntry (string), shortStop (string), shortTargets (array or string), disciplineLine (string). No prose, no markdown."
                : "Return JSON only. Use keys exactly: entry (array), stop (array), targets (array), optionalNote (array). No prose, no markdown."
            },
            {
              role: "user",
              content: JSON.stringify(userPayload)
            }
          ], 0).catch(() => "");

          const parsed = parseJsonObject(jsonRecovery);
          if (parsed) {
            content = mode === "WAIT"
              ? renderWaitFromJson(parsed)
              : renderReadyFromJson(mode, parsed);
          }

          if (!isStrictDecisionFormat(content, mode)) {
            if (isStateSeparatedDecisionFormat(content, mode)) {
              // Continue to canonical normalization below so final output is clean and consistent.
            } else {
              throw new Error(`LLM response unavailable: strict ${mode} format could not be generated.`);
            }
          }
        }
      }
    }

    // Final normalization guarantees clean human-readable WAIT/READY separation.
    content = mode === "WAIT"
      ? buildCanonicalWaitReplyFromPayload(userPayload)
      : buildCanonicalReadyReplyFromPayload(mode, userPayload);

    return content;
  }
}

export async function maybeRenderLlmReply(advice: TradeAdvicePayload, userMessage: string): Promise<string> {
  return renderLlmFromUserPayload({ userMessage, advice });
}

export async function renderComparisonLlmReply(options: {
  userMessage: string;
  symbol: string;
  longAdvice: TradeAdvicePayload;
  shortAdvice: TradeAdvicePayload;
  recommendedSide: "LONG" | "SHORT" | "WAIT";
}): Promise<string> {
  const { userMessage, symbol, longAdvice, shortAdvice, recommendedSide } = options;
  return renderLlmFromUserPayload({
    userMessage,
    symbol,
    comparison: {
      longAdvice,
      shortAdvice,
      recommendedSide
    }
  });
}

export function buildTradeAdviceResult(options: {
  advice: TradeAdvicePayload;
  llmReply: string;
}): TradeAdviceResult {
  const { advice, llmReply } = options;
  return {
    ok: true,
    advice,
    reply: llmReply
  };
}

export function resolveAdviceFromSnapshot(options: {
  request: TradeAdviceRequest;
  snapshot: TradeAdviceSnapshot;
}):
  | { ok: true; advice: TradeAdvicePayload }
  | { ok: false; unresolved: string } {
  const { request, snapshot } = options;
  const row = snapshot.results.find((item) => normalizeSymbol(String(item.symbol ?? "")) === normalizeSymbol(request.symbol));
  if (!row) {
    return {
      ok: false,
      unresolved: `No live ${request.market} scan row found for ${request.symbol}.`
    };
  }

  return {
    ok: true,
    advice: buildTradeAdvice({
      analyzedAt: snapshot.analyzedAt ?? new Date().toISOString(),
      row,
      side: request.side,
      market: request.market
    })
  };
}
