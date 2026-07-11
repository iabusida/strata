import "./env.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { fetchActiveBitunixPerpSymbols, fetchOrderBookExecutionRead } from "./bitunix-service.js";

type FastPumpState = {
  symbols?: Record<string, { lastScore?: number }>;
};

export type ShortCandidate = {
  symbol: string;
  score: number;
  close: number;
  return10dPct: number;
  return20dPct: number;
  sma20GapPct: number;
  rsi14: number;
  spreadPct: number;
  imbalancePct: number;
  action: "BUY" | "WAIT" | "SELL";
  actionConfidence: number;
  bearishContextScore: number;
  trendState: "UP_CONTINUATION" | "DOWN_CONTINUATION" | "TRANSITION";
  bidDepthUsd: number;
  askDepthUsd: number;
  reasons: string[];
};

export type NearShort = {
  symbol: string;
  score: number;
  return10dPct: number;
  return20dPct: number;
  sma20GapPct: number;
  rsi14: number;
  spreadPct: number;
  imbalancePct: number;
  action: "BUY" | "WAIT" | "SELL";
  actionConfidence: number;
  bearishContextScore: number;
  trendState: "UP_CONTINUATION" | "DOWN_CONTINUATION" | "TRANSITION";
  bidDepthUsd: number;
  askDepthUsd: number;
  exhaustionStage: "STRETCHED" | "EARLY_EXHAUSTION" | "CONFIRMED_EXHAUSTION";
  exhaustionScore: number;
  exhaustionReasons: string[];
  blocker: string;
};

export type Gates = {
  minReturn10dPct: number;
  minReturn20dPct: number;
  minSma20GapPct: number;
  minRsi14: number;
  maxSpreadPct: number;
  minDepthUsd: number;
  minSellConfidence: number;
  minNegativeImbalancePct: number;
  minBearishContextScore: number;
};

export const STRICT_GATES: Gates = {
  minReturn10dPct: 100,
  minReturn20dPct: 120,
  minSma20GapPct: 18,
  minRsi14: 70,
  maxSpreadPct: 0.12,
  minDepthUsd: 10_000,
  minSellConfidence: 60,
  minNegativeImbalancePct: 12,
  minBearishContextScore: 62
} as const;

export const RELAXED_GATES: Gates = {
  minReturn10dPct: 80,
  minReturn20dPct: 100,
  minSma20GapPct: 12,
  minRsi14: 66,
  maxSpreadPct: 0.15,
  minDepthUsd: 7_000,
  minSellConfidence: 55,
  minNegativeImbalancePct: 8,
  minBearishContextScore: 52
} as const;

const prisma = new PrismaClient();

export function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase().replace(/-PERP$/i, "");
}

function toExternalPerpSymbol(value: string): string {
  return `${normalizeSymbol(value)}-PERP`;
}

function loadUniverseFromState(minScore = 50): string[] {
  try {
    const raw = readFileSync("./data/fast-pump-state.json", "utf8");
    const parsed = JSON.parse(raw) as FastPumpState;
    return Object.entries(parsed.symbols ?? {})
      .filter(([, row]) => Number(row.lastScore ?? 0) >= minScore)
      .map(([key]) => key.replace(/-PERP$/i, ""))
      .sort();
  } catch {
    return [];
  }
}

async function loadUniverseAllTokens(): Promise<string[]> {
  const rows = await prisma.marketCandle.findMany({
    where: { interval: "D1" },
    select: { symbol: true },
    distinct: ["symbol"]
  });

  return rows
    .map((row) => normalizeSymbol(row.symbol))
    .filter((symbol) => symbol.length > 0)
    .sort();
}

function sma(values: number[], period: number, endIndex: number): number {
  const start = endIndex - period + 1;
  if (start < 0) return Number.NaN;
  let sum = 0;
  for (let i = start; i <= endIndex; i += 1) {
    sum += values[i];
  }
  return sum / period;
}

