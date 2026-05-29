"use client";

import { Fragment, useEffect, useMemo, useState } from "react";

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
      targetReturnPct: number;
      stopReturnPct: number;
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

type DiagnosticStatus = "PASS" | "WARN" | "FAIL";

type DiagnosticCheck = {
  label: string;
  value: string;
  status: DiagnosticStatus;
  note?: string;
};

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
  | "entryTiming"
  | "score"
  | "price";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787";

type CategoryFilter = "ALL" | "CRYPTO" | "AI" | "DEFI" | "GAMING" | "LAYER1" | "LAYER2" | "MEME" | "RWA" | "STOCK" | "OTHER";

const CATEGORY_SYMBOLS: Record<Exclude<CategoryFilter, "ALL" | "CRYPTO" | "OTHER">, Set<string>> = {
  AI: new Set(["0G", "AIXBT", "ANIME", "FET", "GOAT", "GRASS", "GRIFFAIN", "HYPER", "IO", "KAITO", "LAYER", "LIT", "NIL", "PROMPT", "PROVE", "RENDER", "SOPH", "TAO", "VIRTUAL", "WLD", "ZEREBRO", "ARKM", "AI16Z"]),
  DEFI: new Set(["AAVE", "AERO", "APEX", "BANANA", "BIO", "CAKE", "COMP", "CRV", "DYDX", "EIGEN", "ENA", "ENS", "ETHFI", "FTT", "GMX", "HYPE", "JTO", "JUP", "LDO", "LINK", "MAV", "MORPHO", "MKR", "PENDLE", "PYTH", "RESOLV", "REZ", "RSR", "RUNE", "SKY", "SNX", "STABLE", "STBL", "SUSHI", "SYRUP", "TRB", "UMA", "UNI", "USUAL", "VVV", "W", "WCT", "WLFI", "ZRO", "ZORA"]),
  GAMING: new Set(["ACE", "APE", "AXS", "BEAM", "BIGTIME", "BLUR", "DOOD", "GALA", "GMT", "HMSTR", "IMX", "MANA", "MAVIA", "ME", "PENGU", "PIXEL", "PRIME", "SAND", "SUPER", "TNSR", "XAI", "YGG"]),
  LAYER1: new Set(["ADA", "ALGO", "APT", "AR", "ARK", "ATOM", "AVAX", "BCH", "BERA", "BNB", "BSV", "BTC", "CELO", "CFX", "DASH", "DOT", "ETC", "ETH", "FIL", "GAS", "HBAR", "ICP", "INJ", "INIT", "IOTA", "IP", "KAS", "LTC", "MINA", "MON", "MOVE", "NEAR", "NEO", "ORDI", "S", "SEI", "SOL", "STX", "SUI", "TON", "TRX", "VIC", "XLM", "XMR", "XRP", "ZEC", "ZETA"]),
  LAYER2: new Set(["ALT", "ARB", "AZTEC", "BLAST", "DYM", "HEMI", "LAYER", "LINEA", "MANTA", "MEGA", "MERL", "METIS", "MNT", "OP", "POL", "MATIC", "SAGA", "SCR", "STRK", "TIA", "ZEN", "ZK", "ZKS"]),
  MEME: new Set(["BABY", "BONK", "BOME", "BRETT", "CC", "CHIP", "CHILLGUY", "DOGE", "FARTCOIN", "FLOKI", "HMSTR", "MELANIA", "MEME", "MEW", "MOODENG", "NOT", "PEPE", "PEOPLE", "PNUT", "POPCAT", "PUMP", "PURR", "SHIB", "SKR", "SPX", "TRUMP", "TST", "TURBO", "USTC", "VINE", "WIF", "YZY"]),
  RWA: new Set(["ONDO", "PAXG", "POLYX", "RSR", "RIO"]),
  STOCK: new Set(["AAPL", "ABNB", "AMD", "AMZN", "BABA", "COIN", "GOOG", "GOOGL", "HOOD", "INTC", "META", "MSFT", "MSTR", "NFLX", "NIO", "NVDA", "PLTR", "PYPL", "RBLX", "SHOP", "SOFI", "SOFI", "SPOT", "SQ", "TSLA", "UBER"])
};

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
  return symbol.toUpperCase().replace(/-PERP$/i, "").replace(/-USDC$/i, "");
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

  for (const [category, symbols] of Object.entries(CATEGORY_SYMBOLS) as Array<[Exclude<CategoryFilter, "ALL" | "CRYPTO" | "OTHER">, Set<string>]>) {
    if (symbols.has(base)) {
      return category;
    }
  }

  return "OTHER";
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
  fibEnabled: boolean
): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const minScoreThreshold = 5;
  const score = row.confluence.score;
  const hasDirectionalSignal = row.signal.type.includes("LONG") || row.signal.type.includes("SHORT");
  const entryTiming = row.entryTiming ?? "N/A";
  const scoreStatus: DiagnosticStatus = score >= minScoreThreshold ? "PASS" : "FAIL";

  checks.push({
    label: "Score",
    value: `${score}/10 (threshold: ${minScoreThreshold})`,
    status: scoreStatus
  });

  checks.push({
    label: "Signal",
    value: row.signal.type,
    status: hasDirectionalSignal ? "PASS" : "FAIL",
    note: hasDirectionalSignal ? "directSignalQualified" : "No directional trigger"
  });

  checks.push({
    label: "Entry Timing",
    value: entryTiming,
    status: entryTiming === "EARLY" || entryTiming === "MID" ? "PASS" : entryTiming === "LATE" ? "WARN" : "WARN"
  });

  checks.push({
    label: "Volatility",
    value: `${row.volatilityPct.toFixed(2)}%`,
    status: row.tradeContext.passedVolatility ? "PASS" : "FAIL"
  });

  checks.push({
    label: "Liquidity",
    value: `$${(row.volume24h / 1_000_000).toFixed(1)}M`,
    status: row.tradeContext.passedLiquidity ? "PASS" : "FAIL"
  });

  checks.push({
    label: "Structure",
    value: row.tradeContext.passedStructure ? "Valid" : "Not valid",
    status: row.tradeContext.passedStructure ? "PASS" : "FAIL"
  });

  checks.push({
    label: "MicroTrend",
    value: row.tradeContext.passedMicroTrend ? "Aligned" : "Not aligned",
    status: row.tradeContext.passedMicroTrend ? "PASS" : "FAIL"
  });

  const regimeRuleRejected = rejection?.reason === "regime rules";
  const regimeNote = regimeRuleRejected
    ? formatUnknownValue(rejection?.details?.reason)
    : `${row.tradeContext.regime} / ${row.tradeContext.structureState}`;
  checks.push({
    label: "Regime",
    value: row.tradeContext.regime,
    status: regimeRuleRejected ? "FAIL" : "PASS",
    note: regimeNote
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

  if (rejection?.reason === "non-positive EV") {
    const expectedValueRaw = rejection.details?.expectedValue;
    const minExpectedValueRaw = rejection.details?.minExpectedValue;
    const expectedValue = typeof expectedValueRaw === "number" ? expectedValueRaw.toFixed(4) : formatUnknownValue(expectedValueRaw);
    const minExpectedValue = typeof minExpectedValueRaw === "number" ? minExpectedValueRaw.toFixed(4) : formatUnknownValue(minExpectedValueRaw);
    checks.push({
      label: "Expected Value",
      value: `${expectedValue} (min ${minExpectedValue})`,
      status: "FAIL"
    });
  } else {
    checks.push({
      label: "Expected Value",
      value: "No EV rejection",
      status: "PASS"
    });
  }

  if (rejection) {
    checks.push({
      label: "Last Rejection",
      value: rejection.reason,
      status: "WARN",
      note: `At ${new Date(rejection.rejectedAt).toLocaleString()}`
    });
  }

  return checks;
}

const CATEGORY_TABS: Array<{ key: CategoryFilter; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "CRYPTO", label: "Crypto" },
  { key: "AI", label: "AI" },
  { key: "DEFI", label: "DeFi" },
  { key: "GAMING", label: "Gaming" },
  { key: "LAYER1", label: "Layer 1" },
  { key: "LAYER2", label: "Layer 2" },
  { key: "MEME", label: "Meme" },
  { key: "RWA", label: "RWA" },
  { key: "STOCK", label: "Stock" },
  { key: "OTHER", label: "Other" }
];

