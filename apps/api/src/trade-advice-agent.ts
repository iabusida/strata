import { z } from "zod";
import type { TokenRsiResult } from "./rsi.js";

export type AdviceSide = "LONG" | "SHORT";

export type TradeAdviceRequest = {
  message: string;
  market: "spot" | "perp";
  symbol: string;
  side: AdviceSide;
};

export type TradeAdvicePayload = {
  symbol: string;
  side: AdviceSide;
  market: "spot" | "perp";
  analyzedAt: string;
  currentPrice: number;
  action: "WAIT" | "ENTER_ON_RETEST" | "INVALID_SETUP";
  entryTimeframe: "15m" | "1h" | "4h";
  trigger: string;
  invalidation: string;
  takeProfits: number[];
  confidence: number;
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

function inferSymbol(message: string): string | null {
  const upper = message.toUpperCase();
  for (const [alias, symbol] of Object.entries(symbolAliases)) {
    if (upper.includes(alias)) {
      return symbol;
    }
  }

  const matches = upper.match(/\b[A-Z]{2,10}(?:[-/](?:USDT|USDC|USD|PERP|SWAP))?\b/g) ?? [];
  for (const match of matches) {
    const cleaned = normalizeSymbol(match);
    if (cleaned.length < 2) continue;
    if (commonStopwords.has(cleaned)) continue;
    return cleaned;
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

const adviceRequestSchema = z.object({
  message: z.string().trim().min(5),
  market: z.enum(["spot", "perp"]).optional()
});

function confidenceFromRow(row: TokenRsiResult, side: AdviceSide): number {
  let score = 50;
  const interTrend = row.timeframes.intermediary?.trend?.direction ?? "MIXED";
  const macroTrend = row.timeframes.macro?.trend?.direction ?? "MIXED";
  const signalType = String(row.signal?.type ?? "NO SIGNAL").toUpperCase();
  const close = Number(row.close);
  const ema20 = Number(row.tradeContext?.ema20);

  if (side === "LONG") {
    if (interTrend === "UP") score += 12;
    if (interTrend === "DOWN") score -= 12;
    if (macroTrend === "UP") score += 10;
    if (macroTrend === "DOWN") score -= 10;
    if (signalType.includes("LONG")) score += 8;
    if (signalType.includes("SHORT")) score -= 8;
    if (Number.isFinite(close) && Number.isFinite(ema20) && close > ema20) score += 8;
  } else {
    if (interTrend === "DOWN") score += 12;
    if (interTrend === "UP") score -= 12;
    if (macroTrend === "DOWN") score += 10;
    if (macroTrend === "UP") score -= 10;
    if (signalType.includes("SHORT")) score += 8;
    if (signalType.includes("LONG")) score -= 8;
    if (Number.isFinite(close) && Number.isFinite(ema20) && close < ema20) score += 8;
  }

  if (row.tradeContext?.passedLiquidity) score += 5;
  if (row.tradeContext?.passedVolatility) score += 5;

  return Math.max(10, Math.min(90, Math.round(score)));
}

function numberOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

export function parseTradeAdviceRequest(input: unknown): { ok: true; data: TradeAdviceRequest } | { ok: false; error: string } {
  const parsed = adviceRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid request body" };
  }

  const side = inferSide(parsed.data.message);
  if (!side) {
    return { ok: false, error: "Could not infer direction. Include LONG/BUY or SHORT/SELL." };
  }

  const symbol = inferSymbol(parsed.data.message);
  if (!symbol) {
    return { ok: false, error: "Could not infer symbol. Mention token symbol like ETH or BTC." };
  }

  return {
    ok: true,
    data: {
      message: parsed.data.message,
      market: parsed.data.market ?? inferMarket(parsed.data.message),
      symbol,
      side
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
  const confidence = confidenceFromRow(row, side);

  if (side === "LONG") {
    const reclaimLevel = resistance;
    const entryLow = reclaimLevel;
    const entryHigh = reclaimLevel + buffer;
    const action = currentPrice >= entryLow ? "ENTER_ON_RETEST" : "WAIT";
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
      action,
      entryTimeframe: "1h",
      trigger: `Need 1h close above ${formatPrice(reclaimLevel)}, then pullback/retest that closes back above ${formatPrice(entryLow)}-${formatPrice(entryHigh)}.`,
      invalidation: `Invalidate if 1h closes back below ${formatPrice(reclaimLevel - atr1h * 0.35)} after reclaim.`,
      takeProfits,
      confidence,
      rationale: [
        `Local resistance is ${formatPrice(resistance)} and support is ${formatPrice(support)}.`,
        `ATR(1h) is ${formatPrice(atr1h)}, so entries and invalidation use volatility-adjusted buffers.`,
        `Intermediary trend is ${row.timeframes.intermediary.trend.direction}; macro trend is ${row.timeframes.macro.trend.direction}.`
      ]
    };
  }

  const sweepLevel = resistance;
  const entryLow = sweepLevel - buffer;
  const entryHigh = sweepLevel + buffer;
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
    action,
    entryTimeframe: "1h",
    trigger: `Wait for rejection around ${formatPrice(entryLow)}-${formatPrice(entryHigh)} and a 1h close back below ${formatPrice(sweepLevel)}.`,
    invalidation: `Invalidate if 1h closes above ${formatPrice(sweepLevel + atr1h * 0.35)} and holds.`,
    takeProfits: [Number(tp1.toFixed(2)), Number(tp2.toFixed(2)), Number(tp3.toFixed(2))],
    confidence,
    rationale: [
      `Local resistance is ${formatPrice(resistance)} and support is ${formatPrice(support)}.`,
      `ATR(1h) is ${formatPrice(atr1h)}, so take-profit spacing is volatility-aware.`,
      `Intermediary trend is ${row.timeframes.intermediary.trend.direction}; macro trend is ${row.timeframes.macro.trend.direction}.`
    ]
  };
}

function buildDeterministicReply(advice: TradeAdvicePayload): string {
  const sideVerb = advice.side === "LONG" ? "go long" : "go short";
  const actionLine = advice.action === "WAIT"
    ? `Wait for confirmation before you ${sideVerb}.`
    : `You can take the setup on confirmation and retest.`;

  return [
    `${actionLine}`,
    `Trigger: ${advice.trigger}`,
    `Invalidation: ${advice.invalidation}`,
    `TPs: ${advice.takeProfits.map((tp) => formatPrice(tp)).join(", ")}.`,
    `Confidence: ${advice.confidence}% (${advice.entryTimeframe} execution).`
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
            content: "You are a concise trading assistant. Use only provided facts. Keep response under 120 words with clear trigger, invalidation, and TP ladder."
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
