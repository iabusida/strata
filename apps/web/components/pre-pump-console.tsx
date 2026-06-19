"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type PrePumpAssetClass = "CRYPTO" | "STOCK";

type PrePumpTier = "TIER_1" | "TIER_2" | "TIER_3";

type PrePumpFeatureVector = {
  compressionRatio: number;
  volatility20Pct: number;
  trailingReturn10Pct: number;
  trailingReturn20Pct: number;
  sma20GapPct: number;
  sma50GapPct: number;
  rangePosition60: number;
  distFromHigh60Pct: number;
  volumeTrendRatio: number;
  rsi14: number;
};

type PrePumpCandidate = {
  rank: number;
  symbol: string;
  score: number;
  firedCount: number;
  fired: string[];
  tier: PrePumpTier;
  tierLabel: string;
  tierReason: string;
  avgDollarVol14: number;
  features: PrePumpFeatureVector;
  latestBar: string;
  candleCount: number;
};

type PrePumpRuleInfo = {
  name: string;
  detail: string;
};

type PrePumpScanResult = {
  assetClass?: PrePumpAssetClass;
  generatedAt: string;
  datasetRows: number;
  pumpRows: number;
  baseRatePct: number;
  rules: PrePumpRuleInfo[];
  universeSize: number;
  scanned: number;
  skipped: number;
  disqualified: number;
  candidates: PrePumpCandidate[];
};

