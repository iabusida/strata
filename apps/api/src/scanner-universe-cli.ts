#!/usr/bin/env node
import "./env.js";
import { fetchBurstUniverseCandidates, inspectBurstUniverseStats } from "./scanner-burst-universe.js";

function resolveLimit(raw: string | undefined): number {
  const fallback = 50;
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.trunc(parsed));
}

function parseArgs(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
    flags[key] = value;

    if (value !== "true") {
      i += 1;
    }
  }

  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const limit = resolveLimit(flags.limit);

  if (flags.debug === "true") {
    const stats = await inspectBurstUniverseStats();
    console.log("Burst universe diagnostics:");
    console.table([
      {
        snapshots: stats.snapshots,
        withMarketCap: stats.withMarketCap,
        lowCap: stats.lowCap,
        highHourlyVolume: stats.highHourlyVolume,
        finalCandidates: stats.finalCandidates
      }
    ]);
    console.log("Top hourly volume symbols (with market cap match status):");
    console.table(
      stats.topByHourlyVolume.map((row) => ({
        symbol: row.symbol,
        base: row.baseSymbol,
            vol1hM: row.volume1hUsd.toFixed(2),
        mcapM: row.marketCapUsd == null ? "missing" : (row.marketCapUsd / 1_000_000).toFixed(2),
        change24hPct: row.change24hPct == null ? "n/a" : row.change24hPct.toFixed(2)
      }))
    );
  }

  const rows = (await fetchBurstUniverseCandidates()).slice(0, limit);

  if (rows.length === 0) {
    console.log("No burst-universe candidates matched current filters.");
    return;
  }

  console.log(`Burst universe candidates | rows=${rows.length}`);
  console.table(
    rows.map((row) => ({
      symbol: row.symbol,
      base: row.baseSymbol,
      vol1hM: row.volume1hUsd.toFixed(2),
      vol24hM: row.volume24hUsd.toFixed(2),
      mcapM: (row.marketCapUsd / 1_000_000).toFixed(2),
      change24hPct: row.change24hPct == null ? "n/a" : row.change24hPct.toFixed(2)
    }))
  );
}

main().catch((error) => {
  console.error("scanner-universe-cli failed", error);
  process.exit(1);
});
