"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AlignmentPoint, PreEntryWatchPlan, ProfileSetupPlans, SetupPlan, SignalItem, SignalState } from "./system/types";
import { SignalStateBadge } from "./system/signal-state-badge";
import { ScanControlBar } from "./system/scan-control-bar";
import { SignalCard } from "./system/signal-card";
import { LockedOpportunityTeaserCard, NoActiveTradesState, TopOpportunityCard, TopOpportunityEmptyState } from "./system/top-opportunity-card";
import { CompactProfileBar, ProfileContextBanner, ProfileSelector } from "./profile-selector";
import { useUserProfile } from "../hooks/use-user-profile";
import { evaluateSignalForProfile, getForecastInterpretation, getProfileMarketStatus, SIGNAL_STATE_PRIORITY } from "./system/profile-decision";
import { getTimeframeAnalysisHelperText } from "./system/timeframe-analysis";
import { useAppAccess } from "../hooks/use-app-access";
import { AccessValueBanner, UpgradeModal, type UpgradeIntent } from "./system/upgrade-modal";
import { useAuth } from "../contexts/auth-context";
import { useSession } from "next-auth/react";

type DashboardView = "results" | "simulation";

type DashboardProps = {
  initialView?: DashboardView;
  tradeMode?: "test" | "live";
};

type RawDirection = "UP" | "DOWN" | "MIXED";

type RawRow = {
  symbol: string;
  market: "perp" | "spot";
  close: number;
  entryTiming: "EARLY" | "MID" | "LATE" | null;
  signal: { type: string };
  confluence: { score: number };
  levels: {
    localSupport: number;
    localResistance: number;
    nearSupportFloor: boolean;
    nearResistance: boolean;
    supportDistancePct: number;
    resistanceDistancePct: number;
  };
  rsi: number;
  volume24h: number;
  volatilityPct: number;
  tradeContext: {
    emaSlope: number;
    passedVolatility: boolean;
    passedLiquidity: boolean;
    orderBookImbalance?: number;
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
  timeframes: {
    macro: { trend: { direction: RawDirection }; rsi: number; stochK: number };
    intermediary: { trend: { direction: RawDirection }; rsi: number; stochK: number };
    microTrigger: { trend: { direction: RawDirection }; rsi: number; stochK: number };
  };
};

type StatePayload = {
  analyzedAt?: string;
  results?: RawRow[];
  service?: {
    lastSignalScanAt?: string;
    signalIntervalMs?: number;
  };
  tradeSimulation?: {
    stats?: {
      totalTrades: number;
      activeTrades: number;
      winRate: number;
      totalPnlUsd: number;
      unrealizedPnlUsd: number;
    };
  };
};

type TradeAdviceResponse = {
  ok: boolean;
  reply: string;
  saved?: AdvisorHistoryRow;
  advice?: {
    symbol: string;
    side: "LONG" | "SHORT";
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
  unresolved?: string;
  error?: string;
};

type AdvisorHistoryRow = {
  id: string;
  prompt: string;
  reply: string;
  symbol: string | null;
  side: string | null;
  market: string | null;
  action: string | null;
  confidence: number | null;
  createdAt: string;
};

type WatchLifecycleStatus = "NO_WATCH" | "OUTSIDE_ZONE" | "IN_ZONE" | "CONFIRMED" | "INVALIDATED";

type WatchAlertEvent = {
  id: string;
  symbol: string;
  direction: "WATCH_LONG" | "WATCH_SHORT";
  status: Extract<WatchLifecycleStatus, "IN_ZONE" | "CONFIRMED" | "INVALIDATED">;
  price: number;
  timestamp: number;
  message: string;
};

type SymbolWatchSnapshot = {
  status: WatchLifecycleStatus;
  direction: "WATCH_LONG" | "WATCH_SHORT" | "NO_WATCH";
};

type PrimaryTab = "Scan" | "Forecast" | "Execute" | "Simulate";

type MarketFilter = "CRYPTO" | "STOCKS";

type SortKey = "marketCap" | "score" | "volume24h" | "price";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim();

function getApiWebSocketBase(): string {
  if (API_BASE) {
    return API_BASE.replace(/^http/i, "ws").replace(/\/+$/, "");
  }

  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.hostname}:8787`;
  }

  return "ws://127.0.0.1:8787";
}

function getApiHttpBase(): string {
  if (API_BASE) return API_BASE.replace(/\/+$/, "");
  if (typeof window !== "undefined") return `${window.location.protocol}//${window.location.hostname}:8787`;
  return "http://127.0.0.1:8787";
}

const TOKEN_NAMES: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  XRP: "XRP",
  ICP: "Internet Computer",
  AERO: "Aerodrome",
  HYPE: "Hyperliquid",
  ZEC: "Zcash",
  XLM: "Stellar",
  NEAR: "NEAR Protocol",
  JTO: "Jito",
  TAO: "Bittensor",
};

const MARKET_CAP_USD: Record<string, number> = {
  BTC: 1_360_000_000_000,
  ETH: 430_000_000_000,
  BNB: 95_000_000_000,
  SOL: 82_000_000_000,
  XRP: 75_000_000_000,
  TRX: 25_000_000_000,
  ADA: 24_000_000_000,
  DOGE: 23_000_000_000,
  TON: 18_000_000_000,
  AVAX: 15_000_000_000,
  LINK: 12_000_000_000,
  DOT: 11_000_000_000,
  SUI: 11_000_000_000,
  SHIB: 10_000_000_000,
  BCH: 9_000_000_000,
  NEAR: 7_000_000_000,
  LTC: 7_000_000_000,
  UNI: 6_000_000_000,
  POL: 6_500_000_000,
  ICP: 5_200_000_000,
  PEPE: 5_000_000_000,
  APT: 4_500_000_000,
  HBAR: 4_200_000_000,
  RENDER: 4_100_000_000,
  ATOM: 3_900_000_000,
  FIL: 3_800_000_000,
  TAO: 3_600_000_000,
  FET: 3_200_000_000,
  XLM: 3_000_000_000,
  ARB: 2_800_000_000,
  OP: 2_600_000_000,
  WLD: 2_200_000_000,
  INJ: 2_200_000_000,
  WIF: 2_300_000_000,
  AAVE: 1_500_000_000,
  BONK: 1_600_000_000,
};

function toBaseSymbol(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace(/-(USDT|USDC)-SWAP$/i, "")
    .replace(/-(USDT|USDC)$/i, "")
    .replace(/-PERP$/i, "")
    .replace(/-SWAP$/i, "");
}

function getTokenDisplayName(symbol: string): string {
  const base = toBaseSymbol(symbol);
  return TOKEN_NAMES[base] ?? base;
}

function getMarketCapUsd(symbol: string): number | null {
  const base = toBaseSymbol(symbol);
  return Object.prototype.hasOwnProperty.call(MARKET_CAP_USD, base) ? MARKET_CAP_USD[base] : null;
}

function toSignalState(row: RawRow): SignalState {
  const directional = row.signal.type.includes("LONG") || row.signal.type.includes("SHORT");
  const qualityGate = row.tradeContext.passedVolatility && row.tradeContext.passedLiquidity;
  const score = row.confluence.score;

  if (!directional && score >= 6.5) return "BUILDING";
  if (!directional || !qualityGate || score < 4.5) return "BLOCKED";
  if (row.entryTiming === "EARLY" && score >= 7.5) return "READY";
  return "CAUTION";
}

const PROFILE_SETUP_FACTORS: Record<keyof ProfileSetupPlans, {
  entryBufferMultiplier: number;
  invalidationBufferMultiplier: number;
  tp1RangeFraction: number;
  tp2RiskMultiplier: number;
  tp3RiskMultiplier: number;
  rationaleSuffix: string;
}> = {
  scalp: {
    entryBufferMultiplier: 0.45,
    invalidationBufferMultiplier: 0.55,
    tp1RangeFraction: 0.55,
    tp2RiskMultiplier: 0.25,
    tp3RiskMultiplier: 0.65,
    rationaleSuffix: "Built for fast execution with tighter risk and earlier profit-taking.",
  },
  day: {
    entryBufferMultiplier: 0.8,
    invalidationBufferMultiplier: 0.9,
    tp1RangeFraction: 1,
    tp2RiskMultiplier: 0.75,
    tp3RiskMultiplier: 1.5,
    rationaleSuffix: "Structured for session continuation with the first target at the main level.",
  },
  swing: {
    entryBufferMultiplier: 1.1,
    invalidationBufferMultiplier: 1.25,
    tp1RangeFraction: 1,
    tp2RiskMultiplier: 1.5,
    tp3RiskMultiplier: 3,
    rationaleSuffix: "Gives the trade more room to work and leans on extension targets after the main level breaks.",
  },
  long_term: {
    entryBufferMultiplier: 1.35,
    invalidationBufferMultiplier: 1.7,
    tp1RangeFraction: 1,
    tp2RiskMultiplier: 2.5,
    tp3RiskMultiplier: 5,
    rationaleSuffix: "Uses wider invalidation and larger extensions for a patient macro-style hold.",
  },
};

