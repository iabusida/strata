"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AlignmentPoint, SignalItem, SignalState } from "./system/types";
import { SignalStateBadge } from "./system/signal-state-badge";
import { ScanControlBar } from "./system/scan-control-bar";
import { SignalCard } from "./system/signal-card";
import { LockedOpportunityTeaserCard, NoActiveTradesState, TopOpportunityCard, TopOpportunityEmptyState } from "./system/top-opportunity-card";
import { ProfileContextBanner, ProfileSelector } from "./profile-selector";
import { useUserProfile } from "../hooks/use-user-profile";
import { evaluateSignalForProfile, getForecastInterpretation, getProfileMarketStatus, SIGNAL_STATE_PRIORITY } from "./system/profile-decision";
import { getTimeframeAnalysisHelperText } from "./system/timeframe-analysis";
import { useAppAccess } from "../hooks/use-app-access";
import { AccessValueBanner, UpgradeModal, type UpgradeIntent } from "./system/upgrade-modal";

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
  rsi: number;
  volume24h: number;
  volatilityPct: number;
  tradeContext: {
    emaSlope: number;
    passedVolatility: boolean;
    passedLiquidity: boolean;
    orderBookImbalance?: number;
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

function rowToSignalItem(row: RawRow): SignalItem {
  const baseSymbol = toBaseSymbol(row.symbol);
  const state = toSignalState(row);
  const alignment: AlignmentPoint[] = [
    { label: "1D", direction: row.timeframes.macro.trend.direction, dominant: true },
    { label: "4H", direction: row.timeframes.intermediary.trend.direction },
    {
      label: "1H",
      direction: row.timeframes.microTrigger.trend.direction,
      blocked:
        row.timeframes.macro.trend.direction !== "MIXED"
        && row.timeframes.microTrigger.trend.direction !== "MIXED"
        && row.timeframes.macro.trend.direction !== row.timeframes.microTrigger.trend.direction,
    },
    {
      label: "15M",
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

  const entry = row.close;
  const stopLoss = row.signal.type.includes("LONG") ? row.close * 0.985 : row.close * 1.015;
  const takeProfit = row.signal.type.includes("LONG") ? row.close * 1.03 : row.close * 0.97;
  const microDirection: RawDirection = row.timeframes.microTrigger.stochK >= 50 ? "UP" : "DOWN";
  const microRsi = row.rsi;
  const microStochastic = row.timeframes.microTrigger.stochK;
  const microBias = row.tradeContext.emaSlope >= 0 ? 1 : -1;

  const deriveMicroMetric = (
    label: "1M" | "5M",
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
    timeframeMetrics: {
      "1M": deriveMicroMetric("1M", 8, 14),
      "5M": deriveMicroMetric("5M", 4, 8),
      "1D": {
        label: "1D",
        direction: row.timeframes.macro.trend.direction,
        rsi: row.timeframes.macro.rsi,
        stochastic: row.timeframes.macro.stochK,
      },
      "4H": {
        label: "4H",
        direction: row.timeframes.intermediary.trend.direction,
        rsi: row.timeframes.intermediary.rsi,
        stochastic: row.timeframes.intermediary.stochK,
      },
      "1H": {
        label: "1H",
        direction: row.timeframes.microTrigger.trend.direction,
        rsi: row.timeframes.microTrigger.rsi,
        stochastic: row.timeframes.microTrigger.stochK,
      },
      "15M": {
        label: "15M",
        direction: microDirection,
        rsi: row.rsi,
        stochastic: row.timeframes.microTrigger.stochK,
      },
    },
  };
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
  if (initialView === "simulation" || pathname.startsWith("/test-simulation")) return "Simulate";
  if (pathname.startsWith("/dry-run")) return "Execute";
  if (pathname.startsWith("/markets/forecast")) return "Forecast";
  return "Scan";
}

export function Dashboard({ initialView = "results", tradeMode = "live" }: DashboardProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [payload, setPayload] = useState<StatePayload | null>(null);
  const [, setStatus] = useState<"Idle" | "Scanning" | "Error">("Idle");
  const [executionFocus, setExecutionFocus] = useState<SignalItem | null>(null);
  const [tokenQuery, setTokenQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("marketCap");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [upgradeIntent, setUpgradeIntent] = useState<UpgradeIntent | null>(null);

  // User profile management
  const { profile: userProfile, riskLevel, setProfile, setRiskLevel } = useUserProfile();
  const { entitlements, error: accessError } = useAppAccess();
  const effectiveProfile = entitlements.forcedProfile ?? userProfile;

  const primaryTab = useMemo(() => getPrimaryTab(pathname, initialView), [pathname, initialView]);

  useEffect(() => {
    let closedByCleanup = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const connect = (): void => {
      setStatus("Scanning");
      socket = new WebSocket(`${getApiWebSocketBase()}/ws/state?mode=${tradeMode}`);

      socket.onopen = () => {
        setStatus("Idle");
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as StatePayload;
          setPayload(data);
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
  }, [tradeMode]);

  const signals = useMemo(() => {
    const rows = payload?.results ?? [];
    return rows.map(rowToSignalItem);
  }, [payload?.results]);

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
    if (entitlements.maxVisibleSignals == null) {
      return visibleSignals;
    }

    return visibleSignals.slice(0, entitlements.maxVisibleSignals);
  }, [entitlements.maxVisibleSignals, visibleSignals]);

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

  const onExecuteSignal = useCallback((item: SignalItem) => {
    setExecutionFocus(item);
  }, []);

  const onSimulateSignal = useCallback((item: SignalItem) => {
    setExecutionFocus(item);
    router.push(`/test-simulation?symbol=${encodeURIComponent(item.symbol)}`);
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

  return (
    <main className="mx-auto grid w-[min(1680px,99vw)] gap-4 px-0 py-5 text-[#E6EDF3]">
      {primaryTab === "Scan" ? (
        <>
          <ProfileSelector
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

          <ProfileContextBanner activeProfile={effectiveProfile} />

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

          <section className={`rounded-strata border p-5 ${marketStatus.shellClass}`}>
            <p className="text-[11px] uppercase tracking-[0.14em] text-[#AFC2D7]">Market Status</p>
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

          <section className="rounded-strata border border-white/10 bg-[#0F172A] p-4 shadow-strata-card">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-[#E6EDF3]">Top Opportunities</h3>
              <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Decision First</p>
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
              <p className="mt-1 text-lg font-semibold">{payload?.tradeSimulation?.stats?.totalTrades ?? 0}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Active</p>
              <p className="mt-1 text-lg font-semibold">{payload?.tradeSimulation?.stats?.activeTrades ?? 0}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Win Rate</p>
              <p className="mt-1 text-lg font-semibold">{Number(payload?.tradeSimulation?.stats?.winRate ?? 0).toFixed(1)}%</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Realized PnL</p>
              <p className="mt-1 text-lg font-semibold">${Number(payload?.tradeSimulation?.stats?.totalPnlUsd ?? 0).toFixed(2)}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-[#0B1220] p-3">
              <p className="text-xs uppercase tracking-[0.1em] text-[#9FB3C8]">Unrealized</p>
              <p className="mt-1 text-lg font-semibold">${Number(payload?.tradeSimulation?.stats?.unrealizedPnlUsd ?? 0).toFixed(2)}</p>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