export function Dashboard() {
  const [access, setAccess] = useState<AccessState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const [settingsFeedback, setSettingsFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [strategyConfig, setStrategyConfig] = useState<any>(null);
  const [tradingMode, setTradingMode] = useState<"DAY_TRADING" | "SWING_TRADING">("DAY_TRADING");
  const [strategyPending, setStrategyPending] = useState(false);
  const [strategyFeedback, setStrategyFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [autoRefreshActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [stableResults, setStableResults] = useState<RsiRow[]>([]);
  const [expandedSymbols, setExpandedSymbols] = useState<Record<string, boolean>>({});
  const [selectedCategory, setSelectedCategory] = useState<CategoryFilter>("ALL");
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
  const [reopenFeedback, setReopenFeedback] = useState<string | null>(null);
  const [inspectionRow, setInspectionRow] = useState<RsiRow | null>(null);
  const [latestRejectionsBySymbol, setLatestRejectionsBySymbol] = useState<Record<string, TradeRejectionRecord>>({});

  const displayResults = data?.results?.length ? data.results : stableResults;

  const categoryCounts = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      ALL: displayResults.length,
      CRYPTO: 0,
      AI: 0,
      DEFI: 0,
      GAMING: 0,
      LAYER1: 0,
      LAYER2: 0,
      MEME: 0,
      RWA: 0,
      STOCK: 0,
      OTHER: 0
    };

    for (const row of displayResults) {
      const category = inferCategory(row.symbol);
      counts[category] += 1;
      if (category !== "STOCK") {
        counts.CRYPTO += 1;
      }
    }

    return counts;
  }, [displayResults]);

  const visibleResults = useMemo(() => {
    if (selectedCategory === "ALL") {
      return displayResults;
    }

    if (selectedCategory === "CRYPTO") {
      return displayResults.filter((item) => inferCategory(item.symbol) !== "STOCK");
    }

    return displayResults.filter((item) => inferCategory(item.symbol) === selectedCategory);
  }, [displayResults, selectedCategory]);

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

  const wins = data?.tradeSimulation?.stats.wins ?? 0;
  const losses = data?.tradeSimulation?.stats.losses ?? 0;
  const settledTrades = wins + losses;
  const lossRate = settledTrades > 0 ? (losses / settledTrades) * 100 : 0;
  const manualControlsEnabled = access?.features.manualTradeControls ?? true;
  const activeTrades = data?.tradeSimulation?.activeTrades ?? [];

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

    return latestRejectionsBySymbol[inspectionRow.symbol] ?? null;
  }, [inspectionRow, latestRejectionsBySymbol]);

  const inspectionChecks = useMemo(() => {
    if (!inspectionRow) {
      return [];
    }

    const fibEnabled = Boolean(strategyConfig?.enableFibonacci);
    return buildAssetDiagnostics(inspectionRow, selectedRejection, fibEnabled);
  }, [inspectionRow, selectedRejection, strategyConfig]);

  useEffect(() => {
    let cancelled = false;

    async function loadAccessState(): Promise<void> {
      try {
        const response = await fetch(`${API_BASE}/api/access`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Failed to load access state (${response.status})`);
        }

        const payload = (await response.json()) as AccessState;
        if (!cancelled) {
          setAccess(payload);
        }
      } catch (accessError) {
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
        const response = await fetch(`${API_BASE}/api/strategy/config`);
        if (response.ok) {
          const config = await response.json();
          setStrategyConfig(config);
          setTradingMode(config.tradingMode);
        }
      } catch (err) {
        console.error("Failed to load strategy config:", err);
      }
    };

    void loadStrategyConfig();
  }, []);

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

    const wsUrl = API_BASE.replace(/^http/i, "ws") + "/ws/state";
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
  }, [autoRefreshActive]);

  useEffect(() => {
    let cancelled = false;

    async function loadRejections(): Promise<void> {
      try {
        const response = await fetch(`${API_BASE}/api/trades/rejections?limit=500`, { cache: "no-store" });
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as TradeRejectionResponse;
        const next: Record<string, TradeRejectionRecord> = {};

        for (const rejection of payload.rejections ?? []) {
          if (!next[rejection.symbol]) {
            next[rejection.symbol] = rejection;
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
  }, []);

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

  function renderSignalBadge(signal: RsiRow["signal"]) {
    const stateClass = signal.type.startsWith("NO SIGNAL")
      ? "signal-badge no-signal"
      : signal.type === "STRONG LONG" || signal.type === "CONTINUATION LONG" || signal.type === "REVERSAL LONG"
        ? "signal-badge long"
        : signal.type === "STRONG SHORT" || signal.type === "CONTINUATION SHORT" || signal.type === "REVERSAL SHORT"
          ? "signal-badge short"
          : "signal-badge neutral";

    return <span className={`${signal.classes} ${stateClass}`}>{signal.type}</span>;
  }

  function renderConfluenceScore(confluence: RsiRow["confluence"]) {
    const pct = Math.max(0, Math.min(100, (confluence.score / confluence.maxScore) * 100));
    const biasClass = (confluence.bias ?? "neutral").toLowerCase();
    const biasLabel = confluence.bias ?? "NEUTRAL";

    return (
      <div className="score-wrap" title={`${biasLabel} ${confluence.score}/${confluence.maxScore}`}>
        <span className={`score-label ${biasClass}`}>
          {confluence.score}/{confluence.maxScore}
        </span>
        <div className="score-track">
          <span className="score-fill" style={{ width: `${pct}%` }} />
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
      ? "Signal Active"
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

  async function saveLicenseSettings(payload: Partial<Pick<AccessState, "mode" | "plan" | "status">>): Promise<void> {
    setSettingsPending(true);
    setSettingsFeedback(null);

    try {
      const response = await fetch(`${API_BASE}/api/access`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      const body = (await response.json()) as { saved?: boolean; access?: AccessState; error?: string };

      if (!response.ok || !body.saved || !body.access) {
        throw new Error(body.error ?? "Failed to save settings");
      }

      setAccess(body.access);
      setSettingsFeedback({ ok: true, msg: "Settings saved." });
    } catch (err) {
      setSettingsFeedback({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setSettingsPending(false);
    }
  }

  async function reopenLastClosedTrade(symbol: string): Promise<void> {
    if (!manualControlsEnabled) {
      setReopenFeedback("Reopen is locked by the current plan.");
      return;
    }

    setReopenPendingSymbol(symbol);
    setReopenFeedback(null);

    try {
      const response = await fetch(`${API_BASE}/api/trades/reopen-last`, {
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
      const response = await fetch(`${API_BASE}/api/trades/close-symbol`, {
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

    const confirmed = window.confirm(
      "Reset trade simulation? This clears active trades, recent closed trades, cooldowns, and resets stats to baseline."
    );
    if (!confirmed) {
      return;
    }

    setResettingSimulation(true);
    setReopenFeedback(null);

    try {
      const response = await fetch(`${API_BASE}/api/trades/reset`, {
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

  async function switchTradingMode(newMode: "DAY_TRADING" | "SWING_TRADING"): Promise<void> {
    if (!manualControlsEnabled) {
      setStrategyFeedback({ ok: false, msg: "Strategy config is locked by the current plan." });
      return;
    }

    setStrategyPending(true);
    try {
      const response = await fetch(`${API_BASE}/api/strategy/mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: newMode })
      });

      const payload = await response.json() as { success?: boolean; config?: any; error?: string; details?: string };

      if (!response.ok || !payload.success || !payload.config) {
        throw new Error(payload.error ?? payload.details ?? "Failed to switch trading mode");
      }

      setTradingMode(newMode);
      setStrategyConfig(payload.config);
      setStrategyFeedback({ ok: true, msg: `✓ Switched to ${newMode === "DAY_TRADING" ? "Day Trading" : "Swing Trading"}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStrategyFeedback({ ok: false, msg: `Failed to switch mode: ${message}` });
    } finally {
      setStrategyPending(false);
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

  function renderEntryTimingBadge(entryTiming?: "EARLY" | "MID" | "LATE" | null) {
    if (!entryTiming) {
      return <span className="entry-timing unknown">N/A</span>;
    }

    return <span className={`entry-timing ${entryTiming.toLowerCase()}`}>{entryTiming}</span>;
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

  return (
    <main className="shell">
      <section className="hero">
        <div className="brand-row">
          <img className="brand-logo" src="/ciphora-logo.svg" alt="Ciphora logo" />
          <div>
            <p className="eyebrow">Ciphora</p>
            <p className="brand-subtitle">Multi-Factor Market Intelligence</p>
          </div>
        </div>
        <p className="endpoint-indicator">
          API Endpoint: <span>{API_BASE}</span>
        </p>
        {access ? (
          <div className={`access-panel ${access.isSubscribed ? "active" : "restricted"}`}>
            <div className="access-header">
              <div className="access-header-info">
                <p className="access-eyebrow">Access</p>
                <span className="access-plan-title">{access.plan} · {access.status}</span>
                {access.message ? <p className="access-msg">{access.message}</p> : null}
              </div>
              <div className="access-header-chips">
                <span className={`access-chip ${access.features.backgroundAutomation ? "enabled" : "disabled"}`}>
                  Engine {access.features.backgroundAutomation ? "On" : "Locked"}
                </span>
                <span className={`access-chip ${access.features.manualTradeControls ? "enabled" : "disabled"}`}>
                  Controls {access.features.manualTradeControls ? "On" : "Locked"}
                </span>
                <span className={`access-chip ${access.features.telegramAlerts ? "enabled" : "disabled"}`}>
                  Alerts {access.features.telegramAlerts ? "On" : "Locked"}
                </span>
                <span className="access-chip neutral">Scan ≤ {access.limits.maxScanTokens}</span>
                <span className="access-chip neutral">Trades ≤ {access.limits.maxActiveTrades}</span>
                <button
                  type="button"
                  className="settings-toggle"
                  onClick={() => { setSettingsOpen((o) => !o); setSettingsFeedback(null); }}
                >
                  {settingsOpen ? "Close Settings" : "Settings"}
                </button>
              </div>
            </div>

            {settingsOpen ? (
              <div className="settings-panel">
                <h3 className="settings-heading">License Settings</h3>
                <p className="settings-note">
                  Changes are written to <code>data/license.json</code> at the repo root and take effect immediately without restarting the API.
                </p>
                <div className="settings-grid">
                  <div className="settings-field">
                    <label htmlFor="settings-mode">Mode</label>
                    <select
                      id="settings-mode"
                      defaultValue={access.mode}
                      disabled={settingsPending}
                      onChange={(e) => void saveLicenseSettings({ mode: e.target.value as AccessState["mode"] })}
                    >
                      <option value="open">open — enforcement bypassed</option>
                      <option value="licensed">licensed — plan limits enforced</option>
                    </select>
                  </div>
                  <div className="settings-field">
                    <label htmlFor="settings-plan">Plan</label>
                    <select
                      id="settings-plan"
                      defaultValue={access.plan}
                      disabled={settingsPending}
                      onChange={(e) => void saveLicenseSettings({ plan: e.target.value as AccessState["plan"] })}
                    >
                      <option value="FREE">FREE — read-only dashboard</option>
                      <option value="PRO">PRO — automation + 3 active trades</option>
                      <option value="ELITE">ELITE — automation + 10 active trades</option>
                    </select>
                  </div>
                  <div className="settings-field">
                    <label htmlFor="settings-status">Status</label>
                    <select
                      id="settings-status"
                      defaultValue={access.status}
                      disabled={settingsPending}
                      onChange={(e) => void saveLicenseSettings({ status: e.target.value as AccessState["status"] })}
                    >
                      <option value="ACTIVE">ACTIVE</option>
                      <option value="TRIALING">TRIALING</option>
                      <option value="PAST_DUE">PAST_DUE</option>
                      <option value="INACTIVE">INACTIVE</option>
                    </select>
                  </div>
                </div>
                {settingsFeedback ? (
                  <p className={`settings-feedback ${settingsFeedback.ok ? "ok" : "err"}`}>
                    {settingsFeedback.msg}
                  </p>
                ) : null}
                <p className="settings-source">Source: <code>{access.source}</code></p>

                <div style={{ marginTop: "2rem", paddingTop: "1.5rem", borderTop: "1px solid #444" }}>
                  <h3 className="settings-heading">Strategy Configuration</h3>
                  <p className="settings-note">
                    Configure trading modes (Day vs Swing) and enable/disable indicators for your trading strategy.
                  </p>
                  <div className="settings-grid">
                    <div className="settings-field">
                      <label htmlFor="trading-mode">Trading Mode</label>
                      <select
                        id="trading-mode"
                        value={tradingMode}
                        disabled={strategyPending}
                        onChange={(e) => void switchTradingMode(e.target.value as "DAY_TRADING" | "SWING_TRADING")}
                      >
                        <option value="DAY_TRADING">Day Trading (1-4 hour holds)</option>
                        <option value="SWING_TRADING">Swing Trading (multi-day holds)</option>
                      </select>
                    </div>
                    {strategyConfig && (
                      <>
                        <div className="settings-field">
                          <label htmlFor="day-tp">Day Trading TP %</label>
                          <input
                            id="day-tp"
                            type="number"
                            step="0.1"
                            min="0.1"
                            defaultValue={strategyConfig.dayTradingTpPct}
                            disabled={strategyPending}
                            readOnly
                            style={{ backgroundColor: "#333" }}
                          />
                        </div>
                        <div className="settings-field">
                          <label htmlFor="day-sl">Day Trading SL %</label>
                          <input
                            id="day-sl"
                            type="number"
                            step="0.1"
                            min="0.1"
                            defaultValue={strategyConfig.dayTradingSlPct}
                            disabled={strategyPending}
                            readOnly
                            style={{ backgroundColor: "#333" }}
                          />
                        </div>
                        <div className="settings-field">
                          <label htmlFor="swing-tp">Swing Trading TP %</label>
                          <input
                            id="swing-tp"
                            type="number"
                            step="0.1"
                            min="0.1"
                            defaultValue={strategyConfig.swingTradingTpPct}
                            disabled={strategyPending}
                            readOnly
                            style={{ backgroundColor: "#333" }}
                          />
                        </div>
                        <div className="settings-field">
                          <label htmlFor="swing-sl">Swing Trading SL %</label>
                          <input
                            id="swing-sl"
                            type="number"
                            step="0.1"
                            min="0.1"
                            defaultValue={strategyConfig.swingTradingSlPct}
                            disabled={strategyPending}
                            readOnly
                            style={{ backgroundColor: "#333" }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                  <div style={{ marginTop: "1rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.5rem" }}>
                    {strategyConfig && (
                      <>
                        <div><strong>Fibonacci:</strong> {strategyConfig.enableFibonacci ? "✓" : "✗"}</div>
                        <div><strong>CipherB:</strong> {strategyConfig.enableCipherB ? "✓" : "✗"}</div>
                        <div><strong>VWAP:</strong> {strategyConfig.enableVWAP ? "✓" : "✗"}</div>
                        <div><strong>EMA:</strong> {strategyConfig.enableEMA ? "✓" : "✗"}</div>
                        <div><strong>Structure:</strong> {strategyConfig.enableStructure ? "✓" : "✗"}</div>
                        <div><strong>Order Flow:</strong> {strategyConfig.enableOrderFlow ? "✓" : "✗"}</div>
                        <div><strong>ATR:</strong> {strategyConfig.enableATR ? "✓" : "✗"}</div>
                        <div><strong>RSI:</strong> {strategyConfig.enableRSI ? "✓" : "✗"}</div>
                      </>
                    )}
                  </div>
                  {strategyFeedback ? (
                    <p className={`settings-feedback ${strategyFeedback.ok ? "ok" : "err"}`}>
                      {strategyFeedback.msg}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {error ? <p className="error">{error}</p> : null}

      <section className="panel simulation-panel">
        <div className="table-header">
          <h2>Trade Simulation</h2>
          <div className="simulation-header-actions">
            <span>
              Stake ${data?.tradeSimulation?.stats.stakePerTradeUsd ?? 378} @ 5x | TP {data?.tradeSimulation?.stats.targetReturnPct ?? 30}% | SL {Math.abs(data?.tradeSimulation?.stats.stopReturnPct ?? -10)}% | Max Active {data?.tradeSimulation?.stats.maxActiveTrades ?? 1}
            </span>
            <button
              type="button"
              className="reset-sim-btn"
              onClick={() => void resetTradeSimulation()}
              disabled={resettingSimulation || !manualControlsEnabled}
            >
              {!manualControlsEnabled ? "Locked" : resettingSimulation ? "Resetting..." : "Reset Simulation"}
            </button>
          </div>
        </div>
        <div className="sim-stats-grid">
          <article className="sim-stat">
            <p>Win Rate</p>
            <strong>{(data?.tradeSimulation?.stats.winRate ?? 0).toFixed(2)}%</strong>
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
            <strong>{data?.tradeSimulation?.stats.activeTrades ?? 0} / {data?.tradeSimulation?.stats.totalTrades ?? 0}</strong>
          </article>
        </div>

        <div className="trade-table-wrap">
          <h3>Active Trades</h3>
          <table className="trade-table">
            <thead>
              <tr>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("token")}>Token{renderSortIndicator("token")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("marketCap")}>Market Cap{renderSortIndicator("marketCap")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("direction")}>Direction{renderSortIndicator("direction")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("size")}>Size{renderSortIndicator("size")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("assetType")}>Asset Type{renderSortIndicator("assetType")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("entryType")}>Entry Type{renderSortIndicator("entryType")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleTradeSort("entryTiming")}>Entry Timing{renderSortIndicator("entryTiming")}</button></th>
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
                    `Market: ${marketCondition}`
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
                      <td>{renderEntryTimingBadge(entryTiming)}</td>
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
                      <td>{trade.stakeUsd.toFixed(2)} USD</td>
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
        </div>

        <div className="trade-table-wrap">
          <h3>Recent Closed Trades</h3>
          {reopenFeedback ? <p className="trade-action-feedback">{reopenFeedback}</p> : null}
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
              {data?.tradeSimulation?.recentClosedTrades?.length ? (
                data.tradeSimulation.recentClosedTrades.slice(0, 20).map((trade) => (
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
        </div>
      </section>

      <section className="panel table-panel">
        <div className="table-header">
          <h2>Multi-Timeframe Alignment Results</h2>
          <span className="scan-meta">
            {strongShortRows.length > 0 && <span className="badge-short">{strongShortRows.length} SHORT</span>}
            {strongLongRows.length > 0 && <span className="badge-long">{strongLongRows.length} LONG</span>}
            {continuationShortRows.length > 0 && <span className="badge-short">{continuationShortRows.length} CONT SHORT</span>}
            {continuationLongRows.length > 0 && <span className="badge-long">{continuationLongRows.length} CONT LONG</span>}
            {reversalShortRows.length > 0 && <span className="badge-short">{reversalShortRows.length} REV SHORT</span>}
            {reversalLongRows.length > 0 && <span className="badge-long">{reversalLongRows.length} REV LONG</span>}
            <span>{tradeReadyRows.length} READY / {visibleResults.length} IN VIEW</span>
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
        </div>

        {visibleResults.length > 0 && tradeReadyRows.length === 0 ? (
          <div className="notice no-ready-notice">
            No trade-ready signals right now. The scan is live, but the rules are still filtering entries out.
          </div>
        ) : null}

        <div className="table-wrap">
          <table className="timeframe-table">
            <thead>
              <tr>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("token")}>Token{renderResultSortIndicator("token")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("marketCap")}>Market Cap{renderResultSortIndicator("marketCap")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("volume24h")}>24h Volume{renderResultSortIndicator("volume24h")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("volatility")}>Volatility{renderResultSortIndicator("volatility")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("readiness")}>Readiness{renderResultSortIndicator("readiness")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("signal")}>Signal{renderResultSortIndicator("signal")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("entryTiming")}>Entry Timing{renderResultSortIndicator("entryTiming")}</button></th>
                <th>Trend Map</th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("score")}>Score{renderResultSortIndicator("score")}</button></th>
                <th><button type="button" className="sort-header-btn" onClick={() => toggleResultSort("price")}>Price{renderResultSortIndicator("price")}</button></th>
              </tr>
            </thead>
            <tbody>
              {sortedVisibleResults.length > 0 ? sortedVisibleResults.map((row) => {
                const expanded = expandedSymbols[row.symbol] ?? false;

                return (
                  <Fragment key={row.symbol}>
                    <tr className="row-summary">
                      <td className="symbol-cell">
                        <div className="symbol-cell-wrap">
                          <button
                            type="button"
                            className="row-toggle"
                            onClick={() => toggleExpanded(row.symbol)}
                            aria-expanded={expanded}
                          >
                            <span className={`chevron ${expanded ? "open" : ""}`}>▸</span>
                            <span className="token-name">{toBaseSymbol(row.symbol)}</span>
                            <span className="token-subname">{getTokenDisplayName(toBaseSymbol(row.symbol))}</span>
                            <span className={`badge-status ${row.status.toLowerCase()}`}>{row.status}</span>
                          </button>
                          <button
                            type="button"
                            className="inspect-asset-btn"
                            onClick={() => setInspectionRow(row)}
                          >
                            Inspect
                          </button>
                        </div>
                      </td>
                      <td>{formatMarketCap(getMarketCapUsd(row.symbol))}</td>
                      <td className="volume-cell">{row.volume24h > 0 ? `$${(row.volume24h / 1_000_000).toFixed(1)}M` : "N/A"}</td>
                      <td className="volatility-cell">Vol: {row.volatilityPct.toFixed(2)}%</td>
                      <td className="quality-cell">{renderReadinessScore(row)}</td>
                      <td className={`signal-cell ${row.signal.type.startsWith("NO SIGNAL") ? "signal-no" : "signal-live"}`}>
                        {renderSignalBadge(row.signal)}
                      </td>
                      <td>{renderEntryTimingBadge(row.entryTiming)}</td>
                      <td className="trend-map-cell">
                        <div className="trend-strip">
                          {renderTrendChip("4H", row.timeframes.macro)}
                          {renderTrendChip("1H", row.timeframes.intermediary)}
                          {renderTrendChip("15M", row.timeframes.microTrigger, true)}
                        </div>
                      </td>
                      <td className="score-cell">{renderConfluenceScore(row.confluence)}</td>
                      <td className="price-cell">${row.close.toLocaleString()}</td>
                    </tr>

                    {expanded ? (
                      <tr className="details-row">
                        <td colSpan={10}>
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
                              <p>Entry Timing: {row.entryTiming ?? "N/A"}</p>
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
                  <td colSpan={10}>Loading latest scan snapshot...</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

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
              <table className="asset-diagnostic-table">
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Value</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {inspectionChecks.map((check) => (
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


    </main>
  );
}