function computeRsi14(closes: number[]): number {
  if (closes.length < 15) return Number.NaN;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - 14; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const curr = closes[i];
    const d = curr - prev;
    if (d >= 0) gains += d;
    else losses += Math.abs(d);
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function scoreNegativeImbalancePct(imbalancePct: number): number {
  if (!Number.isFinite(imbalancePct)) return 0;
  if (imbalancePct <= -25) return 100;
  if (imbalancePct <= -18) return 84;
  if (imbalancePct <= -12) return 70;
  if (imbalancePct <= -8) return 55;
  if (imbalancePct <= -4) return 35;
  if (imbalancePct <= -1) return 18;
  return 0;
}

function classifyTrendState(closes: number[]): "UP_CONTINUATION" | "DOWN_CONTINUATION" | "TRANSITION" {
  const i = closes.length - 1;
  if (i < 55) {
    return "TRANSITION";
  }

  const close = closes[i];
  const sma20 = sma(closes, 20, i);
  const sma50 = sma(closes, 50, i);
  const sma20Prev5 = sma(closes, 20, i - 5);
  if (![close, sma20, sma50, sma20Prev5].every((v) => Number.isFinite(v) && v > 0)) {
    return "TRANSITION";
  }

  const sma20SlopePct = ((sma20 - sma20Prev5) / sma20Prev5) * 100;

  if (close > sma20 && sma20 > sma50 && sma20SlopePct >= 0.4) {
    return "UP_CONTINUATION";
  }
  if (close < sma20 && sma20 < sma50 && sma20SlopePct <= -0.4) {
    return "DOWN_CONTINUATION";
  }
  return "TRANSITION";
}

function computeBearishContextScore(input: {
  currentImbalancePct: number;
  imbalance1mPct: number;
  imbalance5mPct: number;
  action: "BUY" | "WAIT" | "SELL";
  actionConfidence: number;
  liquidityRegime?: "BUYER_DOMINATED" | "SELLER_DOMINATED" | "POTENTIAL_ABSORPTION" | "ABSORPTION" | "DISTRIBUTION" | "SHORT_FUEL" | "NEUTRAL";
  liquidityDivergence?: "BULLISH" | "BEARISH" | "NONE";
  liquidityStabilityScore?: number;
}): number {
  const currentScore = scoreNegativeImbalancePct(input.currentImbalancePct);
  const score1m = scoreNegativeImbalancePct(input.imbalance1mPct);
  const score5m = scoreNegativeImbalancePct(input.imbalance5mPct);

  let actionScore = 0;
  if (input.action === "SELL") {
    actionScore = Math.min(100, 30 + input.actionConfidence);
  } else if (input.action === "WAIT") {
    actionScore = Math.min(35, input.actionConfidence * 0.4);
  }

  let regimeAdj = 0;
  if (input.liquidityRegime === "SELLER_DOMINATED") regimeAdj += 12;
  if (input.liquidityRegime === "DISTRIBUTION") regimeAdj += 10;
  if (input.liquidityRegime === "BUYER_DOMINATED") regimeAdj -= 10;
  if (input.liquidityRegime === "SHORT_FUEL") regimeAdj -= 8;

  if (input.liquidityDivergence === "BEARISH") regimeAdj += 6;
  if (input.liquidityDivergence === "BULLISH") regimeAdj -= 6;

  const stabilityAdj = Math.max(0, Math.min(10, Math.round((Number(input.liquidityStabilityScore ?? 50) - 45) / 5)));

  const blended =
    currentScore * 0.4 +
    score1m * 0.3 +
    score5m * 0.2 +
    actionScore * 0.1 +
    regimeAdj +
    stabilityAdj;

  return Math.max(0, Math.min(100, Number(blended.toFixed(1))));
}

function classifyExhaustion(input: {
  return10dPct: number;
  return20dPct: number;
  sma20GapPct: number;
  rsi14: number;
  spreadPct: number;
  imbalancePct: number;
  action: "BUY" | "WAIT" | "SELL";
  actionConfidence: number;
  bidDepthUsd: number;
  askDepthUsd: number;
}): {
  stage: "STRETCHED" | "EARLY_EXHAUSTION" | "CONFIRMED_EXHAUSTION";
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];

  if (input.return10dPct >= 100) {
    score += 30;
    reasons.push(`10d +${input.return10dPct.toFixed(1)}% blow-off`);
  } else if (input.return10dPct >= 80) {
    score += 20;
    reasons.push(`10d +${input.return10dPct.toFixed(1)}% extended`);
  } else if (input.return10dPct >= 60) {
    score += 12;
  }

  if (input.return20dPct >= 120) {
    score += 20;
    reasons.push(`20d +${input.return20dPct.toFixed(1)}% parabolic`);
  } else if (input.return20dPct >= 100) {
    score += 14;
  } else if (input.return20dPct >= 80) {
    score += 8;
  }

  if (input.sma20GapPct >= 40) {
    score += 20;
    reasons.push(`SMA20 gap ${input.sma20GapPct.toFixed(1)}%`);
  } else if (input.sma20GapPct >= 20) {
    score += 12;
  } else if (input.sma20GapPct >= 10) {
    score += 6;
  }

  if (input.rsi14 >= 85) {
    score += 20;
    reasons.push(`RSI ${input.rsi14.toFixed(1)} extreme`);
  } else if (input.rsi14 >= 78) {
    score += 14;
  } else if (input.rsi14 >= 70) {
    score += 8;
  } else if (input.rsi14 >= 62) {
    score += 4;
  }

  if (input.action === "SELL") {
    score += 15;
    reasons.push(`action SELL (${input.actionConfidence.toFixed(0)}%)`);
  }
  if (input.actionConfidence >= 60) score += 10;
  else if (input.actionConfidence >= 55) score += 6;

  if (input.imbalancePct <= -20) {
    score += 12;
    reasons.push(`OB ${input.imbalancePct.toFixed(1)}% bearish`);
  } else if (input.imbalancePct <= -8) {
    score += 7;
  } else if (input.imbalancePct <= -3) {
    score += 3;
  }

  const minDepthUsd = Math.min(input.bidDepthUsd, input.askDepthUsd);
  if (minDepthUsd >= 10_000) score += 8;
  else if (minDepthUsd >= 7_000) score += 5;

  if (input.spreadPct <= 0.1) score += 5;
  else if (input.spreadPct <= 0.15) score += 2;

  const bounded = Math.max(0, Math.min(100, score));
  const stage = bounded >= 75
    ? "CONFIRMED_EXHAUSTION"
    : bounded >= 55
      ? "EARLY_EXHAUSTION"
      : "STRETCHED";

  return {
    stage,
    score: bounded,
    reasons,
  };
}

