import assert from "node:assert/strict";

import {
  computeConfluenceScore,
  determineSignal,
  evaluateDailyReversalBias,
  type SignalType,
  type TimeframeRsi
} from "./rsi.js";
import { validateExecution } from "./execution-engine.js";
import { simulateTrade } from "./trade-lifecycle-engine.js";

type SignalCase = {
  name: string;
  daily?: TimeframeRsi;
  twelveh?: TimeframeRsi;
  macro: TimeframeRsi;
  intermediary: TimeframeRsi;
  micro: TimeframeRsi;
  expect: SignalType;
};

type ConfluenceCase = {
  name: string;
  daily: TimeframeRsi | null;
  twelveh: TimeframeRsi | null;
  macro: TimeframeRsi;
  intermediary: TimeframeRsi;
  micro: TimeframeRsi;
  signalType: SignalType;
  volume24h: number;
  averageMarketVolume: number;
  volatilityPct: number;
  expectBias: "LONG" | "SHORT" | null;
  minScore?: number;
  maxScore?: number;
};

function tf(
  interval: TimeframeRsi["interval"],
  rsi: number,
  macdHist: number,
  stochK: number,
  stochD: number,
  prevStochK: number,
  prevStochD: number,
  direction: TimeframeRsi["trend"]["direction"]
): TimeframeRsi {
  return {
    interval,
    rsi,
    macdHist,
    stochRsi: Number(((stochK + stochD) / 2).toFixed(2)),
    stochK,
    stochD,
    prevStochK,
    prevStochD,
    trend: {
      direction,
      arrow: direction === "UP" ? "▲" : direction === "DOWN" ? "▼" : "•",
      overbought: rsi >= 70,
      oversold: rsi <= 30
    }
  };
}

