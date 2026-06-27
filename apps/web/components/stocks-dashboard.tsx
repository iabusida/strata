"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ScanControlBar } from "./system/scan-control-bar";
import { LockedOpportunityTeaserCard, NoActiveTradesState, TopOpportunityCard, TopOpportunityEmptyState } from "./system/top-opportunity-card";
import { CompactProfileBar, getProfileConfig, ProfileContextBanner, ProfileSelector, TradingProfile } from "./profile-selector";
import { useUserProfile } from "../hooks/use-user-profile";
import {
  getAnalysisIntervalForTimeframe,
  getDefaultTimeframeForProfile,
  getTimeframeAnalysisHelperText,
  getTimeframeTriggerLabel,
  TIMEFRAME_VIEWS,
} from "./system/timeframe-analysis";
import { TimeframeView } from "./system/types";
import { useAppAccess } from "../hooks/use-app-access";
import { AccessValueBanner, UpgradeModal, type UpgradeIntent } from "./system/upgrade-modal";
import { deriveSignalState, getSignalStatePresentation, SIGNAL_STATE_PRIORITY, type SignalActionState } from "./system/profile-decision";
import { useAuth } from "../contexts/auth-context";

const API_BASE_ENV = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim();

function getApiWebSocketBase(): string {
  if (API_BASE_ENV) {
    return API_BASE_ENV.replace(/^http/i, "ws").replace(/\/+$/, "");
  }

  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.hostname}:8787`;
  }

  return "ws://localhost:8787";
}

function getApiHttpBase(): string {
  if (API_BASE_ENV) {
    return API_BASE_ENV.replace(/\/+$/, "");
  }

  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:8787`;
  }

  return "http://localhost:8787";
}

type StockData = {
  symbol: string;
  displayName: string;
  marketCapUsd: number | null;
  price: number;
  change: number;
  changePercent: number;
  high?: number;
  low?: number;
  open?: number;
  volume: number;
  lastUpdated: string;
};

type StockTimeframe = TimeframeView;

type StockTimeframeMetric = {
  label: StockTimeframe;
  direction: "UP" | "DOWN" | "MIXED";
  momentumLabel: string;
  triggerLabel: string;
  rangeBias: string;
};

type StockQuoteResponse = {
  provider: string;
  assetClass: "STOCK";
  timestamp: string;
  count: number;
  stale?: boolean;
  staleReason?: string;
  quotes: Array<{
    symbol: string;
    price: number;
    change: number;
    changePercent: number;
    high: number;
    low: number;
    open: number;
    previousClose: number;
    timestamp: number;
  }>;
  error?: string;
  details?: string;
};

const STOCK_NAMES: Record<string, string> = {
  AAPL: "Apple",
  MSFT: "Microsoft",
  GOOGL: "Alphabet",
  AMZN: "Amazon",
  META: "Meta Platforms",
  NVDA: "NVIDIA",
  TSLA: "Tesla",
  JPM: "JPMorgan Chase",
  BAC: "Bank of America",
  WFC: "Wells Fargo",
  GS: "Goldman Sachs",
  MS: "Morgan Stanley"
};

const STOCK_MARKET_CAP_USD: Record<string, number> = {
  AAPL: 3_350_000_000_000,
  MSFT: 3_200_000_000_000,
  NVDA: 3_100_000_000_000,
  GOOGL: 2_100_000_000_000,
  AMZN: 2_050_000_000_000,
  META: 1_350_000_000_000,
  TSLA: 650_000_000_000,
  JPM: 900_000_000_000,
  BAC: 420_000_000_000,
  WFC: 260_000_000_000,
  GS: 360_000_000_000,
  MS: 180_000_000_000
};

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

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatSignedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

type DecisionState = "READY" | "CAUTION" | "BLOCKED";
type StockDecision = "BUY" | "SELL" | "WAIT" | "AVOID" | "HOLD";

type DecisionStock = StockData & {
  state: DecisionState;
  decision: StockDecision;
  signalState: SignalActionState;
  triggerMet: boolean;
  actionLabel: string;
  opportunityLabel: string;
  direction: "Bullish" | "Bearish";
  score: number;
  scoreLabel: "Weak Signal" | "Moderate Signal" | "Strong Signal";
  signalQuality: "Avoid" | "Watch" | "Strong";
  confidence: number;
  confidenceBand: "Very Low" | "Low" | "Medium" | "High" | "Very High";
  structureText: string;
  decisionTitle: string;
  decisionReason: string;
  nextStep: string;
  why: string[];
  strategy: string;
  summaryReason: string;
  triggerCondition: string;
  tf: Array<{ label: StockTimeframe; direction: "UP" | "DOWN" | "MIXED" }>;
  timeframeMetrics: Record<StockTimeframe, StockTimeframeMetric>;
};

function confidenceBand(value: number): "Very Low" | "Low" | "Medium" | "High" | "Very High" {
  if (value < 20) return "Very Low";
  if (value < 40) return "Low";
  if (value < 60) return "Medium";
  if (value < 80) return "High";
  return "Very High";
}