async function analyzeSymbol(symbol: string, gates: Gates): Promise<ShortCandidate | null> {
  const normalized = normalizeSymbol(symbol);

  const candles = await prisma.marketCandle.findMany({
    where: {
      symbol: normalized,
      interval: "D1"
    },
    orderBy: { timestamp: "asc" },
    take: 120
  });

  if (candles.length < 30) {
    return null;
  }

  const closes = candles.map((c) => c.close);
  const i = closes.length - 1;
  const close = closes[i];
  const close10 = closes[i - 10];
  const close20 = closes[i - 20];
  const return10dPct = ((close - close10) / close10) * 100;
  const return20dPct = ((close - close20) / close20) * 100;
  const sma20 = sma(closes, 20, i);
  const sma20GapPct = ((close - sma20) / sma20) * 100;
  const rsi14 = computeRsi14(closes);
  const trendState = classifyTrendState(closes);

  const ob = await fetchOrderBookExecutionRead(normalized);
  if (!ob) {
    return null;
  }

  const action = (ob.actionRecommendation ?? "WAIT") as "BUY" | "WAIT" | "SELL";
  const actionConfidence = Number(ob.actionConfidencePct ?? 0);
  const imbalancePct = Number(ob.imbalance * 100);
  const imbalance1mPct = Number((ob.imbalanceAvg1m ?? ob.imbalance) * 100);
  const imbalance5mPct = Number((ob.imbalanceAvg5m ?? ob.imbalance) * 100);
  const spreadPct = Number(ob.spreadPct);
  const bidDepthUsd = Number(ob.bidDepthUsd ?? 0);
  const askDepthUsd = Number(ob.askDepthUsd ?? 0);
  const bearishContextScore = computeBearishContextScore({
    currentImbalancePct: imbalancePct,
    imbalance1mPct,
    imbalance5mPct,
    action,
    actionConfidence,
    liquidityRegime: ob.liquidityRegime,
    liquidityDivergence: ob.liquidityDivergence,
    liquidityStabilityScore: ob.liquidityStabilityScore,
  });

  const hasParabolicMove = return10dPct >= gates.minReturn10dPct || return20dPct >= gates.minReturn20dPct;
  const hasSmaExtension = sma20GapPct >= gates.minSma20GapPct;
  const hasRsiExtension = rsi14 >= gates.minRsi14;

  const reasons: string[] = [];
  if (return10dPct >= gates.minReturn10dPct) reasons.push(`10d run-up ${return10dPct.toFixed(1)}%`);
  if (return20dPct >= gates.minReturn20dPct) reasons.push(`20d run-up ${return20dPct.toFixed(1)}%`);
  if (hasSmaExtension) reasons.push(`extended vs SMA20 ${sma20GapPct.toFixed(1)}%`);
  if (hasRsiExtension) reasons.push(`RSI14 ${rsi14.toFixed(1)}`);

  const overextended = hasParabolicMove && hasSmaExtension && hasRsiExtension;

  const trendGuard =
    trendState !== "UP_CONTINUATION" ||
    bearishContextScore >= gates.minBearishContextScore + 12;

  const liquidityShort =
    action === "SELL" &&
    actionConfidence >= gates.minSellConfidence &&
    spreadPct <= gates.maxSpreadPct &&
    bidDepthUsd >= gates.minDepthUsd &&
    askDepthUsd >= gates.minDepthUsd &&
    imbalancePct <= -gates.minNegativeImbalancePct &&
    bearishContextScore >= gates.minBearishContextScore &&
    trendGuard;

  if (!overextended || !liquidityShort) {
    return null;
  }

  const score =
    Math.min(100, Math.max(0, return10dPct * 0.5 + return20dPct * 0.5)) * 0.35 +
    Math.min(100, Math.max(0, sma20GapPct * 3.2)) * 0.2 +
    Math.min(100, Math.max(0, (rsi14 - 55) * 2.2)) * 0.15 +
    Math.min(100, actionConfidence) * 0.2 +
    Math.min(100, Math.abs(imbalancePct) * 3) * 0.1;

  reasons.push(`liquidity SELL ${actionConfidence.toFixed(0)}%`);
  reasons.push(`imbalance ${imbalancePct.toFixed(1)}% (1m ${imbalance1mPct.toFixed(1)} / 5m ${imbalance5mPct.toFixed(1)})`);
  reasons.push(`bearish context ${bearishContextScore.toFixed(1)}`);
  reasons.push(`trend ${trendState}`);

  return {
    symbol: normalized,
    score,
    close,
    return10dPct,
    return20dPct,
    sma20GapPct,
    rsi14,
    spreadPct,
    imbalancePct,
    action,
    actionConfidence,
    bearishContextScore,
    trendState,
    bidDepthUsd,
    askDepthUsd,
    reasons
  };
}

