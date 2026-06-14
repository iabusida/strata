"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

type TimeframeData = {
  rsi: number;
  macdHist: number;
  stochK: number;
  stochD: number;
  prevStochK: number;
  prevStochD: number;
  trend: {
    direction: "UP" | "DOWN" | "MIXED";
    arrow: "▲" | "▼" | "•";
    overbought: boolean;
    oversold: boolean;
  };
};

type CandlestickPatternName =
  | "BULLISH_ENGULFING"
  | "BEARISH_ENGULFING"
  | "HAMMER"
  | "SHOOTING_STAR"
  | "MORNING_STAR"
  | "EVENING_STAR";

type CandlestickSignal = {
  bullishPatterns: CandlestickPatternName[];
  bearishPatterns: CandlestickPatternName[];
  bullishScore: number;
  bearishScore: number;
};

type RsiRow = {
  symbol: string;
  market: "perp" | "spot";
  entryTiming: "EARLY" | "MID" | "LATE" | null;
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
    trendlineBreakout: boolean;
    trendlineBreakdown: boolean;
    volatilityPercentile: number;
    liquidityPercentile: number;
    regime: string;
    structureState: string;
    ema20: number;
    emaSlope: number;
    atr: number;
    candlestick?: CandlestickSignal;
  };
  status: "OVERBOUGHT" | "OVERSOLD" | "NEUTRAL";
  signalCategory: "STRONG" | "CONTINUATION" | "REVERSAL" | "SCORE_BASED";
  signal: {
    type:
      | "STRONG SHORT"
      | "STRONG LONG"
      | "CONTINUATION SHORT"
      | "CONTINUATION LONG"
      | "REVERSAL SHORT"
      | "REVERSAL LONG"
      | "NO SIGNAL"
      | "NO SIGNAL (NEAR SUPPORT FLOOR)"
      | "NO SIGNAL (NEAR RESISTANCE)";
    classes: string;
  };
  confluence: {
    score: number;
    bias: "SHORT" | "LONG";
    maxScore: number;
  };
  maxLeverage?: number;
  levels: {
    localSupport: number;
    localResistance: number;
    nearSupportFloor: boolean;
    nearResistance: boolean;
    supportDistancePct: number;
    resistanceDistancePct: number;
  };
  timeframes: {
    macro: TimeframeData;
    intermediary: TimeframeData;
    microTrigger: TimeframeData;
  };
};

type ApiResponse = {
  analyzedAt: string;
  results: RsiRow[];
  skipped: Array<{ symbol: string; reason: string; details?: string }>;
  meta?: {
    onlySignals: boolean;
    filteredOutNoSignal: number;
  };
  signalCounts: {
    strongShort: number;
    strongLong: number;
    continuationShort: number;
    continuationLong: number;
    reversalShort: number;
    reversalLong: number;
    noSignal: number;
  };
  candlestickStats?: {
    totalRows: number;
    rowsWithPatterns: number;
    bullishRows: number;
    bearishRows: number;
    alignedWithDirectionalSignal: number;
    byPattern: Record<string, {
      hits: number;
      bullishHits: number;
      bearishHits: number;
      alignedHits: number;
    }>;
  };
  service?: {
    mode: "background";
    startedAt: string;
    lastSignalScanAt: string;
    lastTradeRefreshAt: string;
    signalIntervalMs: number;
    tradeIntervalMs: number;
    universeSize: number;
    chunkSize: number;
    chunkIndex: number;
  };
  tradeSimulation?: {
    stats: {
      totalTrades: number;
      activeTrades: number;
      wins: number;
      losses: number;
      winRate: number;
      avgMinutesToWin: number;
      avgMinutesToLoss: number;
      totalSimulatedPnl: number;
      totalSimulatedPnlUsd: number;
      totalPnlUsd: number;
      totalPnlPct: number;
      unrealizedPnlUsd: number;
      equityUsd: number;
      accountBalanceUsd: number;
      initialCapitalUsd: number;
      stakePerTradeUsd: number;
      estimatedBalanceUsd: number;
      maxActiveTrades: number;
      leverage: number;
      targetReturnPct: number;
      stopReturnPct: number;
      sentimentShiftClosedTrades?: number;
      closeReasonCounts?: Record<string, number>;
    };
    activeTrades: Array<{
      id: string;
      token: string;
      direction: "LONG" | "SHORT";
      signalType: string;
      signalCategory: "STRONG" | "CONTINUATION" | "REVERSAL" | "SCORE_BASED";
      entryType?: "STRONG" | "CONTINUATION" | "REVERSAL" | "SCORE_BASED";
      entryTiming?: "EARLY" | "MID" | "LATE";
      entryScore?: number;
      riskPctUsed?: number;
      assetType?: "LARGE_CAP" | "ALT";
      takeProfitPct?: number;
      marketCondition?: "TRENDING" | "RANGING";
      stakeUsd: number;
      stakeSource?: string;
      entryPrice: number;
      currentPrice: number;
      tpPrice: number;
      slPrice: number;
      leverage: number;
      status: "OPEN" | "WIN" | "LOSS";
      openTime: string;
      closeTime?: string;
      result?: number;
      resultUsd?: number;
      currentPnlPct: number;
      currentPnlUsd: number;
      positionValueUsd: number;
      markPrice?: number;
      roePct?: number;
      sizeBaseUnits?: number;
      marginUsedUsd?: number;
      fundingRate?: number;
      fundingAccruedUsd?: number;
      estimatedLiqPrice?: number;
      openInterestUsd?: number;
      distanceToTP: number;
      distanceToSL: number;
      maxDrawdown?: number;
      timeToClose?: number;
    }>;
    recentClosedTrades: Array<{
      id: string;
      token: string;
      direction: "LONG" | "SHORT";
      signalType?: string;
      signalCategory?: "STRONG" | "CONTINUATION" | "REVERSAL" | "SCORE_BASED";
      entryType?: "STRONG" | "CONTINUATION" | "REVERSAL" | "SCORE_BASED";
      entryTiming?: "EARLY" | "MID" | "LATE";
      entryScore?: number;
      riskPctUsed?: number;
      assetType?: "LARGE_CAP" | "ALT";
      takeProfitPct?: number;
      marketCondition?: "TRENDING" | "RANGING";
      stakeUsd: number;
      stakeSource?: string;
      entryPrice: number;
      currentPrice: number;
      tpPrice: number;
      slPrice: number;
      leverage: number;
      status: "OPEN" | "WIN" | "LOSS";
      openTime: string;
      closeTime?: string;
      closeReason?: string;
      result?: number;
      resultUsd?: number;
      maxDrawdown?: number;
      timeToClose?: number;
    }>;
  };
};

type TradeSimulationSnapshot = NonNullable<ApiResponse["tradeSimulation"]>;

type TradeRejectionRecord = {
  symbol: string;
  signal?: string;
  score?: number;
  direction?: "LONG" | "SHORT";
  reason: string;
  details?: Record<string, unknown>;
  rejectedAt: string;
};

type TradeRejectionResponse = {
  count: number;
  rejections: TradeRejectionRecord[];
};

type MomentumCandidate = {
  symbol: string;
  score: number;
  move24hPct: number;
  move48hPct: number;
  vol24hVsPrev24h: number;
  dailyVolVs20dAvg: number;
  dailyRsi14: number | null;
  dailyStochRsiK: number | null;
  dailyStochRsiD: number | null;
  weeklyStochRsiK: number | null;
  weeklyStochRsiD: number | null;
  distanceFrom20dHighPct: number | null;
  broke20dHigh: boolean;
};

type MomentumSnapshot = {
  asOf: string;
  universeSize: number;
  candidatesStrict: number;
  candidatesNear: number;
  strictTop: MomentumCandidate[];
  nearTop: MomentumCandidate[];
  dataFreshness: {
    latestH1: string | null;
    latestD1: string | null;
  };
  liveAccount?: {
    stats: {
      totalTrades: number;
      activeTrades: number;
      wins: number;
      losses: number;
      winRate: number;
      avgMinutesToWin: number;
      avgMinutesToLoss: number;
      totalSimulatedPnl: number;
      totalSimulatedPnlUsd: number;
      totalPnlUsd: number;
      totalPnlPct: number;
      unrealizedPnlUsd: number;
      equityUsd: number;
      accountBalanceUsd: number;
      initialCapitalUsd: number;
      stakePerTradeUsd: number;
      estimatedBalanceUsd: number;
      maxActiveTrades: number;
      leverage: number;
      targetReturnPct: number;
      stopReturnPct: number;
      sentimentShiftClosedTrades?: number;
      closeReasonCounts?: Record<string, number>;
    };
    activeTrades: Array<any>;
    recentClosedTrades: Array<any>;
  };
};

type DiagnosticStatus = "PASS" | "WARN" | "FAIL" | "NOT_EVALUATED" | "UNKNOWN";

type DiagnosticCheck = {
  label: string;
  value: string;
  status: DiagnosticStatus;
  note?: string;
};

type EngineGateId =
  | "RUNTIME_GUARDS"
  | "SCORE_OR_SIGNAL"
  | "STRUCTURE_MICRO"
  | "DIRECTIONAL_SIGNAL"
  | "REGIME_RULES"
  | "VOLATILITY"
  | "LIQUIDITY"
  | "EXPECTED_VALUE"
  | "ENTRY_TIMING"
  | "REVERSAL_PHASE"
  | "UNRESOLVED_REVERSAL"
  | "REVERSAL_VOLATILITY"
  | "SYMBOL_INSTABILITY_COOLDOWN"
  | "COUNTER_TREND_EARLY"
  | "RISK_REWARD"
  | "TP_FEASIBILITY"
  | "FIB_TOUCH_MEMORY"
  | "ORDER_BOOK_AVAILABLE"
  | "ORDER_BOOK_EXECUTION"
  | "SLIPPAGE"
  | "EXECUTION_TP_VIABILITY";

const ENGINE_GATE_ORDER: EngineGateId[] = [
  "RUNTIME_GUARDS",
  "SCORE_OR_SIGNAL",
  "STRUCTURE_MICRO",
  "DIRECTIONAL_SIGNAL",
  "REGIME_RULES",
  "VOLATILITY",
  "LIQUIDITY",
  "EXPECTED_VALUE",
  "ENTRY_TIMING",
  "REVERSAL_PHASE",
  "UNRESOLVED_REVERSAL",
  "REVERSAL_VOLATILITY",
  "SYMBOL_INSTABILITY_COOLDOWN",
  "COUNTER_TREND_EARLY",
  "RISK_REWARD",
  "TP_FEASIBILITY",
  "FIB_TOUCH_MEMORY",
  "ORDER_BOOK_AVAILABLE",
  "ORDER_BOOK_EXECUTION",
  "SLIPPAGE",
  "EXECUTION_TP_VIABILITY"
];

const REJECTION_TO_GATE: Record<string, EngineGateId> = {
  "session block": "RUNTIME_GUARDS",
  "global trade throttle": "RUNTIME_GUARDS",
  "global cooldown active": "RUNTIME_GUARDS",
  "rolling drawdown circuit active": "RUNTIME_GUARDS",
  "daily drawdown limit reached": "RUNTIME_GUARDS",
  "global kill switch active": "RUNTIME_GUARDS",
  "concurrent risk cap": "RUNTIME_GUARDS",
  "max active trades reached": "RUNTIME_GUARDS",
  "duplicate active trade": "RUNTIME_GUARDS",
  "duplicate window cooldown": "RUNTIME_GUARDS",
  "flip cooldown active": "RUNTIME_GUARDS",
  "cluster exposure cap": "RUNTIME_GUARDS",
  "directional cluster exposure cap": "RUNTIME_GUARDS",
  "invalid price data": "RUNTIME_GUARDS",
  "invalid position size": "RUNTIME_GUARDS",
  "insufficient balance for fees": "RUNTIME_GUARDS",
  "structure/micro alignment": "STRUCTURE_MICRO",
  "no directional signal": "DIRECTIONAL_SIGNAL",
  "regime rules": "REGIME_RULES",
  "low volatility": "VOLATILITY",
  "low liquidity": "LIQUIDITY",
  "non-positive EV": "EXPECTED_VALUE",
  "entry timing": "ENTRY_TIMING",
  "reversal phase below minimum": "REVERSAL_PHASE",
  "unresolved reversal phase": "UNRESOLVED_REVERSAL",
  "reversal volatility cap": "REVERSAL_VOLATILITY",
  "symbol instability cooldown": "SYMBOL_INSTABILITY_COOLDOWN",
  "counter-trend requires EARLY timing": "COUNTER_TREND_EARLY",
  "RR below threshold": "RISK_REWARD",
  "order book unavailable": "ORDER_BOOK_AVAILABLE",
  "order book execution guard": "ORDER_BOOK_EXECUTION",
  "slippage protection": "SLIPPAGE",
  "execution-adjusted TP viability": "EXECUTION_TP_VIABILITY"
};

const GLOBAL_RUNTIME_REJECTION_REASONS = new Set<string>([
  "session block",
  "global trade throttle",
  "global cooldown active",
  "rolling drawdown circuit active",
  "daily drawdown limit reached",
  "global kill switch active",
  "concurrent risk cap",
  "max active trades reached",
  "duplicate active trade",
  "duplicate window cooldown",
  "flip cooldown active",
  "cluster exposure cap",
  "directional cluster exposure cap",
  "invalid price data",
  "invalid position size",
  "insufficient balance for fees"
]);

function resolveGateStatus(
  gateId: EngineGateId,
  failedGateId: EngineGateId | null,
  evaluatedPass: boolean | null
): DiagnosticStatus {
  const gateIndex = ENGINE_GATE_ORDER.indexOf(gateId);
  const failedIndex = failedGateId ? ENGINE_GATE_ORDER.indexOf(failedGateId) : -1;

  if (failedIndex >= 0) {
    if (gateIndex === failedIndex) {
      return "FAIL";
    }

    if (gateIndex > failedIndex) {
      return "NOT_EVALUATED";
    }
  }

  if (evaluatedPass == null) {
    return "UNKNOWN";
  }

  return evaluatedPass ? "PASS" : "WARN";
}

type AccessState = {
  mode: "open" | "licensed";
  plan: "FREE" | "PRO" | "ELITE";
  status: "ACTIVE" | "TRIALING" | "PAST_DUE" | "INACTIVE";
  source: "license_file" | "environment";
  requiresSubscription: boolean;
  isSubscribed: boolean;
  message: string | null;
  features: {
    dashboard: boolean;
    liveState: boolean;
    onDemandScan: boolean;
    backgroundAutomation: boolean;
    telegramAlerts: boolean;
    manualTradeControls: boolean;
  };
  limits: {
    maxScanTokens: number;
    maxActiveTrades: number;
  };
};

function isNetworkFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("failed to fetch") || message.includes("networkerror") || message.includes("load failed");
}

type PrePumpCandidate = {
  symbol: string;
  score: number;
  close: number;
  volume24h: number;
  status: "OVERBOUGHT" | "OVERSOLD" | "NEUTRAL";
  signalType: string;
  entryTiming: "EARLY" | "MID" | "LATE" | null;
  volatilityPercentile: number;
  liquidityPercentile: number;
  intermediaryRsi: number;
  emaSlope: number;
  stochDelta: number;
  details?: Record<string, unknown>;
};

type PrePumpDetectionResponse = {
  scanned: number;
  eligibleCount: number;
  candidates: PrePumpCandidate[];
  rejectionSummary: Array<{ reason: string; count: number }>;
  nearMisses: Array<{
    symbol: string;
    score: number;
    reason: string;
    details?: Record<string, unknown>;
    volume24h: number;
    signalType: string;
    volatilityPercentile: number;
    intermediaryRsi: number;
  }>;
};

type SortDirection = "asc" | "desc";
type TradeSortKey =
  | "token"
  | "marketCap"
  | "direction"
  | "size"
  | "assetType"
  | "entryType"
  | "entryTiming"
  | "tpPct"
  | "entry"
  | "mark"
  | "positionValue"
  | "roe"
  | "pnlUsd"
  | "liqPrice"
  | "margin"
  | "fundingRate"
  | "fundingPnl"
  | "distTp"
  | "distSl"
  | "stake"
  | "status"
  | "timeInTrade"
  | "openedAt";

type ResultSortKey =
  | "token"
  | "marketCap"
  | "volume24h"
  | "volatility"
  | "readiness"
  | "signal"
  | "prePump"
  | "liquidityHunt"
  | "entryTiming"
  | "score"
  | "price";

type DashboardSectionKey = "simulation" | "results";
type DashboardView = "results" | "simulation";
type SimulationBlockKey = "stats" | "reasons" | "active" | "closed";
type StatusFilter = "ALL" | "OVERBOUGHT" | "OVERSOLD";
type ImbalanceFilter = "ALL" | "LONG_DOMINANT" | "SHORT_DOMINANT";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim();

function getApiHttpBase(): string {
  if (API_BASE) {
    return API_BASE.replace(/\/+$/, "");
  }

  return "";
}

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

type CategoryFilter = "ALL" | "AI" | "DEFI" | "GAMING" | "LAYER1" | "LAYER2" | "MEME" | "RWA";

