#!/usr/bin/env node
/**
 * DeFi Spot Capitulation CLI
 *
 * Spot-only scanner for Solana and Ethereum pools discovered from GeckoTerminal.
 *
 * Commands:
 *   refresh  - Rebuild the DeFi universe and persist the latest scan to data/defi-cap-state.json
 *   report   - Show the latest cached scan
 *   check    - Refresh once, then report
 *   monitor  - Run continuous refresh cycles every 15m
 *
 * Examples:
 *   npm run defi-cap -- refresh
 *   npm run defi-cap -- report
 *   npm run defi-cap -- check
 *   npm run defi-cap -- monitor
 */
import "./env.js";
import { buildDefiCapUniverse, getDefiCapCapitulationRows, getDefiCapRows, runDefiCapMonitorCycle, startDefiCapMonitorService } from "./defi-cap-universe.js";

const argv = process.argv.slice(2);
const cmd = argv.find((arg) => !arg.startsWith("--")) ?? "report";
const force = argv.includes("--force");

function fmt(n: number | null | undefined, decimals = 2, suffix = ""): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n.toFixed(decimals)}${suffix}`;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function statusBadge(status: string): string {
  if (status === "REVERSAL_READY") return "🚨";
  if (status === "REVERSAL_WATCH") return "👀";
  return "  ";
}

async function cmdRefresh(): Promise<void> {
  console.log(`[defi-cap] ${force ? "Force-refreshing" : "Refreshing"} DeFi spot universe (Solana + Ethereum)…`);
  const state = await buildDefiCapUniverse(force);
  console.log(`\n✅ Universe ready: ${state.total} pools scanned, ${state.inCapitulation} in weekly capitulation.\n`);
  await printCapitulationList();
}

async function printCapitulationList(): Promise<void> {
  const rows = await getDefiCapCapitulationRows();
  if (rows.length === 0) {
    console.log("  (no weekly capitulation pools found)");
    return;
  }

  console.log(`📆 DEFI SPOT CAPITULATION POOLS (weekly RSI < 38) — ${rows.length} found:`);
  console.log(
    "  " +
    "#".padEnd(4) +
    "Chain".padEnd(9) +
    "Pair".padEnd(22) +
    "Cap$M".padEnd(8) +
    "Liq$K".padEnd(8) +
    "wRSI".padEnd(7) +
    "wK/wD".padEnd(13) +
    "dRSI".padEnd(7) +
    "dK/dD".padEnd(13) +
    "Dist%ATL".padEnd(10) +
    "ATR%".padEnd(7) +
    "AgeD".padEnd(6) +
    "Close"
  );

  rows.forEach((row, idx) => {
    const weeklyKD = row.weeklyStochK != null && row.weeklyStochD != null
      ? `${row.weeklyStochK.toFixed(1)}/${row.weeklyStochD.toFixed(1)}`
      : "n/a";
    const dailyKD = row.dailyStochK != null && row.dailyStochD != null
      ? `${row.dailyStochK.toFixed(1)}/${row.dailyStochD.toFixed(1)}`
      : "n/a";

    console.log(
      "  " +
      String(idx + 1).padStart(2).padEnd(4) +
      row.network.padEnd(9) +
      row.pairName.padEnd(22) +
      fmt(row.marketCapUsd / 1_000_000, 1).padEnd(8) +
      fmt(row.liquidityUsd / 1_000, 0).padEnd(8) +
      fmt(row.weeklyRsi, 1).padEnd(7) +
      weeklyKD.padEnd(13) +
      fmt(row.dailyRsi, 1).padEnd(7) +
      dailyKD.padEnd(13) +
      `+${fmt(row.distanceFromAtlPct, 1)}%`.padEnd(10) +
      fmt(row.dailyAtrPct, 1, "%").padEnd(7) +
      fmt(row.ageDays, 0).padEnd(6) +
      fmt(row.close, 8)
    );
  });
}

async function cmdReport(): Promise<void> {
  const rows = await getDefiCapRows();

  if (rows.length === 0) {
    console.log("\n[defi-cap] No cached scan found. Run: npm run defi-cap -- refresh");
    return;
  }

  const alerts = rows.filter((row) => row.status === "REVERSAL_READY");
  const watches = rows.filter((row) => row.status === "REVERSAL_WATCH");

  if (alerts.length > 0) {
    console.log("\n🚨🚨🚨 DEFI REVERSAL ALERTS 🚨🚨🚨");
    for (const row of alerts) {
      console.log(
        `  ${row.network.padEnd(7)} ${row.pairName.padEnd(22)}` +
        `  wRSI=${fmt(row.weeklyRsi, 1)}` +
        `  dRSI=${fmt(row.dailyRsi, 1)}` +
        `  vol=${fmtUsd(row.volume24hUsd)}` +
        `  liq=${fmtUsd(row.liquidityUsd)}`
      );
    }
    console.log();
  }

  if (watches.length > 0) {
    console.log("👀 WATCH — Oversold but no full reversal confirmation yet:");
    for (const row of watches) {
      console.log(
        `  ${row.network.padEnd(7)} ${row.pairName.padEnd(22)}` +
        `  wRSI=${fmt(row.weeklyRsi, 1)}` +
        `  dRSI=${fmt(row.dailyRsi, 1)}` +
        `  dist=+${fmt(row.distanceFromAtlPct, 1)}% ATL`
      );
    }
    console.log();
  }

  console.log(`📆 DEFI SPOT CAPITULATION MONITOR — ${rows.length} pools (snapshot ${new Date(rows[0].refreshedAt).toISOString()})`);
  console.log(
    "  " +
    "#".padEnd(4) +
    "Chain".padEnd(9) +
    "Pair".padEnd(22) +
    "Cap$M".padEnd(8) +
    "Liq$K".padEnd(8) +
    "wRSI".padEnd(7) +
    "dRSI".padEnd(7) +
    "15mX".padEnd(6) +
    "1D X".padEnd(6) +
    "ATR%".padEnd(7) +
    "AgeD".padEnd(6) +
    "Price".padEnd(12) +
    "Chg24h".padEnd(10) +
    "Alert"
  );

  for (const [idx, row] of rows.entries()) {
    const badge = statusBadge(row.status);
    console.log(
      `${badge}${String(idx + 1).padStart(2)} `.padEnd(5) +
      row.network.padEnd(9) +
      row.pairName.padEnd(22) +
      fmt(row.marketCapUsd / 1_000_000, 1).padEnd(8) +
      fmt(row.liquidityUsd / 1_000, 0).padEnd(8) +
      fmt(row.weeklyRsi, 1).padEnd(7) +
      fmt(row.dailyRsi, 1).padEnd(7) +
      (row.dailyStochCrossUp ? "YES" : "no").padEnd(6) +
      (row.weeklyStochCrossUp ? "YES" : "no").padEnd(6) +
      fmt(row.dailyAtrPct, 1, "%").padEnd(7) +
      fmt(row.ageDays, 0).padEnd(6) +
      fmt(row.close, 8).padEnd(12) +
      `${row.priceChange24hPct == null ? "n/a" : `${row.priceChange24hPct >= 0 ? "+" : ""}${row.priceChange24hPct.toFixed(2)}%`}`.padEnd(10) +
      row.status
    );
  }

  if (alerts.length === 0 && watches.length === 0) {
    console.log("\n  — No reversal alerts active right now.");
  }
}

async function cmdCheck(): Promise<void> {
  console.log("[defi-cap] Running monitor cycle…");
  const summary = await runDefiCapMonitorCycle();
  console.log(`[defi-cap] Done — checked=${summary.checked} watch=${summary.watch} alerts=${summary.alerts}\n`);
  await cmdReport();
}

(async () => {
  switch (cmd) {
    case "refresh":
      await cmdRefresh();
      break;
    case "report":
      await cmdReport();
      break;
    case "check":
      await cmdCheck();
      break;
    case "monitor":
      await startDefiCapMonitorService();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exitCode = 1;
  }
})();