async function analyzeNearShort(symbol: string): Promise<NearShort | null> {
  const normalized = normalizeSymbol(symbol);
  const candles = await prisma.marketCandle.findMany({
    where: { symbol: normalized, interval: "D1" },
    orderBy: { timestamp: "asc" },
    take: 120
  });
  if (candles.length < 30) return null;

  const closes = candles.map((c) => c.close);
  const i = closes.length - 1;
  const close = closes[i];
  const close10 = closes[i - 10];
  const close20 = closes[i - 20];
  const return10dPct = ((close - close10) / close10) * 100;
  const return20dPct = ((close - close20) / close20) * 100;
  const sma20 = sma(closes, 20, i);
  const sma20GapPct = ((close - sma20) / sma20) * 100;
  const rsi14 = computeRsi14(closes);
  const trendState = classifyTrendState(closes);

  const overextended = return10dPct >= 60 || return20dPct >= 80 || (sma20GapPct >= 8 && rsi14 >= 62);
  if (!overextended) return null;

  const ob = await fetchOrderBookExecutionRead(normalized);
  if (!ob) return null;

  const action = (ob.actionRecommendation ?? "WAIT") as "BUY" | "WAIT" | "SELL";
  const actionConfidence = Number(ob.actionConfidencePct ?? 0);
  const spreadPct = Number(ob.spreadPct ?? 0);
  const imbalancePct = Number(ob.imbalance * 100);
  const imbalance1mPct = Number((ob.imbalanceAvg1m ?? ob.imbalance) * 100);
  const imbalance5mPct = Number((ob.imbalanceAvg5m ?? ob.imbalance) * 100);
  const bidDepthUsd = Number(ob.bidDepthUsd ?? 0);
  const askDepthUsd = Number(ob.askDepthUsd ?? 0);
  const bearishContextScore = computeBearishContextScore({
    currentImbalancePct: imbalancePct,
    imbalance1mPct,
    imbalance5mPct,
    action,
    actionConfidence,
    liquidityRegime: ob.liquidityRegime,
    liquidityDivergence: ob.liquidityDivergence,
    liquidityStabilityScore: ob.liquidityStabilityScore,
  });

  const exhaustion = classifyExhaustion({
    return10dPct,
    return20dPct,
    sma20GapPct,
    rsi14,
    spreadPct,
    imbalancePct,
    action,
    actionConfidence,
    bidDepthUsd,
    askDepthUsd,
  });

  let blocker = "needs SELL confirmation";
  if (trendState === "UP_CONTINUATION" && bearishContextScore < 65) blocker = "drop looks like pullback in uptrend";
  else if (action === "SELL" && actionConfidence < 55) blocker = "SELL confidence below 55%";
  else if (action !== "SELL") blocker = `action ${action} (not SELL)`;
  else if (Math.min(bidDepthUsd, askDepthUsd) < 7000) blocker = "depth below $7k";
  else if (imbalancePct > -8) blocker = "bearish imbalance not strong enough";
  else if (bearishContextScore < 52) blocker = `bearish context weak (${bearishContextScore.toFixed(0)})`;

  const score =
    Math.max(0, return10dPct) * 0.35 +
    Math.max(0, return20dPct) * 0.2 +
    Math.max(0, sma20GapPct) * 2.8 +
    Math.max(0, rsi14 - 50) * 1.5 +
    Math.max(0, -imbalancePct) * 1.1 +
    actionConfidence * 0.25;

  return {
    symbol: normalized,
    score,
    return10dPct,
    return20dPct,
    sma20GapPct,
    rsi14,
    spreadPct,
    imbalancePct,
    action,
    actionConfidence,
    bearishContextScore,
    trendState,
    bidDepthUsd,
    askDepthUsd,
    exhaustionStage: exhaustion.stage,
    exhaustionScore: exhaustion.score,
    exhaustionReasons: exhaustion.reasons,
    blocker
  };
}