const CATEGORY_SYMBOLS: Record<Exclude<CategoryFilter, "ALL">, Set<string>> = {
  AI: new Set(["0G", "AIXBT", "ANIME", "FET", "GOAT", "GRASS", "GRIFFAIN", "HYPER", "IO", "KAITO", "LAYER", "LIT", "NIL", "PROMPT", "PROVE", "RENDER", "SOPH", "TAO", "VIRTUAL", "WLD", "ZEREBRO", "ARKM", "AI16Z"]),
  DEFI: new Set(["AAVE", "AERO", "APEX", "BANANA", "BIO", "CAKE", "COMP", "CRV", "DYDX", "EIGEN", "ENA", "ENS", "ETHFI", "FTT", "GMX", "HYPE", "JTO", "JUP", "LDO", "LINK", "MAV", "MORPHO", "MKR", "PENDLE", "PYTH", "RESOLV", "REZ", "RSR", "RUNE", "SKY", "SNX", "STABLE", "STBL", "SUSHI", "SYRUP", "TRB", "UMA", "UNI", "USUAL", "VVV", "W", "WCT", "WLFI", "ZRO", "ZORA"]),
  GAMING: new Set(["ACE", "APE", "AXS", "BEAM", "BIGTIME", "BLUR", "DOOD", "GALA", "GMT", "HMSTR", "IMX", "MANA", "MAVIA", "ME", "PENGU", "PIXEL", "PRIME", "SAND", "SUPER", "TNSR", "XAI", "YGG"]),
  LAYER1: new Set(["ADA", "ALGO", "APT", "AR", "ARK", "ATOM", "AVAX", "BCH", "BERA", "BNB", "BSV", "BTC", "CELO", "CFX", "DASH", "DOT", "ETC", "ETH", "FIL", "GAS", "HBAR", "ICP", "INJ", "INIT", "IOTA", "IP", "KAS", "LTC", "MINA", "MON", "MOVE", "NEAR", "NEO", "ORDI", "S", "SEI", "SOL", "STX", "SUI", "TON", "TRX", "VIC", "XLM", "XMR", "XRP", "ZEC", "ZETA"]),
  LAYER2: new Set(["ALT", "ARB", "AZTEC", "BLAST", "DYM", "HEMI", "LAYER", "LINEA", "MANTA", "MEGA", "MERL", "METIS", "MNT", "OP", "POL", "MATIC", "SAGA", "SCR", "STRK", "TIA", "ZEN", "ZK", "ZKS"]),
  MEME: new Set(["BABY", "BONK", "BOME", "BRETT", "CC", "CHIP", "CHILLGUY", "DOGE", "FARTCOIN", "FLOKI", "HMSTR", "MELANIA", "MEME", "MEW", "MOODENG", "NOT", "PEPE", "PEOPLE", "PNUT", "POPCAT", "PUMP", "PURR", "SHIB", "SKR", "SPX", "TRUMP", "TST", "TURBO", "USTC", "VINE", "WIF", "YZY"]),
  RWA: new Set(["ONDO", "PAXG", "POLYX", "RSR", "RIO"])
};

// Bitunix-specific overrides for ambiguous or exchange-tagged sectors.
const CATEGORY_OVERRIDES: Record<string, Exclude<CategoryFilter, "ALL">> = {
  ATU: "RWA",
  EPIC: "RWA",
  MANTARA: "RWA",
  OM: "RWA",
  ONDO: "RWA",
  PAXG: "RWA",
  PENDLE: "RWA",
  POLYX: "RWA",
  RIO: "RWA",
  RSR: "RWA",
  STBL: "RWA"
};

const CATEGORY_PRIORITY: Array<Exclude<CategoryFilter, "ALL">> = [
  "RWA",
  "AI",
  "DEFI",
  "GAMING",
  "LAYER1",
  "LAYER2",
  "MEME"
];

const TOKEN_NAMES: Record<string, string> = {
  // Layer 1
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", BNB: "BNB", XRP: "XRP",
  ADA: "Cardano", AVAX: "Avalanche", SUI: "Sui", APT: "Aptos", ATOM: "Cosmos",
  TON: "Toncoin", NEAR: "NEAR Protocol", TRX: "TRON", DOT: "Polkadot", ICP: "Internet Computer",
  FIL: "Filecoin", HBAR: "Hedera", XLM: "Stellar", ALGO: "Algorand", XMR: "Monero",
  ZEC: "Zcash", DASH: "Dash", BCH: "Bitcoin Cash", LTC: "Litecoin", ETC: "Ethereum Classic",
  BSV: "Bitcoin SV", SEI: "Sei", MINA: "Mina Protocol", IOTA: "IOTA", CFX: "Conflux",
  CELO: "Celo", NEO: "Neo", GAS: "Neo Gas", INJ: "Injective", KAS: "Kaspa",
  MON: "Monad", MOVE: "Movement Network", S: "Sonic", BERA: "Berachain", INIT: "Initia",
  ZETA: "ZetaChain", IP: "Story Protocol", AR: "Arweave", ARK: "Ark Network",
  ORDI: "Ordinals", ROSE: "Oasis Network", VIC: "Viction",
  // Layer 2
  ARB: "Arbitrum", OP: "Optimism", POL: "Polygon", MATIC: "Polygon", STRK: "Starknet",
  ZK: "ZKsync", ZKS: "ZKspace", METIS: "Metis", MANTA: "Manta Network", ZEN: "Horizen",
  BLAST: "Blast", HEMI: "Hemi", MEGA: "MegaETH", MNT: "Mantle", DYM: "Dymension",
  ALT: "AltLayer", SAGA: "Saga Protocol", SCR: "Scroll", LINEA: "Linea", AZTEC: "Aztec Network",
  STX: "Stacks", MERL: "Merlin Chain", TIA: "Celestia", LAYER: "Layer3",
  // DeFi
  AAVE: "Aave", UNI: "Uniswap", LINK: "Chainlink", MKR: "Maker", CRV: "Curve DAO",
  LDO: "Lido DAO", MORPHO: "Morpho", ENA: "Ethena", PENDLE: "Pendle", COMP: "Compound",
  SNX: "Synthetix", GMX: "GMX", DYDX: "dYdX", JUP: "Jupiter", HYPE: "Hyperliquid",
  APEX: "ApeX Protocol", UMA: "UMA", MAV: "Maverick Protocol", RESOLV: "Resolv", SYRUP: "Maple Finance",
  SUSHI: "SushiSwap", CAKE: "PancakeSwap", AERO: "Aerodrome", RUNE: "THORchain", SKY: "Sky (Maker)",
  ZRO: "LayerZero", EIGEN: "EigenLayer", ETHFI: "ether.fi", JTO: "Jito", REZ: "Renzo",
  PYTH: "Pyth Network", TRB: "Tellor", BANANA: "Banana Gun", ENS: "Ethereum Name Service",
  W: "Wormhole", USUAL: "Usual Protocol", VVV: "Venice Finance", BIO: "Bio Protocol",
  WLFI: "World Liberty", ZORA: "Zora", STBL: "Stable Jack", STABLE: "Stable Asset",
  WCT: "WalletConnect", FTT: "FTX Token",
  // AI
  FET: "Fetch.ai", RENDER: "Render", TAO: "Bittensor", WLD: "Worldcoin", ARKM: "Arkham",
  AI16Z: "ai16z", VIRTUAL: "Virtuals Protocol", KAITO: "Kaito", AIXBT: "AIXBT by Virtuals",
  IO: "io.net", GOAT: "Goatseus Maximus", GRASS: "Grass", GRIFFAIN: "Griffain",
  ZEREBRO: "Zerebro", NIL: "Nillion", PROMPT: "PromptFi", HYPER: "HyperAI",
  LIT: "Lit Protocol", SOPH: "Sophon", PROVE: "Prove", ANIME: "Animecoin",
  "0G": "0G Network",
  // Gaming
  IMX: "Immutable", GALA: "Gala", AXS: "Axie Infinity", SAND: "The Sandbox", MANA: "Decentraland",
  BEAM: "Beam", BIGTIME: "Big Time", MAVIA: "Heroes of Mavia", ACE: "Fusionist", APE: "ApeCoin",
  BLUR: "Blur", ME: "Magic Eden", PENGU: "Pudgy Penguins", DOOD: "Doodles", TNSR: "Tensor",
  XAI: "Xai", YGG: "Yield Guild Games", SUPER: "SuperVerse", GMT: "STEPN", HMSTR: "Hamster Kombat",
  // RWA
  ONDO: "Ondo Finance", POLYX: "Polymesh", PAXG: "PAX Gold", RSR: "Reserve Rights",
  // Meme
  DOGE: "Dogecoin", SHIB: "Shiba Inu", PEPE: "Pepe", BONK: "Bonk", FLOKI: "Floki",
  WIF: "dogwifhat", FARTCOIN: "Fartcoin", MEME: "Memecoin", POPCAT: "Popcat", MOODENG: "Moo Deng",
  BRETT: "Brett", PURR: "Purr", MEW: "cat in a dogs world", TURBO: "Turbo", MELANIA: "Melania Meme",
  TRUMP: "TRUMP", VINE: "Vine Coin", PNUT: "Peanut the Squirrel", NOT: "Notcoin", BOME: "Book of Meme",
  SPX: "SPX6900", PEOPLE: "ConstitutionDAO", CHILLGUY: "Chill Guy", BABY: "BabyDoge", PUMP: "Pump",
  TST: "Test Token", USTC: "Terra Classic USD", YZY: "YEEZY", CHIP: "Chip", CC: "CC", SKR: "Skirmish",
  // Stock
  TSLA: "Tesla", NVDA: "NVIDIA", AAPL: "Apple", AMZN: "Amazon", MSFT: "Microsoft",
  GOOG: "Alphabet", GOOGL: "Alphabet (Class A)", META: "Meta Platforms", NFLX: "Netflix",
  COIN: "Coinbase", BABA: "Alibaba", AMD: "AMD", INTC: "Intel", PYPL: "PayPal",
  MSTR: "MicroStrategy", NIO: "NIO", PLTR: "Palantir", SOFI: "SoFi Technologies",
  HOOD: "Robinhood", UBER: "Uber", ABNB: "Airbnb", SHOP: "Shopify", SQ: "Block",
  SPOT: "Spotify", RBLX: "Roblox",
};

const MARKET_CAP_USD: Record<string, number> = {
  BTC: 1_360_000_000_000,
  ETH: 430_000_000_000,
  XRP: 75_000_000_000,
  BNB: 95_000_000_000,
  SOL: 82_000_000_000,
  ADA: 24_000_000_000,
  DOGE: 23_000_000_000,
  TRX: 25_000_000_000,
  DOT: 11_000_000_000,
  AVAX: 15_000_000_000,
  LINK: 12_000_000_000,
  SUI: 11_000_000_000,
  TON: 18_000_000_000,
  SHIB: 10_000_000_000,
  LTC: 7_000_000_000,
  BCH: 9_000_000_000,
  UNI: 6_000_000_000,
  AAVE: 1_500_000_000,
  ARB: 2_800_000_000,
  OP: 2_600_000_000,
  NEAR: 7_000_000_000,
  INJ: 2_200_000_000,
  FIL: 3_800_000_000,
  APT: 4_500_000_000,
  ATOM: 3_900_000_000,
  HBAR: 4_200_000_000,
  XLM: 3_000_000_000,
  ICP: 5_200_000_000,
  MATIC: 6_500_000_000,
  POL: 6_500_000_000,
  PEPE: 5_000_000_000,
  WIF: 2_300_000_000,
  BONK: 1_600_000_000,
  FET: 3_200_000_000,
  RENDER: 4_100_000_000,
  TAO: 3_600_000_000,
  WLD: 2_200_000_000
};

function getTokenDisplayName(base: string): string {
  return TOKEN_NAMES[base.toUpperCase()] ?? base;
}

function toBaseSymbol(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace(/-(USDT|USDC)-SWAP$/i, "")
    .replace(/-(USDT|USDC)$/i, "")
    .replace(/-PERP$/i, "")
    .replace(/-SWAP$/i, "");
}

function formatStakeSourceLabel(stakeSource?: string): string {
  switch (stakeSource) {
    case "SIM_BALANCE_DRIVEN":
      return "Sim Balance Driven";
    case "SIM_FIXED_STAKE":
      return "Sim Fixed Stake";
    case "RISK_BUDGET":
      return "Risk Budget";
    case "SIM_REOPEN_CAPPED":
      return "Sim Reopen Capped";
    case "LIVE_EXCHANGE_POSITION":
      return "Live Exchange Position";
    default:
      return "Unspecified";
  }
}

function formatTokenLabel(symbol: string, maxLeverage?: number): string {
  if (Number.isFinite(maxLeverage ?? Number.NaN)) {
    return `${symbol} (${Math.round(maxLeverage as number)}x)`;
  }

  return symbol;
}

function getMarketCapUsd(symbol: string): number | null {
  const base = toBaseSymbol(symbol);
  return Object.prototype.hasOwnProperty.call(MARKET_CAP_USD, base) ? MARKET_CAP_USD[base] : null;
}

function formatMarketCap(marketCapUsd: number | null): string {
  if (!Number.isFinite(marketCapUsd ?? Number.NaN) || marketCapUsd == null || marketCapUsd <= 0) {
    return "Unknown";
  }

  if (marketCapUsd >= 1_000_000_000_000) {
    return `$${(marketCapUsd / 1_000_000_000_000).toFixed(2)}T`;
  }

  if (marketCapUsd >= 1_000_000_000) {
    return `$${(marketCapUsd / 1_000_000_000).toFixed(2)}B`;
  }

  return `$${(marketCapUsd / 1_000_000).toFixed(0)}M`;
}

function inferCategory(symbol: string): CategoryFilter {
  const base = toBaseSymbol(symbol);

  const override = CATEGORY_OVERRIDES[base];
  if (override) {
    return override;
  }

  for (const category of CATEGORY_PRIORITY) {
    const symbols = CATEGORY_SYMBOLS[category];
    if (symbols.has(base)) {
      return category;
    }
  }

  return "ALL";
}

function getSignalDirection(signalType: RsiRow["signal"]["type"]): "LONG" | "SHORT" | null {
  if (signalType.includes("LONG")) {
    return "LONG";
  }

  if (signalType.includes("SHORT")) {
    return "SHORT";
  }

  return null;
}

function describeSignalPlainEnglish(signalType: RsiRow["signal"]["type"]): string {
  if (signalType === "REVERSAL SHORT") {
    return "Model currently favors a downside reversal setup. This does not guarantee an immediate drop.";
  }
  if (signalType === "REVERSAL LONG") {
    return "Model currently favors an upside reversal setup. This does not guarantee an immediate rally.";
  }
  if (signalType === "CONTINUATION SHORT") {
    return "Model favors trend continuation to the downside.";
  }
  if (signalType === "CONTINUATION LONG") {
    return "Model favors trend continuation to the upside.";
  }
  if (signalType === "STRONG SHORT") {
    return "High-conviction short bias based on current model inputs.";
  }
  if (signalType === "STRONG LONG") {
    return "High-conviction long bias based on current model inputs.";
  }
  if (signalType.startsWith("NO SIGNAL")) {
    return "No directional setup is currently qualified by the model.";
  }
  return "Directional model output.";
}

function describeEntryTimingPlainEnglish(entryTiming?: "EARLY" | "MID" | "LATE" | null): string {
  if (entryTiming === "EARLY") {
    return "Early in the move; better potential reward if setup confirms. Timing is informational, not an enter command.";
  }
  if (entryTiming === "MID") {
    return "Middle of the move; balanced but not ideal. Timing is informational, not an enter command.";
  }
  if (entryTiming === "LATE") {
    return "Late in the move; higher chance the move is extended. This does not by itself mean reversal is guaranteed.";
  }
  return "Timing unavailable. Wait for ENTER NOW cue.";
}

function getSignalInlineHint(signalType: RsiRow["signal"]["type"]): string | null {
  if (signalType === "REVERSAL SHORT") {
    return "Downside reversal bias";
  }
  if (signalType === "REVERSAL LONG") {
    return "Upside reversal bias";
  }
  return null;
}

function getSignalRiskCallout(row: RsiRow): string | null {
  const direction = getSignalDirection(row.signal.type);
  if (!direction) {
    return null;
  }

  if (direction === "LONG" && row.status === "OVERBOUGHT") {
    return "Overbought vs long reversal: setup is contested";
  }

  if (direction === "SHORT" && row.status === "OVERSOLD") {
    return "Oversold vs short reversal: setup is contested";
  }

  return null;
}

function formatUnknownValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? `${value}` : value.toFixed(4);
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return String(value);
  }

  if (value == null) {
    return "n/a";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatBackfillRejectionNote(rejection: TradeRejectionRecord): string {
  const at = `At ${new Date(rejection.rejectedAt).toLocaleString()}`;
  if (rejection.reason !== "backfill not complete") {
    return at;
  }

  const details = rejection.details ?? {};
  return `${at} • status ${formatUnknownValue(details.backfillStatus)} • candles ${formatUnknownValue(details.candleCount)} • price ${formatUnknownValue(details.price)}`;
}

function getNearestFibLevelFromRow(
  row: RsiRow,
  direction: "LONG" | "SHORT"
): { level: string; price: number; distancePct: number } | null {
  const support = Number(row.levels.localSupport ?? 0);
  const resistance = Number(row.levels.localResistance ?? 0);
  const close = Number(row.close ?? 0);

  const highPoint = Math.max(support, resistance, close);
  const lowPoint = Math.min(support, resistance, close);
  const diff = highPoint - lowPoint;

  if (!Number.isFinite(highPoint) || !Number.isFinite(lowPoint) || !Number.isFinite(close) || close <= 0 || diff <= 0) {
    return null;
  }

  const levels = direction === "LONG"
    ? [
      { level: "0%", price: highPoint },
      { level: "23.6%", price: highPoint - diff * 0.236 },
      { level: "38.2%", price: highPoint - diff * 0.382 },
      { level: "50%", price: highPoint - diff * 0.5 },
      { level: "61.8%", price: highPoint - diff * 0.618 },
      { level: "78.6%", price: highPoint - diff * 0.786 },
      { level: "100%", price: lowPoint }
    ]
    : [
      { level: "0%", price: lowPoint },
      { level: "23.6%", price: lowPoint + diff * 0.236 },
      { level: "38.2%", price: lowPoint + diff * 0.382 },
      { level: "50%", price: lowPoint + diff * 0.5 },
      { level: "61.8%", price: lowPoint + diff * 0.618 },
      { level: "78.6%", price: lowPoint + diff * 0.786 },
      { level: "100%", price: highPoint }
    ];

  let nearest = levels[0];
  let nearestDistance = Math.abs(close - nearest.price);

  for (const candidate of levels) {
    const distance = Math.abs(close - candidate.price);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }

  return {
    level: nearest.level,
    price: nearest.price,
    distancePct: (nearestDistance / close) * 100
  };
}

function buildAssetDiagnostics(
  row: RsiRow,
  rejection: TradeRejectionRecord | null,
  fibEnabled: boolean,
  backfillStatus: { status: string; candleCount: number; dataAvailableFrom: string | null; lastError: string | null } | null
): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const minScoreThreshold = 5;
  const score = row.confluence.score;
  const hasDirectionalSignal = row.signal.type.includes("LONG") || row.signal.type.includes("SHORT");
  const entryTiming = row.entryTiming ?? "N/A";
  const failedGateId = rejection ? (REJECTION_TO_GATE[rejection.reason] ?? null) : null;
  const strongSignal = row.signal.type.startsWith("STRONG") || row.signal.type.startsWith("REVERSAL");
  const scoreOrSignalPass = strongSignal || score >= minScoreThreshold;
  const structureMicroPass = row.tradeContext.passedStructure || row.tradeContext.passedMicroTrend;

  checks.push({
    label: "Gate: Runtime Guards",
    value: "Session, cooldown, drawdown, throttle, duplicates, caps",
    status: resolveGateStatus("RUNTIME_GUARDS", failedGateId, null),
    note: "Global engine gate evaluated before candidate-level filters"
  });

  checks.push({
    label: "Gate: Score/Signal",
    value: `score ${score}/10 (min ${minScoreThreshold}) OR direct signal`,
    status: resolveGateStatus("SCORE_OR_SIGNAL", failedGateId, scoreOrSignalPass)
  });

  checks.push({
    label: "Gate: Structure+Micro",
    value: `structure ${row.tradeContext.passedStructure ? "pass" : "fail"} / micro ${row.tradeContext.passedMicroTrend ? "pass" : "fail"}`,
    status: resolveGateStatus("STRUCTURE_MICRO", failedGateId, structureMicroPass)
  });

  checks.push({
    label: "Gate: Directional Signal",
    value: row.signal.type,
    status: resolveGateStatus("DIRECTIONAL_SIGNAL", failedGateId, hasDirectionalSignal),
    note: hasDirectionalSignal ? "directSignalQualified" : "No directional trigger"
  });

  checks.push({
    label: "Gate: Regime Rules",
    value: `${row.tradeContext.regime} / ${row.tradeContext.structureState}`,
    status: resolveGateStatus("REGIME_RULES", failedGateId, null),
    note: rejection?.reason === "regime rules" ? formatUnknownValue(rejection.details?.reason) : "Computed in engine; not fully exposed in snapshot"
  });

  checks.push({
    label: "Gate: Volatility",
    value: `${row.volatilityPct.toFixed(2)}%`,
    status: resolveGateStatus("VOLATILITY", failedGateId, row.tradeContext.passedVolatility)
  });

  checks.push({
    label: "Gate: Liquidity",
    value: `$${(row.volume24h / 1_000_000).toFixed(1)}M`,
    status: resolveGateStatus("LIQUIDITY", failedGateId, row.tradeContext.passedLiquidity)
  });

  checks.push({
    label: "Gate: Timing Context",
    value: entryTiming,
    status: resolveGateStatus("ENTRY_TIMING", failedGateId, null),
    note: "Max timing rule is enforced in engine"
  });

  checks.push({
    label: "Gate: Reversal Phase",
    value: "Engine derived",
    status: resolveGateStatus("REVERSAL_PHASE", failedGateId, null),
    note: "Phase is computed from multi-timeframe trend context"
  });

  checks.push({
    label: "Gate: Unresolved Reversal Block",
    value: "Engine derived",
    status: resolveGateStatus("UNRESOLVED_REVERSAL", failedGateId, null),
    note: "Blocks REVERSAL entries when phase is UNRESOLVED"
  });

  checks.push({
    label: "Gate: Reversal Volatility Cap",
    value: `${row.volatilityPct.toFixed(2)}%`,
    status: resolveGateStatus("REVERSAL_VOLATILITY", failedGateId, null),
    note: "Caps excessively volatile reversal entries"
  });

  checks.push({
    label: "Gate: Symbol Instability Cooldown",
    value: "Engine derived",
    status: resolveGateStatus("SYMBOL_INSTABILITY_COOLDOWN", failedGateId, null),
    note: "Temporarily blocks symbols with repeated fast SL hits"
  });

  checks.push({
    label: "Gate: Counter-trend EARLY",
    value: "Engine derived",
    status: resolveGateStatus("COUNTER_TREND_EARLY", failedGateId, null),
    note: "Only applies to counter-trend bounce reversals"
  });

  checks.push({
    label: "Gate: Risk/Reward",
    value: "Engine derived",
    status: resolveGateStatus("RISK_REWARD", failedGateId, null),
    note: "RR threshold check happens after TP/SL construction"
  });

  checks.push({
    label: "Gate: TP Feasibility",
    value: "Engine derived",
    status: resolveGateStatus("TP_FEASIBILITY", failedGateId, null),
    note: "Not currently logged on reject; exposed as unknown unless failed gate is known"
  });

  checks.push({
    label: "Gate: Fib Touch Memory",
    value: "Recent fib touch can preserve the setup briefly",
    status: fibEnabled ? "PASS" : "WARN",
    note: fibEnabled
      ? "Engine may reuse a recent fib touch for a short signal-memory window"
      : "Fibonacci is disabled in strategy config"
  });

  if (!fibEnabled) {
    checks.push({
      label: "Fib Level Reach",
      value: "Fibonacci disabled",
      status: "WARN"
    });
  } else {
    const direction = getSignalDirection(row.signal.type);
    if (direction === "LONG") {
      const nearestFib = getNearestFibLevelFromRow(row, direction);
      checks.push({
        label: "Fib Level Reach",
        value: nearestFib
          ? `Nearest ${nearestFib.level} @ ${nearestFib.price.toFixed(6)} (${nearestFib.distancePct.toFixed(3)}%)`
          : "Unavailable",
        status: nearestFib && nearestFib.distancePct <= 1 ? "PASS" : "WARN",
        note: nearestFib && nearestFib.distancePct <= 1
          ? "Near Fibonacci level"
          : "Fib retrace/rejection zone not reached"
      });
    } else if (direction === "SHORT") {
      const nearestFib = getNearestFibLevelFromRow(row, direction);
      checks.push({
        label: "Fib Level Reach",
        value: nearestFib
          ? `Nearest ${nearestFib.level} @ ${nearestFib.price.toFixed(6)} (${nearestFib.distancePct.toFixed(3)}%)`
          : "Unavailable",
        status: nearestFib && nearestFib.distancePct <= 1 ? "PASS" : "WARN",
        note: nearestFib && nearestFib.distancePct <= 1
          ? "Near Fibonacci level"
          : "Fib retrace/rejection zone not reached"
      });
    } else {
      checks.push({
        label: "Fib Level Reach",
        value: "No directional signal",
        status: "WARN"
      });
    }
  }

  const expectedValueRaw = rejection?.details?.expectedValuePct ?? rejection?.details?.expectedValue;
  const minExpectedValueRaw = rejection?.details?.minExpectedValuePct ?? rejection?.details?.minExpectedValue;
  const expectedValueKnown = typeof expectedValueRaw === "number" && typeof minExpectedValueRaw === "number";
  checks.push({
    label: "Gate: Expected Value",
    value: expectedValueKnown
      ? `${expectedValueRaw.toFixed(4)}% (min ${minExpectedValueRaw.toFixed(4)}%)`
      : "Engine derived",
    status: resolveGateStatus("EXPECTED_VALUE", failedGateId, expectedValueKnown ? expectedValueRaw >= minExpectedValueRaw : null),
    note: expectedValueKnown ? "Normalized EV percent" : "Waiting for engine trace or rejection detail"
  });

  checks.push({
    label: "Gate: Order Book Available",
    value: row.tradeContext.passedOrderBook ? "Order book snapshot available" : "Order book snapshot unavailable",
    status: resolveGateStatus("ORDER_BOOK_AVAILABLE", failedGateId, row.tradeContext.passedOrderBook),
    note: "Runtime depth/spread checks still happen at open step"
  });

  checks.push({
    label: "Gate: Order Book Execution",
    value: "Runtime execution guard",
    status: resolveGateStatus("ORDER_BOOK_EXECUTION", failedGateId, null),
    note: "Checks spread/depth/imbalance against order size at execution time"
  });

  checks.push({
    label: "Gate: Slippage Protection",
    value: "Runtime slippage model",
    status: resolveGateStatus("SLIPPAGE", failedGateId, null),
    note: "Depends on depth and effective order notional"
  });

  checks.push({
    label: "Gate: Execution-Adjusted TP",
    value: "Runtime TP viability after spread/slippage",
    status: resolveGateStatus("EXECUTION_TP_VIABILITY", failedGateId, null)
  });

  {
    const isCompleted = backfillStatus?.status === "COMPLETED";
    const bfValue = backfillStatus
      ? `${backfillStatus.status} • candles ${backfillStatus.candleCount}${backfillStatus.dataAvailableFrom ? ` • from ${new Date(backfillStatus.dataAvailableFrom).toLocaleDateString()}` : ""}`
      : "Loading…";
    const bfNote = backfillStatus?.lastError ? `Last error: ${backfillStatus.lastError}` : undefined;
    checks.push({
      label: "Backfill Status",
      value: bfValue,
      status: backfillStatus == null ? "UNKNOWN" : isCompleted ? "PASS" : "WARN",
      note: bfNote
    });
  }

  if (rejection) {
    checks.push({
      label: "Last Rejection",
      value: rejection.reason,
      status: "WARN",
      note: formatBackfillRejectionNote(rejection)
    });
  } else {
    checks.push({
      label: "Last Rejection",
      value: "No rejection in current log window",
      status: "WARN",
      note: "Use Evaluate Now for an immediate gate trace refresh"
    });
  }

  return checks;
}

const CATEGORY_TABS: Array<{ key: CategoryFilter; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "AI", label: "AI" },
  { key: "DEFI", label: "DeFi" },
  { key: "GAMING", label: "Gaming" },
  { key: "LAYER1", label: "Layer 1" },
  { key: "LAYER2", label: "Layer 2" },
  { key: "MEME", label: "Meme" },
  { key: "RWA", label: "RWA" }
];

const PRE_PUMP_WATCH_MAX_VOLUME_USD = 40_000_000;
const PRE_PUMP_WATCH_MIN_VOLATILITY_PERCENTILE = 70;
const PRE_PUMP_WATCH_MIN_LIQUIDITY_PERCENTILE = 55;
const PRE_PUMP_WATCH_MIN_INTERMEDIARY_RSI = 55;
const PRE_PUMP_WATCH_MAX_INTERMEDIARY_RSI = 78;
const LIQUIDITY_HUNT_SWEEP_BUFFER_PCT = 0.25;
const IMBALANCE_DOMINANCE_THRESHOLD = 0.02;

type DashboardProps = {
  initialView?: DashboardView;
  tradeMode?: "test" | "live";
};