function buildStockTimeframeMetrics(stock: StockData): Record<StockTimeframe, StockTimeframeMetric> {
  const changePct = stock.changePercent;
  const absChangePct = Math.abs(changePct);
  const bullish = changePct >= 0;
  const open = Number(stock.open ?? stock.price);
  const high = Number(stock.high ?? stock.price);
  const low = Number(stock.low ?? stock.price);
  const rangePct = open > 0 ? ((high - low) / open) * 100 : 0;

  const buildMetric = (
    label: StockTimeframe,
    threshold: number,
    triggerBuffer: number,
    noiseFloor: number,
  ): StockTimeframeMetric => {
    const direction = absChangePct < threshold || rangePct < noiseFloor
      ? "MIXED"
      : bullish
        ? "UP"
        : "DOWN";

    const triggerPrice = bullish
      ? stock.price * (1 + triggerBuffer)
      : stock.price * (1 - triggerBuffer);

    return {
      label,
      direction,
      momentumLabel:
        direction === "UP"
          ? `${label} momentum is pushing higher`
          : direction === "DOWN"
            ? `${label} momentum is leaning lower`
            : `${label} momentum is mixed`,
      triggerLabel: getTimeframeTriggerLabel({
        timeframe: label,
        direction,
        price: stock.price,
        upBuffer: triggerBuffer,
        downBuffer: triggerBuffer,
      }),
      rangeBias:
        rangePct >= threshold * 2
          ? `${label} range expansion`
          : `${label} range is compressed`,
    };
  };

  return {
    "1m": buildMetric("1m", 0.05, 0.0012, 0.08),
    "5m": buildMetric("5m", 0.09, 0.002, 0.12),
    "1d": buildMetric("1d", 0.8, 0.01, 0.8),
    "4h": buildMetric("4h", 0.55, 0.0075, 0.55),
    "1h": buildMetric("1h", 0.3, 0.005, 0.35),
    "15m": buildMetric("15m", 0.15, 0.003, 0.2),
  };
}

function toDecisionStock(
  stock: StockData,
  profile: TradingProfile,
  minConfidence: number,
  profileLabel: string,
  selectedTimeframe: StockTimeframe,
): DecisionStock {
  const profileConfig = getProfileConfig(profile);
  const changePct = stock.changePercent;
  const absChangePct = Math.abs(changePct);
  const bullish = changePct >= 0;
  const open = Number(stock.open ?? stock.price);
  const high = Number(stock.high ?? stock.price);
  const low = Number(stock.low ?? stock.price);
  const rangePct = open > 0 ? ((high - low) / open) * 100 : 0;
  const score = Math.max(0, Math.min(10, absChangePct * 2.8 + rangePct * 1.2));
  const confidence = Math.max(5, Math.min(95, Math.round(score * 10 + (absChangePct >= 1 ? 8 : 0) - (absChangePct < 0.25 ? 10 : 0))));
  const timeframeMetrics = buildStockTimeframeMetrics(stock);
  const selectedMetric = timeframeMetrics[selectedTimeframe];
  const structure = selectedMetric.direction === "MIXED" ? "mixed" : selectedMetric.direction === "UP" ? "bullish" : "bearish";

  const decision: StockDecision = confidence < minConfidence
    ? "AVOID"
    : structure === "mixed"
      ? "WAIT"
      : structure === "bullish"
        ? profile === "long_term"
          ? "HOLD"
          : "BUY"
        : profile === "scalp"
          ? "SELL"
          : "AVOID";

  const state: DecisionState = decision === "WAIT" ? "CAUTION" : decision === "AVOID" ? "BLOCKED" : "READY";
  const actionLabel = decision === "BUY"
    ? "BUY"
    : decision === "HOLD"
      ? "HOLD"
      : decision === "SELL"
        ? "SELL"
        : decision === "WAIT"
          ? "PREPARE"
          : "AVOID";
  const opportunityLabel = decision === "BUY"
    ? profile === "day"
      ? "✅ BUY - Intraday Breakout"
      : profile === "swing"
        ? "✅ BUY - Swing Setup"
        : "✅ BUY - Momentum Setup"
    : decision === "HOLD"
      ? "🏦 HOLD - Position Build"
      : decision === "SELL"
        ? "🔻 SELL - Scalp Reversal"
        : decision === "WAIT"
          ? `⚠️ PREPARE - ${profileConfig.name} Setup`
          : `🚫 AVOID - ${profileConfig.name} Filter`;

  const scoreLabel = score <= 3 ? "Weak Signal" : score <= 6 ? "Moderate Signal" : "Strong Signal";
  const signalQuality = score <= 3 ? "Avoid" : score <= 6 ? "Watch" : "Strong";

  const structureText = structure === "mixed"
    ? `⚠️ Structure: Not Aligned (${profileConfig.name} Criteria)`
    : structure === "bullish"
      ? `✅ Structure: Aligned (${profileConfig.name} Criteria)`
      : profile === "scalp"
        ? "🔻 Structure: Downside Aligned (Scalper Criteria)"
        : `⚠️ Structure: Bearish Against ${profileConfig.name} Criteria`;

  const decisionTitle = decision === "BUY"
    ? "✅ STRONG BUY"
    : decision === "HOLD"
      ? "🏦 HOLD / ACCUMULATE"
      : decision === "SELL"
        ? "🔻 STRONG SELL"
        : decision === "WAIT"
          ? "⚠️ PREPARE - Criteria Building"
          : "🚫 AVOID TRADE - Low probability setup";

  const decisionReason = decision === "BUY"
    ? `${profileConfig.name} criteria are aligned and the setup is actionable.`
    : decision === "HOLD"
      ? `Bullish structure remains aligned, so this ${profileConfig.name.toLowerCase()} should hold and accumulate.`
      : decision === "SELL"
        ? "This setup fits a scalp-style downside move with aligned momentum."
        : decision === "WAIT"
          ? `Structure is visible, but it is not fully aligned for ${profileLabel} criteria yet.`
          : `This setup does not meet the ${minConfidence}% confidence threshold for a ${profileLabel}.`;

  const nextStep = decision === "AVOID"
    ? `Stand aside. This does not satisfy ${profileConfig.name} criteria yet.`
    : decision === "HOLD"
      ? "Accumulate gradually"
      : decision === "SELL"
        ? "Enter on momentum spike within minutes"
        : profileConfig.nextStepGuidance;

  const why: string[] = [];
  if (absChangePct < 0.35) why.push("Weak momentum");
  if (rangePct < 0.8) why.push("No breakout confirmation");
  if (decision === "WAIT") why.push("Conflicting short-term structure");
  if ((decision === "BUY" || decision === "HOLD") && absChangePct >= 1) why.push("Momentum building across timeframes");
  why.unshift(selectedMetric.momentumLabel);
  if (why.length < 3) {
    while (why.length < 3) {
      why.push(why.length === 0 ? "Conflicting signals across timeframes" : why.length === 1 ? "Weak buying pressure" : "No breakout confirmation");
    }
  }

  const strategy = decision === "BUY" || decision === "HOLD"
    ? profileConfig.strategy
    : decision === "SELL"
      ? "Fast downside execution only"
      : decision === "WAIT"
        ? `Wait for ${profileConfig.name.toLowerCase()} trigger`
        : "Stand aside";

  const triggerCondition = decision === "AVOID"
    ? "No safe entry right now"
    : decision === "HOLD"
      ? "Accumulate only on controlled pullbacks with steady volume"
      : selectedMetric.triggerLabel;

  const tf: Array<{ label: StockTimeframe; direction: "UP" | "DOWN" | "MIXED" }> = TIMEFRAME_VIEWS.map((label) => ({
    label,
    direction: timeframeMetrics[label].direction,
  }));

  const triggerMet = state === "READY";
  const signalState = deriveSignalState(decision, triggerMet);

  return {
    ...stock,
    state,
    decision,
    signalState,
    triggerMet,
    actionLabel,
    opportunityLabel,
    direction: bullish ? "Bullish" : "Bearish",
    score,
    scoreLabel,
    signalQuality,
    confidence,
    confidenceBand: confidenceBand(confidence),
    structureText,
    decisionTitle,
    decisionReason,
    nextStep,
    why: why.slice(0, 3),
    strategy,
    summaryReason: decision === "BUY"
      ? `${profileConfig.opportunityFocus} are aligned on ${selectedTimeframe}`
      : decision === "HOLD"
        ? "Macro structure supports gradual accumulation"
        : decision === "WAIT"
          ? `${selectedTimeframe} confirmation is still incomplete`
          : `${selectedTimeframe} structure is too weak for ${profileConfig.name}`,
    triggerCondition,
    tf,
    timeframeMetrics,
  };
}