export type ScanOverextendedShortsOptions = {
  symbols?: string[];
  fromState?: boolean;
  allTokens?: boolean;
  minScore?: number;
  relaxed?: boolean;
  includeNear?: boolean;
};

export type ScanOverextendedShortsResult = {
  mode: "STRICT" | "RELAXED";
  gates: Gates;
  requestedUniverse: string[];
  universe: string[];
  skippedNonTradable: string[];
  candidates: ShortCandidate[];
  near: NearShort[];
};

export async function scanOverextendedShorts(options: ScanOverextendedShortsOptions = {}): Promise<ScanOverextendedShortsResult> {
  const relaxed = Boolean(options.relaxed);
  const gates = relaxed ? RELAXED_GATES : STRICT_GATES;
  const symbols = (options.symbols ?? []).map(normalizeSymbol).filter(Boolean);
  let requestedUniverse: string[] = [];

  if (symbols.length > 0) {
    requestedUniverse = symbols;
  } else if (options.allTokens) {
    requestedUniverse = await loadUniverseAllTokens();
  } else if (options.fromState) {
    requestedUniverse = loadUniverseFromState(options.minScore ?? 50);
  }

  const activeSymbols = await fetchActiveBitunixPerpSymbols();
  const universe = requestedUniverse.filter((symbol) => activeSymbols.has(toExternalPerpSymbol(symbol)));
  const skippedNonTradable = requestedUniverse.filter((symbol) => !activeSymbols.has(toExternalPerpSymbol(symbol)));

  if (universe.length === 0) {
    return {
      mode: relaxed ? "RELAXED" : "STRICT",
      gates,
      requestedUniverse,
      universe,
      skippedNonTradable,
      candidates: [],
      near: []
    };
  }

  const candidates: ShortCandidate[] = [];
  for (const symbol of universe) {
    const row = await analyzeSymbol(symbol, gates);
    if (row) candidates.push(row);
  }
  candidates.sort((a, b) => b.score - a.score);

  const near: NearShort[] = [];
  if ((options.includeNear ?? true) && candidates.length === 0) {
    for (const symbol of universe) {
      const row = await analyzeNearShort(symbol);
      if (row) near.push(row);
    }
    near.sort((a, b) => b.score - a.score);
  }

  return {
    mode: relaxed ? "RELAXED" : "STRICT",
    gates,
    requestedUniverse,
    universe,
    skippedNonTradable,
    candidates,
    near
  };
}

