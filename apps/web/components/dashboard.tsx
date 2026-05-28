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

function getTokenDisplayName(base: string): string {
  return TOKEN_NAMES[base.toUpperCase()] ?? base;
}

function toBaseSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/-PERP$/i, "").replace(/-USDC$/i, "");
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
  const [wsConnected, setWsConnected] = useState(false);
  const [autoRefreshActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [stableResults, setStableResults] = useState<RsiRow[]>([]);
  const [expandedSymbols, setExpandedSymbols] = useState<Record<string, boolean>>({});
  const [selectedCategory, setSelectedCategory] = useState<CategoryFilter>("ALL");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [reopenPendingSymbol, setReopenPendingSymbol] = useState<string | null>(null);
  const [reopenFeedback, setReopenFeedback] = useState<string | null>(null);

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
    const ctx = row.tradeContext;

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

    // Signal fires when we have direction — treat that as 100%
    const hasSignal = row.signal?.type?.includes("LONG") || row.signal?.type?.includes("SHORT");
    const displayPct = hasSignal ? 100 : total;

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
      </section>

      {error ? <p className="error">{error}</p> : null}

      <section className="panel simulation-panel">
        <div className="table-header">
          <h2>Trade Simulation</h2>
          <span>
            Stake ${data?.tradeSimulation?.stats.stakePerTradeUsd ?? 378} @ 5x | TP {data?.tradeSimulation?.stats.targetReturnPct ?? 30}% | SL {Math.abs(data?.tradeSimulation?.stats.stopReturnPct ?? -10)}% | Max Active {data?.tradeSimulation?.stats.maxActiveTrades ?? 1}
          </span>
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
                <th>Token</th>
                <th>Direction</th>
                <th>Size</th>
                <th>Asset Type</th>
                <th>Entry Type</th>
                <th>Entry Timing</th>
                <th>TP %</th>
                <th>Entry</th>
                <th>Mark</th>
                <th>Position Value</th>
                <th>ROE %</th>
                <th>PnL USD</th>
                <th>Liq. Price (Est)</th>
                <th>Margin</th>
                <th>Funding Rate</th>
                <th>Funding PnL</th>
                <th>TP / SL</th>
                <th>Dist TP %</th>
                <th>Dist SL %</th>
                <th>Stake</th>
                <th>Progress</th>
                <th>Status</th>
                <th>Time In Trade</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {data?.tradeSimulation?.activeTrades?.length ? (
                data.tradeSimulation.activeTrades.map((trade) => {
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
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={25}>No active simulated trades.</td>
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
                        disabled={reopenPendingSymbol !== null}
                        onClick={() => void reopenLastClosedTrade(trade.token)}
                      >
                        {reopenPendingSymbol === trade.token ? "Reopening..." : "Reopen"}
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
                <th>Token</th>
                <th>24h Volume</th>
                <th>Volatility</th>
                <th>Readiness</th>
                <th>Signal</th>
                <th>Entry Timing</th>
                <th>Trend Map</th>
                <th>Score</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {visibleResults.length > 0 ? visibleResults.map((row) => {
                const expanded = expandedSymbols[row.symbol] ?? false;

                return (
                  <Fragment key={row.symbol}>
                    <tr className="row-summary">
                      <td className="symbol-cell">
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
                      </td>
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
                        <td colSpan={9}>
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
                  <td colSpan={9}>Loading latest scan snapshot...</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>


    </main>
  );
}