function getMarketStatus(
  total: number,
  readyCount: number,
  cautionCount: number,
  blockedCount: number,
  profileLabel: string,
  minConfidence: number,
): { title: string; subtitle: string; shellClass: string } {
  const blockedRatio = total > 0 ? blockedCount / total : 1;

  if (total === 0 || blockedRatio > 0.7) {
    return {
      title: "🚫 No Trade Zone",
      subtitle: `No setups meet ${profileLabel} criteria (${minConfidence}%+ confidence)`,
      shellClass: "border-[#EF4444]/35 bg-[#3F1218]/40 shadow-[0_0_28px_rgba(239,68,68,0.15)]",
    };
  }

  if (readyCount >= 2) {
    return {
      title: "✅ Active Opportunities",
      subtitle: `${readyCount} setups currently meet ${profileLabel} rules`,
      shellClass: "border-[#22C55E]/35 bg-[#0F2E25]/45 shadow-[0_0_28px_rgba(34,197,94,0.18)]",
    };
  }

  if (cautionCount > 0 || readyCount === 1) {
    return {
      title: "⚠️ Mixed Market",
      subtitle: `Only a few setups satisfy ${profileLabel} criteria right now`,
      shellClass: "border-[#F59E0B]/35 bg-[#3A2A0E]/45 shadow-[0_0_28px_rgba(245,158,11,0.16)]",
    };
  }

  return {
    title: "🚫 No Trade Zone",
    subtitle: "Weak signals across market",
    shellClass: "border-[#EF4444]/35 bg-[#3F1218]/40 shadow-[0_0_28px_rgba(239,68,68,0.15)]",
  };
}

