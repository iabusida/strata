#!/usr/bin/env node
/**
 * DeFi Spot Capitulation CLI (DB-backed)
 *
 * Commands:
 *   refresh  - Rebuild/persist universe in Postgres
 *   report   - Show latest monitor state from DB (no live fetches)
 *   check    - Run one monitor cycle now, then report
 *   monitor  - Start continuous 15-minute service loop
 */
import "./env.js";
import { buildDefiCapUniverse, getDefiCapCapitulationRows } from "./defi-cap-universe.js";
import { getDefiMonitorReport, runDefiCapMonitorCycle, startDefiCapMonitorService } from "./defi-cap-monitor.js";

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
  if (status === "ALERT" || status === "REVERSAL_READY") return "🚨";
  if (status === "WATCH" || status === "REVERSAL_WATCH") return "👀";
  return "  ";
}

async function cmdRefresh(): Promise<void> {
  console.log(`[defi-cap] ${force ? "Force-refreshing" : "Refreshing"} DeFi spot universe (Solana + Ethereum)...`);
  const result = await buildDefiCapUniverse(force);

  if (!result.refreshed) {
    console.log(`[defi-cap] Data still fresh. ${result.total} pools, ${result.inCapitulation} in weekly capitulation.`);
    console.log("[defi-cap] Use --force to recompute anyway.");
    return;
  }

  console.log(`\n✅ Universe ready: ${result.total} pools scanned, ${result.inCapitulation} in weekly capitulation.\n`);
  await printCapitulationList();
}

async function printCapitulationList(): Promise<void> {
  const rows = await getDefiCapCapitulationRows();
  if (rows.length === 0) {
    console.log("  (no weekly capitulation pools found)");
    return;
  }

  console.log(`📆 DEFI SPOT CAPITULATION POOLS (weekly RSI < 38) - ${rows.length} found:`);
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
    "Setup"
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
      row.status
    );
  });
}

async function cmdReport(): Promise<void> {
  const rows = await getDefiMonitorReport();

  if (rows.length === 0) {
    console.log("\n[defi-cap] No DeFi capitulation pools in DB. Run: npm run defi-cap -- refresh");
    return;
  }

  const alerts = rows.filter((row) => row.alertLevel === "ALERT");
  const watches = rows.filter((row) => row.alertLevel === "WATCH");

  if (alerts.length > 0) {
    console.log("\n🚨🚨🚨 DEFI REVERSAL ALERTS 🚨🚨🚨");
    for (const row of alerts) {
      console.log(
        `  ${row.network.padEnd(7)} ${row.pairName.padEnd(22)}` +
        `  +${fmt(row.changePct15m, 2)}% 15m` +
        `  vol=${fmtUsd(row.volume15mUsd)}` +
        `  wRSI=${fmt(row.weeklyRsi, 1)}` +
        `  ${row.alertReason ?? ""}`
      );
    }
    console.log();
  }

  if (watches.length > 0) {
    console.log("👀 WATCH - Momentum building:");
    for (const row of watches) {
      console.log(
        `  ${row.network.padEnd(7)} ${row.pairName.padEnd(22)}` +
        `  +${fmt(row.changePct15m, 2)}% 15m` +
        `  wRSI=${fmt(row.weeklyRsi, 1)}`
      );
    }
    console.log();
  }

  console.log(
    `📆 DEFI SPOT CAP MONITOR - ${rows.length} pools ` +
    `${rows[0].snapshotAt ? `(snapshot ${new Date(rows[0].snapshotAt).toISOString()})` : "(no monitor snapshot yet)"}`
  );
  console.log(
    "  " +
    "#".padEnd(4) +
    "Chain".padEnd(9) +
    "Pair".padEnd(22) +
    "Cap$M".padEnd(8) +
    "Liq$K".padEnd(8) +
    "wRSI".padEnd(7) +
    "dRSI".padEnd(7) +
    "Dist%ATL".padEnd(10) +
    "ATR%".padEnd(7) +
    "Price".padEnd(12) +
    "Chg15m".padEnd(9) +
    "Vol15m".padEnd(10) +
    "Scan".padEnd(16) +
    "Alert"
  );

  for (const [idx, row] of rows.entries()) {
    const badge = statusBadge(row.alertLevel);
    const chg = row.changePct15m == null ? "n/a" : `${row.changePct15m >= 0 ? "+" : ""}${row.changePct15m.toFixed(2)}%`;

    console.log(
      `${badge}${String(idx + 1).padStart(2)} `.padEnd(5) +
      row.network.padEnd(9) +
      row.pairName.padEnd(22) +
      fmt(row.marketCapM, 1).padEnd(8) +
      fmt(row.liquidityUsd / 1_000, 0).padEnd(8) +
      fmt(row.weeklyRsi, 1).padEnd(7) +
      fmt(row.dailyRsi, 1).padEnd(7) +
      `+${fmt(row.distanceFromAtlPct, 1)}%`.padEnd(10) +
      fmt(row.dailyAtrPct, 1, "%").padEnd(7) +
      fmt(row.price, 8).padEnd(12) +
      chg.padEnd(9) +
      fmtUsd(row.volume15mUsd).padEnd(10) +
      row.status.padEnd(16) +
      row.alertLevel
    );
  }

  if (alerts.length === 0 && watches.length === 0) {
    console.log("\n  - No active monitor alerts right now.");
  }
}

async function cmdCheck(): Promise<void> {
  console.log("[defi-cap] Running monitor cycle...");
  await buildDefiCapUniverse(false);
  const summary = await runDefiCapMonitorCycle();
  console.log(`[defi-cap] Done - checked=${summary.checked} watch=${summary.watch} alerts=${summary.alerts}\n`);
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