const signalCases: SignalCase[] = [
  {
    name: "strong-short-happy-path",
    macro: tf("4h", 58, -0.3, 42, 55, 50, 53, "DOWN"),
    intermediary: tf("1h", 63, -0.1, 76, 68, 78, 65, "MIXED"),
    micro: tf("15m", 56, -0.02, 62, 70, 75, 69, "DOWN"),
    expect: "STRONG SHORT"
  },
  {
    name: "strong-long-happy-path",
    macro: tf("4h", 44, 0.31, 58, 47, 55, 49, "UP"),
    intermediary: tf("1h", 39, 0.11, 24, 31, 22, 30, "MIXED"),
    micro: tf("15m", 45, 0.03, 38, 31, 28, 33, "UP"),
    expect: "STRONG LONG"
  },
  {
    name: "continuation-short-happy-path",
    macro: tf("4h", 52, -0.2, 45, 54, 48, 50, "DOWN"),
    intermediary: tf("1h", 53, -0.05, 50, 45, 55, 49, "MIXED"),
    micro: tf("15m", 49, -0.02, 42, 48, 56, 45, "DOWN"),
    expect: "CONTINUATION SHORT"
  },
  {
    name: "continuation-long-happy-path",
    macro: tf("4h", 48, 0.2, 58, 49, 52, 50, "UP"),
    intermediary: tf("1h", 54, 0.07, 52, 45, 50, 46, "MIXED"),
    micro: tf("15m", 53, 0.03, 61, 55, 48, 52, "UP"),
    expect: "CONTINUATION LONG"
  },
  {
    name: "strong-short-fails-macro",
    macro: tf("4h", 58, 0.3, 58, 46, 55, 50, "UP"),
    intermediary: tf("1h", 63, -0.1, 76, 68, 78, 65, "MIXED"),
    micro: tf("15m", 56, -0.02, 62, 70, 75, 69, "DOWN"),
    expect: "NO SIGNAL"
  },
  {
    name: "strong-short-fails-intermediary-zone",
    macro: tf("4h", 58, -0.3, 42, 55, 50, 53, "DOWN"),
    intermediary: tf("1h", 50, -0.1, 66, 60, 68, 58, "MIXED"),
    micro: tf("15m", 56, -0.02, 62, 70, 75, 69, "DOWN"),
    expect: "NO SIGNAL"
  },
  {
    name: "strong-short-fails-micro-k-midline",
    macro: tf("4h", 58, -0.3, 42, 55, 50, 53, "DOWN"),
    intermediary: tf("1h", 63, -0.1, 76, 68, 78, 65, "MIXED"),
    micro: tf("15m", 56, -0.02, 48, 58, 62, 55, "DOWN"),
    expect: "NO SIGNAL"
  },
  {
    name: "strong-long-fails-macro",
    macro: tf("4h", 44, -0.31, 42, 51, 45, 50, "DOWN"),
    intermediary: tf("1h", 39, 0.11, 24, 31, 22, 30, "MIXED"),
    micro: tf("15m", 45, 0.03, 38, 31, 28, 33, "UP"),
    expect: "NO SIGNAL"
  },
  {
    name: "strong-long-fails-intermediary-zone",
    macro: tf("4h", 44, 0.31, 58, 47, 55, 49, "UP"),
    intermediary: tf("1h", 47, 0.11, 34, 39, 30, 36, "MIXED"),
    micro: tf("15m", 45, 0.03, 38, 31, 28, 33, "UP"),
    expect: "NO SIGNAL"
  },
  {
    name: "strong-long-fails-micro-k-midline",
    macro: tf("4h", 44, 0.31, 58, 47, 55, 49, "UP"),
    intermediary: tf("1h", 39, 0.11, 24, 31, 22, 30, "MIXED"),
    micro: tf("15m", 45, 0.03, 57, 49, 43, 51, "UP"),
    expect: "NO SIGNAL"
  },
  {
    name: "continuation-short-lower-bound-pass",
    macro: tf("4h", 52, -0.2, 45, 54, 48, 50, "DOWN"),
    intermediary: tf("1h", 45, -0.05, 30, 28, 36, 31, "MIXED"),
    micro: tf("15m", 49, -0.02, 40, 48, 56, 45, "DOWN"),
    expect: "CONTINUATION SHORT"
  },
  {
    name: "continuation-short-upper-bound-pass",
    macro: tf("4h", 58, -0.2, 47, 55, 49, 51, "DOWN"),
    intermediary: tf("1h", 60, -0.05, 65, 60, 69, 62, "MIXED"),
    micro: tf("15m", 52, -0.02, 49, 52, 57, 50, "DOWN"),
    expect: "CONTINUATION SHORT"
  },
  {
    name: "continuation-short-fails-intermediary-range",
    macro: tf("4h", 52, -0.2, 45, 54, 48, 50, "DOWN"),
    intermediary: tf("1h", 62, -0.05, 66, 59, 70, 62, "MIXED"),
    micro: tf("15m", 49, -0.02, 42, 48, 56, 45, "DOWN"),
    expect: "NO SIGNAL"
  },
  {
    name: "continuation-short-fails-micro-midline",
    macro: tf("4h", 52, -0.2, 45, 54, 48, 50, "DOWN"),
    intermediary: tf("1h", 53, -0.05, 50, 45, 55, 49, "MIXED"),
    micro: tf("15m", 49, -0.02, 52, 59, 61, 57, "DOWN"),
    expect: "NO SIGNAL"
  },
  {
    name: "continuation-long-lower-bound-pass",
    macro: tf("4h", 48, 0.2, 58, 49, 52, 50, "UP"),
    intermediary: tf("1h", 45, 0.07, 35, 30, 33, 31, "MIXED"),
    micro: tf("15m", 53, 0.03, 54, 51, 46, 50, "UP"),
    expect: "CONTINUATION LONG"
  },
  {
    name: "continuation-long-upper-bound-pass",
    macro: tf("4h", 56, 0.2, 60, 52, 55, 51, "UP"),
    intermediary: tf("1h", 64, 0.07, 70, 66, 67, 65, "MIXED"),
    micro: tf("15m", 59, 0.03, 66, 60, 48, 55, "UP"),
    expect: "CONTINUATION LONG"
  },
  {
    name: "continuation-long-fails-intermediary-range",
    macro: tf("4h", 48, 0.2, 58, 49, 52, 50, "UP"),
    intermediary: tf("1h", 66, 0.07, 72, 69, 68, 66, "MIXED"),
    micro: tf("15m", 53, 0.03, 61, 55, 48, 52, "UP"),
    expect: "NO SIGNAL"
  },
  {
    name: "continuation-long-fails-micro-midline",
    macro: tf("4h", 48, 0.2, 58, 49, 52, 50, "UP"),
    intermediary: tf("1h", 54, 0.07, 52, 45, 50, 46, "MIXED"),
    micro: tf("15m", 53, 0.03, 47, 42, 39, 44, "UP"),
    expect: "NO SIGNAL"
  },
  {
    name: "no-signal-balanced-mixed",
    macro: tf("4h", 51, 0.01, 51, 50, 49, 49, "MIXED"),
    intermediary: tf("1h", 50, 0, 51, 50, 50, 49, "MIXED"),
    micro: tf("15m", 50, 0, 49, 49, 48, 48, "MIXED"),
    expect: "NO SIGNAL"
  },
  {
    name: "reversal-short-valid",
    daily: tf("1d", 85, 0.1, 95, 90, 92, 88, "UP"),
    twelveh: tf("12h", 70, 0.05, 80, 75, 82, 77, "UP"),
    macro: tf("4h", 60, -0.04, 65, 60, 70, 63, "MIXED"),
    intermediary: tf("1h", 58, 0.01, 70, 75, 78, 72, "MIXED"),
    micro: tf("15m", 52, -0.02, 48, 60, 65, 58, "DOWN"),
    expect: "REVERSAL SHORT"
  },
  {
    name: "reversal-long-valid",
    daily: tf("1d", 18, -0.1, 8, 12, 10, 14, "DOWN"),
    twelveh: tf("12h", 30, -0.05, 25, 28, 20, 24, "DOWN"),
    macro: tf("4h", 40, 0.03, 42, 38, 35, 37, "MIXED"),
    intermediary: tf("1h", 43, -0.01, 28, 25, 22, 20, "MIXED"),
    micro: tf("15m", 46, 0.02, 54, 42, 38, 45, "UP"),
    expect: "REVERSAL LONG"
  },
  {
    name: "reversal-short-blocked-by-trend",
    daily: tf("1d", 85, 0.1, 95, 90, 92, 88, "UP"),
    macro: tf("4h", 70, 0.3, 80, 60, 75, 65, "UP"),
    intermediary: tf("1h", 68, 0.2, 78, 70, 74, 68, "UP"),
    micro: tf("15m", 60, 0.1, 72, 65, 70, 63, "UP"),
    expect: "NO SIGNAL"
  },
  {
    name: "no-crossover-flat-kd",
    macro: tf("4h", 50, 0, 50, 50, 50, 50, "MIXED"),
    intermediary: tf("1h", 50, 0, 50, 50, 50, 50, "MIXED"),
    micro: tf("15m", 50, 0, 50, 50, 50, 50, "MIXED"),
    expect: "NO SIGNAL"
  },
  {
    name: "equal-kd-no-signal",
    macro: tf("4h", 55, 0.1, 60, 60, 58, 60, "MIXED"),
    intermediary: tf("1h", 55, 0.05, 60, 60, 61, 60, "MIXED"),
    micro: tf("15m", 50, 0, 50, 50, 50, 50, "MIXED"),
    expect: "NO SIGNAL"
  },
  {
    name: "conflicting-macro-bull-micro-bear",
    macro: tf("4h", 50, 0.2, 60, 50, 55, 48, "UP"),
    intermediary: tf("1h", 52, -0.1, 48, 55, 52, 57, "DOWN"),
    micro: tf("15m", 49, -0.05, 45, 52, 55, 50, "DOWN"),
    expect: "NO SIGNAL"
  },
  {
    name: "conflicting-macro-bear-micro-bull",
    macro: tf("4h", 50, -0.2, 40, 50, 45, 52, "DOWN"),
    intermediary: tf("1h", 48, 0.1, 52, 45, 48, 42, "UP"),
    micro: tf("15m", 50, 0.05, 55, 48, 50, 45, "UP"),
    expect: "NO SIGNAL"
  },
  {
    name: "near-threshold-just-below-strong-long",
    macro: tf("4h", 44, 0.3, 58, 47, 55, 49, "UP"),
    intermediary: tf("1h", 46, 0.11, 31, 34, 29, 32, "MIXED"),
    micro: tf("15m", 45, 0.03, 51, 49, 48, 50, "UP"),
    expect: "NO SIGNAL"
  },
  {
    name: "near-threshold-just-valid-strong-long",
    macro: tf("4h", 44, 0.3, 58, 47, 55, 49, "UP"),
    intermediary: tf("1h", 45, 0.11, 30, 31, 28, 30, "MIXED"),
    micro: tf("15m", 45, 0.03, 49, 44, 40, 47, "UP"),
    expect: "STRONG LONG"
  },
  {
    name: "structure-invalid-shape-no-signal",
    macro: tf("4h", 44, 0.31, 58, 47, 55, 49, "UP"),
    intermediary: tf("1h", 47, 0.11, 34, 39, 30, 36, "MIXED"),
    micro: tf("15m", 45, 0.03, 57, 49, 43, 51, "UP"),
    expect: "NO SIGNAL"
  }
];