export function StocksDashboard() {
  const { user, token } = useAuth();
  const isGuestPreview = !user && !token;
  const [stocks, setStocks] = useState<StockData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wsStatus, setStatus] = useState<"Idle" | "Scanning" | "Error">("Idle");
  const [tokenQuery, setTokenQuery] = useState("");
  const [sortBy, setSortBy] = useState<"marketCap" | "score" | "volume24h" | "price">("marketCap");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [lastWsMessageAt, setLastWsMessageAt] = useState<number | null>(null);
  const [wsMessageCount, setWsMessageCount] = useState(0);
  const [timeframesBySymbol, setTimeframesBySymbol] = useState<Record<string, StockTimeframe>>({});
  const [upgradeIntent, setUpgradeIntent] = useState<UpgradeIntent | null>(null);

  // User profile management
  const { profile: userProfile, riskLevel, setProfile, setRiskLevel } = useUserProfile();
  const { entitlements, error: accessError } = useAppAccess();
  const effectiveProfile = entitlements.forcedProfile ?? userProfile;

  useEffect(() => {
    let cancelled = false;

    const hydrateFromHttp = async (limit: number): Promise<void> => {
      try {
        const response = await fetch(`${getApiHttpBase()}/api/prices/stocks?limit=${limit}`, { cache: "no-store" });
        if (!response.ok || cancelled) {
          return;
        }

        const data = (await response.json()) as StockQuoteResponse;
        const mapped = (data.quotes ?? []).map((quote) => ({
          symbol: quote.symbol,
          displayName: STOCK_NAMES[quote.symbol] ?? quote.symbol,
          marketCapUsd: STOCK_MARKET_CAP_USD[quote.symbol] ?? null,
          price: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
          high: quote.high,
          low: quote.low,
          open: quote.open,
          volume: 0,
          lastUpdated: new Date((quote.timestamp ?? 0) * 1000).toISOString()
        }));

        if (cancelled || mapped.length === 0) {
          return;
        }

        setStocks((current) => (mapped.length >= current.length ? mapped : current));
        setLastUpdated(data.timestamp ?? mapped[0]?.lastUpdated ?? new Date().toISOString());
        setLoading(false);
      } catch {
        // Websocket stream still provides updates when HTTP warmup fails.
      }
    };

    void hydrateFromHttp(50);
    void hydrateFromHttp(200);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let closedByCleanup = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const connect = (): void => {
      setStatus("Scanning");
      setError(null);

      socket = new WebSocket(`${getApiWebSocketBase()}/ws/prices/stocks?limit=50`);

      socket.onopen = () => {
        setStatus("Idle");
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as StockQuoteResponse;
          if (data.error) {
            setError(data.details ?? data.error);
            setStatus("Error");
            setLoading(false);
            return;
          }

          const mapped = (data.quotes ?? []).map((quote) => ({
            symbol: quote.symbol,
            displayName: STOCK_NAMES[quote.symbol] ?? quote.symbol,
            marketCapUsd: STOCK_MARKET_CAP_USD[quote.symbol] ?? null,
            price: quote.price,
            change: quote.change,
            changePercent: quote.changePercent,
            high: quote.high,
            low: quote.low,
            open: quote.open,
            volume: 0,
            lastUpdated: new Date((quote.timestamp ?? 0) * 1000).toISOString()
          }));

          setStocks(mapped);
          setLastUpdated(data.timestamp ?? mapped[0]?.lastUpdated ?? new Date().toISOString());
          setLastWsMessageAt(Date.now());
          setWsMessageCount((count) => count + 1);
          setError(null);
          setStatus("Idle");
          setLoading(false);
        } catch (parseError) {
          setError(parseError instanceof Error ? parseError.message : "Invalid websocket payload");
          setStatus("Error");
          setLoading(false);
        }
      };

      socket.onerror = () => {
        setError("Stock websocket stream interrupted");
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
  }, []);

  const wsAgeSeconds = useMemo(
    () => (lastWsMessageAt ? Math.max(0, Math.floor((Date.now() - lastWsMessageAt) / 1000)) : null),
    [lastWsMessageAt, stocks.length],
  );

  const visibleStocks = useMemo(() => {
    const query = tokenQuery.trim().toUpperCase();
    const filtered = query
      ? stocks.filter((stock) => stock.symbol.includes(query) || stock.displayName.toUpperCase().includes(query))
      : stocks;

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
          return (left.changePercent - right.changePercent) * directionFactor;
        case "volume24h":
          return (left.volume - right.volume) * directionFactor;
        case "price":
          return (left.price - right.price) * directionFactor;
        default:
          return 0;
      }
    });

    return sorted;
  }, [sortBy, sortDirection, stocks, tokenQuery]);

  const activeProfileConfig = useMemo(
    () => getProfileConfig(effectiveProfile),
    [effectiveProfile],
  );

  const decisionStocks = useMemo(
    () => visibleStocks.map((stock) => toDecisionStock(
      stock,
      effectiveProfile,
      activeProfileConfig.minConfidence,
      activeProfileConfig.name.toLowerCase(),
      timeframesBySymbol[stock.symbol] ?? getDefaultTimeframeForProfile(effectiveProfile),
    )),
    [activeProfileConfig.minConfidence, activeProfileConfig.name, effectiveProfile, timeframesBySymbol, visibleStocks],
  );

  const summary = useMemo(() => {
    let ready = 0;
    let caution = 0;
    let blocked = 0;

    for (const stock of decisionStocks) {
      if (stock.state === "READY") ready += 1;
      else if (stock.state === "CAUTION") caution += 1;
      else blocked += 1;
    }

    return {
      total: decisionStocks.length,
      ready,
      caution,
      blocked,
    };
  }, [decisionStocks]);

  const marketStatus = useMemo(
    () => getMarketStatus(summary.total, summary.ready, summary.caution, summary.blocked, activeProfileConfig.name, activeProfileConfig.minConfidence),
    [activeProfileConfig.minConfidence, activeProfileConfig.name, summary.blocked, summary.caution, summary.ready, summary.total],
  );

  const topOpportunities = useMemo(() => {
    return [...decisionStocks]
      .filter((item) => item.state === "READY" || item.state === "CAUTION")
      .sort((a, b) => {
        const statePriority = SIGNAL_STATE_PRIORITY[a.signalState] - SIGNAL_STATE_PRIORITY[b.signalState];
        if (statePriority !== 0) return statePriority;
        return b.confidence - a.confidence;
      })
      .slice(0, 3);
  }, [decisionStocks]);

  const hasActiveOpportunity = useMemo(
    () => topOpportunities.some((item) => item.signalState === "ACTIVE"),
    [topOpportunities],
  );

  const displayedStocks = useMemo(() => {
    if (isGuestPreview) {
      return decisionStocks.slice(0, 3);
    }

    if (entitlements.maxVisibleSignals == null) {
      return decisionStocks;
    }

    return decisionStocks.slice(0, entitlements.maxVisibleSignals);
  }, [decisionStocks, entitlements.maxVisibleSignals, isGuestPreview]);

  const guestLockedPreview = useMemo(() => {
    if (!isGuestPreview) {
      return [] as DecisionStock[];
    }

    return decisionStocks.slice(3, Math.min(8, decisionStocks.length));
  }, [decisionStocks, isGuestPreview]);

  const hiddenSignalCount = Math.max(0, decisionStocks.length - displayedStocks.length);
  const visibleTopOpportunities = topOpportunities.slice(0, entitlements.visibleTopOpportunityCount);
  const lockedOpportunityCount = Math.max(0, topOpportunities.length - visibleTopOpportunities.length);

  function requestUpgrade(intent: UpgradeIntent): void {
    setUpgradeIntent(intent);
  }

  if (loading) {
    return (
      <main className="mx-auto grid w-[min(1680px,99vw)] gap-4 px-0 py-5 text-[#E6EDF3]">
        <section className="rounded-strata border border-white/10 bg-[#0F172A] p-5 shadow-strata-card">
          <p className="text-sm text-[#9FB3C8]">Loading stock dashboard...</p>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto grid w-[min(1680px,99vw)] gap-4 px-0 py-5 text-[#E6EDF3]">
      <ScanControlBar
        tokenQuery={tokenQuery}
        sortBy={sortBy}
        sortDirection={sortDirection}
        helperText={getTimeframeAnalysisHelperText("STOCKS")}
        onTokenQueryChange={setTokenQuery}
        onSortByChange={setSortBy}
        onSortDirectionChange={setSortDirection}
      />

      <details className="relative z-20">
        <summary className="inline-flex cursor-pointer list-none items-center rounded-md border border-white/15 bg-[#0F172A] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-[#9FB3C8] shadow-strata-card">
          Quick Panels (Market, Opportunities, Filters)
        </summary>

      <div className="fixed right-4 top-[88px] z-40 grid max-h-[calc(100vh-104px)] w-[min(420px,92vw)] gap-3 overflow-y-auto rounded-strata border border-white/15 bg-[#0B1220]/95 p-3 shadow-[0_16px_48px_rgba(2,6,23,0.65)] backdrop-blur">

      {/* ── Market Status ── first thing users see */}
      <section className={`rounded-strata border p-5 ${marketStatus.shellClass}`}>
        <div className="flex items-center gap-2">
          <p className="text-[11px] uppercase tracking-[0.14em] text-[#AFC2D7]">Market Status</p>
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
            {wsAgeSeconds != null ? <span className="text-[#6B859E]">{wsAgeSeconds}s ago</span> : null}
            {wsMessageCount > 0 ? <span className="text-[#6B859E]">{wsMessageCount} updates</span> : null}
          </span>
        </div>
        <h2 className="mt-1 text-2xl font-bold tracking-tight text-[#E6EDF3]">{marketStatus.title}</h2>
        <p className="mt-1 text-sm text-[#C7D6E7]">{marketStatus.subtitle}</p>
        <p className="mt-2 text-xs text-[#9FB3C8]">
          {summary.ready === 1 ? `Only 1 setup meets ${activeProfileConfig.name} rules` : `${summary.ready} setups meet ${activeProfileConfig.name} rules`}
        </p>
        {lastUpdated ? (
          <p className="mt-1 text-[11px] text-[#6B859E]">Last quote: {new Date(lastUpdated).toLocaleTimeString()}</p>
        ) : null}
      </section>

      {/* ── Top Opportunities ── immediately below market status */}
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
          {visibleTopOpportunities.map((item) => {
            return (
              <TopOpportunityCard
                key={`${item.symbol}-opportunity`}
                symbol={item.symbol}
                direction={item.direction}
                actionLabel={item.opportunityLabel}
                signalState={item.signalState}
                confidence={item.confidence}
                confidenceBand={item.confidenceBand}
                reason={item.summaryReason}
                triggerCondition={item.triggerCondition}
                progressGradientClass="from-[#EF4444] via-[#F59E0B] to-[#22C55E]"
              />
            );
          })}
          {entitlements.isFreeTier && lockedOpportunityCount > 0 ? (
            <LockedOpportunityTeaserCard
              hiddenCount={lockedOpportunityCount}
              onUnlock={() => requestUpgrade({ feature: "top_opportunities", marketLabel: "Stocks" })}
            />
          ) : null}
        </div>
      </section>

      {/* ── Compact control bar: Mode + Risk dropdowns ── */}
      <CompactProfileBar
        activeProfile={effectiveProfile}
        activeRiskLevel={riskLevel}
        onProfileChange={(profile) => {
          if (entitlements.forcedProfile && profile !== entitlements.forcedProfile) {
            requestUpgrade({
              feature: "profile_switch",
              marketLabel: "Stocks",
              context: `${profile.replace(/_/g, " ")} mode is Pro`,
            });
            return;
          }
          setProfile(profile);
        }}
        onRiskLevelChange={setRiskLevel}
        lockedProfile={entitlements.forcedProfile}
        onLockedProfileAttempt={(profile) => requestUpgrade({
          feature: "profile_switch",
          marketLabel: "Stocks",
          context: `${profile.replace(/_/g, " ")} mode is Pro`,
        })}
      />

      <AccessValueBanner
        entitlements={entitlements}
        hiddenSignalCount={hiddenSignalCount}
        lockedOpportunityCount={lockedOpportunityCount}
        marketLabel="Stocks"
        accessError={accessError}
        onUpgradeClick={requestUpgrade}
      />
      </div>
      </details>

      {isGuestPreview ? (
        <section className="rounded-strata border border-[#F59E0B]/30 bg-[#3A2A0E]/40 p-4 shadow-strata-card">
          <p className="text-xs uppercase tracking-[0.12em] text-[#FCD34D]">Guest Preview</p>
          <p className="mt-1 text-sm text-[#FDE7C7]">
            You are viewing 3 live stock signals. Sign in to unlock full market depth and full setup details.
          </p>
        </section>
      ) : null}

      {error ? (
        <section className="rounded-strata border border-[#EF4444]/30 bg-[#0F172A] p-5 shadow-strata-card">
          <p className="text-sm text-[#FCA5A5]">Stock quotes are temporarily unavailable: {error}</p>
        </section>
      ) : null}

      <section className="flex flex-wrap items-center gap-2 rounded-strata border border-white/10 bg-[#0F172A] px-3 py-2 text-xs shadow-strata-card">
        <span className="rounded-md border border-white/10 px-2 py-1 text-[#C7D6E7]">Scanned <strong className="text-[#E6EDF3]">{entitlements.isFreeTier ? displayedStocks.length : summary.total}</strong></span>
        <span className="rounded-md border border-[#22C55E]/30 px-2 py-1 text-[#86EFAC]">Ready <strong>{summary.ready}</strong></span>
        <span className="rounded-md border border-[#F59E0B]/30 px-2 py-1 text-[#FDE68A]">Caution <strong>{summary.caution}</strong></span>
        <span className="rounded-md border border-[#EF4444]/30 px-2 py-1 text-[#FCA5A5]">Blocked <strong>{summary.blocked}</strong></span>
      </section>

      <section className="grid max-h-[calc(100vh-210px)] gap-2 overflow-y-auto pr-1">
        {displayedStocks.map((stock) => {
          const selectedTimeframe = timeframesBySymbol[stock.symbol] ?? getDefaultTimeframeForProfile(effectiveProfile);
          const positive = stock.changePercent > 0;
          const negative = stock.changePercent < 0;
          const changeClass = positive ? "text-[#22C55E]" : negative ? "text-[#EF4444]" : "text-[#9FB3C8]";
          const decisionShell = stock.state === "READY"
            ? stock.direction === "Bullish"
              ? "border-[#22C55E]/35 bg-[#0F2E25]/45 text-[#BBF7D0]"
              : "border-[#EF4444]/35 bg-[#3F1218]/40 text-[#FECACA]"
            : stock.state === "CAUTION"
              ? "border-[#F59E0B]/35 bg-[#3A2A0E]/45 text-[#FDE68A]"
              : "border-[#EF4444]/35 bg-[#3F1218]/40 text-[#FECACA]";

          return (
            <article key={stock.symbol} className="rounded-strata border border-white/10 bg-[#0F172A] p-4 shadow-strata-card transition hover:border-white/20">
              <section className={`rounded-xl border p-4 ${decisionShell}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xl font-extrabold tracking-tight">{stock.decisionTitle}</p>
                  <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-[0.08em] ${getSignalStatePresentation(stock.signalState).badgeClass}`}>
                    {getSignalStatePresentation(stock.signalState).badge}
                  </span>
                </div>
                <p className="mt-1 text-sm text-[#D7E4F2]">{stock.decisionReason}</p>
                <div className={`mt-3 rounded-lg border px-3 py-2 ${getSignalStatePresentation(stock.signalState).bannerClass}`}>
                  <p className="text-sm font-bold tracking-tight">{getSignalStatePresentation(stock.signalState).bannerText}</p>
                  <p className="mt-0.5 text-xs font-medium opacity-90">{getSignalStatePresentation(stock.signalState).microCopy}</p>
                </div>
              </section>

              <section className="mt-3 rounded-lg border border-white/10 bg-[#0B1220] p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Next Step</p>
                <p className="mt-1 text-sm font-semibold text-[#E6EDF3]">{getSignalStatePresentation(stock.signalState).nextStep}</p>
                <p className="mt-1 text-xs text-[#9FB3C8]">{stock.nextStep}</p>
              </section>

              {entitlements.isFreeTier && (stock.confidence >= 75 || stock.actionLabel.includes("BUY")) ? (
                <section className="mt-3 rounded-lg border border-[#F59E0B]/30 bg-[linear-gradient(135deg,rgba(120,53,15,0.45),rgba(15,23,42,0.9))] p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-[#FCD34D]">High-confidence Pro teaser</p>
                  <p className="mt-1 text-sm font-semibold text-[#FFF7ED]">This setup is close to actionable. Pro unlocks the exact setup, entry zone, and simulation path.</p>
                  <button
                    type="button"
                    onClick={() => requestUpgrade({ feature: "trade_setup", symbol: stock.symbol, marketLabel: "Stocks", confidence: stock.confidence, actionLabel: stock.actionLabel, context: "High-confidence setup" })}
                    className="mt-3 rounded-lg border border-[#FCD34D]/35 bg-[#451A03]/70 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#FDE68A] transition hover:bg-[#5B2107]"
                  >
                    Unlock this setup
                  </button>
                </section>
              ) : null}

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:items-center">
                <div className="lg:col-span-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Token</p>
                  <p className="text-base font-semibold text-[#E6EDF3]">{stock.symbol}</p>
                  <p className="text-xs text-[#9FB3C8]">{stock.displayName}</p>
                  <p className="mt-1 text-[10px] uppercase tracking-[0.08em] text-[#6B859E]">MCap {formatMarketCap(stock.marketCapUsd)}</p>
                </div>

                <div className="lg:col-span-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Score</p>
                  <p className="text-sm font-semibold text-[#E6EDF3]">{stock.scoreLabel} ({stock.score.toFixed(1)} / 10)</p>
                  <p className="mt-1 text-[11px] text-[#9FB3C8]">Signal Quality: {stock.signalQuality}</p>
                </div>

                <div className="lg:col-span-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Confidence</p>
                  <p className="text-lg font-bold text-[#E6EDF3]">{stock.confidence}% ({stock.confidenceBand})</p>
                  <div className="mt-1 h-2 rounded-full bg-[#0B1220]">
                    <div
                      className="h-2 rounded-full bg-gradient-to-r from-[#EF4444] via-[#F59E0B] to-[#22C55E] transition-all"
                      style={{ width: `${stock.confidence}%` }}
                    />
                  </div>
                </div>

                <div className="lg:col-span-4">
                  <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Market Structure</p>
                  <p className="mt-1 text-sm font-semibold text-[#E6EDF3]">{stock.structureText}</p>
                  <p className="mt-1 text-xs text-[#9FB3C8]">{stock.timeframeMetrics[selectedTimeframe].rangeBias}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
                    {stock.tf.map((point) => (
                      <span key={`${stock.symbol}-${point.label}`} className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-[#0B1220] px-2 py-1">
                        <span className="font-mono text-[10px] tracking-[0.12em] text-[#9FB3C8]">{point.label}</span>
                        <span className={point.direction === "UP" ? "text-[#22C55E]" : point.direction === "DOWN" ? "text-[#EF4444]" : "text-[#9FB3C8]"}>{point.direction === "UP" ? "↑" : point.direction === "DOWN" ? "↓" : "•"}</span>
                      </span>
                    ))}
                  </div>
                </div>

                <div className="lg:col-span-2 flex items-center justify-end gap-2">
                  {entitlements.isFreeTier ? (
                    <>
                      <button
                        type="button"
                        onClick={() => requestUpgrade({ feature: "trade_setup", symbol: stock.symbol, marketLabel: "Stocks", confidence: stock.confidence, actionLabel: stock.actionLabel, context: "Unlock the exact trade" })}
                        className={`rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] transition ${(stock.signalState === "ACTIVE" || stock.confidence > 70) ? "border-[#22C55E]/50 bg-[#22C55E]/20 text-[#BBF7D0] hover:bg-[#22C55E]/30" : "border-[#2F7BFF]/40 bg-[#2F7BFF]/20 text-[#8ED8FF] hover:bg-[#2F7BFF]/35"}`}
                      >
                        🔍 Unlock Full Trade Setup
                      </button>
                      <button
                        type="button"
                        onClick={() => requestUpgrade({ feature: "simulation", symbol: stock.symbol, marketLabel: "Stocks", confidence: stock.confidence, actionLabel: stock.actionLabel, context: "Test this trade in Pro" })}
                        className="rounded-lg border border-white/20 bg-[#0F172A] px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#C7D6E7] transition hover:border-white/35"
                      >
                        🧪 Test This Trade
                      </button>
                      <button
                        type="button"
                        onClick={() => requestUpgrade({ feature: "entry_zone", symbol: stock.symbol, marketLabel: "Stocks", confidence: stock.confidence, actionLabel: stock.actionLabel, context: "View the entry plan in Pro" })}
                        className="rounded-lg border border-white/20 bg-[#0F172A] px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#C7D6E7] transition hover:border-white/35"
                      >
                        📊 View Entry Plan
                      </button>
                    </>
                  ) : (
                    <>
                      <Link
                        href={`/analysis?symbol=${stock.symbol}&assetType=STOCK&interval=${getAnalysisIntervalForTimeframe(selectedTimeframe)}`}
                        className="rounded-lg border border-[#2F7BFF]/40 bg-[#2F7BFF]/20 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#8ED8FF] transition hover:bg-[#2F7BFF]/35"
                      >
                        🔍 Unlock Full Trade Setup
                      </Link>
                      <Link
                        href={`/simulation?symbol=${stock.symbol}`}
                        className="rounded-lg border border-white/20 bg-[#0F172A] px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#C7D6E7] transition hover:border-white/35"
                      >
                        🧪 Test This Trade
                      </Link>
                      <Link
                        href={`/analysis?symbol=${stock.symbol}&assetType=STOCK&interval=${getAnalysisIntervalForTimeframe(selectedTimeframe)}`}
                        className="rounded-lg border border-white/20 bg-[#0F172A] px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#C7D6E7] transition hover:border-white/35"
                      >
                        📊 View Entry Plan
                      </Link>
                    </>
                  )}
                </div>
              </div>

              <section className="mt-3 rounded-lg border border-white/10 bg-[#0B1220] p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Why This Decision</p>
                <ul className="mt-2 space-y-1 text-sm text-[#C7D6E7]">
                  {stock.why.map((reason) => (
                    <li key={`${stock.symbol}-${reason}`}>• {reason}</li>
                  ))}
                </ul>
              </section>

              {entitlements.isFreeTier ? (
                <section className="mt-3 rounded-lg border border-[#F59E0B]/25 bg-[#78350F]/25 p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-[#FCD34D]">{stock.signalState === "ACTIVE" ? "✅ Trigger Met — Entry is valid" : stock.signalState === "PREPARE" ? "⚡ Trigger Condition" : "🚫 No Safe Entry Right Now"} ({activeProfileConfig.name})</p>
                  <p className="mt-1 text-sm font-medium text-[#FDE68A]">You already know the direction. Pro reveals the exact confirmation trigger.</p>
                  <button
                    type="button"
                    onClick={() => requestUpgrade({ feature: "trigger_details", symbol: stock.symbol, marketLabel: "Stocks", confidence: stock.confidence, actionLabel: stock.actionLabel, context: "Trigger details locked" })}
                    className="mt-3 rounded-lg border border-[#FCD34D]/35 bg-[#451A03]/70 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#FDE68A] transition hover:bg-[#5B2107]"
                  >
                    Unlock Trigger
                  </button>
                </section>
              ) : (
                <section className="mt-3 rounded-lg border border-[#F59E0B]/25 bg-[#78350F]/25 p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-[#FCD34D]">{stock.signalState === "ACTIVE" ? "✅ Trigger Met — Entry is valid" : stock.signalState === "PREPARE" ? "⚡ Trigger Condition" : "🚫 No Safe Entry Right Now"} ({activeProfileConfig.name})</p>
                  <p className="mt-1 text-sm font-medium text-[#FDE68A]">
                    {stock.signalState === "ACTIVE" ? "Entry is valid now — act on the confirmed trigger." : stock.triggerCondition}
                  </p>
                </section>
              )}

              <section className="mt-3 rounded-lg border border-white/10 bg-[#0B1220] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Stock Timeframe</p>
                  <div className="rounded-lg border border-white/10 bg-[#0F172A] p-1">
                    {TIMEFRAME_VIEWS.map((value) => (
                      <button
                        key={`${stock.symbol}-${value}`}
                        type="button"
                        onClick={() => setTimeframesBySymbol((current) => ({ ...current, [stock.symbol]: value }))}
                        className={`rounded-md px-3 py-1.5 text-xs font-medium tracking-[0.08em] ${selectedTimeframe === value ? "bg-[#3EC6FF]/20 text-[#E6EDF3]" : "text-[#9FB3C8] hover:text-[#E6EDF3]"}`}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <section className="mt-3 grid grid-cols-1 gap-2 rounded-lg border border-white/10 bg-[#0B1220] p-3 md:grid-cols-3">
                <p className="text-sm text-[#E6EDF3]"><span className="text-[#9FB3C8]">Action:</span> {stock.actionLabel}</p>
                <p className="text-sm text-[#E6EDF3]"><span className="text-[#9FB3C8]">Confidence:</span> {stock.confidenceBand} ({stock.confidence}%)</p>
                <p className="text-sm text-[#E6EDF3]"><span className="text-[#9FB3C8]">Strategy:</span> {stock.strategy}</p>
              </section>

              {entitlements.isFreeTier ? (
                <section className="mt-3 rounded-lg border border-[#F59E0B]/25 bg-[#78350F]/25 p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-[#FCD34D]">Execution Layer</p>
                  <p className="mt-1 text-sm text-[#FDE7C7]">Entry zone, exact risk framing, and simulation are kept for Pro so Free can stay fast and decision-first.</p>
                </section>
              ) : null}

              <section className="mt-3 rounded-lg border border-white/10 bg-[#0B1220] p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Price Action Data</p>
                <p className={`mt-1 text-sm font-semibold ${changeClass}`}>Price ${stock.price.toFixed(2)} • Change {formatSigned(stock.change)} • {formatSignedPercent(stock.changePercent)}</p>
                <p className="mt-1 text-xs text-[#9FB3C8]">Session range ${Number(stock.low ?? 0).toFixed(2)} - ${Number(stock.high ?? 0).toFixed(2)} • Open ${Number(stock.open ?? 0).toFixed(2)}</p>
                <p className="mt-1 text-xs text-[#9FB3C8]">Selected timeframe: {selectedTimeframe} • {stock.timeframeMetrics[selectedTimeframe].momentumLabel}</p>
              </section>
            </article>
          );
        })}

        {isGuestPreview && guestLockedPreview.length > 0 ? (
          guestLockedPreview.map((stock) => (
            <article
              key={`${stock.symbol}-guest-locked`}
              className="relative overflow-hidden rounded-strata border border-white/10 bg-[#0F172A]"
            >
              <div className="pointer-events-none select-none p-4 blur-[2px] opacity-60">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-[#E6EDF3]">{stock.symbol}</p>
                  <p className="text-xs text-[#9FB3C8]">Locked</p>
                </div>
                <p className="mt-2 text-xs text-[#9FB3C8]">Additional setup details are available after sign in.</p>
              </div>
              <div className="absolute inset-0 flex items-center justify-center bg-[#020617]/45">
                <Link
                  href="/login"
                  className="rounded-lg border border-[#FCD34D]/45 bg-[#451A03]/80 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#FDE68A] transition hover:bg-[#5B2107]"
                >
                  Sign In To Unlock
                </Link>
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
    </main>
  );
}