function emptySetupPlan(direction: SetupPlan["direction"], rationale: string): SetupPlan {
  return {
    direction,
    entryZoneLow: null,
    entryZoneHigh: null,
    invalidation: null,
    tp1: null,
    tp2: null,
    tp3: null,
    rationale,
  };
}

function buildProfileSetupPlan(options: {
  profile: keyof ProfileSetupPlans;
  direction: SetupPlan["direction"];
  directionalSignal: boolean;
  validLevels: boolean;
  support: number;
  resistance: number;
  setupBufferPct: number;
  invalidationBufferPct: number;
  nearSupportFloor: boolean;
  nearResistance: boolean;
}): SetupPlan {
  const {
    profile,
    direction,
    directionalSignal,
    validLevels,
    support,
    resistance,
    setupBufferPct,
    invalidationBufferPct,
    nearSupportFloor,
    nearResistance,
  } = options;

  if (!directionalSignal) {
    return emptySetupPlan("NEUTRAL", "No directional signal is available yet.");
  }

  if (!validLevels) {
    return emptySetupPlan(direction, "Support and resistance are not reliable enough yet for a profile-specific trade plan.");
  }

  const factors = PROFILE_SETUP_FACTORS[profile];
  const entryBuffer = setupBufferPct * factors.entryBufferMultiplier;
  const invalidationBuffer = invalidationBufferPct * factors.invalidationBufferMultiplier;
  const range = Math.max(0.0001, resistance - support);

  if (direction === "LONG") {
    const entryZoneLow = support * (1 - entryBuffer / 100);
    const entryZoneHigh = support * (1 + entryBuffer / 100);
    const invalidation = support * (1 - invalidationBuffer / 100);
    const averageEntry = (entryZoneLow + entryZoneHigh) / 2;
    const risk = Math.max(0.0001, averageEntry - invalidation);
    const tp1 = support + (range * factors.tp1RangeFraction);
    const tp2 = tp1 + (risk * factors.tp2RiskMultiplier);
    const tp3 = tp1 + (risk * factors.tp3RiskMultiplier);
    const rationale = nearSupportFloor
      ? `Setup is anchored to local support with invalidation below the floor. ${factors.rationaleSuffix}`
      : `Plan waits for pullback into support, then scales targets higher as the trade timeframe widens. ${factors.rationaleSuffix}`;

    return {
      direction,
      entryZoneLow,
      entryZoneHigh,
      invalidation,
      tp1,
      tp2,
      tp3,
      rationale,
    };
  }

  if (direction === "SHORT") {
    const entryZoneLow = resistance * (1 - entryBuffer / 100);
    const entryZoneHigh = resistance * (1 + entryBuffer / 100);
    const invalidation = resistance * (1 + invalidationBuffer / 100);
    const averageEntry = (entryZoneLow + entryZoneHigh) / 2;
    const risk = Math.max(0.0001, invalidation - averageEntry);
    const tp1 = resistance - (range * factors.tp1RangeFraction);
    const tp2 = Math.max(0, tp1 - (risk * factors.tp2RiskMultiplier));
    const tp3 = Math.max(0, tp1 - (risk * factors.tp3RiskMultiplier));
    const rationale = nearResistance
      ? `Setup is anchored to local resistance with invalidation above the sweep zone. ${factors.rationaleSuffix}`
      : `Plan waits for recovery into resistance, then scales downside targets further for slower trade profiles. ${factors.rationaleSuffix}`;

    return {
      direction,
      entryZoneLow,
      entryZoneHigh,
      invalidation,
      tp1,
      tp2,
      tp3,
      rationale,
    };
  }

  return emptySetupPlan(direction, "No directional setup is available yet.");
}

function buildPreEntryWatchPlan(options: {
  signalState: SignalState;
  direction: SetupPlan["direction"];
  directionalSignal: boolean;
  validLevels: boolean;
  support: number;
  resistance: number;
  setupBufferPct: number;
  invalidationBufferPct: number;
  triggerDirection: RawDirection;
  currentPrice: number;
}): PreEntryWatchPlan {
  const {
    signalState,
    direction,
    validLevels,
    support,
    resistance,
    setupBufferPct,
    invalidationBufferPct,
    triggerDirection,
    currentPrice,
  } = options;

  if (signalState === "READY") {
    return {
      state: "NO_WATCH",
      zoneLow: null,
      zoneHigh: null,
      invalidation: null,
      trigger: null,
      rationale: "Trigger is already active. Use the trade map execution plan.",
    };
  }

  const inferredDirection: SetupPlan["direction"] =
    direction !== "NEUTRAL"
      ? direction
      : triggerDirection === "UP"
        ? "LONG"
        : triggerDirection === "DOWN"
          ? "SHORT"
          : currentPrice <= support || support > 0
            ? "LONG"
            : "SHORT";

  const watchEntryBuffer = Math.max(0.2, setupBufferPct * 0.95);
  const watchInvalidationBuffer = Math.max(0.35, invalidationBufferPct * 1.05);
  const hasReliableLevels = validLevels && support > 0 && resistance > support;

  if (inferredDirection === "LONG") {
    const anchor = hasReliableLevels ? support : currentPrice;
    const triggerAnchor = hasReliableLevels ? resistance : currentPrice;
    const zoneLow = anchor * (1 - watchEntryBuffer / 100);
    const zoneHigh = anchor * (1 + watchEntryBuffer / 100);
    const invalidation = anchor * (1 - watchInvalidationBuffer / 100);
    const trigger = triggerAnchor * (1 + (watchEntryBuffer * 0.25) / 100);

    return {
      state: "WATCH_LONG",
      zoneLow,
      zoneHigh,
      invalidation,
      trigger,
      rationale: hasReliableLevels
        ? "Watch for support hold inside the zone, then reclaim above trigger for confirmation."
        : "Levels are still forming, but this provisional long watch zone tracks price for early preparation.",
    };
  }

  const anchor = hasReliableLevels ? resistance : currentPrice;
  const triggerAnchor = hasReliableLevels ? support : currentPrice;
  const zoneLow = anchor * (1 - watchEntryBuffer / 100);
  const zoneHigh = anchor * (1 + watchEntryBuffer / 100);
  const invalidation = anchor * (1 + watchInvalidationBuffer / 100);
  const trigger = triggerAnchor * (1 - (watchEntryBuffer * 0.25) / 100);

  return {
    state: "WATCH_SHORT",
    zoneLow,
    zoneHigh,
    invalidation,
    trigger,
    rationale: hasReliableLevels
      ? "Watch for rejection near the zone, then breakdown under trigger for confirmation."
      : "Levels are still forming, but this provisional short watch zone tracks price for early preparation.",
  };
}

