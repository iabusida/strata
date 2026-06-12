import type { TokenRsiResult } from "./rsi.js";

export type AiDecisionDirection = "LONG" | "SHORT" | "ABSTAIN";
export type AiDecisionProvider = "HEURISTIC" | "OPENAI" | "AZURE_OPENAI";

export type AiDecisionConfig = {
  enabled: boolean;
  shadowMode: boolean;
  provider: AiDecisionProvider;
  model: string;
  minConfidence: number;
  timeoutMs: number;
  logDecisions: boolean;
  apiEndpoint: string;
  apiKey: string;
  azureEndpoint: string;
  azureApiVersion: string;
  azureDeploymentName: string;
  azureApiKey: string;
};

export type AiTradeDecision = {
  provider: AiDecisionProvider;
  model: string;
  mode: "HEURISTIC" | "REMOTE";
  direction: AiDecisionDirection;
  confidence: number;
  expectedEdgePct: number;
  reasonCodes: string[];
  raw?: string;
};

function resolveBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  return parsed;
}

function resolveStringEnv(name: string, defaultValue: string): string {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }

  return raw.trim();
}

function resolveProviderEnv(name: string, defaultValue: AiDecisionProvider): AiDecisionProvider {
  const value = resolveStringEnv(name, defaultValue).toUpperCase();
  if (value === "OPENAI") {
    return "OPENAI";
  }
  if (value === "AZURE_OPENAI") {
    return "AZURE_OPENAI";
  }

  return "HEURISTIC";
}

const AI_DECISION_CONFIG: AiDecisionConfig = {
  enabled: resolveBooleanEnv("AI_DECISION_ENABLED", false),
  shadowMode: resolveBooleanEnv("AI_DECISION_SHADOW_MODE", true),
  provider: resolveProviderEnv("AI_DECISION_PROVIDER", "HEURISTIC"),
  model: resolveStringEnv("AI_DECISION_MODEL", "gpt-4o-mini"),
  minConfidence: Math.max(0, Math.min(1, resolveNumberEnv("AI_DECISION_MIN_CONFIDENCE", 0.6))),
  timeoutMs: Math.max(500, Math.trunc(resolveNumberEnv("AI_DECISION_TIMEOUT_MS", 3500))),
  logDecisions: resolveBooleanEnv("AI_DECISION_LOG_DECISIONS", true),
  apiEndpoint: resolveStringEnv("AI_DECISION_API_ENDPOINT", "https://api.openai.com/v1/chat/completions"),
  apiKey: resolveStringEnv("AI_DECISION_API_KEY", ""),
  azureEndpoint: resolveStringEnv("AZURE_OPENAI_ENDPOINT", ""),
  azureApiVersion: resolveStringEnv("AZURE_OPENAI_API_VERSION", "2024-12-01-preview"),
  azureDeploymentName: resolveStringEnv("AZURE_OPENAI_DEPLOYMENT_NAME", ""),
  azureApiKey: resolveStringEnv("AZURE_OPENAI_API_KEY", "")
};

