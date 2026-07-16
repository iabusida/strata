#!/usr/bin/env node
/**
 * Coinbase Spot Weekly Capitulation CLI
 *
 * Commands:
 *   refresh  – Rebuild universe from Coinbase spot pairs + compute indicators
 *   report   – Show latest monitor state from DB (no live fetches)
 *   check    – Run a single monitor cycle and show results
 *   monitor  – Start continuous 15-minute polling service
 *
 * Flags:
 *   --force  – With "refresh", always recompute even if data is fresh
 *
 * Examples:
 *   npm run coinbase-cap -- refresh
 *   npm run coinbase-cap -- refresh --force
 *   npm run coinbase-cap -- report
 *   npm run coinbase-cap -- check
 *   npm run coinbase-cap -- monitor
 */
import "./env.js";
import { buildCoinbaseCapUniverse, getCapitulationTokens } from "./coinbase-cap-universe.js";
import { runMonitorCycle, startCoinbaseCapMonitorService, getMonitorReport } from "./coinbase-cap-monitor.js";

// ── CLI arg parsing ───────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const cmd  = argv.find((a) => !a.startsWith("--")) ?? "report";
const force = argv.includes("--force");

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, decimals = 2, suffix = ""): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n.toFixed(decimals)}${suffix}`;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function alertBadge(level: string): string {
  if (level === "ALERT") return "🚨";
  if (level === "WATCH") return "👀";
  return "  ";
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdRefresh(): Promise<void> {
  console.log(`[coinbase-cap] ${force ? "Force-refreshing" : "Refreshing"} universe (≤$200M cap, Coinbase spot)…`);
  const result = await buildCoinbaseCapUniverse({ forceRefresh: force });

  if (!result.refreshed) {
    console.log(`[coinbase-cap] Data is still fresh. ${result.total} tokens, ${result.inCapitulation} in capitulation.`);
    console.log("[coinbase-cap] Use --force to recompute anyway.");
    return;
  }

  console.log(`\n✅ Universe ready: ${result.total} tokens total, ${result.inCapitulation} in capitulation.\n`);
  await printCapitulationList();
}

async function printCapitulationList(): Promise<void> {
  const tokens = await getCapitulationTokens();
  if (tokens.length === 0) {
    console.log("  (no capitulation tokens found)");
    return;
  }

  console.log(`📆 CAPITULATION TOKENS (weekly RSI <38) — ${tokens.length} found:`);
  console.log(
    "  " + "#".padEnd(4) +
    "Symbol".padEnd(14) +
    "Cap$M".padEnd(7) +
    "wRSI".padEnd(7) +
    "wK/wD".padEnd(12) +
    "wCross".padEnd(8) +
    "dRSI".padEnd(7) +
    "dCross".padEnd(8) +
    "Dist%ATL".padEnd(10) +
    "ATR%".padEnd(7) +
    "Close",
  );

  tokens.forEach((t, idx) => {
    const wKD = (t.weeklyStochK != null && t.weeklyStochD != null)
      ? `${t.weeklyStochK.toFixed(1)}/${t.weeklyStochD.toFixed(1)}`
      : "n/a";
    console.log(
      "  " + String(idx + 1).padStart(2).padEnd(4) +
      t.symbol.padEnd(14) +
      fmt(t.marketCapUsd / 1_000_000, 1).padEnd(7) +
      fmt(t.weeklyRsi, 1).padEnd(7) +
      wKD.padEnd(12) +
      (t.weeklyStochCrossUp ? "YES" : "no").padEnd(8) +
      fmt(t.dailyRsi, 1).padEnd(7) +
      (t.dailyStochCrossUp ? "YES" : "no").padEnd(8) +
      `+${fmt(t.distanceFromAtlPct, 1)}%`.padEnd(10) +
      fmt(t.atrPct, 1, "%").padEnd(7) +
      fmt(t.close, 6),
    );
  });
}

async function cmdCheck(): Promise<void> {
  await buildCoinbaseCapUniverse();
  console.log("\n[coinbase-cap] Running monitor cycle…");
  const summary = await runMonitorCycle();
  console.log(`[coinbase-cap] Done — checked=${summary.checked} watch=${summary.watch} alerts=${summary.alerts}\n`);
  await cmdReport();
}

async function cmdReport(): Promise<void> {
  const rows = await getMonitorReport();

  if (rows.length === 0) {
    console.log("\n[coinbase-cap] No capitulation tokens in DB. Run: npm run coinbase-cap -- refresh");
    return;
  }

  const alerts = rows.filter((r) => r.alertLevel === "ALERT");
  const watches = rows.filter((r) => r.alertLevel === "WATCH");

  if (alerts.length > 0) {
    console.log("\n🚨🚨🚨 EXPLOSION ALERTS — READY TO MOVE 🚨🚨🚨");
    for (const r of alerts) {
      console.log(
        `  ${r.symbol.padEnd(14)}` +
        ` +${fmt(r.changePct15m, 2)}% 15m` +
        `  vol=${fmtUsd(r.volume15mUsd)}` +
        `  wRSI=${fmt(r.weeklyRsi, 1)}` +
        `  dist=+${fmt(r.distanceFromAtlPct, 1)}% ATL` +
        `  ${r.alertReason ?? ""}`,
      );
    }
    console.log();
  }

  if (watches.length > 0) {
    console.log("👀 WATCH — Price moving:");
    for (const r of watches) {
      console.log(
        `  ${r.symbol.padEnd(14)}` +
        ` +${fmt(r.changePct15m, 2)}% 15m` +
        `  wRSI=${fmt(r.weeklyRsi, 1)}` +
        `  dist=+${fmt(r.distanceFromAtlPct, 1)}% ATL`,
      );
    }
    console.log();
  }

  const age = rows[0]?.snapshotAt
    ? `(snapshot ${new Date(rows[0].snapshotAt).toISOString()})`
    : "(no monitor data yet — run: npm run coinbase-cap -- check)";

  console.log(`📆 COINBASE SPOT CAPITULATION MONITOR — ${rows.length} tokens ${age}`);
  console.log(
    "  " + "#".padEnd(4) +
    "Symbol".padEnd(14) +
    "Cap$M".padEnd(7) +
    "wRSI".padEnd(7) +
    "Dist%ATL".padEnd(10) +
    "15mX".padEnd(6) +
    "1hX".padEnd(5) +
    "6hX".padEnd(5) +
    "dX".padEnd(4) +
    "wX".padEnd(4) +
    "Cross#".padEnd(8) +
    "ATR%".padEnd(7) +
    "Price".padEnd(12) +
    "Chg15m".padEnd(9) +
    "Vol15m".padEnd(10) +
    "Alert",
  );

  for (const [idx, r] of rows.entries()) {
    const badge = alertBadge(r.alertLevel);
    const changeStr = r.changePct15m != null
      ? `${r.changePct15m >= 0 ? "+" : ""}${r.changePct15m.toFixed(2)}%`
      : "n/a";
    const crossStr = `${r.timeframeCrossCount}/5`;

    console.log(
      `${badge}${String(idx + 1).padStart(2)} `.padEnd(5) +
      r.symbol.padEnd(14) +
      fmt(r.marketCapM, 1).padEnd(7) +
      fmt(r.weeklyRsi, 1).padEnd(7) +
      `+${fmt(r.distanceFromAtlPct, 1)}%`.padEnd(10) +
      (r.stoch15mCrossUp ? "YES" : "no").padEnd(6) +
      (r.stoch1hCrossUp  ? "YES" : "no").padEnd(5) +
      (r.stoch6hCrossUp  ? "YES" : "no").padEnd(5) +
      (r.dailyStochCrossUp   ? "YES" : "no").padEnd(4) +
      (r.weeklyStochCrossUp  ? "YES" : "no").padEnd(4) +
      crossStr.padEnd(8) +
      fmt(r.atrPct, 1, "%").padEnd(7) +
      fmt(r.price, 6).padEnd(12) +
      changeStr.padEnd(9) +
      fmtUsd(r.volume15mUsd).padEnd(10) +
      r.alertLevel,
    );
  }

  if (alerts.length === 0 && watches.length === 0) {
    console.log("\n  — No alerts active right now.");
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

(async () => {
  switch (cmd) {
    case "refresh": await cmdRefresh(); break;
    case "report":  await cmdReport();  break;
    case "check":   await cmdCheck();   break;
    case "monitor": await startCoinbaseCapMonitorService(); break;
    default:
      console.error(`[coinbase-cap] Unknown command: ${cmd}`);
      console.error("  Valid commands: refresh | report | check | monitor");
      process.exit(1);
  }
  process.exit(0);
})();
