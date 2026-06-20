"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScanControlBar } from "./system/scan-control-bar";

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

export function StocksDashboard() {
  const router = useRouter();
  const [stocks, setStocks] = useState<StockData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"Idle" | "Scanning" | "Error">("Idle");
  const [timeframe, setTimeframe] = useState<"15M" | "1H" | "4H" | "1D">("1D");
  const [tokenQuery, setTokenQuery] = useState("");
  const [sortBy, setSortBy] = useState<"marketCap" | "score" | "volume24h" | "price">("marketCap");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  useEffect(() => {
    let closedByCleanup = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const connect = (): void => {
      setStatus("Scanning");
      setError(null);

      socket = new WebSocket(`${getApiWebSocketBase()}/ws/prices/stocks?limit=12&pollMs=30000`);

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

  const summary = useMemo(() => {
    let advancers = 0;
    let decliners = 0;
    let flat = 0;

    for (const stock of visibleStocks) {
      if (stock.changePercent > 0) {
        advancers += 1;
      } else if (stock.changePercent < 0) {
        decliners += 1;
      } else {
        flat += 1;
      }
    }

    return {
      total: visibleStocks.length,
      advancers,
      decliners,
      flat
    };
  }, [visibleStocks]);

  const handleMarketChange = useCallback((market: "CRYPTO" | "STOCKS") => {
    if (market === "CRYPTO") {
      router.push("/markets/crypto");
    }
  }, [router]);

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
        market="STOCKS"
        timeframe={timeframe}
        tokenQuery={tokenQuery}
        sortBy={sortBy}
        sortDirection={sortDirection}
        lastUpdated={lastUpdated}
        status={status}
        helperText="Live stock quotes view with token filtering and market-cap sorting."
        onMarketChange={handleMarketChange}
        onTimeframeChange={setTimeframe}
        onTokenQueryChange={setTokenQuery}
        onSortByChange={setSortBy}
        onSortDirectionChange={setSortDirection}
      />

      {error ? (
        <section className="rounded-strata border border-[#EF4444]/30 bg-[#0F172A] p-5 shadow-strata-card">
          <p className="text-sm text-[#FCA5A5]">Stock quotes are temporarily unavailable: {error}</p>
        </section>
      ) : null}

      <section className="grid grid-cols-2 gap-3 rounded-strata border border-white/10 bg-[#0F172A] p-4 shadow-strata-card md:grid-cols-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Total Quoted</p>
          <p className="mt-1 text-xl font-semibold">{summary.total}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Advancers</p>
          <p className="mt-2 text-lg font-semibold text-[#22C55E]">{summary.advancers}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Decliners</p>
          <p className="mt-2 text-lg font-semibold text-[#EF4444]">{summary.decliners}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-[#6B859E]">Flat</p>
          <p className="mt-2 text-lg font-semibold text-[#9FB3C8]">{summary.flat}</p>
        </div>
      </section>

      <section className="grid gap-3">
        {visibleStocks.map((stock) => {
          const positive = stock.changePercent > 0;
          const negative = stock.changePercent < 0;
          const changeClass = positive ? "text-[#22C55E]" : negative ? "text-[#EF4444]" : "text-[#9FB3C8]";

          return (
            <article key={stock.symbol} className="rounded-strata border border-white/10 bg-[#0F172A] p-4 shadow-strata-card transition hover:border-white/20">
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:items-center">
                <div className="lg:col-span-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Token</p>
                  <p className="text-base font-semibold text-[#E6EDF3]">{stock.symbol}</p>
                  <p className="text-xs text-[#9FB3C8]">{stock.displayName}</p>
                  <p className="mt-1 text-[11px] uppercase tracking-[0.08em] text-[#6B859E]">MCap {formatMarketCap(stock.marketCapUsd)}</p>
                </div>

                <div className="lg:col-span-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Price</p>
                  <p className="text-sm font-semibold text-[#E6EDF3]">${stock.price.toFixed(2)}</p>
                  <p className={`mt-1 text-sm font-semibold ${changeClass}`}>{formatSigned(stock.change)} • {formatSignedPercent(stock.changePercent)}</p>
                </div>

                <div className="lg:col-span-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">Session Range</p>
                  <p className="text-sm text-[#E6EDF3]">${Number(stock.low ?? 0).toFixed(2)} - ${Number(stock.high ?? 0).toFixed(2)}</p>
                  <p className="mt-1 text-xs text-[#9FB3C8]">Open ${Number(stock.open ?? 0).toFixed(2)}</p>
                </div>

                <div className="lg:col-span-3">
                  <p className="text-xs uppercase tracking-[0.12em] text-[#6B859E]">View Status</p>
                  <p className="inline-flex rounded-full border border-[#3EC6FF]/30 bg-[#3EC6FF]/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#3EC6FF]">Quote Snapshot</p>
                  <p className="mt-2 text-sm text-[#9FB3C8]">Signal alignment is not computed in the stock quotes view.</p>
                </div>

                <div className="lg:col-span-2 flex items-center justify-end gap-2">
                  <Link
                    href={`/analysis?symbol=${stock.symbol}&assetType=STOCK&interval=1h`}
                    className="rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#9FB3C8] transition hover:text-[#E6EDF3]"
                  >
                    Details
                  </Link>
                </div>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}