const confluenceCases: ConfluenceCase[] = [
  {
    name: "confluence-reversal-short-boost",
    daily: tf("1d", 84, 0.12, 95, 91, 92, 88, "UP"),
    twelveh: tf("12h", 69, 0.08, 77, 74, 81, 78, "UP"),
    macro: tf("4h", 61, -0.05, 58, 55, 66, 60, "MIXED"),
    intermediary: tf("1h", 58, 0.01, 68, 72, 76, 70, "MIXED"),
    micro: tf("15m", 53, -0.01, 47, 58, 63, 55, "DOWN"),
    signalType: "REVERSAL SHORT",
    volume24h: 45_000_000,
    averageMarketVolume: 20_000_000,
    volatilityPct: 5,
    expectBias: "SHORT",
    minScore: 7
  },
  {
    name: "confluence-reversal-long-boost",
    daily: tf("1d", 18, -0.14, 8, 12, 11, 16, "DOWN"),
    twelveh: tf("12h", 31, -0.09, 24, 28, 18, 22, "DOWN"),
    macro: tf("4h", 39, 0.03, 42, 39, 35, 37, "MIXED"),
    intermediary: tf("1h", 42, -0.01, 30, 24, 22, 20, "MIXED"),
    micro: tf("15m", 46, 0.02, 52, 41, 38, 44, "UP"),
    signalType: "REVERSAL LONG",
    volume24h: 35_000_000,
    averageMarketVolume: 20_000_000,
    volatilityPct: 4,
    expectBias: "LONG",
    minScore: 7
  },
  {
    name: "confluence-continuation-short",
    daily: tf("1d", 62, -0.05, 61, 66, 68, 64, "DOWN"),
    twelveh: tf("12h", 58, -0.04, 56, 60, 63, 59, "DOWN"),
    macro: tf("4h", 54, -0.08, 40, 52, 47, 50, "DOWN"),
    intermediary: tf("1h", 51, -0.03, 55, 50, 58, 54, "DOWN"),
    micro: tf("15m", 48, -0.02, 42, 48, 55, 45, "DOWN"),
    signalType: "CONTINUATION SHORT",
    volume24h: 50_000_000,
    averageMarketVolume: 20_000_000,
    volatilityPct: 3,
    expectBias: "SHORT",
    minScore: 5
  },
  {
    name: "confluence-neutral-low",
    daily: tf("1d", 54, 0.01, 55, 54, 53, 55, "MIXED"),
    twelveh: tf("12h", 52, 0.01, 50, 51, 52, 49, "MIXED"),
    macro: tf("4h", 51, 0.01, 51, 50, 49, 49, "MIXED"),
    intermediary: tf("1h", 50, 0, 51, 50, 50, 49, "MIXED"),
    micro: tf("15m", 50, 0, 49, 49, 48, 48, "MIXED"),
    signalType: "NO SIGNAL",
    volume24h: 10_000_000,
    averageMarketVolume: 20_000_000,
    volatilityPct: 1,
    expectBias: null,
    maxScore: 3
  },
  {
    name: "confluence-low-volatility-reject",
    daily: tf("1d", 60, 0.01, 60, 59, 58, 60, "MIXED"),
    twelveh: tf("12h", 55, 0.01, 55, 54, 53, 54, "MIXED"),
    macro: tf("4h", 52, 0.01, 52, 51, 50, 51, "MIXED"),
    intermediary: tf("1h", 50, 0.01, 50, 50, 50, 50, "MIXED"),
    micro: tf("15m", 50, 0.01, 50, 50, 50, 50, "MIXED"),
    signalType: "NO SIGNAL",
    volume24h: 15_000_000,
    averageMarketVolume: 20_000_000,
    volatilityPct: 0.8,
    expectBias: null,
    maxScore: 2.5
  },
  {
    name: "confluence-low-liquidity-reject",
    daily: tf("1d", 65, 0.05, 65, 62, 60, 63, "UP"),
    twelveh: tf("12h", 60, 0.03, 60, 58, 57, 59, "UP"),
    macro: tf("4h", 55, 0.02, 55, 53, 52, 54, "UP"),
    intermediary: tf("1h", 52, 0.01, 52, 50, 49, 51, "UP"),
    micro: tf("15m", 50, 0.01, 50, 50, 50, 50, "UP"),
    signalType: "CONTINUATION LONG",
    volume24h: 5_000_000,
    averageMarketVolume: 20_000_000,
    volatilityPct: 2,
    expectBias: null,
    maxScore: 3
  }
];