export function getAiDecisionConfig(): AiDecisionConfig {
  return AI_DECISION_CONFIG;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function heuristicDecision(row: TokenRsiResult, proposedDirection: "LONG" | "SHORT"): AiTradeDecision {
  const close = Number(row.close ?? 0);
  const ema20 = Number(row.tradeContext?.ema20 ?? 0);
  const macroTrend = row.timeframes.macro.trend.direction;
  const intermediaryTrend = row.timeframes.intermediary.trend.direction;
  const stochK = Number(row.timeframes.intermediary.stochK ?? 50);
  const stochD = Number(row.timeframes.intermediary.stochD ?? 50);
  const macdHist = Number(row.timeframes.intermediary.macdHist ?? 0);
  const confluenceScore = Number(row.confluence.score ?? 0);

  let confidence = 0.5;
  const reasonCodes: string[] = [];

  if (proposedDirection === "SHORT") {
    if (Number.isFinite(close) && Number.isFinite(ema20) && close < ema20) {
      confidence += 0.12;
      reasonCodes.push("PRICE_BELOW_EMA20");
    } else {
      confidence -= 0.12;
    }

    if (intermediaryTrend === "DOWN" || macroTrend === "DOWN") {
      confidence += 0.14;
      reasonCodes.push("TREND_DOWN_ALIGNMENT");
    }

    if (stochK < stochD) {
      confidence += 0.1;
      reasonCodes.push("STOCH_BEARISH");
    }

    if (macdHist < 0) {
      confidence += 0.1;
      reasonCodes.push("MACD_NEGATIVE");
    }
  } else {
    if (Number.isFinite(close) && Number.isFinite(ema20) && close > ema20) {
      confidence += 0.12;
      reasonCodes.push("PRICE_ABOVE_EMA20");
    } else {
      confidence -= 0.12;
    }

    if (intermediaryTrend === "UP" || macroTrend === "UP") {
      confidence += 0.14;
      reasonCodes.push("TREND_UP_ALIGNMENT");
    }

    if (stochK > stochD) {
      confidence += 0.1;
      reasonCodes.push("STOCH_BULLISH");
    }

    if (macdHist > 0) {
      confidence += 0.1;
      reasonCodes.push("MACD_POSITIVE");
    }
  }

  if (row.tradeContext?.passedVolatility) {
    confidence += 0.06;
    reasonCodes.push("VOLATILITY_OK");
  }
  if (row.tradeContext?.passedLiquidity) {
    confidence += 0.06;
    reasonCodes.push("LIQUIDITY_OK");
  }

  confidence += (Math.max(0, Math.min(10, confluenceScore)) / 10 - 0.5) * 0.18;

  const normalizedConfidence = clamp01(confidence);
  const direction: AiDecisionDirection = normalizedConfidence >= 0.45 ? proposedDirection : "ABSTAIN";
  const expectedEdgePct = Math.max(0, Number((normalizedConfidence * 1.8).toFixed(3)));

  return {
    provider: "HEURISTIC",
    model: "RULE_BLEND_V1",
    mode: "HEURISTIC",
    direction,
    confidence: Number(normalizedConfidence.toFixed(3)),
    expectedEdgePct,
    reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["LOW_SIGNAL_QUALITY"]
  };
}

function parseAiResponse(rawContent: string): {
  direction: AiDecisionDirection;
  confidence: number;
  expectedEdgePct: number;
  reasonCodes: string[];
} | null {
  try {
    const parsed = JSON.parse(rawContent) as {
      direction?: unknown;
      confidence?: unknown;
      expectedEdgePct?: unknown;
      reasonCodes?: unknown;
    };

    const rawDirection = String(parsed.direction ?? "ABSTAIN").toUpperCase();
    const direction: AiDecisionDirection =
      rawDirection === "LONG" || rawDirection === "SHORT" || rawDirection === "ABSTAIN"
        ? rawDirection
        : "ABSTAIN";

    const confidence = clamp01(Number(parsed.confidence ?? 0));
    const expectedEdgePct = Number(parsed.expectedEdgePct ?? 0);
    const reasonCodes = Array.isArray(parsed.reasonCodes)
      ? parsed.reasonCodes.map((item) => String(item)).slice(0, 8)
      : ["REMOTE_NO_REASON_CODES"];

    return {
      direction,
      confidence: Number(confidence.toFixed(3)),
      expectedEdgePct: Number((Number.isFinite(expectedEdgePct) ? expectedEdgePct : 0).toFixed(3)),
      reasonCodes
    };
  } catch {
    return null;
  }
}

async function remoteOpenAiDecision(
  row: TokenRsiResult,
  proposedDirection: "LONG" | "SHORT",
  config: AiDecisionConfig
): Promise<AiTradeDecision | null> {
  if (!config.apiKey) {
    return null;
  }

  const payload = {
    model: config.model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a trading decision classifier. Respond with ONLY JSON: {direction:'LONG|SHORT|ABSTAIN', confidence:0..1, expectedEdgePct:number, reasonCodes:string[]}."
      },
      {
        role: "user",
        content: JSON.stringify({
          proposedDirection,
          symbol: row.symbol,
          close: row.close,
          confluenceScore: row.confluence.score,
          signalType: row.signal.type,
          marketStatus: row.status,
          volatilityPct: row.tradeContext?.volatilityPct,
          liquidityPass: row.tradeContext?.passedLiquidity,
          volatilityPass: row.tradeContext?.passedVolatility,
          ema20: row.tradeContext?.ema20,
          macroTrend: row.timeframes.macro.trend.direction,
          intermediaryTrend: row.timeframes.intermediary.trend.direction,
          stochK: row.timeframes.intermediary.stochK,
          stochD: row.timeframes.intermediary.stochD,
          macdHist: row.timeframes.intermediary.macdHist
        })
      }
    ]
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.apiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    const json = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = String(json.choices?.[0]?.message?.content ?? "").trim();
    if (!content) {
      return null;
    }

    const parsed = parseAiResponse(content);
    if (!parsed) {
      return null;
    }

    return {
      provider: "OPENAI",
      model: config.model,
      mode: "REMOTE",
      direction: parsed.direction,
      confidence: parsed.confidence,
      expectedEdgePct: parsed.expectedEdgePct,
      reasonCodes: parsed.reasonCodes,
      raw: content
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveAzureChatCompletionsUrl(config: AiDecisionConfig): string {
  const endpoint = config.azureEndpoint.trim().replace(/\/$/, "");
  if (!endpoint) {
    return "";
  }

  const apiVersion = encodeURIComponent(config.azureApiVersion);

  if (endpoint.includes("/openai/v1")) {
    const separator = endpoint.includes("?") ? "&" : "?";
    return `${endpoint}/chat/completions${separator}api-version=${apiVersion}`;
  }

  if (endpoint.includes("/openai/deployments/")) {
    const separator = endpoint.includes("?") ? "&" : "?";
    return `${endpoint}/chat/completions${separator}api-version=${apiVersion}`;
  }

  const deployment = encodeURIComponent(config.azureDeploymentName.trim());
  if (!deployment) {
    return "";
  }

  return `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
}

async function remoteAzureOpenAiDecision(
  row: TokenRsiResult,
  proposedDirection: "LONG" | "SHORT",
  config: AiDecisionConfig
): Promise<AiTradeDecision | null> {
  const apiKey = config.azureApiKey.trim();
  if (!apiKey) {
    return null;
  }

  const url = resolveAzureChatCompletionsUrl(config);
  if (!url) {
    return null;
  }

  const deploymentModel = config.azureDeploymentName.trim() || config.model;
  const payload = {
    model: deploymentModel,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a trading decision classifier. Respond with ONLY JSON: {direction:'LONG|SHORT|ABSTAIN', confidence:0..1, expectedEdgePct:number, reasonCodes:string[]}."
      },
      {
        role: "user",
        content: JSON.stringify({
          proposedDirection,
          symbol: row.symbol,
          close: row.close,
          confluenceScore: row.confluence.score,
          signalType: row.signal.type,
          marketStatus: row.status,
          volatilityPct: row.tradeContext?.volatilityPct,
          liquidityPass: row.tradeContext?.passedLiquidity,
          volatilityPass: row.tradeContext?.passedVolatility,
          ema20: row.tradeContext?.ema20,
          macroTrend: row.timeframes.macro.trend.direction,
          intermediaryTrend: row.timeframes.intermediary.trend.direction,
          stochK: row.timeframes.intermediary.stochK,
          stochD: row.timeframes.intermediary.stochD,
          macdHist: row.timeframes.intermediary.macdHist
        })
      }
    ]
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    const json = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = String(json.choices?.[0]?.message?.content ?? "").trim();
    if (!content) {
      return null;
    }

    const parsed = parseAiResponse(content);
    if (!parsed) {
      return null;
    }

    return {
      provider: "AZURE_OPENAI",
      model: deploymentModel,
      mode: "REMOTE",
      direction: parsed.direction,
      confidence: parsed.confidence,
      expectedEdgePct: parsed.expectedEdgePct,
      reasonCodes: parsed.reasonCodes,
      raw: content
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function evaluateAiDecision(
  row: TokenRsiResult,
  proposedDirection: "LONG" | "SHORT"
): Promise<AiTradeDecision> {
  const config = getAiDecisionConfig();

  if (config.provider === "OPENAI") {
    const remote = await remoteOpenAiDecision(row, proposedDirection, config);
    if (remote) {
      return remote;
    }
  }

  if (config.provider === "AZURE_OPENAI") {
    const remote = await remoteAzureOpenAiDecision(row, proposedDirection, config);
    if (remote) {
      return remote;
    }
  }

  const fallback = heuristicDecision(row, proposedDirection);
  if (config.provider === "OPENAI" || config.provider === "AZURE_OPENAI") {
    fallback.reasonCodes = ["REMOTE_FALLBACK_HEURISTIC", ...fallback.reasonCodes];
  }
  return fallback;
}