type PrePumpResponse = {
  cached: boolean;
  result: PrePumpScanResult;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787";

const TIER_BADGE: Record<PrePumpTier, { emoji: string; label: string }> = {
  TIER_1: { emoji: "🟢", label: "T1" },
  TIER_2: { emoji: "🟡", label: "T2" },
  TIER_3: { emoji: "🔴", label: "T3" }
};

function fmtPct(v: number, digits = 1): string {
  return Number.isFinite(v) ? `${v >= 0 ? "" : ""}${v.toFixed(digits)}%` : "n/a";
}

function fmtSignedPct(v: number): string {
  return Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(0)}%` : "n/a";
}

function fmtNum(v: number, digits = 2): string {
  return Number.isFinite(v) ? v.toFixed(digits) : "n/a";
}

function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return "n/a";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function PrePumpConsole({ assetClass = "CRYPTO" }: { assetClass?: PrePumpAssetClass }) {
  const [data, setData] = useState<PrePumpScanResult | null>(null);
  const [cached, setCached] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const url = `${API_BASE}/api/pre-pump/candidates?topN=50&assetClass=${assetClass}${refresh ? "&refresh=true" : ""}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; details?: string } | null;
        throw new Error(body?.details ?? body?.error ?? `Request failed (${res.status})`);
      }
      const payload = (await res.json()) as PrePumpResponse;
      setData(payload.result);
      setCached(payload.cached);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [assetClass]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const tierCounts = useMemo(() => {
    const counts = { TIER_1: 0, TIER_2: 0, TIER_3: 0 } as Record<PrePumpTier, number>;
    for (const c of data?.candidates ?? []) counts[c.tier] += 1;
    return counts;
  }, [data]);

  return (
    <main id="section-top" className="shell">
      <section className="panel simulation-panel">
        <div className="table-header">
          <h2>{assetClass} Pre-Pump Coils</h2>
          <div className="simulation-header-actions">
            <button
              type="button"
              className="reset-sim-btn"
              onClick={() => void load(true)}
              disabled={loading}
            >
              {loading ? "Scanning..." : "Refresh Scan"}
            </button>
          </div>
        </div>

        <p className="dry-run-context-hint">
          Early / accumulation phase scan — tokens in a quiet volatility squeeze BEFORE a breakout.
          Anything that has already moved (run-up, extended above its SMAs, overbought, or near its
          range highs) is excluded. Deterministic; no AI.
        </p>

        {error ? <p className="trade-action-feedback">{error}</p> : null}

        <div className="settings-grid" style={{ marginBottom: "0.5rem" }}>
          <Link className={`app-nav-link ${assetClass === "CRYPTO" ? "app-nav-link-active" : ""}`} href="/pre-pump/crypto">Crypto</Link>
          <Link className={`app-nav-link ${assetClass === "STOCK" ? "app-nav-link-active" : ""}`} href="/pre-pump/stocks">Stocks</Link>
        </div>

        {data ? (
          <>
            <div className="dry-run-metrics">
              <div className="dry-run-metric">
                <span>Coils Found</span>
                <strong>{data.candidates.length}</strong>
              </div>
              <div className="dry-run-metric">
                <span>Scanned Tokens</span>
                <strong>{data.scanned}</strong>
              </div>
              <div className="dry-run-metric">
                <span>Excluded (already moved)</span>
                <strong>{data.disqualified}</strong>
              </div>
              <div className="dry-run-metric">
                <span>Base → Pump Rate</span>
                <strong>{data.baseRatePct}%</strong>
              </div>
              <div className="dry-run-metric">
                <span>Tiers</span>
                <strong>
                  🟢 {tierCounts.TIER_1} · 🟡 {tierCounts.TIER_2} · 🔴 {tierCounts.TIER_3}
                </strong>
              </div>
            </div>

            <p className="dry-run-context-hint">
              Generated {new Date(data.generatedAt).toLocaleString()} · {cached ? "cached" : "fresh"} ·{" "}
              {data.universeSize} {assetClass === "CRYPTO" ? "Coinbase USD spot" : "stock"} markets · {data.skipped} skipped (insufficient data) ·
              historically {data.pumpRows.toLocaleString()}/{data.datasetRows.toLocaleString()} quiet
              bases later pumped ≥60%
            </p>

            <div className="trade-table-wrap">
              <table className="trade-table dry-run-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Token</th>
                    <th>Tier</th>
                    <th>Score</th>
                    <th>Signals</th>
                    <th>Squeeze</th>
                    <th>Vol 20d</th>
                    <th>Run-up 10d</th>
                    <th>SMA20 gap</th>
                    <th>SMA50 gap</th>
                    <th>Range pos</th>
                    <th>Below high</th>
                    <th>Vol trend</th>
                    <th>RSI</th>
                    <th>Liquidity</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {data.candidates.length > 0 ? (
                    data.candidates.map((c) => {
                      const badge = TIER_BADGE[c.tier];
                      return (
                        <tr key={c.symbol}>
                          <td>{c.rank}</td>
                          <td>
                            <strong>{c.symbol}</strong>
                          </td>
                          <td title={c.tierLabel}>
                            {badge.emoji} {badge.label}
                          </td>
                          <td>{c.score.toFixed(0)}</td>
                          <td>
                            {c.firedCount} [{c.fired.join(",")}]
                          </td>
                          <td>{fmtNum(c.features.compressionRatio)}</td>
                          <td>{fmtPct(c.features.volatility20Pct)}</td>
                          <td>{fmtSignedPct(c.features.trailingReturn10Pct)}</td>
                          <td>{fmtSignedPct(c.features.sma20GapPct)}</td>
                          <td>{fmtSignedPct(c.features.sma50GapPct)}</td>
                          <td>{(c.features.rangePosition60 * 100).toFixed(0)}%</td>
                          <td>{fmtPct(c.features.distFromHigh60Pct, 0)}</td>
                          <td>{fmtNum(c.features.volumeTrendRatio)}</td>
                          <td>{c.features.rsi14.toFixed(0)}</td>
                          <td>{fmtUsd(c.avgDollarVol14)}</td>
                          <td>{c.tierReason}</td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={16}>No tokens are in a clean pre-breakout coil right now.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <p className="dry-run-context-hint">
              🟢 prime coil · 🟡 forming base · 🔴 early / weak — already-moved names are excluded.
              Signals: sqz volatility squeeze, acc volume accumulation, base lower-range position,
              flat coiling price, coil below resistance, rsi neutral. Squeeze &lt; 1 = volatility
              contracting.
            </p>
          </>
        ) : (
          !error && <p className="dry-run-context-hint">{loading ? "Running scan…" : "No data yet."}</p>
        )}
      </section>
    </main>
  );
}