const dailyBiasCases = [
  { name: "daily-bias-short-threshold", daily: tf("1d", 80, 0.1, 90, 86, 88, 84, "UP"), expect: "SHORT" as const },
  { name: "daily-bias-long-threshold", daily: tf("1d", 20, -0.1, 10, 14, 12, 16, "DOWN"), expect: "LONG" as const },
  { name: "daily-bias-none-mid", daily: tf("1d", 55, 0, 55, 54, 53, 52, "MIXED"), expect: null }
];

function resolveSignalCase(scenario: SignalCase): SignalType {
  return determineSignal(scenario.macro, scenario.intermediary, scenario.micro, {
    daily: scenario.daily,
    twelveh: scenario.twelveh
  });
}

const signalOutputs = signalCases.map((scenario) => {
  const actual = resolveSignalCase(scenario);
  assert.equal(actual, scenario.expect, `${scenario.name}: expected ${scenario.expect} got ${actual}`);
  return { name: scenario.name, signal: actual };
});

const confluenceOutputs = confluenceCases.map((scenario) => {
  const confluence = computeConfluenceScore({
    daily: scenario.daily,
    twelveh: scenario.twelveh,
    macro: scenario.macro,
    intermediary: scenario.intermediary,
    microTrigger: scenario.micro,
    signalType: scenario.signalType,
    volume24h: scenario.volume24h,
    averageMarketVolume: scenario.averageMarketVolume,
    volatilityPct: scenario.volatilityPct
  });

  assert.equal(confluence.bias, scenario.expectBias, `${scenario.name}: bias mismatch`);
  if (typeof scenario.minScore === "number") {
    assert.ok(confluence.score >= scenario.minScore, `${scenario.name}: score too low ${confluence.score}`);
  }
  if (typeof scenario.maxScore === "number") {
    assert.ok(confluence.score <= scenario.maxScore, `${scenario.name}: score too high ${confluence.score}`);
  }

  return { name: scenario.name, confluence };
});