function rowToSignalItem(row: RawRow): SignalItem {
  const baseSymbol = toBaseSymbol(row.symbol);
  const state = toSignalState(row);
  const alignment: AlignmentPoint[] = [
    { label: "1d", direction: row.timeframes.macro.trend.direction, dominant: true },
    { label: "4h", direction: row.timeframes.intermediary.trend.direction },
    {
      label: "1h",
      direction: row.timeframes.microTrigger.trend.direction,
      blocked:
        row.timeframes.macro.trend.direction !== "MIXED"
        && row.timeframes.microTrigger.trend.direction !== "MIXED"
        && row.timeframes.macro.trend.direction !== row.timeframes.microTrigger.trend.direction,
    },
    {
      label: "15m",
      direction: row.timeframes.microTrigger.stochK >= 50 ? "UP" : "DOWN",
    },
  ];

  const hasConflict = alignment.some((point) => point.blocked);
  const directionWord = row.signal.type.includes("LONG") ? "upside" : row.signal.type.includes("SHORT") ? "downside" : "neutral";

  const liquiditySweep = Math.abs(Number(row.tradeContext.orderBookImbalance ?? 0)) > 0.06
    ? "HIGH"
    : Math.abs(Number(row.tradeContext.orderBookImbalance ?? 0)) > 0.02
      ? "MEDIUM"
      : "LOW";

  const support = Number(row.levels.localSupport ?? 0);
  const resistance = Number(row.levels.localResistance ?? 0);
  const directionalSignal = row.signal.type.includes("LONG") || row.signal.type.includes("SHORT");
  const direction = row.signal.type.includes("LONG") ? "LONG" : row.signal.type.includes("SHORT") ? "SHORT" : "NEUTRAL";
  const validLevels = Number.isFinite(support) && support > 0 && Number.isFinite(resistance) && resistance > support;
  const setupBufferPct = Math.max(0.25, Math.min(0.9, Number(row.volatilityPct ?? 0) * 0.18 || 0.35));
  const invalidationBufferPct = Math.max(0.45, Math.min(1.2, Number(row.volatilityPct ?? 0) * 0.32 || 0.6));

  const fallbackEntry = row.close;
  const fallbackStop = row.signal.type.includes("LONG") ? row.close * 0.985 : row.close * 1.015;
  const fallbackTp = row.signal.type.includes("LONG") ? row.close * 1.03 : row.close * 0.97;

  const profileSetupPlans: ProfileSetupPlans = {
    scalp: buildProfileSetupPlan({
      profile: "scalp",
      direction,
      directionalSignal,
      validLevels,
      support,
      resistance,
      setupBufferPct,
      invalidationBufferPct,
      nearSupportFloor: row.levels.nearSupportFloor,
      nearResistance: row.levels.nearResistance,
    }),
    day: buildProfileSetupPlan({
      profile: "day",
      direction,
      directionalSignal,
      validLevels,
      support,
      resistance,
      setupBufferPct,
      invalidationBufferPct,
      nearSupportFloor: row.levels.nearSupportFloor,
      nearResistance: row.levels.nearResistance,
    }),
    swing: buildProfileSetupPlan({
      profile: "swing",
      direction,
      directionalSignal,
      validLevels,
      support,
      resistance,
      setupBufferPct,
      invalidationBufferPct,
      nearSupportFloor: row.levels.nearSupportFloor,
      nearResistance: row.levels.nearResistance,
    }),
    long_term: buildProfileSetupPlan({
      profile: "long_term",
      direction,
      directionalSignal,
      validLevels,
      support,
      resistance,
      setupBufferPct,
      invalidationBufferPct,
      nearSupportFloor: row.levels.nearSupportFloor,
      nearResistance: row.levels.nearResistance,
    }),
  };

  const microDirection: RawDirection = row.timeframes.microTrigger.stochK >= 50 ? "UP" : "DOWN";

  const preEntryWatch = buildPreEntryWatchPlan({
    signalState: state,
    direction,
    directionalSignal,
    validLevels,
    support,
    resistance,
    setupBufferPct,
    invalidationBufferPct,
    triggerDirection: microDirection,
    currentPrice: row.close,
  });

  const setupPlan = profileSetupPlans.day;
  const entry = setupPlan.entryZoneLow != null && setupPlan.entryZoneHigh != null
    ? (setupPlan.entryZoneLow + setupPlan.entryZoneHigh) / 2
    : fallbackEntry;
  const stopLoss = setupPlan.invalidation ?? fallbackStop;
  const takeProfit = setupPlan.tp1 ?? fallbackTp;
  const microRsi = row.rsi;
  const microStochastic = row.timeframes.microTrigger.stochK;
  const microBias = row.tradeContext.emaSlope >= 0 ? 1 : -1;

  const deriveMicroMetric = (
    label: "1m" | "5m",
    rsiOffset: number,
    stochasticOffset: number,
  ) => {
    const adjustedRsi = Math.max(0, Math.min(100, microRsi + (rsiOffset * microBias)));
    const adjustedStochastic = Math.max(0, Math.min(100, microStochastic + (stochasticOffset * microBias)));
    const direction: RawDirection = adjustedStochastic >= 55 ? "UP" : adjustedStochastic <= 45 ? "DOWN" : "MIXED";

    return {
      label,
      direction,
      rsi: adjustedRsi,
      stochastic: adjustedStochastic,
    };
  };

  return {
    symbol: baseSymbol,
    displayName: getTokenDisplayName(baseSymbol),
    price: row.close,
    marketCapUsd: getMarketCapUsd(baseSymbol),
    score: row.confluence.score,
    state,
    summary: hasConflict
      ? `Layered structure conflict detected. ${directionWord} bias remains ${state.toLowerCase()}.`
      : `Multi-timeframe structure is coherent with ${directionWord} bias.`,
    alignment,
    entryTiming: row.entryTiming,
    rsi: row.rsi,
    stochastic: row.timeframes.microTrigger.stochK,
    emaSlope: row.tradeContext.emaSlope,
    volume24h: row.volume24h,
    volatilityPct: row.volatilityPct,
    liquiditySweep,
    fibZone: row.signal.type.includes("LONG") ? "0.5-0.618 retrace" : "0.382-0.5 rejection",
    htfConfirmed: !hasConflict,
    suggestedEntry: entry,
    stopLoss,
    takeProfit,
    setupPlan,
    profileSetupPlans,
    preEntryWatch,
    timeframeMetrics: {
      "1m": deriveMicroMetric("1m", 8, 14),
      "5m": deriveMicroMetric("5m", 4, 8),
      "1d": {
        label: "1d",
        direction: row.timeframes.macro.trend.direction,
        rsi: row.timeframes.macro.rsi,
        stochastic: row.timeframes.macro.stochK,
      },
      "4h": {
        label: "4h",
        direction: row.timeframes.intermediary.trend.direction,
        rsi: row.timeframes.intermediary.rsi,
        stochastic: row.timeframes.intermediary.stochK,
      },
      "1h": {
        label: "1h",
        direction: row.timeframes.microTrigger.trend.direction,
        rsi: row.timeframes.microTrigger.rsi,
        stochastic: row.timeframes.microTrigger.stochK,
      },
      "15m": {
        label: "15m",
        direction: microDirection,
        rsi: row.rsi,
        stochastic: row.timeframes.microTrigger.stochK,
      },
    },
    counterTrendContext: row.tradeContext.counterTrendContext,
  };
}

function deriveWatchLifecycleStatus(item: SignalItem): SymbolWatchSnapshot {
  const watch = item.preEntryWatch;

  if (!watch || watch.state === "NO_WATCH") {
    return { status: "NO_WATCH", direction: "NO_WATCH" };
  }

  const direction = watch.state;
  const zoneLow = watch.zoneLow;
  const zoneHigh = watch.zoneHigh;
  const invalidation = watch.invalidation;
  const trigger = watch.trigger;

  if (zoneLow == null || zoneHigh == null || invalidation == null || trigger == null) {
    return { status: "OUTSIDE_ZONE", direction };
  }

  if (direction === "WATCH_LONG") {
    if (item.price <= invalidation) return { status: "INVALIDATED", direction };
    if (item.price >= trigger) return { status: "CONFIRMED", direction };
  } else {
    if (item.price >= invalidation) return { status: "INVALIDATED", direction };
    if (item.price <= trigger) return { status: "CONFIRMED", direction };
  }

  if (item.price >= zoneLow && item.price <= zoneHigh) {
    return { status: "IN_ZONE", direction };
  }

  return { status: "OUTSIDE_ZONE", direction };
}

function inferSignalBias(item: SignalItem): "LONG" | "SHORT" | "NEUTRAL" {
  if (item.takeProfit > item.suggestedEntry && item.stopLoss < item.suggestedEntry) {
    return "LONG";
  }

  if (item.takeProfit < item.suggestedEntry && item.stopLoss > item.suggestedEntry) {
    return "SHORT";
  }

  return "NEUTRAL";
}

function toConfidencePercent(item: SignalItem): number {
  const base = (item.score / 10) * 100;
  const htfBoost = item.htfConfirmed ? 8 : -10;
  const stateBoost = item.state === "READY" ? 12 : item.state === "CAUTION" ? 2 : -12;
  return Math.max(5, Math.min(99, Math.round(base + htfBoost + stateBoost)));
}

