"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "../contexts/auth-context";

const API_BASE_ENV = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").trim();

function getApiBase(): string {
  if (API_BASE_ENV) {
    return API_BASE_ENV.replace(/\/+$/, "");
  }
  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "https" : "http";
    return `${protocol}://${window.location.hostname}:8787`;
  }
  return "http://localhost:8787";
}

type StockData = {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  lastUpdated: string;
};

type StockQuoteResponse = {
  provider: string;
  assetClass: "STOCK";
  timestamp: string;
  count: number;
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
};

export function StocksDashboard() {
  const { token } = useAuth();
  const apiBase = getApiBase();
  const [stocks, setStocks] = useState<StockData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStocks = async () => {
      try {
        setLoading(true);
        setError(null);

        // Fetch latest stock market data
        const response = await fetch(`${apiBase}/api/prices/stocks`, {
          cache: "no-store"
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch stock data: ${response.status}`);
        }

        const data = (await response.json()) as StockQuoteResponse | StockData[];
        if (Array.isArray(data)) {
          setStocks(data);
        } else {
          const mapped = (data.quotes ?? []).map((q) => ({
            symbol: q.symbol,
            price: q.price,
            change: q.change,
            changePercent: q.changePercent,
            volume: 0,
            lastUpdated: new Date((q.timestamp ?? 0) * 1000).toISOString()
          }));
          setStocks(mapped);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setError(msg);
        console.error("Error fetching stocks:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchStocks();
    const interval = setInterval(fetchStocks, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [apiBase]);

  if (loading) {
    return (
      <div className="shell">
        <section className="panel">
          <h2>Stock Markets</h2>
          <p className="section-collapsed-note">Loading stock data...</p>
        </section>
      </div>
    );
  }

  if (error) {
    return (
      <div className="shell">
        <section className="panel error-panel">
          <h2>Stock Markets</h2>
          <p className="section-collapsed-note" style={{ color: "#ff6b6b" }}>
            ⚠️ Error: {error}
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="shell">
      <section className="panel">
        <h2>Stock Markets</h2>
        <p className="section-collapsed-note">
          Real-time stock quotes from Finnhub
        </p>

        {stocks.length === 0 ? (
          <div className="no-data">
            <p>No stock data available. Run backfill:</p>
            <p style={{ fontSize: "0.85em", fontFamily: "monospace", color: "#999" }}>
              npm run backfill:stocks
            </p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Price</th>
                  <th>Change</th>
                  <th>Change %</th>
                  <th>Volume</th>
                  <th>Last Updated</th>
                </tr>
              </thead>
              <tbody>
                {stocks.map((stock) => (
                  <tr key={stock.symbol}>
                    <td className="symbol-cell">
                      <Link href={`/analysis?symbol=${stock.symbol}&assetType=STOCK&interval=1h`}>
                        {stock.symbol}
                      </Link>
                    </td>
                    <td className="price-cell">${stock.price.toFixed(2)}</td>
                    <td
                      className={stock.change >= 0 ? "bullish" : "bearish"}
                      style={{ color: stock.change >= 0 ? "#22c55e" : "#ef4444" }}
                    >
                      {stock.change >= 0 ? "+" : ""}{stock.change.toFixed(2)}
                    </td>
                    <td
                      className={stock.changePercent >= 0 ? "bullish" : "bearish"}
                      style={{ color: stock.changePercent >= 0 ? "#22c55e" : "#ef4444" }}
                    >
                      {stock.changePercent >= 0 ? "+" : ""}{stock.changePercent.toFixed(2)}%
                    </td>
                    <td className="volume-cell">{stock.volume > 0 ? `${(stock.volume / 1e6).toFixed(1)}M` : "-"}</td>
                    <td className="time-cell" style={{ fontSize: "0.85em", color: "#666" }}>
                      {new Date(stock.lastUpdated).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="links-row" style={{ marginTop: "20px" }}>
          <Link href="/pre-pump/stocks" className="app-nav-link">
            → Stock Pre-Pump Analysis
          </Link>
          <Link href="/workspace/simulation" className="app-nav-link">
            → Simulation Settings
          </Link>
        </div>
      </section>
    </div>
  );
}