const dailyBiasOutputs = dailyBiasCases.map((scenario) => {
  const bias = evaluateDailyReversalBias(scenario.daily);
  assert.equal(bias, scenario.expect, `${scenario.name}: expected ${scenario.expect} got ${bias}`);
  return { name: scenario.name, bias };
});

const executionOutputs = [
  {
    name: "execution-high-spread-reject",
    actual: validateExecution({ spreadPct: 0.2, depthUsd: 1_000_000, orderNotional: 50_000, maxSpread: 0.05 }).ok,
    expect: false
  },
  {
    name: "execution-low-liquidity-reject",
    actual: validateExecution({ spreadPct: 0.03, depthUsd: 40_000, orderNotional: 30_000, maxSpread: 0.05 }).ok,
    expect: false
  },
  {
    name: "execution-slippage-reject",
    actual: validateExecution({ spreadPct: 0.03, depthUsd: 20_000, orderNotional: 50_000, maxSpread: 0.05 }).ok,
    expect: false
  }
].map((scenario) => {
  assert.equal(scenario.actual, scenario.expect, `${scenario.name}: expected ${scenario.expect} got ${scenario.actual}`);
  return scenario;
});

const lifecycleOutputs = [
  {
    name: "lifecycle-tp-hit",
    actual: simulateTrade(
      { direction: "LONG", tpPrice: 102, slPrice: 98, entryType: "STRONG" },
      [{ open: 100, high: 103, low: 99, close: 101, elapsedMinutes: 10 }]
    ).outcome,
    expect: "WIN"
  },
  {
    name: "lifecycle-sl-hit",
    actual: simulateTrade(
      { direction: "LONG", tpPrice: 102, slPrice: 98, entryType: "STRONG" },
      [{ open: 100, high: 101, low: 97, close: 98, elapsedMinutes: 10 }]
    ).outcome,
    expect: "LOSS"
  },
  {
    name: "lifecycle-time-exit",
    actual: simulateTrade(
      { direction: "LONG", tpPrice: 110, slPrice: 90, entryType: "REVERSAL" },
      [{ open: 100, high: 101, low: 99, close: 100, elapsedMinutes: 95 }]
    ).outcome,
    expect: "TIME_EXIT"
  }
].map((scenario) => {
  assert.equal(scenario.actual, scenario.expect, `${scenario.name}: expected ${scenario.expect} got ${scenario.actual}`);
  return scenario;
});

