"use client";

import { useState, useEffect } from "react";
import { useAuth } from "../contexts/auth-context";
import { useSearchParams } from "next/navigation";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ComposedChart
} from "recharts";

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

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandleResponse {
  symbol: string;
  assetType: "CRYPTO" | "STOCK";
  interval: string;
  count: number;
  candles: Candle[];
}

const SUPPORTED_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "12h", "1d"] as const;

function formatChartDate(timestamp: number, interval: string): string {
  if (interval === "1d") {
    return new Date(timestamp).toLocaleDateString();
  }

  if (interval === "12h" || interval === "4h") {
    return new Date(timestamp).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

interface ChartData extends Candle {
  date: string;
  rsi?: number;
  macdLine?: number;
  macdSignal?: number;
  macdHistogram?: number;
}

export default function MarketAnalysis() {
  const { user, token } = useAuth();
  const searchParams = useSearchParams();
  const [symbol, setSymbol] = useState("BTC");
  const [assetType, setAssetType] = useState<"CRYPTO" | "STOCK">("CRYPTO");
  const [interval, setInterval] = useState("1h");
  const [data, setData] = useState<ChartData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiBase = getApiBase();

  useEffect(() => {
    const symbolParam = String(searchParams.get("symbol") ?? "").trim().toUpperCase();
    const assetTypeParam = String(searchParams.get("assetType") ?? "").trim().toUpperCase();
    const intervalParam = String(searchParams.get("interval") ?? "").trim();

    if (symbolParam) setSymbol(symbolParam);
    if (assetTypeParam === "CRYPTO" || assetTypeParam === "STOCK") {
      setAssetType(assetTypeParam);
    }
    if (SUPPORTED_INTERVALS.includes(intervalParam as typeof SUPPORTED_INTERVALS[number])) {
      setInterval(intervalParam);
    }
  }, [searchParams]);

  // Calculate RSI
  const calculateRSI = (prices: number[], period = 14): number[] => {
    const rsi: number[] = [];
    let gains = 0;
    let losses = 0;

    for (let i = 0; i < prices.length; i++) {
      if (i === 0) {
        rsi.push(50);
        continue;
      }

      const change = prices[i] - prices[i - 1];
      if (i <= period) {
        if (change > 0) gains += change;
        else losses += Math.abs(change);
        if (i === period) {
          gains /= period;
          losses /= period;
        }
      } else {
        gains = (gains * (period - 1) + (change > 0 ? change : 0)) / period;
        losses = (losses * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
      }

      if (i < period) {
        rsi.push(50);
      } else {
        const rs = losses === 0 ? 100 : (gains / losses) * 100;
        rsi.push(100 - 100 / (1 + rs / 100));
      }
    }
    return rsi;
  };

  // Calculate MACD
  const calculateMACD = (prices: number[], fast = 12, slow = 26, signal = 9) => {
    const ema = (data: number[], period: number) => {
      const k = 2 / (period + 1);
      let emaValue = data[0];
      return data.map((price) => {
        emaValue = price * k + emaValue * (1 - k);
        return emaValue;
      });
    };

    const fastEMA = ema(prices, fast);
    const slowEMA = ema(prices, slow);
    const macdLine = fastEMA.map((f, i) => f - slowEMA[i]);
    const signalLine = ema(macdLine, signal);

    return {
      macdLine,
      signalLine,
      histogram: macdLine.map((m, i) => m - signalLine[i])
    };
  };

  useEffect(() => {
    if (!token || !user) return;

    const fetchCandles = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `${apiBase}/api/candles?symbol=${symbol}&assetType=${assetType}&interval=${interval}&limit=100`,
          {
            headers: { Authorization: `Bearer ${token}` }
          }
        );

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to fetch candles");
        }

        const candleData: CandleResponse = await res.json();

        if (candleData.candles.length === 0) {
          setError(`No candles found for ${symbol}`);
          setData([]);
          return;
        }

        const closes = candleData.candles.map((c) => c.close);
        const rsiValues = calculateRSI(closes);
        const macdData = calculateMACD(closes);

        const chartData: ChartData[] = candleData.candles.map((candle, idx) => ({
          ...candle,
          date: formatChartDate(candle.timestamp, interval),
          rsi: rsiValues[idx],
          macdLine: macdData.macdLine[idx],
          macdSignal: macdData.signalLine[idx],
          macdHistogram: macdData.histogram[idx]
        }));

        setData(chartData);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setData([]);
      } finally {
        setLoading(false);
      }
    };

    fetchCandles();
  }, [symbol, assetType, interval, token, user, apiBase]);

  if (!user) {
    return <div className="text-center py-12">Please log in to view market analysis</div>;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="bg-panel rounded-lg border border-line p-4">
        <h1 className="text-2xl font-bold mb-4">Market Analysis</h1>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-muted mb-2">Symbol</label>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="BTC, AAPL"
              className="w-full px-3 py-2 bg-bg border border-line rounded text-text"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted mb-2">Asset Type</label>
            <select
              value={assetType}
              onChange={(e) => setAssetType(e.target.value as "CRYPTO" | "STOCK")}
              className="w-full px-3 py-2 bg-bg border border-line rounded text-text"
            >
              <option value="CRYPTO">Crypto</option>
              <option value="STOCK">Stock</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-muted mb-2">Interval</label>
            <select
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              className="w-full px-3 py-2 bg-bg border border-line rounded text-text"
            >
              <option value="1m">1m</option>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
              <option value="1h">1h</option>
              <option value="4h">4h</option>
              <option value="12h">12h</option>
              <option value="1d">1d</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-muted mb-2">Status</label>
            <div className="px-3 py-2 bg-bg border border-line rounded text-text text-sm">
              {loading ? "Loading..." : `${data.length} candles`}
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
            {error}
          </div>
        )}

        {data.length > 0 && (
          <div className="space-y-6">
            {/* OHLC Chart */}
            <div className="bg-bg rounded border border-line p-4">
              <h2 className="text-lg font-semibold mb-4 text-text">Price & Volume</h2>
              <ResponsiveContainer width="100%" height={400}>
                <ComposedChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="date" stroke="var(--muted)" style={{ fontSize: "12px" }} />
                  <YAxis yAxisId="left" stroke="var(--muted)" width={60} />
                  <YAxis yAxisId="right" orientation="right" stroke="var(--muted)" width={60} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--bg)",
                      border: "1px solid var(--line)",
                      borderRadius: "4px"
                    }}
                    labelStyle={{ color: "var(--text)" }}
                  />
                  <Legend />
                  <Bar yAxisId="right" dataKey="volume" fill="var(--muted)" opacity={0.3} />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="close"
                    stroke="var(--hot)"
                    dot={false}
                    strokeWidth={2}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* RSI Indicator */}
            <div className="bg-bg rounded border border-line p-4">
              <h2 className="text-lg font-semibold mb-4 text-text">RSI (14)</h2>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="date" stroke="var(--muted)" style={{ fontSize: "12px" }} />
                  <YAxis stroke="var(--muted)" domain={[0, 100]} width={60} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--bg)",
                      border: "1px solid var(--line)",
                      borderRadius: "4px"
                    }}
                    labelStyle={{ color: "var(--text)" }}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="rsi"
                    stroke="var(--cold)"
                    dot={false}
                    strokeWidth={2}
                  />
                  {/* Overbought/Oversold lines */}
                  <Line
                    type="linear"
                    dataKey={() => 70}
                    stroke="var(--muted)"
                    strokeDasharray="5 5"
                    name="Overbought (70)"
                    dot={false}
                  />
                  <Line
                    type="linear"
                    dataKey={() => 30}
                    stroke="var(--muted)"
                    strokeDasharray="5 5"
                    name="Oversold (30)"
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* MACD Indicator */}
            <div className="bg-bg rounded border border-line p-4">
              <h2 className="text-lg font-semibold mb-4 text-text">MACD</h2>
              <ResponsiveContainer width="100%" height={250}>
                <ComposedChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="date" stroke="var(--muted)" style={{ fontSize: "12px" }} />
                  <YAxis stroke="var(--muted)" width={60} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--bg)",
                      border: "1px solid var(--line)",
                      borderRadius: "4px"
                    }}
                    labelStyle={{ color: "var(--text)" }}
                  />
                  <Legend />
                  <Bar dataKey="macdHistogram" fill="var(--muted)" opacity={0.3} name="Histogram" />
                  <Line
                    type="monotone"
                    dataKey="macdLine"
                    stroke="var(--hot)"
                    dot={false}
                    strokeWidth={2}
                    name="MACD Line"
                  />
                  <Line
                    type="monotone"
                    dataKey="macdSignal"
                    stroke="var(--cold)"
                    dot={false}
                    strokeWidth={2}
                    name="Signal Line"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Price Stats */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div className="bg-bg rounded border border-line p-3">
                <div className="text-xs text-muted mb-1">Open</div>
                <div className="text-lg font-semibold text-text">
                  ${data[0]?.open.toFixed(2)}
                </div>
              </div>
              <div className="bg-bg rounded border border-line p-3">
                <div className="text-xs text-muted mb-1">High</div>
                <div className="text-lg font-semibold text-hot">
                  ${Math.max(...data.map((d) => d.high)).toFixed(2)}
                </div>
              </div>
              <div className="bg-bg rounded border border-line p-3">
                <div className="text-xs text-muted mb-1">Low</div>
                <div className="text-lg font-semibold text-cold">
                  ${Math.min(...data.map((d) => d.low)).toFixed(2)}
                </div>
              </div>
              <div className="bg-bg rounded border border-line p-3">
                <div className="text-xs text-muted mb-1">Close</div>
                <div className="text-lg font-semibold text-text">
                  ${data[data.length - 1]?.close.toFixed(2)}
                </div>
              </div>
              <div className="bg-bg rounded border border-line p-3">
                <div className="text-xs text-muted mb-1">RSI</div>
                <div className="text-lg font-semibold text-text">
                  {data[data.length - 1]?.rsi?.toFixed(1)}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
