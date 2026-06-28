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
  "THINKING",
  "GOING",
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

function inferSideState(message: string): { side: AdviceSide | null; ambiguous: boolean; hasDirectionalHint: boolean } {
  const normalized = message.toLowerCase();
  const hasLong = /\blong\b|\bbuy\b/.test(normalized);
  const hasShort = /\bshort\b|\bsell\b/.test(normalized);

  if (hasLong && hasShort) {
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

function inferSymbol(message: string): string | null {
  const upper = message.toUpperCase();
  for (const [alias, symbol] of Object.entries(symbolAliases)) {
    if (upper.includes(alias)) {
      return symbol;
    }
  }

  // Prefer explicit directional phrases first (for example: "buy SOL", "short BTC").
  const directionalMatch = message.match(/\b(?:buy|long|short|sell)\s+([A-Z]{2,10}(?:[-/](?:USDT|USDC|USD|PERP|SWAP))?)\b/i);
  if (directionalMatch?.[1]) {
    const directionalSymbol = normalizeSymbol(directionalMatch[1]);
    if (directionalSymbol.length >= 2 && !commonStopwords.has(directionalSymbol)) {
      return directionalSymbol;
    }
  }

  const matches = upper.match(/\b[A-Z]{2,10}(?:[-/](?:USDT|USDC|USD|PERP|SWAP))?\b/g) ?? [];
  const candidates: string[] = [];
  for (const match of matches) {
    const cleaned = normalizeSymbol(match);
    if (cleaned.length < 2) continue;
    if (commonStopwords.has(cleaned)) continue;
    candidates.push(cleaned);
  }

  if (candidates.length > 0) {
    // In natural-language prompts, the actionable symbol is often near the end.
    return candidates[candidates.length - 1] ?? null;
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

  return entries.map(([label, timeframe]) => {
    if (!timeframe) {
      return `${label}: n/a`;
    }

    return `${label}: ${timeframe.trend.direction} | RSI ${timeframe.rsi.toFixed(1)} | MACD ${formatSigned(timeframe.macdHist)}`;
  });
}

function weightedStackScore(row: TokenRsiResult, side: AdviceSide): number {
  return [
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
  const daily = row.timeframes.daily?.trend.direction ?? "MIXED";
  const twelveh = row.timeframes.twelveh?.trend.direction ?? "MIXED";
  const macro = row.timeframes.macro?.trend.direction ?? "MIXED";
  const inter = row.timeframes.intermediary?.trend.direction ?? "MIXED";
  const micro = row.timeframes.microTrigger?.trend.direction ?? "MIXED";

  const longAligned = [daily, twelveh, macro, inter, micro].filter((direction) => direction === "UP").length;
  const shortAligned = [daily, twelveh, macro, inter, micro].filter((direction) => direction === "DOWN").length;

  if (longAligned >= 3 && side === "LONG") return "TREND_TRADE";
  if (shortAligned >= 3 && side === "SHORT") return "TREND_TRADE";

  const higherBiasLong = daily === "UP" || twelveh === "UP" || macro === "UP";
  const higherBiasShort = daily === "DOWN" || twelveh === "DOWN" || macro === "DOWN";

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

export function parseTradeAdviceContextRequest(input: unknown): { ok: true; data: TradeAdviceContextRequest } | { ok: false; error: string } {
  const parsed = adviceRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid request body" };
  }

  const symbol = inferSymbol(parsed.data.message);
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
  const sideLabel = advice.side === "LONG" ? "Long" : "Short";
  const actionLine = advice.action === "WAIT"
    ? `${sideLabel} setup is not live yet: wait for trigger confirmation.`
    : `${sideLabel} setup is actionable on confirmation/retest.`;
  const timeframeLine = `Timeframe map (1d->15m): ${formatTimeframeMap(advice.timeframeSummary)}.`;
  const setupLine = `Setup: ${advice.setupType.replace(/_/g, " ").toLowerCase()} | Execution TF: ${advice.entryTimeframe} | Confidence: ${advice.confidence}%.`;
  const trendlinesSummary = advice.trendlineStack.filter((t) => t.breakout || t.breakdown).map((t) => `${t.timeframe}:${t.breakout ? "↑BO" : "↓BD"}`).join(", ");
  const trendlineLine = trendlinesSummary ? `Trendlines: ${trendlinesSummary}.` : "";

  return [
    `${advice.symbol} ${advice.market.toUpperCase()} live price: ${formatPrice(advice.currentPrice)}.`,
    `${actionLine}`,
    setupLine,
    `Levels: support ${formatPrice(advice.support)}, resistance ${formatPrice(advice.resistance)}.`,
    `Plan: ${formatTradeLevels(advice)}.`,
    trendlineLine ? trendlineLine : undefined,
    timeframeLine,
    `Trigger: ${advice.trigger}`,
    `Invalidation: ${advice.invalidation}`,
    `Rationale: ${advice.rationale.slice(0, 2).join(" ")}`
  ].filter(Boolean).join(" ");
}

export function buildComparisonReply(options: {
  symbol: string;
  longAdvice: TradeAdvicePayload;
  shortAdvice: TradeAdvicePayload;
  recommendedSide: "LONG" | "SHORT" | "WAIT";
}): string {
  const { symbol, longAdvice, shortAdvice, recommendedSide } = options;

  const longSummary = `LONG -> ${longAdvice.action}, ${longAdvice.confidence}% (${longAdvice.entryTimeframe}). ${formatTradeLevels(longAdvice)}.`;
  const shortSummary = `SHORT -> ${shortAdvice.action}, ${shortAdvice.confidence}% (${shortAdvice.entryTimeframe}). ${formatTradeLevels(shortAdvice)}.`;
  const recommendation = recommendedSide === "WAIT"
    ? "Bias: WAIT for cleaner alignment before committing directional risk."
    : `Bias: ${recommendedSide}.`;

  return [
    `${symbol} live price: ${formatPrice(longAdvice.currentPrice)} (${longAdvice.market}).`,
    `Timeframe map: ${formatTimeframeMap(longAdvice.timeframeSummary)}.`,
    longSummary,
    shortSummary,
    recommendation
  ].join(" ");
}

export async function maybeRenderLlmReply(advice: TradeAdvicePayload, userMessage: string): Promise<string | null> {
  const endpoint = String(process.env.AZURE_OPENAI_ENDPOINT ?? "").trim();
  const deployment = String(process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? "").trim();
  const apiVersion = String(process.env.AZURE_OPENAI_API_VERSION ?? "2024-12-01-preview").trim();
  const apiKey = String(process.env.AZURE_OPENAI_API_KEY ?? "").trim();

  if (!endpoint || !deployment || !apiKey) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const url = `${endpoint.replace(/\/+$/, "")}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey
      },
      signal: controller.signal,
      body: JSON.stringify({
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You are a concise trading assistant. Use only provided facts. Evaluate the full timeframe stack from daily through 15m. Prefer higher timeframes for direction and lower timeframes for timing. If timeframes conflict, say so clearly. Keep response under 120 words with clear trigger, invalidation, and TP ladder."
          },
          {
            role: "user",
            content: JSON.stringify({ userMessage, advice })
          }
        ]
      })
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = String(payload.choices?.[0]?.message?.content ?? "").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildTradeAdviceResult(options: {
  advice: TradeAdvicePayload;
  llmReply: string | null;
}): TradeAdviceResult {
  const { advice, llmReply } = options;
  return {
    ok: true,
    advice,
    reply: llmReply ?? buildDeterministicReply(advice)
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