const evOutputs = [
  { name: "ev-low-rejected", score: 3, tpDistance: 1, slDistance: 2, expectAccepted: false },
  { name: "ev-high-accepted", score: 8, tpDistance: 2.5, slDistance: 1, expectAccepted: true }
].map((scenario) => {
  const winProb = scenario.score / 10;
  const ev = (winProb * scenario.tpDistance) - ((1 - winProb) * scenario.slDistance);
  const accepted = ev > 0;
  assert.equal(accepted, scenario.expectAccepted, `${scenario.name}: expected ${scenario.expectAccepted} got ${accepted}`);
  return { name: scenario.name, ev: Number(ev.toFixed(4)), accepted };
});

const regimeOutputs = [
  {
    name: "regime-trending-blocks-reversal-without-break",
    regime: "TRENDING",
    signalType: "REVERSAL SHORT",
    structureState: "TRENDING",
    expectAllowed: false
  },
  {
    name: "regime-choppy-blocks-strong",
    regime: "CHOPPY",
    signalType: "STRONG LONG",
    structureState: "TRENDING",
    expectAllowed: false
  }
].map((scenario) => {
  const allowed = scenario.regime === "CHOPPY" && scenario.signalType.startsWith("STRONG")
    ? false
    : scenario.regime === "TRENDING" && scenario.signalType.startsWith("REVERSAL") && scenario.structureState !== "REVERSAL"
      ? false
      : true;
  assert.equal(allowed, scenario.expectAllowed, `${scenario.name}: expected ${scenario.expectAllowed} got ${allowed}`);
  return { ...scenario, allowed };
});

console.log(
  JSON.stringify(
    {
      ok: true,
      totalCases:
        signalCases.length +
        confluenceCases.length +
        dailyBiasCases.length +
        executionOutputs.length +
        lifecycleOutputs.length +
        evOutputs.length +
        regimeOutputs.length,
      signalCaseCount: signalCases.length,
      confluenceCaseCount: confluenceCases.length,
      dailyBiasCaseCount: dailyBiasCases.length,
      executionCaseCount: executionOutputs.length,
      lifecycleCaseCount: lifecycleOutputs.length,
      evCaseCount: evOutputs.length,
      regimeCaseCount: regimeOutputs.length,
      signalOutputs,
      confluenceOutputs,
      dailyBiasOutputs,
      executionOutputs,
      lifecycleOutputs,
      evOutputs,
      regimeOutputs
    },
    null,
    2
  )
);