function getDirectionLabel(item: SignalItem): "Bullish" | "Bearish" | "Neutral" {
  const bias = inferSignalBias(item);
  if (bias === "LONG") return "Bullish";
  if (bias === "SHORT") return "Bearish";
  return "Neutral";
}

function getOpportunityLabel(item: SignalItem): "Strong Buy" | "Strong Sell" | "Watch" | "Avoid" {
  if (item.state === "READY") {
    return inferSignalBias(item) === "SHORT" ? "Strong Sell" : "Strong Buy";
  }

  if (item.state === "CAUTION" || item.state === "BUILDING") {
    return "Watch";
  }

  return "Avoid";
}

function getMarketStatus(
  total: number,
  readyCount: number,
  blockedCount: number,
  cautionCount: number,
): { title: string; subtitle: string; shellClass: string } {
  const blockedRatio = total > 0 ? blockedCount / total : 1;

  if (total === 0) {
    return {
      title: "No Trade Zone",
      subtitle: "No signals available in current scan window.",
      shellClass: "border-[#EF4444]/35 bg-[#3F1218]/40 shadow-[0_0_28px_rgba(239,68,68,0.15)]",
    };
  }

  if (blockedRatio > 0.7) {
    return {
      title: "No Trade Zone",
      subtitle: "Weak signals across market. Most setups are currently blocked.",
      shellClass: "border-[#EF4444]/35 bg-[#3F1218]/40 shadow-[0_0_28px_rgba(239,68,68,0.15)]",
    };
  }

  if (readyCount >= 2) {
    return {
      title: "Active Opportunities",
      subtitle: "High probability setups available with aligned momentum.",
      shellClass: "border-[#22C55E]/35 bg-[#0F2E25]/45 shadow-[0_0_28px_rgba(34,197,94,0.18)]",
    };
  }

  if (cautionCount > 0 || readyCount === 1) {
    return {
      title: "Mixed Market",
      subtitle: "Limited opportunities. Wait for clearer confirmation before sizing up.",
      shellClass: "border-[#F59E0B]/35 bg-[#3A2A0E]/45 shadow-[0_0_28px_rgba(245,158,11,0.16)]",
    };
  }

  return {
    title: "No Trade Zone",
    subtitle: "Weak market structure across assets. Preserve capital and wait.",
    shellClass: "border-[#EF4444]/35 bg-[#3F1218]/40 shadow-[0_0_28px_rgba(239,68,68,0.15)]",
  };
}

function confidenceBand(value: number): "Very Low" | "Low" | "Medium" | "High" | "Very High" {
  if (value < 20) return "Very Low";
  if (value < 40) return "Low";
  if (value < 60) return "Medium";
  if (value < 80) return "High";
  return "Very High";
}

function opportunityReason(item: SignalItem): string {
  if (item.state === "READY") {
    return item.htfConfirmed
      ? "Momentum building across timeframes"
      : "Strong setup but monitor for alignment confirmation";
  }

  if (item.state === "CAUTION" || item.state === "BUILDING") {
    return "Setup forming, but breakout confirmation is still missing";
  }

  return "Signal quality too weak to justify a trade";
}

function getPrimaryTab(pathname: string, initialView: DashboardView): PrimaryTab {
  if (initialView === "simulation" || pathname.startsWith("/simulation") || pathname.startsWith("/test-simulation")) return "Simulate";
  if (pathname.startsWith("/dry-run")) return "Execute";
  if (pathname.startsWith("/markets/forecast")) return "Forecast";
  return "Scan";
}