export function Dashboard({ initialView = "results", tradeMode = "live" }: DashboardProps) {
  const apiHttpBase = useMemo(() => getApiHttpBase(), []);
  const apiWsBase = useMemo(() => getApiWebSocketBase(), []);

  const searchParams = useSearchParams();
  const [access, setAccess] = useState<AccessState | null>(null);
  const [strategyConfig, setStrategyConfig] = useState<any>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [autoRefreshActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [stableResults, setStableResults] = useState<RsiRow[]>([]);
  const [expandedSymbols, setExpandedSymbols] = useState<Record<string, boolean>>({});
  const [selectedCategory, setSelectedCategory] = useState<CategoryFilter>("ALL");
  const [tokenFilterText, setTokenFilterText] = useState("");
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<StatusFilter>("ALL");
  const [selectedImbalanceFilter, setSelectedImbalanceFilter] = useState<ImbalanceFilter>("ALL");
  const [showPrePumpOnly, setShowPrePumpOnly] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [resultSort, setResultSort] = useState<{ key: ResultSortKey; direction: SortDirection }>({
    key: "marketCap",
    direction: "desc"
  });
  const [tradeSort, setTradeSort] = useState<{ key: TradeSortKey; direction: SortDirection }>({
    key: "marketCap",
    direction: "desc"
  });
  const [closePendingSymbol, setClosePendingSymbol] = useState<string | null>(null);
  const [reopenPendingSymbol, setReopenPendingSymbol] = useState<string | null>(null);
  const [resettingSimulation, setResettingSimulation] = useState(false);
  const [detectingPrePump, setDetectingPrePump] = useState(false);
  const [prePumpDetection, setPrePumpDetection] = useState<PrePumpDetectionResponse | null>(null);
  const [reopenFeedback, setReopenFeedback] = useState<string | null>(null);
  const [inspectionRow, setInspectionRow] = useState<RsiRow | null>(null);
  const [latestTradeRejections, setLatestTradeRejections] = useState<TradeRejectionRecord[]>([]);
  const [latestRejectionsBySymbol, setLatestRejectionsBySymbol] = useState<Record<string, TradeRejectionRecord>>({});
  const [inspectionBackfill, setInspectionBackfill] = useState<{ status: string; candleCount: number; dataAvailableFrom: string | null; lastError: string | null } | null>(null);
  const [manualOpenPending, setManualOpenPending] = useState<string | null>(null);
  const [manualOpenFeedback, setManualOpenFeedback] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [collapsedSections, setCollapsedSections] = useState<Record<DashboardSectionKey, boolean>>({
    simulation: false,
    results: false
  });
  const [activeView, setActiveView] = useState<DashboardView>(initialView);
  const [collapsedSimulationBlocks, setCollapsedSimulationBlocks] = useState<Record<SimulationBlockKey, boolean>>({
    stats: false,
    reasons: false,
    active: false,
    closed: false
  });
  const [momentumSnapshot, setMomentumSnapshot] = useState<MomentumSnapshot | null>(null);
  const [momentumLoading, setMomentumLoading] = useState(false);
  const [momentumError, setMomentumError] = useState<string | null>(null);

  useEffect(() => {
    const requestedView = String(searchParams.get("view") ?? "").toLowerCase();
    if (requestedView === "simulation") {
      setActiveView("simulation");
      return;
    }

    if (requestedView === "results" || requestedView === "") {
      setActiveView(initialView);
    }
  }, [searchParams, initialView]);

  const displayResults = data?.results?.length ? data.results : stableResults;

  const loadMomentumCandidates = useCallback(async (forceRefresh: boolean = false): Promise<void> => {
    setMomentumLoading(true);

    try {
      const params = new URLSearchParams();
      params.set("limit", "12");
      if (forceRefresh) {
        params.set("refresh", "true");
      }

      const response = await fetch(`${apiHttpBase}/api/momentum/early-runs?${params.toString()}`, {
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`Momentum scan failed (${response.status})`);
      }

      const payload = (await response.json()) as MomentumSnapshot;
      setMomentumSnapshot(payload);
      setMomentumError(null);
    } catch (scanError) {
      if (!isNetworkFetchError(scanError)) {
        setMomentumError(scanError instanceof Error ? scanError.message : String(scanError));
      }
    } finally {
      setMomentumLoading(false);
    }
  }, [apiHttpBase]);

  const getPrePumpWatchMetrics = (row: RsiRow): { isCandidate: boolean; strength: number } => {
    const hasDirectionalSignal = getSignalDirection(row.signal.type) !== null;
    const isOverbought = row.status === "OVERBOUGHT";

    const volume24h = Number(row.tradeContext?.volume24h ?? row.volume24h ?? 0);
    const inLowLiquidityBucket = Number.isFinite(volume24h) && volume24h > 0 && volume24h <= PRE_PUMP_WATCH_MAX_VOLUME_USD;

    const passedLiquidity = Boolean(row.tradeContext?.passedLiquidity);
    const liquidityPercentile = Number(row.tradeContext?.liquidityPercentile ?? 0);
    const passedLiquidityPercentile = liquidityPercentile >= PRE_PUMP_WATCH_MIN_LIQUIDITY_PERCENTILE;

    const volatilityPercentile = Number(row.tradeContext?.volatilityPercentile ?? 0);
    const passedVolatilityPercentile = volatilityPercentile >= PRE_PUMP_WATCH_MIN_VOLATILITY_PERCENTILE;

    const intermediaryRsi = Number(row.timeframes.intermediary?.rsi ?? 0);
    const intermediaryRsiInBand = intermediaryRsi >= PRE_PUMP_WATCH_MIN_INTERMEDIARY_RSI
      && intermediaryRsi <= PRE_PUMP_WATCH_MAX_INTERMEDIARY_RSI;

    const ema20 = Number(row.tradeContext?.ema20 ?? 0);
    const priceAboveEma20 = Number.isFinite(ema20) && ema20 > 0 && row.close > ema20;

    const emaSlope = Number(row.tradeContext?.emaSlope ?? 0);
    const risingEmaSlope = emaSlope >= 0;

    const stochK = Number(row.timeframes.intermediary?.stochK ?? 0);
    const prevStochK = Number(row.timeframes.intermediary?.prevStochK ?? 0);
    const stochRising = stochK > prevStochK;

    const checks = [
      !hasDirectionalSignal,
      !isOverbought,
      inLowLiquidityBucket,
      passedLiquidity,
      passedLiquidityPercentile,
      passedVolatilityPercentile,
      intermediaryRsiInBand,
      priceAboveEma20,
      risingEmaSlope,
      stochRising
    ];

    const passedChecks = checks.filter(Boolean).length;
    const strength = Math.round((passedChecks / checks.length) * 100);

    const isCandidate = checks.every(Boolean);
    return { isCandidate, strength };
  };

  const getLiquidityHuntProfile = (row: RsiRow): {
    huntScore: number;
    lowerScore: number;
    upperScore: number;
    likelySide: "UPPER_SWEEP" | "LOWER_SWEEP" | "BALANCED";
    targetLevel: number | null;
    longStopSweepPrice: number | null;
    shortStopSweepPrice: number | null;
    longStopLiquidityUsd: number | null;
    shortStopLiquidityUsd: number | null;
    totalStopLiquidityUsd: number | null;
    estimatedLongPct: number;
    estimatedShortPct: number;
    positionPct: number;
  } => {
    const support = Number(row.levels.localSupport ?? 0);
    const resistance = Number(row.levels.localResistance ?? 0);
    const close = Number(row.close ?? 0);

    const validRange = Number.isFinite(support)
      && Number.isFinite(resistance)
      && Number.isFinite(close)
      && support > 0
      && resistance > support
      && close > 0;

    const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

    if (!validRange) {
      return {
        huntScore: 0,
        lowerScore: 0,
        upperScore: 0,
        likelySide: "BALANCED",
        targetLevel: null,
        longStopSweepPrice: null,
        shortStopSweepPrice: null,
        longStopLiquidityUsd: null,
        shortStopLiquidityUsd: null,
        totalStopLiquidityUsd: null,
        estimatedLongPct: 50,
        estimatedShortPct: 50,
        positionPct: 0.5
      };
    }

    const supportDistance = Number(row.levels.supportDistancePct ?? 100);
    const resistanceDistance = Number(row.levels.resistanceDistancePct ?? 100);
    const supportCloseness = clamp01(1 - supportDistance / 2.5);
    const resistanceCloseness = clamp01(1 - resistanceDistance / 2.5);

    const volatilityPctile = Number(row.tradeContext?.volatilityPercentile ?? 0);
    const volatilityFactor = clamp01(volatilityPctile / 100);

    const imbalance = Math.max(-1, Math.min(1, Number(row.tradeContext?.orderBookImbalance ?? 0)));
    const bidDominance = Math.max(0, imbalance);
    const askDominance = Math.max(0, -imbalance);

    const intermediaryRsi = Number(row.timeframes.intermediary?.rsi ?? 50);
    const upperMomentum = intermediaryRsi < 45 ? 0.08 : intermediaryRsi > 70 ? -0.06 : 0;
    const lowerMomentum = intermediaryRsi > 60 ? 0.08 : intermediaryRsi < 30 ? -0.06 : 0;

    const emaSlope = Number(row.tradeContext?.emaSlope ?? 0);
    const trendForUpper = emaSlope > 0 ? 0.05 : 0;
    const trendForLower = emaSlope < 0 ? 0.05 : 0;

    const upperScore = clamp01(
      resistanceCloseness * 0.45
      + askDominance * 0.2
      + volatilityFactor * 0.2
      + trendForUpper
      + upperMomentum
      + (row.levels.nearResistance ? 0.1 : 0)
    );

    const lowerScore = clamp01(
      supportCloseness * 0.45
      + bidDominance * 0.2
      + volatilityFactor * 0.2
      + trendForLower
      + lowerMomentum
      + (row.levels.nearSupportFloor ? 0.1 : 0)
    );

    const diff = upperScore - lowerScore;
    const likelySide = Math.abs(diff) < 0.08
      ? "BALANCED"
      : diff > 0
        ? "UPPER_SWEEP"
        : "LOWER_SWEEP";

    const sweepBuffer = LIQUIDITY_HUNT_SWEEP_BUFFER_PCT / 100;
    const volatilityBufferMultiplier = 1 + volatilityFactor * 0.6;
    const longStopSweepPrice = support * (1 - sweepBuffer * volatilityBufferMultiplier);
    const shortStopSweepPrice = resistance * (1 + sweepBuffer * volatilityBufferMultiplier);

    const orderBookLongTilt = clamp01((imbalance + 1) / 2);
    const estimatedLongRaw = lowerScore * 0.72 + orderBookLongTilt * 0.28;
    const estimatedShortRaw = upperScore * 0.72 + (1 - orderBookLongTilt) * 0.28;
    const estimateTotal = Math.max(0.0001, estimatedLongRaw + estimatedShortRaw);
    const estimatedLongPct = Math.round((estimatedLongRaw / estimateTotal) * 100);
    const estimatedShortPct = Math.max(0, 100 - estimatedLongPct);
    const orderBookCombinedDepthUsd = Number(row.tradeContext?.orderBookCombinedDepthUsd ?? 0);
    const liquidityPercentile = clamp01(Number(row.tradeContext?.liquidityPercentile ?? 0) / 100);
    const volume24h = Math.max(0, Number(row.tradeContext?.volume24h ?? row.volume24h ?? 0));
    const estimatedProxyDepthUsd = volume24h > 0
      ? volume24h * (0.015 + (liquidityPercentile * 0.045))
      : null;
    const totalStopLiquidityUsd = orderBookCombinedDepthUsd > 0
      ? orderBookCombinedDepthUsd
      : estimatedProxyDepthUsd;
    const longStopLiquidityUsd = totalStopLiquidityUsd == null ? null : totalStopLiquidityUsd * (estimatedLongPct / 100);
    const shortStopLiquidityUsd = totalStopLiquidityUsd == null ? null : totalStopLiquidityUsd * (estimatedShortPct / 100);

    const targetLevel = likelySide === "UPPER_SWEEP"
      ? shortStopSweepPrice
      : likelySide === "LOWER_SWEEP"
        ? longStopSweepPrice
        : close;

    const positionPct = clamp01((close - support) / (resistance - support));
    const huntScore = Math.round(Math.max(upperScore, lowerScore) * 100);

    return {
      huntScore,
      lowerScore,
      upperScore,
      likelySide,
      targetLevel,
      longStopSweepPrice,
      shortStopSweepPrice,
      longStopLiquidityUsd,
      shortStopLiquidityUsd,
      totalStopLiquidityUsd,
      estimatedLongPct,
      estimatedShortPct,
      positionPct
    };
  };

  const isPrePumpWatchCandidate = (row: RsiRow): boolean => {
    return getPrePumpWatchMetrics(row).isCandidate;
  };

  const getDominanceScore = (row: RsiRow): number => {
    const rawImbalance = Number(row.tradeContext?.orderBookImbalance ?? Number.NaN);
    if (Number.isFinite(rawImbalance) && Math.abs(rawImbalance) >= 0.001) {
      return Math.max(-1, Math.min(1, rawImbalance));
    }

    const huntProfile = getLiquidityHuntProfile(row);
    const proxyScore = (huntProfile.estimatedLongPct - huntProfile.estimatedShortPct) / 100;
    return Math.max(-1, Math.min(1, proxyScore));
  };

  const tokenFilteredResults = useMemo(() => {
    const query = tokenFilterText.trim().toUpperCase();
    if (!query) {
      return displayResults;
    }

    return displayResults.filter((row) => {
      const baseSymbol = toBaseSymbol(row.symbol);
      const tokenName = getTokenDisplayName(baseSymbol).toUpperCase();
      return baseSymbol.includes(query) || tokenName.includes(query);
    });
  }, [displayResults, tokenFilterText]);

  const statusFilteredResults = useMemo(() => {
    if (selectedStatusFilter === "ALL") {
      return tokenFilteredResults;
    }

    return tokenFilteredResults.filter((row) => row.status === selectedStatusFilter);
  }, [tokenFilteredResults, selectedStatusFilter]);

  const imbalanceFilteredResults = useMemo(() => {
    if (selectedImbalanceFilter === "ALL") {
      return statusFilteredResults;
    }

    return statusFilteredResults.filter((row) => {
      const dominanceScore = getDominanceScore(row);

      if (selectedImbalanceFilter === "LONG_DOMINANT") {
        return dominanceScore >= IMBALANCE_DOMINANCE_THRESHOLD;
      }

      return dominanceScore <= -IMBALANCE_DOMINANCE_THRESHOLD;
    });
  }, [statusFilteredResults, selectedImbalanceFilter]);

  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      ALL: imbalanceFilteredResults.length,
      AI: 0,
      DEFI: 0,
      GAMING: 0,
      LAYER1: 0,
      LAYER2: 0,
      MEME: 0,
      RWA: 0
    };

    for (const row of imbalanceFilteredResults) {
      const category = inferCategory(row.symbol);
      if (category !== "ALL") {
        counts[category] += 1;
      }
    }

    return counts;
  }, [imbalanceFilteredResults]);

  const categoryFilteredResults = useMemo(() => {
    if (selectedCategory === "ALL") {
      return imbalanceFilteredResults;
    }

    return imbalanceFilteredResults.filter((item) => inferCategory(item.symbol) === selectedCategory);
  }, [imbalanceFilteredResults, selectedCategory]);

  const prePumpWatchCount = useMemo(
    () => imbalanceFilteredResults.filter((item) => isPrePumpWatchCandidate(item)).length,
    [imbalanceFilteredResults]
  );

  const momentumRows = useMemo(() => {
    if (!momentumSnapshot) {
      return [] as MomentumCandidate[];
    }

    if (momentumSnapshot.nearTop.length > 0) {
      return momentumSnapshot.nearTop;
    }

    return momentumSnapshot.strictTop;
  }, [momentumSnapshot]);

  const visibleResults = useMemo(() => {
    if (!showPrePumpOnly) {
      return categoryFilteredResults;
    }

    return categoryFilteredResults.filter((item) => isPrePumpWatchCandidate(item));
  }, [categoryFilteredResults, showPrePumpOnly]);

  const sortedVisibleResults = useMemo(() => {
    const next = [...visibleResults];
    const directionFactor = resultSort.direction === "asc" ? 1 : -1;

    const compareNullableNumber = (left: number | null, right: number | null): number => {
      if (left == null && right == null) {
        return 0;
      }

      if (left == null) {
        return 1;
      }

      if (right == null) {
        return -1;
      }

      return (left - right) * directionFactor;
    };

    next.sort((left, right) => {
      const leftReadiness = getReadinessPct(left);
      const rightReadiness = getReadinessPct(right);
      const leftEntryTiming = left.entryTiming ?? "";
      const rightEntryTiming = right.entryTiming ?? "";

      switch (resultSort.key) {
        case "token":
          return left.symbol.localeCompare(right.symbol) * directionFactor;
        case "marketCap":
          return compareNullableNumber(getMarketCapUsd(left.symbol), getMarketCapUsd(right.symbol));
        case "volume24h":
          return (left.volume24h - right.volume24h) * directionFactor;
        case "volatility":
          return (left.volatilityPct - right.volatilityPct) * directionFactor;
        case "readiness":
          return (leftReadiness - rightReadiness) * directionFactor;
        case "signal":
          return left.signal.type.localeCompare(right.signal.type) * directionFactor;
        case "prePump": {
          const leftPrePump = getPrePumpWatchMetrics(left);
          const rightPrePump = getPrePumpWatchMetrics(right);

          if (leftPrePump.isCandidate !== rightPrePump.isCandidate) {
            return (Number(leftPrePump.isCandidate) - Number(rightPrePump.isCandidate)) * directionFactor;
          }

          return (leftPrePump.strength - rightPrePump.strength) * directionFactor;
        }
        case "liquidityHunt": {
          const leftHunt = getLiquidityHuntProfile(left);
          const rightHunt = getLiquidityHuntProfile(right);
          return (leftHunt.huntScore - rightHunt.huntScore) * directionFactor;
        }
        case "entryTiming":
          return leftEntryTiming.localeCompare(rightEntryTiming) * directionFactor;
        case "score":
          return (left.confluence.score - right.confluence.score) * directionFactor;
        case "price":
          return (left.close - right.close) * directionFactor;
        default:
          return 0;
      }
    });

    return next;
  }, [resultSort, visibleResults]);

  const strongShortRows = useMemo(
    () => visibleResults.filter((item) => item.signal.type === "STRONG SHORT"),
    [visibleResults]
  );

  const strongLongRows = useMemo(
    () => visibleResults.filter((item) => item.signal.type === "STRONG LONG"),
    [visibleResults]
  );

  const continuationShortRows = useMemo(
    () => visibleResults.filter((item) => item.signal.type === "CONTINUATION SHORT"),
    [visibleResults]
  );

  const continuationLongRows = useMemo(
    () => visibleResults.filter((item) => item.signal.type === "CONTINUATION LONG"),
    [visibleResults]
  );

  const reversalShortRows = useMemo(
    () => visibleResults.filter((item) => item.signal.type === "REVERSAL SHORT"),
    [visibleResults]
  );

  const reversalLongRows = useMemo(
    () => visibleResults.filter((item) => item.signal.type === "REVERSAL LONG"),
    [visibleResults]
  );

  const tradeReadyRows = useMemo(
    () => visibleResults.filter((item) => item.tradeContext?.passedVolatility && item.tradeContext?.passedLiquidity),
    [visibleResults]
  );

  const noSignalRows = useMemo(
    () => visibleResults.filter((item) => item.signal.type.startsWith("NO SIGNAL")),
    [visibleResults]
  );

  const topCandlestickPatterns = useMemo(() => {
    const buckets = data?.candlestickStats?.byPattern;
    if (!buckets) {
      return [] as Array<{ name: string; hits: number; alignedHits: number; alignmentPct: number }>;
    }

    return Object.entries(buckets)
      .map(([name, stats]) => {
        const hits = stats?.hits ?? 0;
        const alignedHits = stats?.alignedHits ?? 0;
        return {
          name,
          hits,
          alignedHits,
          alignmentPct: hits > 0 ? Number(((alignedHits / hits) * 100).toFixed(1)) : 0
        };
      })
      .filter((row) => row.hits > 0)
      .sort((left, right) => {
        if (right.hits !== left.hits) {
          return right.hits - left.hits;
        }
        return right.alignmentPct - left.alignmentPct;
      })
      .slice(0, 6);
  }, [data?.candlestickStats]);

  const modeStats = tradeMode === "test"
    ? data?.tradeSimulation?.stats
    : ((data as any)?.liveAccount?.stats ?? data?.tradeSimulation?.stats);
  const wins = modeStats?.wins ?? 0;
  const losses = modeStats?.losses ?? 0;
  const settledTrades = wins + losses;
  const lossRate = settledTrades > 0 ? (losses / settledTrades) * 100 : 0;
  const closeReasonBreakdown = useMemo(() => {
    const counts = modeStats?.closeReasonCounts;
    if (!counts) {
      return [] as Array<{ reason: string; count: number; pct: number }>;
    }

    const entries = Object.entries(counts)
      .map(([reason, count]) => ({ reason, count: Number(count ?? 0) }))
      .filter((entry) => Number.isFinite(entry.count) && entry.count > 0)
      .sort((left, right) => right.count - left.count);

    const total = entries.reduce((sum, entry) => sum + entry.count, 0);
    if (total <= 0) {
      return [] as Array<{ reason: string; count: number; pct: number }>;
    }

    return entries.map((entry) => ({
      ...entry,
      pct: Number(((entry.count / total) * 100).toFixed(1))
    }));
  }, [modeStats?.closeReasonCounts]);

  const tradeRejectionBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    for (const rejection of latestTradeRejections) {
      counts.set(rejection.reason, (counts.get(rejection.reason) ?? 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 6);
  }, [latestTradeRejections]);

  const tradeRejectionSignalBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    for (const rejection of latestTradeRejections) {
      const signal = rejection.signal || "UNKNOWN";
      counts.set(signal, (counts.get(signal) ?? 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([signal, count]) => ({ signal, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 6);
  }, [latestTradeRejections]);
  const manualControlsEnabled = access?.features.manualTradeControls ?? true;
  // Select appropriate trade data based on mode: test simulation vs live trading
  const currentTradeData = tradeMode === "test" 
    ? data?.tradeSimulation 
    : ((data as any)?.liveAccount ?? data?.tradeSimulation);
  
  const activeTrades = currentTradeData?.activeTrades ?? [];
  const activeTradeTokens = useMemo(
    () => new Set(activeTrades.map((trade: any) => toBaseSymbol(trade.token))),
    [activeTrades]
  );

  const sortedActiveTrades = useMemo(() => {
    const next = [...activeTrades];
    const directionFactor = tradeSort.direction === "asc" ? 1 : -1;

    const compareNullableNumber = (left: number | null, right: number | null): number => {
      if (left == null && right == null) {
        return 0;
      }

      if (left == null) {
        return 1;
      }

      if (right == null) {
        return -1;
      }

      return (left - right) * directionFactor;
    };

    next.sort((left, right) => {
      const leftSize = left.sizeBaseUnits ?? ((left.stakeUsd * left.leverage) / (left.entryPrice > 0 ? left.entryPrice : 1));
      const rightSize = right.sizeBaseUnits ?? ((right.stakeUsd * right.leverage) / (right.entryPrice > 0 ? right.entryPrice : 1));
      const leftMark = left.markPrice ?? left.currentPrice;
      const rightMark = right.markPrice ?? right.currentPrice;
      const leftPnlPct = left.currentPnlPct ?? (left.direction === "LONG"
        ? ((left.currentPrice - left.entryPrice) / left.entryPrice) * left.leverage * 100
        : ((left.entryPrice - left.currentPrice) / left.entryPrice) * left.leverage * 100);
      const rightPnlPct = right.currentPnlPct ?? (right.direction === "LONG"
        ? ((right.currentPrice - right.entryPrice) / right.entryPrice) * right.leverage * 100
        : ((right.entryPrice - right.currentPrice) / right.entryPrice) * right.leverage * 100);
      const leftRoe = left.roePct ?? leftPnlPct;
      const rightRoe = right.roePct ?? rightPnlPct;
      const leftPnlUsd = left.currentPnlUsd ?? (left.stakeUsd * (leftPnlPct / 100));
      const rightPnlUsd = right.currentPnlUsd ?? (right.stakeUsd * (rightPnlPct / 100));
      const leftPositionValue = left.positionValueUsd ?? (left.stakeUsd * left.leverage * (leftMark / left.entryPrice));
      const rightPositionValue = right.positionValueUsd ?? (right.stakeUsd * right.leverage * (rightMark / right.entryPrice));
      const leftMargin = left.marginUsedUsd ?? left.stakeUsd;
      const rightMargin = right.marginUsedUsd ?? right.stakeUsd;
      const leftFundingRate = (left.fundingRate ?? 0) * 100;
      const rightFundingRate = (right.fundingRate ?? 0) * 100;
      const leftFundingPnl = left.fundingAccruedUsd ?? 0;
      const rightFundingPnl = right.fundingAccruedUsd ?? 0;
      const leftLiqPrice = left.estimatedLiqPrice ?? (left.direction === "LONG"
        ? left.entryPrice * (1 - Math.max((1 / left.leverage) - 0.005, 0.01))
        : left.entryPrice * (1 + Math.max((1 / left.leverage) - 0.005, 0.01)));
      const rightLiqPrice = right.estimatedLiqPrice ?? (right.direction === "LONG"
        ? right.entryPrice * (1 - Math.max((1 / right.leverage) - 0.005, 0.01))
        : right.entryPrice * (1 + Math.max((1 / right.leverage) - 0.005, 0.01)));
      const leftDistTp = left.distanceToTP ?? (((left.tpPrice - left.currentPrice) / left.currentPrice) * 100);
      const rightDistTp = right.distanceToTP ?? (((right.tpPrice - right.currentPrice) / right.currentPrice) * 100);
      const leftDistSl = left.distanceToSL ?? (((left.currentPrice - left.slPrice) / left.currentPrice) * 100);
      const rightDistSl = right.distanceToSL ?? (((right.currentPrice - right.slPrice) / right.currentPrice) * 100);
      const leftOpenedAt = Date.parse(left.openTime);
      const rightOpenedAt = Date.parse(right.openTime);
      const leftSeconds = Number.isFinite(leftOpenedAt) ? Math.max(0, Math.floor((nowMs - leftOpenedAt) / 1000)) : 0;
      const rightSeconds = Number.isFinite(rightOpenedAt) ? Math.max(0, Math.floor((nowMs - rightOpenedAt) / 1000)) : 0;
      const leftEntryType = left.entryType ?? left.signalCategory ?? "SCORE_BASED";
      const rightEntryType = right.entryType ?? right.signalCategory ?? "SCORE_BASED";
      const leftEntryTiming = left.entryTiming ?? "";
      const rightEntryTiming = right.entryTiming ?? "";
      const leftAssetType = left.assetType ?? "ALT";
      const rightAssetType = right.assetType ?? "ALT";
      const leftTakeProfitPct = left.takeProfitPct ?? 15;
      const rightTakeProfitPct = right.takeProfitPct ?? 15;

      switch (tradeSort.key) {
        case "marketCap":
          return compareNullableNumber(getMarketCapUsd(left.token), getMarketCapUsd(right.token));
        case "token":
          return left.token.localeCompare(right.token) * directionFactor;
        case "direction":
          return left.direction.localeCompare(right.direction) * directionFactor;
        case "size":
          return (leftSize - rightSize) * directionFactor;
        case "assetType":
          return leftAssetType.localeCompare(rightAssetType) * directionFactor;
        case "entryType":
          return leftEntryType.localeCompare(rightEntryType) * directionFactor;
        case "entryTiming":
          return leftEntryTiming.localeCompare(rightEntryTiming) * directionFactor;
        case "tpPct":
          return (leftTakeProfitPct - rightTakeProfitPct) * directionFactor;
        case "entry":
          return (left.entryPrice - right.entryPrice) * directionFactor;
        case "mark":
          return (leftMark - rightMark) * directionFactor;
        case "positionValue":
          return (leftPositionValue - rightPositionValue) * directionFactor;
        case "roe":
          return (leftRoe - rightRoe) * directionFactor;
        case "pnlUsd":
          return (leftPnlUsd - rightPnlUsd) * directionFactor;
        case "liqPrice":
          return (leftLiqPrice - rightLiqPrice) * directionFactor;
        case "margin":
          return (leftMargin - rightMargin) * directionFactor;
        case "fundingRate":
          return (leftFundingRate - rightFundingRate) * directionFactor;
        case "fundingPnl":
          return (leftFundingPnl - rightFundingPnl) * directionFactor;
        case "distTp":
          return (leftDistTp - rightDistTp) * directionFactor;
        case "distSl":
          return (leftDistSl - rightDistSl) * directionFactor;
        case "stake":
          return (left.stakeUsd - right.stakeUsd) * directionFactor;
        case "status":
          return left.status.localeCompare(right.status) * directionFactor;
        case "timeInTrade":
          return (leftSeconds - rightSeconds) * directionFactor;
        case "openedAt":
          return (leftOpenedAt - rightOpenedAt) * directionFactor;
        default:
          return 0;
      }
    });

    return next;
  }, [activeTrades, nowMs, tradeSort]);

  const selectedRejection = useMemo(() => {
    if (!inspectionRow) {
      return null;
    }

    return latestRejectionsBySymbol[inspectionRow.symbol]
      ?? latestRejectionsBySymbol[toBaseSymbol(inspectionRow.symbol)]
      ?? null;
  }, [inspectionRow, latestRejectionsBySymbol]);

  const latestGlobalRuntimeRejection = useMemo(() => {
    const globalEntry = latestRejectionsBySymbol.SYSTEM;
    if (!globalEntry) {
      return null;
    }

    return GLOBAL_RUNTIME_REJECTION_REASONS.has(globalEntry.reason) ? globalEntry : null;
  }, [latestRejectionsBySymbol]);

  const inspectionChecks = useMemo(() => {
    if (!inspectionRow) {
      return [];
    }

    const fibEnabled = Boolean(strategyConfig?.enableFibonacci);
    return buildAssetDiagnostics(inspectionRow, selectedRejection, fibEnabled, inspectionBackfill);
  }, [inspectionRow, selectedRejection, strategyConfig, inspectionBackfill]);

  const visibleInspectionChecks = useMemo(
    () => inspectionChecks.filter((check) => check.status !== "NOT_EVALUATED" && check.status !== "UNKNOWN"),
    [inspectionChecks]
  );

  const hiddenInspectionChecksCount = inspectionChecks.length - visibleInspectionChecks.length;

  useEffect(() => {
    let cancelled = false;

    async function loadAccessState(): Promise<void> {
      try {
        const response = await fetch(`${apiHttpBase}/api/access`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Failed to load access state (${response.status})`);
        }

        const payload = (await response.json()) as AccessState;
        if (!cancelled) {
          setAccess(payload);
        }
      } catch (accessError) {
        if (isNetworkFetchError(accessError)) {
          return;
        }

        if (!cancelled) {
          setError((previous) => previous ?? (accessError instanceof Error ? accessError.message : String(accessError)));
        }
      }
    }

    void loadAccessState();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Load strategy config on mount
    const loadStrategyConfig = async () => {
      try {
          const response = await fetch(`${apiHttpBase}/api/strategy/config`);
        if (response.ok) {
          const config = await response.json();
          setStrategyConfig(config);
        }
      } catch (err) {
        if (!isNetworkFetchError(err)) {
          console.error("Failed to load strategy config:", err);
        }
      }
    };

    void loadStrategyConfig();
  }, [apiHttpBase]);

  useEffect(() => {
    let cancelled = false;

    const run = async (): Promise<void> => {
      if (cancelled) {
        return;
      }

      await loadMomentumCandidates(false);
    };

    void run();

    const intervalId = setInterval(() => {
      void run();
    }, 120000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [loadMomentumCandidates]);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!autoRefreshActive) {
      return;
    }

    const wsUrl = `${apiWsBase}/ws/state?mode=${tradeMode}`;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let closedByCleanup = false;
    let socket: WebSocket | null = null;

    const connect = () => {
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        setWsConnected(true);
        setError(null);
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as ApiResponse;
          if (payload.results?.length) {
            setStableResults(payload.results);
          }
          setData(payload);
        } catch {
          // Ignore malformed payloads.
        }
      };

      socket.onerror = () => {
        setWsConnected(false);
        setError("WebSocket stream interrupted. Reconnecting...");
      };

      socket.onclose = () => {
        setWsConnected(false);
        if (!closedByCleanup) {
          setError("WebSocket disconnected. Waiting to reconnect...");
          reconnectTimeout = setTimeout(connect, 3000);
        }
      };
    };

    connect();

    return () => {
      closedByCleanup = true;
      setWsConnected(false);
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [autoRefreshActive, apiWsBase, tradeMode]);

  useEffect(() => {
    let cancelled = false;

    async function loadRejections(): Promise<void> {
      try {
        const response = await fetch(`${apiHttpBase}/api/trades/rejections?limit=500`, { cache: "no-store" });
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as TradeRejectionResponse;
        if (!cancelled) {
          setLatestTradeRejections(payload.rejections ?? []);
        }
        const next: Record<string, TradeRejectionRecord> = {};

        for (const rejection of payload.rejections ?? []) {
          if (!next[rejection.symbol]) {
            next[rejection.symbol] = rejection;
          }

          const normalizedSymbol = toBaseSymbol(rejection.symbol);
          if (!next[normalizedSymbol]) {
            next[normalizedSymbol] = rejection;
          }
        }

        if (!cancelled) {
          setLatestRejectionsBySymbol(next);
        }
      } catch {
        // Keep dashboard live even if rejection diagnostics endpoint is temporarily unavailable.
      }
    }

    void loadRejections();
    const intervalId = setInterval(() => {
      void loadRejections();
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [apiHttpBase]);

  useEffect(() => {
    if (!inspectionRow) {
      setInspectionBackfill(null);
      return;
    }

    const baseSymbol = toBaseSymbol(inspectionRow.symbol);
    fetch(`${apiHttpBase}/api/backfill/status?symbol=${encodeURIComponent(baseSymbol)}`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((payload) => {
        if (payload) {
          setInspectionBackfill({
            status: String(payload.status ?? "UNKNOWN"),
            candleCount: Number(payload.candleCount ?? 0),
            dataAvailableFrom: payload.dataAvailableFrom ?? null,
            lastError: payload.lastError ?? null
          });
        }
      })
      .catch(() => setInspectionBackfill(null));
  }, [inspectionRow, apiHttpBase]);

  useEffect(() => {
    if (!inspectionRow) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setInspectionRow(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [inspectionRow]);

  function hasExhaustionConflict(row: RsiRow): boolean {
    const direction = getSignalDirection(row.signal.type);
    if (!direction) {
      return false;
    }

    return (direction === "LONG" && row.status === "OVERBOUGHT") || (direction === "SHORT" && row.status === "OVERSOLD");
  }

  function getPrePumpWatchCallout(row: RsiRow): string | null {
    if (!isPrePumpWatchCandidate(row)) {
      return null;
    }

    return "Pre-pump watch: volume creep + trend persistence";
  }

  function renderSignalBadgeForRow(row: RsiRow) {
    const direction = getSignalDirection(row.signal.type);
    const cautionClass = hasExhaustionConflict(row) && direction ? " caution" : "";
    const stateClass = row.signal.type.startsWith("NO SIGNAL")
      ? "signal-badge no-signal"
      : direction === "LONG"
        ? `signal-badge long${cautionClass}`
        : direction === "SHORT"
          ? `signal-badge short${cautionClass}`
          : "signal-badge neutral";

    return <span className={`${row.signal.classes} ${stateClass}`} title={describeSignalPlainEnglish(row.signal.type)}>{row.signal.type}</span>;
  }

  function renderConfluenceScore(row: RsiRow) {
    const confluence = row.confluence;
    const pct = Math.max(0, Math.min(100, (confluence.score / confluence.maxScore) * 100));
    const biasClass = hasExhaustionConflict(row)
      ? "caution"
      : (confluence.bias ?? "neutral").toLowerCase();
    const biasLabel = confluence.bias ?? "NEUTRAL";

    return (
      <div className="score-wrap" title={`${biasLabel} ${confluence.score}/${confluence.maxScore}`}>
        <span className={`score-label ${biasClass}`}>
          {confluence.score}/{confluence.maxScore}
        </span>
        <div className="score-track">
          <span className={`score-fill ${biasClass}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  function renderPrePumpIndicator(row: RsiRow) {
    const metrics = getPrePumpWatchMetrics(row);

    if (metrics.isCandidate) {
      return <span className="pre-pump-indicator watch">WATCH {metrics.strength}%</span>;
    }

    if (metrics.strength >= 70) {
      return <span className="pre-pump-indicator arming">ARMING {metrics.strength}%</span>;
    }

    return <span className="pre-pump-indicator cold">{metrics.strength}%</span>;
  }

  function renderLiquidityHuntMap(row: RsiRow) {
    const profile = getLiquidityHuntProfile(row);

    const sideText = profile.likelySide === "UPPER_SWEEP"
      ? "Short stops likely above"
      : profile.likelySide === "LOWER_SWEEP"
        ? "Long stops likely below"
        : "Balanced stop pressure";

    const sideClass = profile.likelySide === "UPPER_SWEEP"
      ? "upper"
      : profile.likelySide === "LOWER_SWEEP"
        ? "lower"
        : "balanced";

    return (
      <div className="liquidity-hunt-wrap">
        <div className="liquidity-hunt-track" role="img" aria-label={`Liquidity hunt heat map ${sideText}`}>
          <span className="liquidity-hunt-zone lower" style={{ opacity: Math.max(0.2, profile.lowerScore) }} />
          <span className="liquidity-hunt-zone upper" style={{ opacity: Math.max(0.2, profile.upperScore) }} />
          <span className="liquidity-hunt-price" style={{ left: `${(profile.positionPct * 100).toFixed(1)}%` }} />
        </div>
        <div className="liquidity-hunt-meta">
          <span className={`liquidity-hunt-side ${sideClass}`}>{sideText}</span>
          <span className="liquidity-hunt-target">Confidence {profile.huntScore}%</span>
        </div>
        <div className="liquidity-hunt-levels">
          <span className={`liquidity-hunt-level ${profile.likelySide === "LOWER_SWEEP" ? "active" : ""}`}>
            Long SL avg {profile.longStopSweepPrice ? `$${profile.longStopSweepPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : "n/a"}
          </span>
          <span className={`liquidity-hunt-level ${profile.likelySide === "UPPER_SWEEP" ? "active" : ""}`}>
            Short hunt top {profile.shortStopSweepPrice ? `$${profile.shortStopSweepPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : "n/a"}
          </span>
          <span className="liquidity-hunt-positioning">
            Positioning est: {profile.estimatedLongPct}% long / {profile.estimatedShortPct}% short
          </span>
          <span className={`liquidity-hunt-liquidity ${profile.likelySide === "LOWER_SWEEP" ? "active" : ""}`}>
            Long stop liq est. {profile.longStopLiquidityUsd != null ? `$${profile.longStopLiquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "n/a"}
          </span>
          <span className={`liquidity-hunt-liquidity ${profile.likelySide === "UPPER_SWEEP" ? "active" : ""}`}>
            Short stop liq est. {profile.shortStopLiquidityUsd != null ? `$${profile.shortStopLiquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "n/a"}
          </span>
          <span className="liquidity-hunt-positioning">
            Stop liquidity pool est. {profile.totalStopLiquidityUsd != null ? `$${profile.totalStopLiquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "n/a"}
          </span>
        </div>
      </div>
    );
  }

  function toggleExpanded(symbol: string) {
    setExpandedSymbols((previous) => ({
      ...previous,
      [symbol]: !previous[symbol]
    }));
  }

  async function handleManualOpen(row: RsiRow, direction: "LONG" | "SHORT") {
    const key = `${row.symbol}:${direction}`;
    if (manualOpenPending === key) return;
    setManualOpenPending(key);
    setManualOpenFeedback((prev) => ({ ...prev, [row.symbol]: { ok: true, msg: "Opening…" } }));
    try {
      const resp = await fetch(`${API_BASE}/api/trades/open-manual?mode=${tradeMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: row.symbol, direction, signalType: row.signal.type, entryPrice: row.close })
      });
      const payload = await resp.json();
      if (resp.ok && payload.opened) {
        setManualOpenFeedback((prev) => ({ ...prev, [row.symbol]: { ok: true, msg: `${direction} opened` } }));
      } else {
        setManualOpenFeedback((prev) => ({ ...prev, [row.symbol]: { ok: false, msg: payload.reason ?? payload.error ?? "Blocked" } }));
      }
    } catch (err) {
      setManualOpenFeedback((prev) => ({ ...prev, [row.symbol]: { ok: false, msg: err instanceof Error ? err.message : "Error" } }));
    } finally {
      setManualOpenPending(null);
      setTimeout(() => setManualOpenFeedback((prev) => { const next = { ...prev }; delete next[row.symbol]; return next; }), 4000);
    }
  }

  function renderTrendChip(label: string, timeframe: TimeframeData, microTrigger: boolean = false) {
    const directionClass = timeframe.trend.direction.toLowerCase();

    return (
      <span className={`trend-chip ${directionClass}`}>
        <span className="trend-label">{label}</span>
        <span className="trend-arrow">{timeframe.trend.arrow}</span>
        {timeframe.trend.overbought ? <span className="trend-dot overbought" title="Overbought">•</span> : null}
        {timeframe.trend.oversold ? <span className="trend-dot oversold" title="Oversold">•</span> : null}
        {microTrigger ? <span className="trend-trigger">TRG</span> : null}
      </span>
    );
  }

  function renderReadinessScore(row: RsiRow) {
    const displayPct = getReadinessPct(row);
    const ctx = row.tradeContext;
    const hasSignal = row.signal?.type?.includes("LONG") || row.signal?.type?.includes("SHORT");

    // --- Component scores (each out of 25) ---
    // 1. Volatility: passed = full 25, else 0
    const volScore = (ctx?.passedVolatility ?? false) ? 25 : 0;

    // 2. Liquidity: use percentile if available, else boolean
    const liqPct = ctx?.liquidityPercentile ?? (ctx?.passedLiquidity ? 100 : 0);
    const liqScore = Math.round((Math.min(liqPct, 100) / 100) * 25);

    // 3. Structure / trend alignment: two independent gates + trendline bonus
    const structureOk = ctx?.passedStructure ?? false;
    const microOk = ctx?.passedMicroTrend ?? false;
    const trendlineBoost = (ctx?.trendlineBreakout ?? false) || (ctx?.trendlineBreakdown ?? false);
    const structureScore = Math.round(
      ((structureOk ? 10 : 0) + (microOk ? 10 : 0) + (trendlineBoost ? 5 : 0))
    );

    // 4. Confluence: scale score/maxScore to 25
    const confScore = row.confluence?.score ?? 0;
    const confMax = row.confluence?.maxScore ?? 10;
    const confScoreNorm = confMax > 0 ? Math.round((Math.min(confScore, confMax) / confMax) * 25) : 0;

    const total = Math.min(100, volScore + liqScore + structureScore + confScoreNorm);

    // Color: green ≥80, amber 50–79, slate <50
    const fillColor =
      displayPct >= 80 ? "#4ade80"
      : displayPct >= 50 ? "#fbbf24"
      : "#64748b";

    const label = hasSignal
      ? "Enter now"
      : displayPct >= 80
      ? "Near entry"
      : displayPct >= 50
      ? "Building"
      : "Watching";

    const breakdown = [
      `Volatility: ${volScore}/25`,
      `Liquidity: ${liqScore}/25`,
      `Structure: ${structureScore}/25`,
      `Confluence: ${confScoreNorm}/25`,
    ].join(" · ");

    return (
      <div className="readiness-cell" title={`${breakdown}`}>
        <div className="readiness-header">
          <span className="readiness-pct" style={{ color: fillColor }}>{displayPct}%</span>
          <span className="readiness-label">{label}</span>
        </div>
        <div className="readiness-track">
          <div
            className="readiness-fill"
            style={{ width: `${displayPct}%`, background: fillColor }}
          />
        </div>
      </div>
    );
  }

  function getReadinessPct(row: RsiRow): number {
    const ctx = row.tradeContext;
    const volScore = (ctx?.passedVolatility ?? false) ? 25 : 0;
    const liqPct = ctx?.liquidityPercentile ?? (ctx?.passedLiquidity ? 100 : 0);
    const liqScore = Math.round((Math.min(liqPct, 100) / 100) * 25);
    const structureOk = ctx?.passedStructure ?? false;
    const microOk = ctx?.passedMicroTrend ?? false;
    const trendlineBoost = (ctx?.trendlineBreakout ?? false) || (ctx?.trendlineBreakdown ?? false);
    const structureScore = Math.round(
      ((structureOk ? 10 : 0) + (microOk ? 10 : 0) + (trendlineBoost ? 5 : 0))
    );
    const confScore = row.confluence?.score ?? 0;
    const confMax = row.confluence?.maxScore ?? 10;
    const confScoreNorm = confMax > 0 ? Math.round((Math.min(confScore, confMax) / confMax) * 25) : 0;
    const total = Math.min(100, volScore + liqScore + structureScore + confScoreNorm);
    const hasSignal = row.signal?.type?.includes("LONG") || row.signal?.type?.includes("SHORT");
    return hasSignal ? 100 : total;
  }

  function getExecutionRowState(row: RsiRow): {
    shouldHighlight: boolean;
    title?: string;
    background?: string;
  } {
    const readiness = getReadinessPct(row);
    const token = toBaseSymbol(row.symbol);
    if (activeTradeTokens.has(token)) {
      return { shouldHighlight: false };
    }

    const isNearExecution = readiness >= 65 && readiness < 100;
    if (!isNearExecution) {
      return { shouldHighlight: false };
    }

    const strength = Math.min(1, Math.max(0, (readiness - 65) / 35));
    const amberAlpha = 0.05 + strength * 0.10;
    const greenAlpha = 0.06 + strength * 0.14;

    return {
      shouldHighlight: true,
      title: `Near execution: ${readiness}% and waiting on remaining gates before ENTER NOW.`,
      background: `linear-gradient(90deg, rgba(251, 191, 36, ${amberAlpha}) 0%, rgba(74, 222, 128, ${greenAlpha}) 100%)`
    };
  }

  function formatTimeInTrade(openTime: string): string {
    const openedAt = Date.parse(openTime);
    if (!Number.isFinite(openedAt)) {
      return "-";
    }

    const elapsedSeconds = Math.max(0, Math.floor((nowMs - openedAt) / 1000));
    if (elapsedSeconds < 60) {
      return `${elapsedSeconds}s`;
    }

    if (elapsedSeconds < 3600) {
      return `${Math.floor(elapsedSeconds / 60)}m`;
    }

    const hours = Math.floor(elapsedSeconds / 3600);
    const minutes = Math.floor((elapsedSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }

  function formatCloseReason(closeReason?: string): string {
    if (!closeReason || closeReason.trim().length === 0) {
      return "-";
    }

    return closeReason
      .split("_")
      .filter((part) => part.length > 0)
      .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
      .join(" ");
  }

  async function reopenLastClosedTrade(symbol: string): Promise<void> {
    if (!manualControlsEnabled) {
      setReopenFeedback("Reopen is locked by the current plan.");
      return;
    }

    setReopenPendingSymbol(symbol);
    setReopenFeedback(null);

    try {
      const response = await fetch(`${API_BASE}/api/trades/reopen-last?mode=${tradeMode}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ symbol })
      });

      const payload = (await response.json()) as {
        reopened?: boolean;
        reason?: string;
        reopenedTradeId?: string;
        error?: string;
        details?: string;
        snapshot?: ApiResponse["tradeSimulation"];
      };

      if (!response.ok || !payload.reopened || !payload.snapshot) {
        const reason = payload.reason ?? payload.error ?? payload.details ?? "Failed to reopen trade";
        throw new Error(reason);
      }

      setData((previous) => {
        if (!previous) {
          return previous;
        }

        return {
          ...previous,
          tradeSimulation: payload.snapshot
        };
      });

      setReopenFeedback(`Reopened ${symbol} as ${payload.reopenedTradeId ?? "new trade"}.`);
      setError(null);
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : String(actionError);
      setReopenFeedback(`Reopen failed for ${symbol}: ${message}`);
    } finally {
      setReopenPendingSymbol(null);
    }
  }

  async function closeOpenTrade(symbol: string): Promise<void> {
    if (!manualControlsEnabled) {
      setReopenFeedback("Close is locked by the current plan.");
      return;
    }

    setClosePendingSymbol(symbol);
    setReopenFeedback(null);

    try {
      const response = await fetch(`${API_BASE}/api/trades/close-symbol?mode=${tradeMode}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ symbol })
      });

      const payload = (await response.json()) as {
        symbol?: string;
        closedCount?: number;
        stats?: TradeSimulationSnapshot["stats"];
        activeTrades?: TradeSimulationSnapshot["activeTrades"];
        recentClosedTrades?: TradeSimulationSnapshot["recentClosedTrades"];
        error?: string;
        details?: string;
      };

      if (!response.ok || !payload.stats || !payload.activeTrades || !payload.recentClosedTrades) {
        const reason = payload.error ?? payload.details ?? "Failed to close trade";
        throw new Error(reason);
      }

      const stats = payload.stats;
      const activeTrades = payload.activeTrades;
      const recentClosedTrades = payload.recentClosedTrades;

      setData((previous) => {
        if (!previous) {
          return previous;
        }

        return {
          ...previous,
          tradeSimulation: {
            stats,
            activeTrades,
            recentClosedTrades
          }
        };
      });

      setReopenFeedback(`Closed ${symbol} (${payload.closedCount ?? 0} trade${(payload.closedCount ?? 0) === 1 ? "" : "s"}).`);
      setError(null);
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : String(actionError);
      setReopenFeedback(`Close failed for ${symbol}: ${message}`);
    } finally {
      setClosePendingSymbol(null);
    }
  }

  async function resetTradeSimulation(): Promise<void> {
    if (!manualControlsEnabled) {
      setReopenFeedback("Reset is locked by the current plan.");
      return;
    }

    const baseline = Number(currentTradeData?.stats.initialCapitalUsd ?? 350).toFixed(2);
    const confirmed = window.confirm(
      `Reset trade simulation? This clears active trades, recent closed trades, cooldowns, and resets the starting balance to $${baseline}.`
    );
    if (!confirmed) {
      return;
    }

    setResettingSimulation(true);
    setReopenFeedback(null);

    try {
      const response = await fetch(`${API_BASE}/api/trades/reset?mode=${tradeMode}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        }
      });

      const payload = (await response.json()) as {
        reset?: boolean;
        snapshot?: TradeSimulationSnapshot;
        stats?: TradeSimulationSnapshot["stats"];
        activeTrades?: TradeSimulationSnapshot["activeTrades"];
        recentClosedTrades?: TradeSimulationSnapshot["recentClosedTrades"];
        error?: string;
        details?: string;
      };

      const stats = payload.stats ?? payload.snapshot?.stats;
      const activeTrades = payload.activeTrades ?? payload.snapshot?.activeTrades;
      const recentClosedTrades = payload.recentClosedTrades ?? payload.snapshot?.recentClosedTrades;

      if (!response.ok || !payload.reset || !stats || !activeTrades || !recentClosedTrades) {
        const reason = payload.error ?? payload.details ?? "Failed to reset trade simulation";
        throw new Error(reason);
      }

      setData((previous) => {
        if (!previous) {
          return previous;
        }

        return {
          ...previous,
          tradeSimulation: {
            stats,
            activeTrades,
            recentClosedTrades
          }
        };
      });

      setReopenFeedback("Trade simulation reset completed.");
      setError(null);
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : String(actionError);
      setReopenFeedback(`Reset failed: ${message}`);
    } finally {
      setResettingSimulation(false);
    }
  }

  async function detectPrePumpCandidates(): Promise<void> {
    if (!manualControlsEnabled) {
      setReopenFeedback("Pre-pump detection is locked by the current plan.");
      return;
    }

    setDetectingPrePump(true);
    setReopenFeedback(null);
    setPrePumpDetection(null);

    try {
      const response = await fetch(`${API_BASE}/api/trades/detect-pre-pump?mode=${tradeMode}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ maxTokens: 20 })
      });

      const payload = (await response.json()) as {
        scanned?: number;
        eligibleCount?: number;
        candidates?: PrePumpCandidate[];
        rejectionSummary?: Array<{ reason: string; count: number }>;
        nearMisses?: Array<{
          symbol: string;
          score: number;
          reason: string;
          details?: Record<string, unknown>;
          volume24h: number;
          signalType: string;
          volatilityPercentile: number;
          intermediaryRsi: number;
        }>;
        error?: string;
        details?: string;
      };

      if (!response.ok || !Array.isArray(payload.candidates)) {
        throw new Error(payload.error ?? payload.details ?? "Failed to run pre-pump detection");
      }

      const result: PrePumpDetectionResponse = {
        scanned: payload.scanned ?? 0,
        eligibleCount: payload.eligibleCount ?? payload.candidates.length,
        candidates: payload.candidates,
        rejectionSummary: payload.rejectionSummary ?? [],
        nearMisses: payload.nearMisses ?? []
      };
      setPrePumpDetection(result);
      setReopenFeedback(`Detected ${result.eligibleCount} pre-pump candidate${result.eligibleCount === 1 ? "" : "s"} from ${result.scanned} scanned tokens.`);
      setError(null);
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : String(actionError);
      setReopenFeedback(`Pre-pump detection failed: ${message}`);
    } finally {
      setDetectingPrePump(false);
    }
  }

  function renderEntryTypeBadge(
    entryType: "STRONG" | "CONTINUATION" | "REVERSAL" | "SCORE_BASED",
    entryScore: number
  ) {
    const safeScore = Number.isFinite(entryScore) ? entryScore : 0;
    return (
      <span className={`entry-type ${entryType.toLowerCase()}`}>
        {entryType}
        <span className="entry-score">Score: {safeScore}/10</span>
      </span>
    );
  }

  function renderAssetTypeBadge(assetType?: "LARGE_CAP" | "ALT") {
    const type = assetType ?? "ALT";
    const label = type === "LARGE_CAP" ? "LARGE CAP" : "ALT";
    return <span className={`asset-type ${type.toLowerCase()}`}>{label}</span>;
  }

  function renderTPBadge(takeProfitPct?: number) {
    const tp = takeProfitPct ?? 15;
    return <span className="tp-badge">TP {tp}%</span>;
  }

  function renderEntryTimingBadge(
    entryTiming?: "EARLY" | "MID" | "LATE" | null,
    direction?: "LONG" | "SHORT" | null,
    status?: RsiRow["status"] | null
  ) {
    if (!entryTiming) {
      return <span className="entry-timing unknown" title={describeEntryTimingPlainEnglish(entryTiming)}>N/A</span>;
    }

    const suffix = direction ? ` ${direction}` : "";
    const hasExhaustionConflict =
      (direction === "LONG" && status === "OVERBOUGHT") ||
      (direction === "SHORT" && status === "OVERSOLD");
    const label = hasExhaustionConflict
      ? `Caution${suffix}`
      : entryTiming === "EARLY"
        ? `Prepare${suffix}`
        : entryTiming === "MID"
          ? `Build${suffix}`
          : `Caution${suffix}`;

    const directionClass = direction ? direction.toLowerCase() : "neutral";
    return <span className={`entry-timing ${entryTiming.toLowerCase()} ${directionClass}`} title={describeEntryTimingPlainEnglish(entryTiming)}>{label}</span>;
  }

  function toggleTradeSort(key: TradeSortKey): void {
    setTradeSort((previous) => {
      if (previous.key === key) {
        return {
          key,
          direction: previous.direction === "asc" ? "desc" : "asc"
        };
      }

      return {
        key,
        direction: "desc"
      };
    });
  }

  function renderSortIndicator(key: TradeSortKey): string {
    if (tradeSort.key !== key) {
      return "";
    }

    return tradeSort.direction === "asc" ? " ▲" : " ▼";
  }

  function toggleResultSort(key: ResultSortKey): void {
    setResultSort((previous) => {
      if (previous.key === key) {
        return {
          key,
          direction: previous.direction === "asc" ? "desc" : "asc"
        };
      }

      return {
        key,
        direction: "desc"
      };
    });
  }

  function renderResultSortIndicator(key: ResultSortKey): string {
    if (resultSort.key !== key) {
      return "";
    }

    return resultSort.direction === "asc" ? " ▲" : " ▼";
  }

  function toggleSection(section: DashboardSectionKey): void {
    setCollapsedSections((previous) => ({
      ...previous,
      [section]: !previous[section]
    }));
  }

  function scrollToSection(sectionId: string): void {
    const target = document.getElementById(sectionId);
    if (!target) {
      return;
    }

    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function toggleSimulationBlock(block: SimulationBlockKey): void {
    setCollapsedSimulationBlocks((previous) => ({
      ...previous,
      [block]: !previous[block]
    }));
  }

  function setAllSimulationBlocksCollapsed(collapsed: boolean): void {
    setCollapsedSimulationBlocks({
      stats: collapsed,
      reasons: collapsed,
      active: collapsed,
      closed: collapsed
    });
  }

  function switchDashboardView(nextView: DashboardView): void {
    setActiveView(nextView);
  }

  return (
    <main id="section-top" className="shell">


      {error ? <p className="error">{error}</p> : null}

      <div className="workspace-layout">
      <div className="workspace-content">
      {activeView === "simulation" ? (
      <section id="section-simulation" className="panel simulation-panel">
        <div className="table-header">
          <h2>Trade Simulation</h2>
          <div className="simulation-header-actions">
            <span>
              Starting ${Number(currentTradeData?.stats.initialCapitalUsd ?? 350).toFixed(2)} | P/L {(currentTradeData?.stats.totalPnlUsd ?? 0) >= 0 ? "+" : ""}${Number(currentTradeData?.stats.totalPnlUsd ?? 0).toFixed(2)} | Balance ${Number((currentTradeData?.stats.initialCapitalUsd ?? 350) + (currentTradeData?.stats.totalPnlUsd ?? 0)).toFixed(2)} | Stake ≤ ${Number(currentTradeData?.stats.stakePerTradeUsd ?? 100).toFixed(2)} @ {currentTradeData?.stats.leverage ?? 3}x | Max Active {currentTradeData?.stats.maxActiveTrades ?? 1}
            </span>
            <button
              type="button"
              className="reset-sim-btn"
              onClick={() => void resetTradeSimulation()}
              disabled={resettingSimulation || !manualControlsEnabled}
            >
              {!manualControlsEnabled ? "Locked" : resettingSimulation ? "Resetting..." : "Reset Simulation"}
            </button>
            <button
              type="button"
              className="reset-sim-btn"
              onClick={() => void detectPrePumpCandidates()}
              disabled={detectingPrePump || !manualControlsEnabled}
            >
              {!manualControlsEnabled ? "Locked" : detectingPrePump ? "Detecting..." : "Detect Pre-pump"}
            </button>
            <button
              type="button"
              className="section-toggle-btn"
              onClick={() => toggleSection("simulation")}
            >
              {collapsedSections.simulation ? "Expand" : "Collapse"}
            </button>
          </div>
        </div>
        {!collapsedSections.simulation ? (
          <>
            <div className="simulation-subsection-controls">
              <button type="button" className="section-toggle-btn" onClick={() => setAllSimulationBlocksCollapsed(false)}>Expand All</button>
              <button type="button" className="section-toggle-btn" onClick={() => setAllSimulationBlocksCollapsed(true)}>Collapse All</button>
            </div>

            <div className="simulation-subsection">
              <div className="simulation-subsection-header">
                <h3>Performance Snapshot</h3>
                <button type="button" className="section-toggle-btn" onClick={() => toggleSimulationBlock("stats")}>
                  {collapsedSimulationBlocks.stats ? "Expand" : "Collapse"}
                </button>
              </div>
              {!collapsedSimulationBlocks.stats ? (
                <div className="sim-stats-grid">
                  <article className="sim-stat">
                    <p>Win Rate</p>
                    <strong>{(currentTradeData?.stats.winRate ?? 0).toFixed(2)}%</strong>
                  </article>
                  <article className="sim-stat">
                    <p>Loss Rate</p>
                    <strong>{lossRate.toFixed(2)}%</strong>
                  </article>
                  <article className="sim-stat">
                    <p>Wins / Losses</p>
                    <strong>{wins} / {losses}</strong>
                  </article>
                  <article className="sim-stat">
                    <p>Active / Total Trades</p>
                    <strong>{currentTradeData?.stats.activeTrades ?? 0} / {currentTradeData?.stats.totalTrades ?? 0}</strong>
                  </article>
                  <article className="sim-stat">
                    <p>Starting Balance</p>
                    <strong>${Number(currentTradeData?.stats.initialCapitalUsd ?? 350).toFixed(2)}</strong>
                  </article>
                  <article className="sim-stat">
                    <p>Total P/L</p>
                    <strong className={(currentTradeData?.stats.totalPnlUsd ?? 0) >= 0 ? "pnl-positive" : "pnl-negative"}>
                      {(currentTradeData?.stats.totalPnlUsd ?? 0) >= 0 ? "+" : ""}${Number(currentTradeData?.stats.totalPnlUsd ?? 0).toFixed(2)}
                    </strong>
                  </article>
                  <article className="sim-stat">
                    <p>Total Balance</p>
                    <strong>${Number((currentTradeData?.stats.initialCapitalUsd ?? 350) + (currentTradeData?.stats.totalPnlUsd ?? 0)).toFixed(2)}</strong>
                  </article>
                  <article className="sim-stat">
                    <p>Sentiment-Shift Exits</p>
                    <strong>{currentTradeData?.stats.sentimentShiftClosedTrades ?? 0}</strong>
                  </article>
                </div>
              ) : (
                <p className="section-collapsed-note">Performance Snapshot is collapsed.</p>
              )}
            </div>

            <div className="simulation-subsection trade-table-wrap">
              <div className="simulation-subsection-header">
                <h3>Why No Trades</h3>
              </div>
              <div className="asset-rejection-detail">
                <div className="asset-rejection-grid">
                  <p>
                    <strong>Simulation trades:</strong> {currentTradeData?.stats.totalTrades ?? 0}
                  </p>
                  <p>
                    <strong>Active trades:</strong> {currentTradeData?.stats.activeTrades ?? 0}
                  </p>
                  <p>
                    <strong>Current scan signals:</strong> {data?.signalCounts ? `${(data.signalCounts.strongLong ?? 0) + (data.signalCounts.strongShort ?? 0) + (data.signalCounts.continuationLong ?? 0) + (data.signalCounts.continuationShort ?? 0) + (data.signalCounts.reversalLong ?? 0) + (data.signalCounts.reversalShort ?? 0)} directional / ${data.signalCounts.noSignal ?? 0} no-signal` : "N/A"}
                  </p>
                  <p>
                    <strong>Rejection log:</strong> {latestTradeRejections.length} recent entries
                  </p>
                </div>
              </div>

              <div className="asset-rejection-detail">
                <h4>Top Blocking Reasons</h4>
                <div className="asset-rejection-grid">
                  {tradeRejectionBreakdown.length > 0 ? (
                    tradeRejectionBreakdown.map((item) => (
                      <p key={item.reason}>
                        <strong>{formatCloseReason(item.reason)}:</strong> {item.count}
                      </p>
                    ))
                  ) : (
                    <p>No trade rejection history loaded yet.</p>
                  )}
                </div>
              </div>

              <div className="asset-rejection-detail">
                <h4>Top Rejected Signals</h4>
                <div className="asset-rejection-grid">
                  {tradeRejectionSignalBreakdown.length > 0 ? (
                    tradeRejectionSignalBreakdown.map((item) => (
                      <p key={item.signal}>
                        <strong>{item.signal}:</strong> {item.count}
                      </p>
                    ))
                  ) : (
                    <p>No rejection signals loaded yet.</p>
                  )}
                </div>
              </div>

              {latestGlobalRuntimeRejection ? (
                <div className="asset-rejection-detail">
                  <h4>Global Blocker</h4>
                  <div className="asset-rejection-grid">
                    <p>
                      <strong>Reason:</strong> {latestGlobalRuntimeRejection.reason}
                    </p>
                    {latestGlobalRuntimeRejection.details?.hourUtc != null ? (
                      <p>
                        <strong>UTC hour:</strong> {formatUnknownValue(latestGlobalRuntimeRejection.details.hourUtc)}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="simulation-subsection trade-table-wrap">
              <div className="simulation-subsection-header">
                <h3>Close Reason Breakdown</h3>
                <button type="button" className="section-toggle-btn" onClick={() => toggleSimulationBlock("reasons")}>
                  {collapsedSimulationBlocks.reasons ? "Expand" : "Collapse"}
                </button>
              </div>
              {!collapsedSimulationBlocks.reasons ? (
                <table className="trade-table">
                  <thead>
                    <tr>
                      <th>Reason</th>
                      <th>Count</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closeReasonBreakdown.length > 0 ? (
                      closeReasonBreakdown.slice(0, 10).map((entry) => (
                        <tr key={entry.reason}>
                          <td>{formatCloseReason(entry.reason)}</td>
                          <td>{entry.count}</td>
                          <td>{entry.pct.toFixed(1)}%</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={3}>No close reasons recorded yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : (
                <p className="section-collapsed-note">Close Reason Breakdown is collapsed.</p>
              )}
            </div>

            <div className="simulation-subsection trade-table-wrap">
              <div className="simulation-subsection-header">
                <h3>Active Trades</h3>
                <button type="button" className="section-toggle-btn" onClick={() => toggleSimulationBlock("active")}>
                  {collapsedSimulationBlocks.active ? "Expand" : "Collapse"}
                </button>
              </div>
              {!collapsedSimulationBlocks.active ? (
                <table className="trade-table">
            <thead>
              <tr>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("token")}>Token{renderSortIndicator("token")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("marketCap")}>Market Cap{renderSortIndicator("marketCap")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("direction")}>Direction{renderSortIndicator("direction")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("size")}>Size (Token){renderSortIndicator("size")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("assetType")}>Asset Type{renderSortIndicator("assetType")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("entryType")}>Entry Type{renderSortIndicator("entryType")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("entryTiming")}>Timing Context{renderSortIndicator("entryTiming")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("tpPct")}>TP %{renderSortIndicator("tpPct")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("entry")}>Entry{renderSortIndicator("entry")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("mark")}>Mark{renderSortIndicator("mark")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("positionValue")}>Position Value{renderSortIndicator("positionValue")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("roe")}>ROE %{renderSortIndicator("roe")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("pnlUsd")}>PnL USD{renderSortIndicator("pnlUsd")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("liqPrice")}>Liq. Price (Est){renderSortIndicator("liqPrice")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("margin")}>Margin{renderSortIndicator("margin")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("fundingRate")}>Funding Rate{renderSortIndicator("fundingRate")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("fundingPnl")}>Funding PnL{renderSortIndicator("fundingPnl")}</button></th>
                <th>TP / SL</th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("distTp")}>Dist TP %{renderSortIndicator("distTp")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("distSl")}>Dist SL %{renderSortIndicator("distSl")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("stake")}>Stake{renderSortIndicator("stake")}</button></th>
                <th>Progress</th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("status")}>Status{renderSortIndicator("status")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("timeInTrade")}>Time In Trade{renderSortIndicator("timeInTrade")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("openedAt")}>Opened{renderSortIndicator("openedAt")}</button></th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedActiveTrades.length ? (
                sortedActiveTrades.map((trade) => {
                  const fallbackPnlPct =
                    trade.direction === "LONG"
                      ? ((trade.currentPrice - trade.entryPrice) / trade.entryPrice) * trade.leverage * 100
                      : ((trade.entryPrice - trade.currentPrice) / trade.entryPrice) * trade.leverage * 100;
                  const currentPnlPct = trade.currentPnlPct ?? fallbackPnlPct;
                  const roePct = trade.roePct ?? currentPnlPct;
                  const currentPnlUsd = trade.currentPnlUsd ?? (trade.stakeUsd * (currentPnlPct / 100));
                  const markPrice = trade.markPrice ?? trade.currentPrice;
                  const positionValueUsd =
                    trade.positionValueUsd ??
                    (trade.stakeUsd * trade.leverage * (markPrice / trade.entryPrice));
                  const sizeBaseUnits =
                    trade.sizeBaseUnits ??
                    ((trade.stakeUsd * trade.leverage) / (trade.entryPrice > 0 ? trade.entryPrice : 1));
                  const marginUsedUsd = trade.marginUsedUsd ?? trade.stakeUsd;
                  const fundingRatePct = (trade.fundingRate ?? 0) * 100;
                  const fundingAccruedUsd = trade.fundingAccruedUsd ?? 0;
                  const liqPriceEstimate =
                    trade.estimatedLiqPrice ??
                    (trade.direction === "LONG"
                      ? trade.entryPrice * (1 - Math.max((1 / trade.leverage) - 0.005, 0.01))
                      : trade.entryPrice * (1 + Math.max((1 / trade.leverage) - 0.005, 0.01)));
                  const distanceToTP =
                    trade.distanceToTP ?? (((trade.tpPrice - trade.currentPrice) / trade.currentPrice) * 100);
                  const distanceToSL =
                    trade.distanceToSL ?? (((trade.currentPrice - trade.slPrice) / trade.currentPrice) * 100);
                  const entryType = trade.entryType ?? trade.signalCategory ?? "SCORE_BASED";
                  const entryTiming = trade.entryTiming ?? null;
                  const entryScore = trade.entryScore ?? 0;
                  const riskPctUsed = trade.riskPctUsed ?? 2;
                  const assetType = trade.assetType ?? "ALT";
                  const takeProfitPct = trade.takeProfitPct ?? 15;
                  const marketCondition = trade.marketCondition ?? "RANGING";
                  const stakeSourceLabel = formatStakeSourceLabel(trade.stakeSource);

                  const tradePnlClass = currentPnlUsd > 0 ? "pnl-positive" : currentPnlUsd < 0 ? "pnl-negative" : "pnl-neutral";
                  const progressDenominator = trade.tpPrice - trade.slPrice;
                  const progressRaw =
                    progressDenominator === 0
                      ? 0.5
                      : (trade.currentPrice - trade.slPrice) / progressDenominator;
                  const progressClamped = Math.max(0, Math.min(1, progressRaw));
                  const progress = progressClamped * 100;
                  const progressHue = Math.round(progressClamped * 120);
                  const progressColor = `hsl(${progressHue}, 80%, 58%)`;
                  const tradeDebugTitle = [
                    `Signal: ${trade.signalType}`,
                    `Score: ${entryScore}/10`,
                    `Opened: ${new Date(trade.openTime).toLocaleString()}`,
                    `Risk Used: ${riskPctUsed.toFixed(2)}%`,
                    `Asset: ${assetType}`,
                    `TP Target: ${takeProfitPct}%`,
                    `Market: ${marketCondition}`,
                    `Stake Source: ${stakeSourceLabel}`
                  ].join("\n");

                  return (
                    <tr key={trade.id} title={tradeDebugTitle} className={`asset-type-row ${assetType.toLowerCase()}`}>
                      <td>
                        <span>{trade.token.replace(/-PERP$/i, "").replace(/-USDT-SWAP$/i, "").replace(/-USDT$/i, "")}</span>
                        <span style={{ display: "block", fontSize: "0.75em", opacity: 0.6 }}>{getTokenDisplayName(trade.token.replace(/-PERP$/i, "").replace(/-USDT-SWAP$/i, "").replace(/-USDT$/i, ""))}</span>
                      </td>
                      <td>{formatMarketCap(getMarketCapUsd(trade.token))}</td>
                      <td className={`dir ${trade.direction.toLowerCase()}`}>
                        {trade.direction === "LONG" ? "↑ LONG" : "↓ SHORT"}
                      </td>
                      <td>{sizeBaseUnits.toFixed(2)} {trade.token.replace(/-PERP$/i, "").replace(/-USDT-SWAP$/i, "").replace(/-USDT$/i, "")}</td>
                      <td>{renderAssetTypeBadge(assetType)}</td>
                      <td>{renderEntryTypeBadge(entryType, entryScore)}</td>
                      <td>{renderEntryTimingBadge(entryTiming, trade.direction)}</td>
                      <td>{renderTPBadge(takeProfitPct)}</td>
                      <td>{trade.entryPrice.toLocaleString()}</td>
                      <td>{markPrice.toLocaleString()}</td>
                      <td className={tradePnlClass}>{positionValueUsd.toFixed(2)} USD</td>
                      <td className={tradePnlClass}>{roePct.toFixed(2)}%</td>
                      <td className={tradePnlClass}>{currentPnlUsd.toFixed(2)} USD</td>
                      <td>{liqPriceEstimate.toLocaleString()}</td>
                      <td>{marginUsedUsd.toFixed(2)} USD</td>
                      <td className={fundingRatePct >= 0 ? "pnl-negative" : "pnl-positive"}>{fundingRatePct.toFixed(4)}%</td>
                      <td className={fundingAccruedUsd >= 0 ? "pnl-positive" : "pnl-negative"}>{fundingAccruedUsd.toFixed(4)} USD</td>
                      <td>{trade.tpPrice.toLocaleString()} / {trade.slPrice.toLocaleString()}</td>
                      <td>{distanceToTP.toFixed(2)}%</td>
                      <td>{distanceToSL.toFixed(2)}%</td>
                      <td>
                        <div>{trade.stakeUsd.toFixed(2)} USD</div>
                        <div style={{ fontSize: "0.72em", opacity: 0.72 }}>{stakeSourceLabel}</div>
                      </td>
                      <td>
                        <div className="trade-progress" title={`Progress ${progress.toFixed(1)}%`}>
                          <span className="trade-progress-fill" style={{ width: `${progress}%`, background: progressColor }} />
                        </div>
                      </td>
                      <td><span className={`trade-status ${trade.status.toLowerCase()}`}>{trade.status}</span></td>
                      <td>{formatTimeInTrade(trade.openTime)}</td>
                      <td>{new Date(trade.openTime).toLocaleTimeString()}</td>
                      <td>
                        <button
                          type="button"
                          className="close-btn"
                          disabled={closePendingSymbol !== null || !manualControlsEnabled}
                          onClick={() => void closeOpenTrade(trade.token)}
                        >
                          {!manualControlsEnabled ? "Locked" : closePendingSymbol === trade.token ? "Closing..." : "Close"}
                        </button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={27}>No active simulated trades.</td>
                </tr>
              )}
            </tbody>
                </table>
              ) : (
                <p className="section-collapsed-note">Active Trades is collapsed.</p>
              )}
            </div>

            <div className="simulation-subsection trade-table-wrap">
              <div className="simulation-subsection-header">
                <h3>Recent Closed Trades</h3>
                <button type="button" className="section-toggle-btn" onClick={() => toggleSimulationBlock("closed")}>
                  {collapsedSimulationBlocks.closed ? "Expand" : "Collapse"}
                </button>
              </div>
              {reopenFeedback ? <p className="trade-action-feedback">{reopenFeedback}</p> : null}
              {!collapsedSimulationBlocks.closed ? (
                <table className="trade-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Direction</th>
                <th>Result</th>
                <th>Result (USD)</th>
                <th>Reason</th>
                <th>Time To Close</th>
                <th>Max DD</th>
                <th>Closed</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {currentTradeData?.recentClosedTrades?.length ? (
                currentTradeData.recentClosedTrades.slice(0, 20).map((trade: any) => (
                  <tr key={trade.id}>
                    <td>{trade.token}</td>
                    <td className={`dir ${trade.direction.toLowerCase()}`}>{trade.direction}</td>
                    <td className={(trade.result ?? 0) >= 0 ? "pnl-positive" : "pnl-negative"}>
                      {(trade.result ?? 0).toFixed(2)}%
                    </td>
                    <td className={(trade.resultUsd ?? 0) >= 0 ? "pnl-positive" : "pnl-negative"}>
                      {(trade.resultUsd ?? 0).toFixed(2)} USD
                    </td>
                    <td>{formatCloseReason(trade.closeReason)}</td>
                    <td>{trade.timeToClose ?? 0}m</td>
                    <td>{(trade.maxDrawdown ?? 0).toFixed(2)}%</td>
                    <td>{trade.closeTime ? new Date(trade.closeTime).toLocaleTimeString() : "-"}</td>
                    <td>
                      <button
                        type="button"
                        className="reopen-btn"
                        disabled={reopenPendingSymbol !== null || !manualControlsEnabled}
                        onClick={() => void reopenLastClosedTrade(trade.token)}
                      >
                        {!manualControlsEnabled ? "Locked" : reopenPendingSymbol === trade.token ? "Reopening..." : "Reopen"}
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={9}>No closed simulated trades yet.</td>
                </tr>
              )}
            </tbody>
                </table>
              ) : (
                <p className="section-collapsed-note">Recent Closed Trades is collapsed.</p>
              )}
            </div>
          </>
        ) : (
          <p className="section-collapsed-note">Trade Simulation section is collapsed. Use Expand to view stats and tables.</p>
        )}
      </section>
  ) : null}

  {activeView === "results" ? (
  <section id="section-results" className="panel table-panel">
        <div className="table-header">
          <div className="table-header-title-wrap">
            <h2>Multi-Timeframe Alignment Results</h2>
            <button
              type="button"
              className="section-toggle-btn"
              onClick={() => toggleSection("results")}
            >
              {collapsedSections.results ? "Expand" : "Collapse"}
            </button>
          </div>
          <span className="scan-meta">
            {strongShortRows.length > 0 && <span className="badge-short">{strongShortRows.length} SHORT</span>}
            {strongLongRows.length > 0 && <span className="badge-long">{strongLongRows.length} LONG</span>}
            {continuationShortRows.length > 0 && <span className="badge-short">{continuationShortRows.length} CONT SHORT</span>}
            {continuationLongRows.length > 0 && <span className="badge-long">{continuationLongRows.length} CONT LONG</span>}
            {reversalShortRows.length > 0 && <span className="badge-short">{reversalShortRows.length} REV SHORT</span>}
            {reversalLongRows.length > 0 && <span className="badge-long">{reversalLongRows.length} REV LONG</span>}
            <span>{tradeReadyRows.length} ENTER NOW / {visibleResults.length} IN VIEW</span>
            <span>{noSignalRows.length} NO SIGNAL</span>
            <span>
              Chunk {(data?.service?.chunkIndex ?? 0) + 1}
              {" / "}
              {Math.max(1, Math.ceil((data?.service?.universeSize ?? 0) / Math.max(1, data?.service?.chunkSize ?? 1)))}
              {" · Universe: "}
              {data?.service?.universeSize ?? displayResults.length}
            </span>
            <span>{data ? `Last scan: ${new Date(data.analyzedAt).toLocaleString()}` : "No scan yet"}</span>
          </span>
        </div>

        {!collapsedSections.results ? (
          <>

            {data?.candlestickStats ? (
          <div className="notice" style={{ marginBottom: "0.75rem" }}>
            <strong>Candlestick Hits:</strong>
            {" "}
            {data.candlestickStats.rowsWithPatterns}/{data.candlestickStats.totalRows} rows with patterns
            {" · "}
            directional alignment {data.candlestickStats.rowsWithPatterns > 0
              ? `${((data.candlestickStats.alignedWithDirectionalSignal / data.candlestickStats.rowsWithPatterns) * 100).toFixed(1)}%`
              : "0.0%"}
            {topCandlestickPatterns.length > 0 ? (
              <span>
                {" · Top: "}
                {topCandlestickPatterns.map((pattern) => (
                  <span key={pattern.name} className="badge-neutral" style={{ marginLeft: "0.35rem" }}>
                    {pattern.name.replaceAll("_", " ")} {pattern.hits} ({pattern.alignmentPct}%)
                  </span>
                ))}
              </span>
            ) : null}
          </div>
            ) : null}

            <div className="momentum-scout-panel">
              <div className="momentum-scout-header">
                <div>
                  <h3>Early-Run Candidates</h3>
                  <p>Daily and weekly RSI/Stoch RSI + 24h/48h move + volume ignition + breakout proximity.</p>
                </div>
                <div className="momentum-scout-actions">
                  <span className="badge-neutral">Strict {momentumSnapshot?.candidatesStrict ?? 0}</span>
                  <span className="badge-neutral">Near {momentumSnapshot?.candidatesNear ?? 0}</span>
                  <button
                    type="button"
                    className="section-toggle-btn"
                    onClick={() => void loadMomentumCandidates(true)}
                    disabled={momentumLoading}
                  >
                    {momentumLoading ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
              </div>

              <p className="momentum-scout-meta">
                Universe {momentumSnapshot?.universeSize ?? "-"}
                {" · "}
                Latest H1 {momentumSnapshot?.dataFreshness.latestH1 ? new Date(momentumSnapshot.dataFreshness.latestH1).toLocaleString() : "-"}
                {" · "}
                Latest D1 {momentumSnapshot?.dataFreshness.latestD1 ? new Date(momentumSnapshot.dataFreshness.latestD1).toLocaleString() : "-"}
              </p>

              {momentumError ? <p className="momentum-scout-error">{momentumError}</p> : null}

              {!momentumError && momentumRows.length === 0 ? (
                <p className="momentum-scout-empty">No clean early-run setups right now. Market is mostly either extended or still unconfirmed.</p>
              ) : null}

              {momentumRows.length > 0 ? (
                <div className="momentum-scout-table-wrap">
                  <table className="momentum-scout-table">
                    <thead>
                      <tr>
                        <th>Token</th>
                        <th>Score</th>
                        <th>24h</th>
                        <th>48h</th>
                        <th>Vol 24h/Prev</th>
                        <th>Vol Daily/20d</th>
                        <th>D1 RSI</th>
                        <th>D1 K/D</th>
                        <th>W1 K/D</th>
                        <th>Dist 20d High</th>
                      </tr>
                    </thead>
                    <tbody>
                      {momentumRows.slice(0, 12).map((row) => (
                        <tr key={row.symbol}>
                          <td>{row.symbol}</td>
                          <td>{row.score.toFixed(1)}</td>
                          <td>{row.move24hPct.toFixed(2)}%</td>
                          <td>{row.move48hPct.toFixed(2)}%</td>
                          <td>{row.vol24hVsPrev24h.toFixed(2)}x</td>
                          <td>{row.dailyVolVs20dAvg.toFixed(2)}x</td>
                          <td>{row.dailyRsi14 != null ? row.dailyRsi14.toFixed(2) : "-"}</td>
                          <td>
                            {row.dailyStochRsiK != null && row.dailyStochRsiD != null
                              ? `${row.dailyStochRsiK.toFixed(1)} / ${row.dailyStochRsiD.toFixed(1)}`
                              : "-"}
                          </td>
                          <td>
                            {row.weeklyStochRsiK != null && row.weeklyStochRsiD != null
                              ? `${row.weeklyStochRsiK.toFixed(1)} / ${row.weeklyStochRsiD.toFixed(1)}`
                              : "-"}
                          </td>
                          <td>{row.distanceFrom20dHighPct != null ? `${row.distanceFrom20dHighPct.toFixed(2)}%` : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>

            <div className="category-tabs" role="tablist" aria-label="Token category filters">
          {CATEGORY_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`category-tab ${selectedCategory === tab.key ? "active" : ""}`}
              onClick={() => setSelectedCategory(tab.key)}
              role="tab"
              aria-selected={selectedCategory === tab.key}
            >
              {tab.label}
              <span className="category-count">{categoryCounts[tab.key]}</span>
            </button>
          ))}
          <button
            type="button"
            className={`category-tab pre-pump-tab ${showPrePumpOnly ? "active" : ""}`}
            onClick={() => setShowPrePumpOnly((prev) => !prev)}
            aria-pressed={showPrePumpOnly}
            title="Filter rows to pre-pump watch candidates"
          >
            Pre-pump Watch
            <span className="category-count">{prePumpWatchCount}</span>
          </button>
            </div>

            <div className="results-filter-bar" aria-label="Results filters">
              <label className="results-filter-field results-filter-search">
                <span>Token</span>
                <input
                  type="text"
                  value={tokenFilterText}
                  onChange={(event) => setTokenFilterText(event.target.value)}
                  placeholder="Search token symbol or name"
                  aria-label="Filter by token symbol or name"
                />
              </label>

              <label className="results-filter-field">
                <span>Status</span>
                <select
                  value={selectedStatusFilter}
                  onChange={(event) => setSelectedStatusFilter(event.target.value as StatusFilter)}
                  aria-label="Filter by status"
                >
                  <option value="ALL">All statuses</option>
                  <option value="OVERBOUGHT">Overbought</option>
                  <option value="OVERSOLD">Oversold</option>
                </select>
              </label>

              <label className="results-filter-field">
                <span>Imbalance</span>
                <select
                  value={selectedImbalanceFilter}
                  onChange={(event) => setSelectedImbalanceFilter(event.target.value as ImbalanceFilter)}
                  aria-label="Filter by order book imbalance"
                >
                  <option value="ALL">All imbalance</option>
                  <option value="LONG_DOMINANT">Long-dominant (bids &gt; asks)</option>
                  <option value="SHORT_DOMINANT">Short-dominant (asks &gt; bids)</option>
                </select>
              </label>
            </div>

            {visibleResults.length > 0 && tradeReadyRows.length === 0 ? (
          <div className="notice no-ready-notice">
            No ENTER NOW signals right now. The scan is live, but the rules are still filtering entries out.
          </div>
            ) : null}

            <div className="table-wrap">
          <table className="timeframe-table">
            <thead>
              <tr>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("token")}>Token{renderResultSortIndicator("token")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("marketCap")}>Market Cap{renderResultSortIndicator("marketCap")}</button></th>
                <th className="price-col-header"><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("price")}>Price{renderResultSortIndicator("price")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("volume24h")}>24h Volume{renderResultSortIndicator("volume24h")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("volatility")}>Volatility{renderResultSortIndicator("volatility")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("readiness")}>Readiness{renderResultSortIndicator("readiness")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("signal")}>Signal{renderResultSortIndicator("signal")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("prePump")}>Pre-pump{renderResultSortIndicator("prePump")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("liquidityHunt")}>Liquidity Hunt{renderResultSortIndicator("liquidityHunt")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("entryTiming")}>Timing Context{renderResultSortIndicator("entryTiming")}</button></th>
                <th>Trend Map</th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("score")}>Score{renderResultSortIndicator("score")}</button></th>
              </tr>
            </thead>
            <tbody>
              {sortedVisibleResults.length > 0 ? sortedVisibleResults.map((row) => {
                const expanded = expandedSymbols[row.symbol] ?? false;
                const executionRowState = getExecutionRowState(row);

                return (
                  <Fragment key={row.symbol}>
                    <tr
                      className={`row-summary ${executionRowState.shouldHighlight ? "near-execution" : ""}`}
                      title={executionRowState.title}
                      style={executionRowState.background ? { background: executionRowState.background } : undefined}
                    >
                      <td className="symbol-cell">
                        <div className="symbol-cell-wrap">
                          <button
                            type="button"
                            className="row-toggle"
                            onClick={() => toggleExpanded(row.symbol)}
                            aria-expanded={expanded}
                          >
                            <span className={`chevron ${expanded ? "open" : ""}`}>▸</span>
                            <span className="token-name">{formatTokenLabel(toBaseSymbol(row.symbol), row.maxLeverage)}</span>
                            <span className="token-subname">{getTokenDisplayName(toBaseSymbol(row.symbol))}</span>
                          </button>
                          <div className="symbol-actions-row">
                            <span className={`badge-status ${row.status.toLowerCase()}`}>{row.status}</span>
                            <button
                              type="button"
                              className="inspect-asset-btn"
                              onClick={() => setInspectionRow(row)}
                            >
                              Inspect
                            </button>
                            <button
                              type="button"
                              className="manual-open-btn long"
                              disabled={manualOpenPending !== null}
                              onClick={() => handleManualOpen(row, "LONG")}
                              title={`Manual LONG on ${toBaseSymbol(row.symbol)} at $${row.close}`}
                            >
                              ▲ L
                            </button>
                            <button
                              type="button"
                              className="manual-open-btn short"
                              disabled={manualOpenPending !== null}
                              onClick={() => handleManualOpen(row, "SHORT")}
                              title={`Manual SHORT on ${toBaseSymbol(row.symbol)} at $${row.close}`}
                            >
                              ▼ S
                            </button>
                            {manualOpenFeedback[row.symbol] && (
                              <span className={`manual-open-feedback ${manualOpenFeedback[row.symbol].ok ? "ok" : "fail"}`}>
                                {manualOpenFeedback[row.symbol].msg}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>{formatMarketCap(getMarketCapUsd(row.symbol))}</td>
                      <td className="price-cell">${row.close.toLocaleString()}</td>
                      <td className="volume-cell">{row.volume24h > 0 ? `$${(row.volume24h / 1_000_000).toFixed(1)}M` : "N/A"}</td>
                      <td className="volatility-cell">Vol: {row.volatilityPct.toFixed(2)}%</td>
                      <td className="quality-cell">{renderReadinessScore(row)}</td>
                      <td className={`signal-cell ${row.signal.type.startsWith("NO SIGNAL") ? "signal-no" : "signal-live"}`}>
                        <div className="signal-cell-wrap">
                          {renderSignalBadgeForRow(row)}
                          {getSignalInlineHint(row.signal.type) ? (
                            <span className="signal-inline-note">{getSignalInlineHint(row.signal.type)}</span>
                          ) : null}
                          {getSignalRiskCallout(row) ? (
                            <span className="signal-inline-note caution">{getSignalRiskCallout(row)}</span>
                          ) : null}
                          {getPrePumpWatchCallout(row) ? (
                            <span className="signal-inline-note prepump">{getPrePumpWatchCallout(row)}</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="pre-pump-cell">{renderPrePumpIndicator(row)}</td>
                      <td className="liquidity-hunt-cell">{renderLiquidityHuntMap(row)}</td>
                      <td>
                        <div className="entry-timing-cell-wrap">
                          {renderEntryTimingBadge(row.entryTiming, getSignalDirection(row.signal.type), row.status)}
                        </div>
                      </td>
                      <td className="trend-map-cell">
                        <div className="trend-strip">
                          {renderTrendChip("4H", row.timeframes.macro)}
                          {renderTrendChip("1H", row.timeframes.intermediary)}
                          {renderTrendChip("15M", row.timeframes.microTrigger, true)}
                        </div>
                      </td>
                      <td className="score-cell">{renderConfluenceScore(row)}</td>
                    </tr>

                    {expanded ? (
                      <tr className="details-row">
                        <td colSpan={12}>
                          <div className="details-wrap">
                            <div className="detail-card">
                              <h4>Macro (4h)</h4>
                              <p>K: {row.timeframes.macro.stochK.toFixed(1)}</p>
                              <p>D: {row.timeframes.macro.stochD.toFixed(1)}</p>
                              <p>RSI: {row.timeframes.macro.rsi.toFixed(1)}</p>
                              <p>MACD Hist: {row.timeframes.macro.macdHist.toFixed(4)}</p>
                            </div>
                            <div className="detail-card">
                              <h4>Intermediary (1h)</h4>
                              <p>K: {row.timeframes.intermediary.stochK.toFixed(1)}</p>
                              <p>D: {row.timeframes.intermediary.stochD.toFixed(1)}</p>
                              <p>RSI: {row.timeframes.intermediary.rsi.toFixed(1)}</p>
                              <p>MACD Hist: {row.timeframes.intermediary.macdHist.toFixed(4)}</p>
                            </div>
                            <div className="detail-card">
                              <h4>Micro Trigger (15m)</h4>
                              <p>K: {row.timeframes.microTrigger.stochK.toFixed(1)}</p>
                              <p>D: {row.timeframes.microTrigger.stochD.toFixed(1)}</p>
                              <p>RSI: {row.timeframes.microTrigger.rsi.toFixed(1)}</p>
                              <p>Prev K/D: {row.timeframes.microTrigger.prevStochK.toFixed(1)} / {row.timeframes.microTrigger.prevStochD.toFixed(1)}</p>
                            </div>
                            <div className="detail-card">
                              <h4>Support / Resistance</h4>
                              <p>Timing Context: {row.entryTiming ?? "N/A"}</p>
                              <p>Support: {row.levels.localSupport.toLocaleString()}</p>
                              <p>Resistance: {row.levels.localResistance.toLocaleString()}</p>
                              <p>Distance to Support: {row.levels.supportDistancePct.toFixed(3)}%</p>
                              <p>Near Support Floor: {row.levels.nearSupportFloor ? "YES" : "NO"}</p>
                              <p>Spread: {(row.tradeContext?.orderBookSpreadPct ?? 0).toFixed(4)}%</p>
                              <p>Depth ({row.tradeContext?.orderBookDepthBps ?? 10}bps): ${(row.tradeContext?.orderBookCombinedDepthUsd ?? 0).toLocaleString()}</p>
                              <p>Imbalance: {(row.tradeContext?.orderBookImbalance ?? 0).toFixed(3)}</p>
                              <p>Structure: {row.tradeContext?.passedStructure ? "Pass" : "Fail"} · Micro trend: {row.tradeContext?.passedMicroTrend ? "Pass" : "Fail"}</p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              }) : (
                <tr>
                  <td colSpan={12}>Loading latest scan snapshot...</td>
                </tr>
              )}
            </tbody>
          </table>
            </div>
          </>
        ) : (
          <p className="section-collapsed-note">Scan Results section is collapsed. Use Expand to view live candidates.</p>
        )}
      </section>
      ) : null}
      </div>
      </div>

      {inspectionRow ? (
        <div
          className="asset-modal-backdrop"
          role="presentation"
          onClick={() => setInspectionRow(null)}
        >
          <section
            className="asset-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${inspectionRow.symbol} trade diagnostics`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="asset-modal-header">
              <div>
                <h3>{inspectionRow.symbol} Entry Diagnostics</h3>
                <p>
                  Signal {inspectionRow.signal.type} · Score {inspectionRow.confluence.score}/10 · Entry {inspectionRow.entryTiming ?? "N/A"}
                </p>
                {latestGlobalRuntimeRejection ? (
                  <p className="asset-modal-global-blocker">
                    Global blocker: {latestGlobalRuntimeRejection.reason}
                    {latestGlobalRuntimeRejection.details?.hourUtc != null
                      ? ` (UTC ${formatUnknownValue(latestGlobalRuntimeRejection.details.hourUtc)})`
                      : ""}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                className="asset-modal-close"
                onClick={() => setInspectionRow(null)}
              >
                Close
              </button>
            </header>

            <div className="asset-modal-body">
              {hiddenInspectionChecksCount > 0 ? (
                <p className="asset-modal-muted-note">
                  Hidden {hiddenInspectionChecksCount} disabled checks (NOT_EVALUATED/UNKNOWN) to keep this view focused.
                </p>
              ) : null}
              <table className="asset-diagnostic-table">
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Value</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleInspectionChecks.map((check) => (
                    <tr key={check.label}>
                      <td>{check.label}</td>
                      <td>
                        <div className="diag-value">{check.value}</div>
                        {check.note ? <div className="diag-note">{check.note}</div> : null}
                      </td>
                      <td>
                        <span className={`diag-status ${check.status.toLowerCase()}`}>{check.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {selectedRejection?.details && Object.keys(selectedRejection.details).length > 0 ? (
                <div className="asset-rejection-detail">
                  <h4>Latest Rejection Payload</h4>
                  <div className="asset-rejection-grid">
                    {Object.entries(selectedRejection.details).map(([key, value]) => (
                      <p key={key}>
                        <strong>{key}:</strong> {formatUnknownValue(value)}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {prePumpDetection ? (
        <div
          className="asset-modal-backdrop"
          role="presentation"
          onClick={() => setPrePumpDetection(null)}
        >
          <section
            className="asset-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Pre-pump detection results"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="asset-modal-header">
              <div>
                <h3>Pre-pump Detection Results</h3>
                <p>
                  Candidates {prePumpDetection.eligibleCount} · Scanned {prePumpDetection.scanned}
                </p>
              </div>
              <button
                type="button"
                className="asset-modal-close"
                onClick={() => setPrePumpDetection(null)}
              >
                Close
              </button>
            </header>

            <div className="asset-modal-body">
              {prePumpDetection.candidates.length === 0 ? (
                <>
                  <p className="asset-modal-muted-note">No candidates matched the current pre-pump thresholds.</p>

                  {prePumpDetection.rejectionSummary.length > 0 ? (
                    <div className="asset-rejection-detail">
                      <h4>Top Rejection Reasons</h4>
                      <div className="asset-rejection-grid">
                        {prePumpDetection.rejectionSummary.slice(0, 5).map((item) => (
                          <p key={item.reason}>
                            <strong>{item.reason}:</strong> {item.count}
                          </p>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {prePumpDetection.nearMisses.length > 0 ? (
                    <table className="asset-diagnostic-table">
                      <thead>
                        <tr>
                          <th>Token</th>
                          <th>Signal</th>
                          <th>Score</th>
                          <th>Rejected Because</th>
                          <th>24h Volume</th>
                          <th>Vol%ile</th>
                          <th>1H RSI</th>
                        </tr>
                      </thead>
                      <tbody>
                        {prePumpDetection.nearMisses.map((item) => (
                          <tr key={`${item.symbol}:${item.reason}`}>
                            <td>{item.symbol}</td>
                            <td>{item.signalType}</td>
                            <td>{item.score.toFixed(1)}/10</td>
                            <td>{item.reason}</td>
                            <td>${(item.volume24h / 1_000_000).toFixed(2)}M</td>
                            <td>{item.volatilityPercentile.toFixed(1)}</td>
                            <td>{item.intermediaryRsi.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                </>
              ) : (
                <table className="asset-diagnostic-table">
                  <thead>
                    <tr>
                      <th>Token</th>
                      <th>Signal</th>
                      <th>Score</th>
                      <th>24h Volume</th>
                      <th>Vol%ile</th>
                      <th>Liq%ile</th>
                      <th>1H RSI</th>
                      <th>EMA Slope</th>
                      <th>Stoch Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prePumpDetection.candidates.map((candidate) => (
                      <tr key={candidate.symbol}>
                        <td>{candidate.symbol}</td>
                        <td>{candidate.signalType}</td>
                        <td>{candidate.score.toFixed(1)}/10</td>
                        <td>${(candidate.volume24h / 1_000_000).toFixed(2)}M</td>
                        <td>{candidate.volatilityPercentile.toFixed(1)}</td>
                        <td>{candidate.liquidityPercentile.toFixed(1)}</td>
                        <td>{candidate.intermediaryRsi.toFixed(1)}</td>
                        <td>{candidate.emaSlope.toFixed(4)}</td>
                        <td>{candidate.stochDelta.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      ) : null}


    </main>
  );
}