function printCli(result: ScanOverextendedShortsResult): void {
  console.log("\nOVEREXTENDED + LIQUIDITY SELL SCAN");
  console.log(`Universe: ${result.universe.length} tradable symbols (requested ${result.requestedUniverse.length})\n`);
  if (result.skippedNonTradable.length > 0) {
    const preview = result.skippedNonTradable.slice(0, 12).join(", ");
    const suffix = result.skippedNonTradable.length > 12 ? ` ... +${result.skippedNonTradable.length - 12} more` : "";
    console.log(`Skipped non-tradable on Bitunix: ${preview}${suffix}\n`);
  }
  console.log(
    `Mode: ${result.mode} | min10d=${result.gates.minReturn10dPct}% min20d=${result.gates.minReturn20dPct}% minSMA20=${result.gates.minSma20GapPct}% minRSI=${result.gates.minRsi14} minSELLconf=${result.gates.minSellConfidence}% minDepth=$${result.gates.minDepthUsd.toLocaleString()} minCtx=${result.gates.minBearishContextScore}\n`
  );

  if (result.candidates.length === 0) {
    console.log("No short candidates passed all gates.");
    console.log("Required: 100%+ style overextension + action=SELL + confidence/depth/imbalance confirmation.");

    if (result.near.length > 0) {
      console.log("\nClosest-to-short (monitor for SELL flip):");
      result.near.slice(0, 10).forEach((n, idx) => {
        console.log(
          `${String(idx + 1).padEnd(3)} ${n.symbol.padEnd(8)} score=${n.score.toFixed(1)} exh=${n.exhaustionStage}(${n.exhaustionScore.toFixed(0)}) 10d=${n.return10dPct.toFixed(1)}% 20d=${n.return20dPct.toFixed(1)}% sma20=${n.sma20GapPct.toFixed(1)}% rsi=${n.rsi14.toFixed(1)} ob=${n.imbalancePct.toFixed(1)}% ctx=${n.bearishContextScore.toFixed(0)} trend=${n.trendState} action=${n.action}(${n.actionConfidence.toFixed(0)}%) blocker=${n.blocker}`
        );
        if (n.exhaustionReasons.length > 0) {
          console.log(`      ${n.exhaustionReasons.slice(0, 3).join(" | ")}`);
        }
      });
    }
    return;
  }

  console.log("Rank  Symbol   Score  10d%   20d%   SMA20%  RSI14  OB%    Ctx  Trend           Act(conf)  Bid$    Ask$   Spread%");
  result.candidates.slice(0, 20).forEach((c, idx) => {
    console.log(
      `${String(idx + 1).padEnd(5)} ${c.symbol.padEnd(7)} ${c.score.toFixed(1).padEnd(6)} ${c.return10dPct.toFixed(1).padEnd(6)} ${c.return20dPct.toFixed(1).padEnd(6)} ${c.sma20GapPct.toFixed(1).padEnd(7)} ${c.rsi14.toFixed(1).padEnd(6)} ${c.imbalancePct.toFixed(1).padEnd(6)} ${c.bearishContextScore.toFixed(0).padEnd(4)} ${c.trendState.padEnd(15)} ${`${c.action}(${c.actionConfidence.toFixed(0)}%)`.padEnd(10)} ${c.bidDepthUsd.toFixed(0).padEnd(7)} ${c.askDepthUsd.toFixed(0).padEnd(7)} ${c.spreadPct.toFixed(4)}`
    );
    console.log(`      ${c.reasons.join(" | ")}`);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fromState = args.includes("--from-state");
  const allTokens = args.includes("--all");
  const relaxed = args.includes("--relaxed");
  const minScoreArg = args.find((arg) => arg.startsWith("--min-score="));
  const minScore = minScoreArg ? Number.parseInt(minScoreArg.split("=")[1] ?? "50", 10) || 50 : 50;

  const symbols = args.filter((arg) => !arg.startsWith("--")).map(normalizeSymbol).filter(Boolean);
  const shouldLoadFromState = symbols.length === 0 && !allTokens ? fromState : false;

  if (symbols.length === 0 && !shouldLoadFromState && !allTokens) {
    console.log("Usage:");
    console.log("  npx tsx src/overextended-short-scan.ts --from-state --min-score=50");
    console.log("  npx tsx src/overextended-short-scan.ts --all");
    console.log("  npx tsx src/overextended-short-scan.ts --all --relaxed");
    console.log("  npx tsx src/overextended-short-scan.ts --relaxed --from-state");
    console.log("  npx tsx src/overextended-short-scan.ts CELO BNB DOGE");
    return;
  }

  const result = await scanOverextendedShorts({
    symbols,
    fromState: shouldLoadFromState,
    allTokens,
    minScore,
    relaxed,
    includeNear: true
  });

  printCli(result);
}

const currentFile = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] === currentFile;

if (isDirectRun) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