export function Dashboard({ initialView = "results", tradeMode = "live" }: DashboardProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useAuth();
  const { data: session } = useSession();
  const sessionJwtToken = (session?.user as { jwtToken?: string } | undefined)?.jwtToken ?? null;
  const hasAuthenticatedSession = Boolean(session?.user?.email);
  const isGuestPreview = !user && !sessionJwtToken && !hasAuthenticatedSession;
  const [payload, setPayload] = useState<StatePayload | null>(null);
  const [wsStatus, setStatus] = useState<"Idle" | "Scanning" | "Error">("Idle");
  const [lastWsMessageAt, setLastWsMessageAt] = useState<number | null>(null);
  const [wsMessageCount, setWsMessageCount] = useState(0);
  const [hasSeenPayload, setHasSeenPayload] = useState(false);
  const [executionFocus, setExecutionFocus] = useState<SignalItem | null>(null);
  const [tokenQuery, setTokenQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("marketCap");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [upgradeIntent, setUpgradeIntent] = useState<UpgradeIntent | null>(null);
  const [testSimStats, setTestSimStats] = useState<StatePayload["tradeSimulation"] | null>(null);
  const [watchAlerts, setWatchAlerts] = useState<WatchAlertEvent[]>([]);
  const [advisorPrompt, setAdvisorPrompt] = useState("I'm thinking of going long ETH right now, when should I enter?");
  const [advisorMarket, setAdvisorMarket] = useState<"spot" | "perp">("spot");
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const [advisorError, setAdvisorError] = useState<string | null>(null);
  const [advisorResponse, setAdvisorResponse] = useState<TradeAdviceResponse | null>(null);
  const [advisorHistory, setAdvisorHistory] = useState<AdvisorHistoryRow[]>([]);
  const watchSnapshotRef = useRef<Record<string, SymbolWatchSnapshot>>({});

  // User profile management
  const { profile: userProfile, riskLevel, setProfile, setRiskLevel } = useUserProfile();
  const { entitlements, error: accessError } = useAppAccess();
  const effectiveProfile = entitlements.forcedProfile ?? userProfile;

  const primaryTab = useMemo(() => getPrimaryTab(pathname, initialView), [pathname, initialView]);

  useEffect(() => {
    let cancelled = false;

    const loadCachedState = async (limitTokens: number): Promise<void> => {
      try {
        const response = await fetch(
          `${getApiHttpBase()}/api/state/public?limitTokens=${limitTokens}&onlySignals=false`,
          { cache: "no-store" }
        );
        if (!response.ok || cancelled) {
          return;
        }

        const data = (await response.json()) as StatePayload;
        if (cancelled) {
          return;
        }

        setPayload((previous) => {
          if (!previous) {
            return data;
          }

          const incoming = Array.isArray(data.results) ? data.results : [];
          const current = Array.isArray(previous.results) ? previous.results : [];
          return incoming.length >= current.length
            ? { ...previous, ...data }
            : previous;
        });
        setHasSeenPayload(true);
        setStatus("Idle");
      } catch {
        // Best effort cache bootstrap; websocket or next refresh can still hydrate.
      }
    };

    void loadCachedState(50);

    if (!isGuestPreview) {
      void loadCachedState(200);
    }

    return () => {
      cancelled = true;
    };
  }, [isGuestPreview]);

  // Poll test simulation stats when on the Simulate tab
  useEffect(() => {
    if (primaryTab !== "Simulate") return;
    let cancelled = false;

    const fetchTestSim = async () => {
      try {
        const token = (typeof window !== "undefined" ? localStorage.getItem("authToken") : null) ?? sessionJwtToken;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers["Authorization"] = `Bearer ${token}`;
        // Test simulation trades are engine-driven and stored under the default tenant.
        // Use the cheap snapshot path here so the summary cards do not wait on a full refresh.
        const params = new URLSearchParams({ mode: "test", tenantId: "default", refresh: "0", summaryOnly: "1" });
        const res = await fetch(`${getApiHttpBase()}/api/trades?${params.toString()}`, { headers });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setTestSimStats({ stats: data?.stats });
      } catch {
        // ignore
      }
    };

    fetchTestSim();
    const interval = setInterval(fetchTestSim, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [primaryTab, user?.organizationId, sessionJwtToken]);

  useEffect(() => {
    let closedByCleanup = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const authToken = (typeof window !== "undefined" ? localStorage.getItem("authToken") : null) ?? sessionJwtToken;
    if (!authToken) {
      return () => {
        // Guest preview mode: REST cache bootstrap handles data without websocket auth.
      };
    }

    const connect = (): void => {
      setStatus("Scanning");
      const params = new URLSearchParams({ mode: tradeMode });
      if (user?.organizationId) {
        params.set("tenantId", user.organizationId);
      }
      params.set("token", authToken);
      socket = new WebSocket(`${getApiWebSocketBase()}/ws/state?${params.toString()}`);

      socket.onopen = () => {
        setStatus("Idle");
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as StatePayload;
          setPayload(data);
          setHasSeenPayload(true);
          setLastWsMessageAt(Date.now());
          setWsMessageCount((count) => count + 1);
          setStatus("Idle");
        } catch {
          setStatus("Error");
        }
      };

      socket.onerror = () => {
        setStatus("Error");
      };

      socket.onclose = () => {
        if (closedByCleanup) {
          return;
        }

        setStatus("Error");
        reconnectTimeout = setTimeout(() => {
          connect();
        }, 3000);
      };
    };

    connect();

    return () => {
      closedByCleanup = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [tradeMode, user?.organizationId, sessionJwtToken]);

  const signals = useMemo(() => {
    const rows = payload?.results ?? [];
    return rows.map(rowToSignalItem);
  }, [payload?.results]);

  useEffect(() => {
    const nextSnapshot: Record<string, SymbolWatchSnapshot> = {};
    const nextAlerts: WatchAlertEvent[] = [];

    for (const item of signals) {
      const current = deriveWatchLifecycleStatus(item);
      const previous = watchSnapshotRef.current[item.symbol];
      nextSnapshot[item.symbol] = current;

      if (!previous) {
        continue;
      }

      const stateChanged = previous.status !== current.status || previous.direction !== current.direction;
      if (!stateChanged) {
        continue;
      }

      if (current.direction === "NO_WATCH") {
        continue;
      }

      if (current.status === "IN_ZONE") {
        nextAlerts.push({
          id: `${item.symbol}-${current.direction}-IN_ZONE-${Date.now()}`,
          symbol: item.symbol,
          direction: current.direction,
          status: "IN_ZONE",
          price: item.price,
          timestamp: Date.now(),
          message: `${item.symbol} entered ${current.direction === "WATCH_LONG" ? "long" : "short"} watch zone`,
        });
      }

      if (current.status === "CONFIRMED") {
        nextAlerts.push({
          id: `${item.symbol}-${current.direction}-CONFIRMED-${Date.now()}`,
          symbol: item.symbol,
          direction: current.direction,
          status: "CONFIRMED",
          price: item.price,
          timestamp: Date.now(),
          message: `${item.symbol} watch trigger confirmed`,
        });
      }

      if (current.status === "INVALIDATED") {
        nextAlerts.push({
          id: `${item.symbol}-${current.direction}-INVALIDATED-${Date.now()}`,
          symbol: item.symbol,
          direction: current.direction,
          status: "INVALIDATED",
          price: item.price,
          timestamp: Date.now(),
          message: `${item.symbol} watch setup invalidated`,
        });
      }
    }

    watchSnapshotRef.current = nextSnapshot;

    if (nextAlerts.length > 0) {
      setWatchAlerts((previous) => [...nextAlerts.reverse(), ...previous].slice(0, 12));
    }
  }, [signals]);

  const visibleSignals = useMemo(() => {
    const query = tokenQuery.trim().toUpperCase();
    const filtered = query
      ? signals.filter((item) => item.symbol.includes(query) || item.displayName.toUpperCase().includes(query))
      : signals;

    const sorted = [...filtered];
    const directionFactor = sortDirection === "asc" ? 1 : -1;
    sorted.sort((left, right) => {
      switch (sortBy) {
        case "marketCap": {
          const leftCap = left.marketCapUsd;
          const rightCap = right.marketCapUsd;
          if (leftCap == null && rightCap == null) return left.symbol.localeCompare(right.symbol);
          if (leftCap == null) return 1;
          if (rightCap == null) return -1;
          return (leftCap - rightCap) * directionFactor;
        }
        case "score":
          return (left.score - right.score) * directionFactor;
        case "volume24h":
          return (left.volume24h - right.volume24h) * directionFactor;
        case "price":
          return (left.price - right.price) * directionFactor;
        default:
          return 0;
      }
    });

    return sorted;
  }, [signals, sortBy, sortDirection, tokenQuery]);

  const evaluatedSignals = useMemo(
    () => visibleSignals.map((item) => ({ item, profile: evaluateSignalForProfile(item, effectiveProfile) })),
    [effectiveProfile, visibleSignals],
  );

  const summary = useMemo(() => {
    let ready = 0;
    let caution = 0;
    let blocked = 0;

    for (const { profile } of evaluatedSignals) {
      if (profile.decision === "BUY" || profile.decision === "SELL" || profile.decision === "HOLD") ready += 1;
      else if (profile.decision === "WAIT") caution += 1;
      else blocked += 1;
    }

    return {
      total: evaluatedSignals.length,
      READY: ready,
      CAUTION: caution,
      BLOCKED: blocked,
      BUILDING: 0,
    };
  }, [evaluatedSignals]);

  const forecastMetrics = useMemo(() => {
    const bullish = signals.filter((item) => item.summary.includes("upside")).length;
    const bearish = signals.filter((item) => item.summary.includes("downside")).length;
    const neutral = Math.max(0, signals.length - bullish - bearish);
    const total = Math.max(1, bullish + bearish + neutral);

    return {
      bullishPct: (bullish / total) * 100,
      bearishPct: (bearish / total) * 100,
      neutralPct: (neutral / total) * 100,
      confidence: Math.min(95, Math.max(40, (summary.READY / Math.max(1, signals.length)) * 100 + 35)),
      minRange: signals.length ? Math.min(...signals.map((item) => item.price)) : 0,
      maxRange: signals.length ? Math.max(...signals.map((item) => item.price)) : 0,
    };
  }, [signals, summary.READY]);

  const actionable = useMemo(() => visibleSignals.filter((item) => item.state === "READY" || item.state === "CAUTION").slice(0, 8), [visibleSignals]);

  const topOpportunities = useMemo(() => {
    return [...evaluatedSignals]
      .filter(({ profile }) => profile.decision !== "AVOID")
      .sort((left, right) => {
        const statePriority = SIGNAL_STATE_PRIORITY[left.profile.signalState] - SIGNAL_STATE_PRIORITY[right.profile.signalState];
        if (statePriority !== 0) return statePriority;
        return right.profile.confidence - left.profile.confidence;
      })
      .slice(0, 3);
  }, [evaluatedSignals]);

  const hasActiveOpportunity = useMemo(
    () => topOpportunities.some(({ profile }) => profile.signalState === "ACTIVE"),
    [topOpportunities],
  );

  const displayedSignals = useMemo(() => {
    if (isGuestPreview) {
      return visibleSignals.slice(0, 3);
    }

    if (entitlements.maxVisibleSignals == null) {
      return visibleSignals;
    }

    return visibleSignals.slice(0, entitlements.maxVisibleSignals);
  }, [entitlements.maxVisibleSignals, isGuestPreview, visibleSignals]);

  const guestLockedPreview = useMemo(() => {
    if (!isGuestPreview) {
      return [] as SignalItem[];
    }

    return visibleSignals.slice(3, Math.min(8, visibleSignals.length));
  }, [isGuestPreview, visibleSignals]);

  const hiddenSignalCount = Math.max(0, visibleSignals.length - displayedSignals.length);
  const visibleTopOpportunities = topOpportunities.slice(0, entitlements.visibleTopOpportunityCount);
  const lockedOpportunityCount = Math.max(0, topOpportunities.length - visibleTopOpportunities.length);

  const marketStatusProfile = useMemo(
    () => getProfileMarketStatus(visibleSignals, effectiveProfile),
    [effectiveProfile, visibleSignals],
  );

  const marketStatus = useMemo(() => {
    if (marketStatusProfile.tone === "green") {
      return {
        title: marketStatusProfile.title,
        subtitle: marketStatusProfile.subtitle,
        shellClass: "border-[#22C55E]/35 bg-[#0F2E25]/45 shadow-[0_0_28px_rgba(34,197,94,0.18)]",
      };
    }

    if (marketStatusProfile.tone === "yellow") {
      return {
        title: marketStatusProfile.title,
        subtitle: marketStatusProfile.subtitle,
        shellClass: "border-[#F59E0B]/35 bg-[#3A2A0E]/45 shadow-[0_0_28px_rgba(245,158,11,0.16)]",
      };
    }

    return {
      title: marketStatusProfile.title,
      subtitle: marketStatusProfile.subtitle,
      shellClass: "border-[#EF4444]/35 bg-[#3F1218]/40 shadow-[0_0_28px_rgba(239,68,68,0.15)]",
    };
  }, [marketStatusProfile]);

  const showTokenLoading = !hasSeenPayload && wsStatus !== "Error";
  const wsAgeSeconds = lastWsMessageAt ? Math.max(0, Math.floor((Date.now() - lastWsMessageAt) / 1000)) : null;

  const onExecuteSignal = useCallback((item: SignalItem) => {
    setExecutionFocus(item);
  }, []);

  const onSimulateSignal = useCallback((item: SignalItem, options?: { forced?: boolean }) => {
    setExecutionFocus(item);
    const prefill = {
      symbol: item.symbol,
      mode: options?.forced ? "FORCED" : "STRATA",
      entry: item.suggestedEntry,
      tp: item.takeProfit,
      sl: item.stopLoss,
      side: item.takeProfit >= item.suggestedEntry ? "BUY" : "SELL",
      savedAt: Date.now()
    };
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem("strata.sim.prefill", JSON.stringify(prefill));
      } catch {
        // Ignore storage write failures and continue with URL navigation.
      }
    }
    const params = new URLSearchParams({
      symbol: item.symbol,
      mode: options?.forced ? "FORCED" : "STRATA",
      entry: String(item.suggestedEntry),
      tp: String(item.takeProfit),
      sl: String(item.stopLoss),
      side: item.takeProfit >= item.suggestedEntry ? "BUY" : "SELL"
    });
    router.push(`/simulation?${params.toString()}`);
  }, [router]);

  const onProfileChange = useCallback((nextProfile: typeof userProfile) => {
    if (entitlements.forcedProfile && nextProfile !== entitlements.forcedProfile) {
      setUpgradeIntent({
        feature: "profile_switch",
        marketLabel: "Crypto",
        context: `${nextProfile.replace(/_/g, " ")} mode is Pro`,
      });
      return;
    }

    setProfile(nextProfile);
  }, [entitlements.forcedProfile, setProfile, userProfile]);

  useEffect(() => {
    let cancelled = false;

    const loadAdvisorHistory = async (): Promise<void> => {
      const token = (typeof window !== "undefined" ? localStorage.getItem("authToken") : null) ?? sessionJwtToken;
      if (!token) {
        if (!cancelled) {
          setAdvisorHistory([]);
        }
        return;
      }

      try {
        const response = await fetch(`${getApiHttpBase()}/api/agent/trade-advice/history?limit=12`, {
          headers: {
            Authorization: `Bearer ${token}`
          },
          cache: "no-store"
        });

        if (!response.ok || cancelled) {
          return;
        }

        const payload = await response.json() as { ok?: boolean; rows?: AdvisorHistoryRow[] };
        if (!cancelled && payload.ok && Array.isArray(payload.rows)) {
          setAdvisorHistory(payload.rows);
        }
      } catch {
        // Keep local state when history load fails.
      }
    };

    void loadAdvisorHistory();

    return () => {
      cancelled = true;
    };
  }, [sessionJwtToken]);

  const requestTradeAdvice = useCallback(async () => {
    const trimmed = advisorPrompt.trim();
    if (trimmed.length < 5) {
      setAdvisorError("Add a full question so the advisor can infer symbol and direction.");
      return;
    }

    setAdvisorLoading(true);
    setAdvisorError(null);

    try {
      const token = (typeof window !== "undefined" ? localStorage.getItem("authToken") : null) ?? sessionJwtToken;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(`${getApiHttpBase()}/api/agent/trade-advice`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: trimmed,
          market: advisorMarket
        })
      });

      const payload = await response.json() as TradeAdviceResponse;
      if (!response.ok || !payload.ok) {
        const message = payload.error ?? payload.unresolved ?? payload.reply ?? "Advisor request failed";
        setAdvisorResponse(null);
        setAdvisorError(message);
        return;
      }

      setAdvisorResponse(payload);
      setAdvisorHistory((previous) => {
        if (payload.saved) {
          return [payload.saved, ...previous.filter((item) => item.id !== payload.saved?.id)].slice(0, 12);
        }

        return [
          {
            id: `local-${Date.now()}`,
            prompt: trimmed,
            reply: payload.reply,
            symbol: payload.advice?.symbol ?? null,
            side: payload.advice?.side ?? null,
            market: payload.advice?.market ?? null,
            action: payload.advice?.action ?? null,
            confidence: payload.advice?.confidence ?? null,
            createdAt: new Date().toISOString()
          },
          ...previous
        ].slice(0, 12);
      });
    } catch (error) {
      setAdvisorResponse(null);
      setAdvisorError(error instanceof Error ? error.message : "Advisor request failed");
    } finally {
      setAdvisorLoading(false);
    }
  }, [advisorMarket, advisorPrompt, sessionJwtToken]);

  return (
    <main className="mx-auto grid w-[min(1680px,99vw)] gap-4 px-0 py-5 text-[#E6EDF3]">
      {primaryTab === "Scan" ? (
        <>
          {/* ── Market Status ── first thing users see */}
          <section className={`rounded-strata border p-5 ${marketStatus.shellClass}`}>
            <div className="flex items-center gap-2">
              <p className="text-[11px] uppercase tracking-[0.14em] text-[#AFC2D7]">Market Status</p>
              {/* Live WebSocket indicator */}
              <span className="flex items-center gap-1 text-[10px] font-medium">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    wsStatus === "Idle"
                      ? "animate-pulse bg-[#22C55E]"
                      : wsStatus === "Scanning"
                        ? "animate-pulse bg-[#F59E0B]"
                        : "bg-[#EF4444]"
                  }`}
                />
                <span className={wsStatus === "Error" ? "text-[#EF4444]" : "text-[#6B859E]"}>
                  {wsStatus === "Idle" ? "Live" : wsStatus === "Scanning" ? "Connecting…" : "Disconnected"}
                </span>
                {wsAgeSeconds != null ? (
                  <span className="text-[#6B859E]">{wsAgeSeconds}s ago</span>
                ) : null}
                {wsMessageCount > 0 ? (
                  <span className="text-[#6B859E]">{wsMessageCount} updates</span>
                ) : null}
              </span>
            </div>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-[#E6EDF3]">
              {marketStatus.title === "Active Opportunities" ? "✅" : marketStatus.title === "Mixed Market" ? "⚠️" : "🚫"} {marketStatus.title}
            </h2>
            <p className="mt-1 text-sm text-[#C7D6E7]">{marketStatus.subtitle}</p>
            <p className="mt-2 text-xs text-[#9FB3C8]">
              {marketStatusProfile.viableCount === 1
                ? `Only 1 viable ${effectiveProfile.replace(/_/g, " ")} setup detected`
                : `${marketStatusProfile.viableCount} viable ${effectiveProfile.replace(/_/g, " ")} setups detected`}
            </p>
          </section>

          <section className="rounded-strata border border-[#3EC6FF]/20 bg-[#0B1220] p-4 shadow-strata-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[11px] uppercase tracking-[0.14em] text-[#7DD3FC]">AI Trade Advisor</p>
                <p className="mt-1 text-sm text-[#C7D6E7]">Ask in plain English and get a trigger, invalidation, and TP ladder instantly.</p>
              </div>
              <div className="inline-flex rounded-md border border-white/10 bg-[#0F172A] p-1 text-xs">
                <button
                  type="button"
                  onClick={() => setAdvisorMarket("spot")}
                  className={`rounded px-2 py-1 ${advisorMarket === "spot" ? "bg-[#1D4ED8] text-white" : "text-[#9FB3C8]"}`}
                >
                  Spot
                </button>
                <button
                  type="button"
                  onClick={() => setAdvisorMarket("perp")}
                  className={`rounded px-2 py-1 ${advisorMarket === "perp" ? "bg-[#1D4ED8] text-white" : "text-[#9FB3C8]"}`}
                >
                  Perp
                </button>
              </div>
            </div>

            <div className="mt-3 grid gap-2">
              <textarea
                value={advisorPrompt}
                onChange={(event) => setAdvisorPrompt(event.target.value)}
                placeholder="I'm thinking of going long ETH right now, when should I enter?"
                rows={2}
                className="w-full rounded-md border border-white/15 bg-[#0F172A] px-3 py-2 text-sm text-[#E6EDF3] outline-none ring-0 placeholder:text-[#6B859E] focus:border-[#3EC6FF]/70"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={requestTradeAdvice}
                  disabled={advisorLoading}
                  className="rounded-md border border-[#3EC6FF]/45 bg-[#082A3A] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#7DD3FC] transition hover:border-[#3EC6FF]/80 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {advisorLoading ? "Analyzing..." : "Get Advice"}
                </button>
                <button
                  type="button"
                  onClick={() => setAdvisorPrompt("I'm thinking of going short ETH right now, where is the invalidation and TP?")}
                  className="rounded-md border border-white/15 bg-[#0F172A] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#9FB3C8] transition hover:border-white/30"
                >
                  Short ETH Example
                </button>
              </div>
            </div>

            {advisorError ? (
              <p className="mt-3 rounded-md border border-[#EF4444]/35 bg-[#3F1218]/35 px-3 py-2 text-xs text-[#FCA5A5]">{advisorError}</p>
            ) : null}

            {advisorResponse?.advice ? (
              <div className="mt-3 rounded-md border border-white/10 bg-[#0F172A]/70 p-3">
                <p className="text-sm font-semibold text-[#E6EDF3]">{advisorResponse.reply}</p>
                <div className="mt-2 grid gap-2 text-xs text-[#C7D6E7] md:grid-cols-2">
                  <p><span className="text-[#9FB3C8]">Symbol:</span> {advisorResponse.advice.symbol} ({advisorResponse.advice.market})</p>
                  <p><span className="text-[#9FB3C8]">Direction:</span> {advisorResponse.advice.side}</p>
                  <p><span className="text-[#9FB3C8]">Action:</span> {advisorResponse.advice.action}</p>
                  <p><span className="text-[#9FB3C8]">Execution TF:</span> {advisorResponse.advice.entryTimeframe}</p>
                  <p className="md:col-span-2"><span className="text-[#9FB3C8]">Trigger:</span> {advisorResponse.advice.trigger}</p>
                  <p className="md:col-span-2"><span className="text-[#9FB3C8]">Invalidation:</span> {advisorResponse.advice.invalidation}</p>
                  <p className="md:col-span-2"><span className="text-[#9FB3C8]">TP ladder:</span> {advisorResponse.advice.takeProfits.join(" / ")}</p>
                </div>
              </div>
            ) : null}

            {advisorHistory.length > 0 ? (
              <div className="mt-3 rounded-md border border-white/10 bg-[#0F172A]/60 p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-[#9FB3C8]">Recent Advice</p>
                <div className="mt-2 grid gap-2">
                  {advisorHistory.map((item, index) => (
                    <div key={`${item.id}-${index}`} className="rounded-md border border-white/10 bg-[#0B1220] px-3 py-2">
                      <p className="text-[11px] text-[#9FB3C8]">{new Date(item.createdAt).toLocaleTimeString()} • {item.prompt}</p>
                      <p className="mt-1 text-xs text-[#E6EDF3]">{item.reply}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          {watchAlerts.length > 0 ? (
            <section className="rounded-strata border border-[#F59E0B]/25 bg-[#3A2A0E]/25 p-4 shadow-strata-card">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] uppercase tracking-[0.14em] text-[#FCD34D]">Watch Alerts</p>
                <button
                  type="button"
                  onClick={() => setWatchAlerts([])}
                  className="rounded-md border border-white/15 bg-[#0F172A]/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#C7D6E7] transition hover:border-white/30"
                >
                  Clear
                </button>
              </div>

              <div className="mt-3 grid gap-2">
                {watchAlerts.slice(0, 4).map((alert) => (
                  <div key={alert.id} className="rounded-md border border-white/10 bg-[#0F172A]/75 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-[#E6EDF3]">{alert.message}</p>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold tracking-[0.08em] ${
                          alert.status === "CONFIRMED"
                            ? "bg-[#0F2E25] text-[#86EFAC]"
                            : alert.status === "INVALIDATED"
                              ? "bg-[#3F1218] text-[#FCA5A5]"
                              : "bg-[#10243C] text-[#93C5FD]"
                        }`}
                      >
                        {alert.status}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-[#9FB3C8]">
                      {alert.direction === "WATCH_LONG" ? "Long" : "Short"} watch • ${alert.price.toFixed(4)} • {new Date(alert.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* ── Top Opportunities ── immediately below market status */}
          <section className="rounded-strata border border-white/10 bg-[#0F172A] p-4 shadow-strata-card">
            <div className="mb-3 flex items-center justify-between gap-3">
              {topOpportunities.length > 0 && hasActiveOpportunity ? (
                <h3 className="text-base font-bold text-[#86EFAC]">✅ TRADE SETUPS AVAILABLE</h3>
              ) : (
                <h3 className="text-base font-bold text-[#E6EDF3]">Top Opportunities</h3>
              )}
            </div>

            {topOpportunities.length === 0 ? (
              <TopOpportunityEmptyState />
            ) : !hasActiveOpportunity ? (
              <div className="mb-3"><NoActiveTradesState /></div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visibleTopOpportunities.map(({ item, profile }) => {
                const confidence = profile.confidence;
                const direction = getDirectionLabel(item);
                const confidenceLabel = confidenceBand(confidence);

                return (
                  <TopOpportunityCard
                    key={`${item.symbol}-opportunity`}
                    symbol={item.symbol}
                    direction={direction}
                    actionLabel={profile.opportunityLabel}
                    signalState={profile.signalState}
                    confidence={confidence}
                    confidenceBand={confidenceLabel}
                    reason={profile.reasons[0] ?? opportunityReason(item)}
                    triggerCondition={profile.triggerCondition}
                    progressGradientClass="from-[#3EC6FF] to-[#2F7BFF]"
                  />
                );
              })}
              {entitlements.isFreeTier && lockedOpportunityCount > 0 ? (
                <LockedOpportunityTeaserCard
                  hiddenCount={lockedOpportunityCount}
                  onUnlock={() => setUpgradeIntent({ feature: "top_opportunities", marketLabel: "Crypto" })}
                />
              ) : null}
            </div>
          </section>

          {/* ── Compact control bar: Mode + Risk dropdowns ── */}
          <CompactProfileBar
            activeProfile={effectiveProfile}
            activeRiskLevel={riskLevel}
            onProfileChange={onProfileChange}
            onRiskLevelChange={setRiskLevel}
            lockedProfile={entitlements.forcedProfile}
            onLockedProfileAttempt={(profile) => {
              setUpgradeIntent({
                feature: "profile_switch",
                marketLabel: "Crypto",
                context: `${profile.replace(/_/g, " ")} mode is Pro`,
              });
            }}
          />

          <AccessValueBanner
            entitlements={entitlements}
            hiddenSignalCount={hiddenSignalCount}
            lockedOpportunityCount={lockedOpportunityCount}
            marketLabel="Crypto"
            accessError={accessError}
            onUpgradeClick={setUpgradeIntent}
          />

          <ScanControlBar
            tokenQuery={tokenQuery}
            sortBy={sortBy}
            sortDirection={sortDirection}
            helperText={getTimeframeAnalysisHelperText("CRYPTO")}
            onTokenQueryChange={setTokenQuery}
            onSortByChange={setSortBy}
            onSortDirectionChange={setSortDirection}
          />

          {isGuestPreview ? (
            <section className="rounded-strata border border-[#F59E0B]/30 bg-[#3A2A0E]/40 p-4 shadow-strata-card">
              <p className="text-xs uppercase tracking-[0.12em] text-[#FCD34D]">Guest Preview</p>
              <p className="mt-1 text-sm text-[#FDE7C7]">
                You are viewing 3 live tokens. Sign in to unlock full market depth, full filters, and complete setup detail.
              </p>
            </section>
          ) : null}

          {showTokenLoading ? (
            <section className="rounded-strata border border-[#3B82F6]/30 bg-[#0B1220] p-4 shadow-strata-card">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#22D3EE]" />
                <p className="text-sm font-semibold text-[#E6EDF3]">Loading live tokens...</p>
              </div>
              <p className="mt-1 text-xs text-[#9FB3C8]">
                Syncing websocket state and first token snapshot. This usually takes a few seconds.
              </p>
              <div className="mt-3 h-2 w-full animate-pulse rounded-full bg-[#1F2A3D]" />
            </section>
          ) : null}

          {/* ── Stats summary bar ── */}
          <section className="grid grid-cols-2 gap-3 rounded-strata border border-white/10 bg-[#0F172A] p-4 shadow-strata-card md:grid-cols-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Total Scanned</p>
              <p className="mt-1 text-xl font-semibold">{entitlements.isFreeTier ? displayedSignals.length : summary.total}</p>
              {entitlements.isFreeTier ? (
                <p className="mt-1 text-xs text-[#FCD34D]">{hiddenSignalCount > 0 ? `${hiddenSignalCount} more visible in Pro` : "Focused Free view"}</p>
              ) : null}
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Ready</p>
              <div className="mt-1"><SignalStateBadge state="READY" /></div>
              <p className="mt-1 text-lg font-semibold text-[#22C55E]">{summary.READY}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Caution</p>
              <div className="mt-1"><SignalStateBadge state="CAUTION" /></div>
              <p className="mt-1 text-lg font-semibold text-[#F59E0B]">{summary.CAUTION}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Blocked</p>
              <div className="mt-1"><SignalStateBadge state="BLOCKED" /></div>
              <p className="mt-1 text-lg font-semibold text-[#EF4444]">{summary.BLOCKED}</p>
            </div>
          </section>

          <section className="grid gap-3">
            {displayedSignals.map((item) => (
              <SignalCard
                key={item.symbol}
                item={item}
                onExecute={onExecuteSignal}
                onSimulate={onSimulateSignal}
                userProfile={effectiveProfile}
                accessEntitlements={entitlements}
                onUpgradeRequest={setUpgradeIntent}
              />
            ))}

            {isGuestPreview && guestLockedPreview.length > 0 ? (
              guestLockedPreview.map((item) => (
                <article
                  key={`${item.symbol}-guest-locked`}
                  className="relative overflow-hidden rounded-strata border border-white/10 bg-[#0F172A]"
                >
                  <div className="pointer-events-none select-none p-4 blur-[2px] opacity-60">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-[#E6EDF3]">{item.symbol}</p>
                      <p className="text-xs text-[#9FB3C8]">Locked</p>
                    </div>
                    <p className="mt-2 text-xs text-[#9FB3C8]">Additional setup details are available after sign in.</p>
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center bg-[#020617]/45">
                    <button
                      type="button"
                      onClick={() => router.push("/login")}
                      className="rounded-lg border border-[#FCD34D]/45 bg-[#451A03]/80 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#FDE68A] transition hover:bg-[#5B2107]"
                    >
                      Sign In To Unlock
                    </button>
                  </div>
                </article>
              ))
            ) : null}
          </section>

          <UpgradeModal
            open={Boolean(upgradeIntent)}
            onClose={() => setUpgradeIntent(null)}
            entitlements={entitlements}
            intent={upgradeIntent}
          />
        </>
      ) : null}

      {primaryTab === "Forecast" ? (
        <section className="grid gap-4 rounded-strata border border-white/10 bg-[#0F172A] p-5 shadow-strata-card">
          <header>
            <p className="text-xs uppercase tracking-[0.14em] text-[#6B859E]">Forecast Engine</p>
            <h2 className="mt-1 text-xl font-semibold">Bias Probability & Range Projection</h2>
            <p className="mt-1 text-sm text-[#9FB3C8]">Neutral analytical distribution based on current multi-timeframe structure.</p>
          </header>

          <div className="grid gap-3 md:grid-cols-3">
            {[
              { label: "Bullish", value: forecastMetrics.bullishPct, color: "from-[#22C55E] to-[#3EC6FF]" },
              { label: "Bearish", value: forecastMetrics.bearishPct, color: "from-[#EF4444] to-[#F59E0B]" },
              { label: "Neutral", value: forecastMetrics.neutralPct, color: "from-[#6B859E] to-[#9FB3C8]" },
            ].map((bar) => (
              <div key={bar.label} className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">{bar.label}</p>
                  <p className="text-sm font-semibold">{bar.value.toFixed(1)}%</p>
                </div>
                <div className="mt-2 h-2 rounded-full bg-white/10">
                  <div className={`h-2 rounded-full bg-gradient-to-r ${bar.color}`} style={{ width: `${bar.value}%` }} />
                </div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Price Range</p>
              <p className="mt-1 text-sm">${forecastMetrics.minRange.toFixed(4)} {"->"} ${forecastMetrics.maxRange.toFixed(4)}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Confidence</p>
              <p className="mt-1 text-sm">{forecastMetrics.confidence.toFixed(1)}%</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Universe</p>
              <p className="mt-1 text-sm">{summary.total} assets sampled</p>
            </div>
          </div>

          {(() => {
            const interpretation = getForecastInterpretation(forecastMetrics.bullishPct, forecastMetrics.bearishPct);
            const toneClass = interpretation.tone === "green"
              ? "border-[#22C55E]/35 bg-[#0F2E25]/45"
              : interpretation.tone === "red"
                ? "border-[#EF4444]/35 bg-[#3F1218]/40"
                : "border-[#F59E0B]/35 bg-[#3A2A0E]/45";
            return (
              <div className={`rounded-lg border p-4 ${toneClass}`}>
                <p className="text-[11px] uppercase tracking-[0.14em] text-[#AFC2D7]">What To Do With This</p>
                <p className="mt-1 text-sm font-semibold text-[#E6EDF3]">👉 Interpretation: {interpretation.interpretation}</p>
                <p className="mt-1 text-sm font-semibold text-[#E6EDF3]">👉 Strategy: {interpretation.strategy}</p>
              </div>
            );
          })()}
        </section>
      ) : null}

      {primaryTab === "Execute" ? (
        <section className="grid gap-4 rounded-strata border border-white/10 bg-[#0F172A] p-5 shadow-strata-card">
          <header>
            <p className="text-xs uppercase tracking-[0.14em] text-[#6B859E]">Execution Panel</p>
            <h2 className="mt-1 text-xl font-semibold">Controlled Entry Queue ({tradeMode === "live" ? "Live" : "Dry Run"})</h2>
          </header>

          {executionFocus && executionFocus.state === "BLOCKED" ? (
            <div className="rounded-lg border border-[#EF4444]/40 bg-[#EF4444]/10 p-3 text-sm text-[#FCA5A5]">
              Alignment is BLOCKED for {executionFocus.symbol}. Execution is paused until structure resolves.
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2">
            {(executionFocus ? [executionFocus] : actionable).map((item) => (
              <div key={item.symbol} className="rounded-lg border border-white/10 bg-[#0B1220] p-4">
                <div className="flex items-center justify-between">
                  <p className="text-base font-semibold">{item.symbol}</p>
                  <SignalStateBadge state={item.state} />
                </div>
                <p className="mt-2 text-sm text-[#9FB3C8]">Suggested entry ${item.suggestedEntry.toFixed(4)}</p>
                <p className="text-sm text-[#9FB3C8]">HTF confirmation: {item.htfConfirmed ? "Confirmed" : "Conflicted"}</p>
                <p className="text-sm text-[#9FB3C8]">Stop ${item.stopLoss.toFixed(4)} / Exit ${item.takeProfit.toFixed(4)}</p>
                <button
                  type="button"
                  onClick={() => setExecutionFocus(item)}
                  className="mt-3 rounded-md border border-white/15 px-3 py-1.5 text-xs uppercase tracking-[0.08em] text-[#9FB3C8]"
                >
                  Focus Asset
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {primaryTab === "Simulate" ? (
        <section className="grid gap-4 rounded-strata border border-white/10 bg-[#0F172A] p-5 shadow-strata-card">
          <header>
            <p className="text-xs uppercase tracking-[0.14em] text-[#6B859E]">Simulation</p>
            <h2 className="mt-1 text-xl font-semibold">Strategy Stress Snapshot</h2>
          </header>

          <div className="grid gap-3 md:grid-cols-5">
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Total Trades</p>
              <p className="mt-1 text-lg font-semibold">{testSimStats?.stats?.totalTrades ?? 0}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Active</p>
              <p className="mt-1 text-lg font-semibold">{testSimStats?.stats?.activeTrades ?? 0}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Win Rate</p>
              <p className="mt-1 text-lg font-semibold">{Number(testSimStats?.stats?.winRate ?? 0).toFixed(1)}%</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Realized PnL</p>
              <p className="mt-1 text-lg font-semibold">${Number(testSimStats?.stats?.totalPnlUsd ?? 0).toFixed(2)}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Unrealized</p>
              <p className="mt-1 text-lg font-semibold">${Number(testSimStats?.stats?.unrealizedPnlUsd ?? 0).toFixed(2)}</p>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
