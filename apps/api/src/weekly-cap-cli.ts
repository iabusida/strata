#!/usr/bin/env node
/**
 * Weekly Capitulation CLI
 *
 * Commands (first non-flag argument):
 *   refresh   – Force-rebuild universe and indicators. Run once to seed DB.
 *   report    – Show latest monitor state from DB. No live fetches.
 *   check     – Run a single monitor cycle right now and show results.
 *   monitor   – Start continuous 15-minute polling service (runs forever).
 *
 * Flags:
 *   --force   – With "refresh", always recompute even if data is fresh.
 *
 * Examples:
 *   npm run weekly-cap -- refresh
 *   npm run weekly-cap -- report
 *   npm run weekly-cap -- check
 *   npm run weekly-cap -- monitor
 */
import "./env.js";
import { buildWeeklyCapUniverse, getCapitulationTokens } from "./weekly-cap-universe.js";
import { runMonitorCycle, startWeeklyCapMonitorService, getMonitorReport } from "./weekly-cap-monitor.js";
import { fetchPerpTickerSnapshots } from "./bitunix-service.js";

// ── CLI arg parsing ───────────────────────────────────────────────────────────

const argv  = process.argv.slice(2);
const cmd   = argv.find((a) => !a.startsWith("--")) ?? "report";
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
  if (level === "CAUTION") return "⚠️ ";
  if (level === "WATCH") return "👀";
  return "  ";
}

// ── "refresh" command ─────────────────────────────────────────────────────────

async function cmdRefresh(): Promise<void> {
  console.log(`[weekly-cap] ${force ? "Force-refreshing" : "Refreshing"} universe (≤$50M cap)…`);
  const result = await buildWeeklyCapUniverse({ forceRefresh: force });

  if (!result.refreshed) {
    console.log(`[weekly-cap] Data is still fresh (≤12h old). ${result.total} tokens, ${result.inCapitulation} in capitulation.`);
    console.log("[weekly-cap] Use --force to recompute anyway.");
    return;
  }

  console.log(`\n✅ Universe ready: ${result.total} tokens total, ${result.inCapitulation} in capitulation.`);
  await printCapitulationList();
}

// ── "check" command ───────────────────────────────────────────────────────────

async function cmdCheck(): Promise<void> {
  // Ensure universe is loaded first
  await buildWeeklyCapUniverse();
  console.log("\n[weekly-cap] Running monitor cycle…");
  const summary = await runMonitorCycle();
  console.log(`[weekly-cap] Done — checked=${summary.checked} watch=${summary.watch} alerts=${summary.alerts}\n`);
  await cmdReport();
}

// ── "report" command ──────────────────────────────────────────────────────────

async function cmdReport(): Promise<void> {
  const rows = await getMonitorReport();
  const volume24hBySymbol = new Map(
    (await fetchPerpTickerSnapshots()).map((snapshot) => [snapshot.symbol, snapshot.volume24hUsd]),
  );

  if (rows.length === 0) {
    console.log("\n[weekly-cap] No capitulation tokens in DB. Run: npm run weekly-cap -- refresh");
    return;
  }

  const alerts = rows.filter((r) => r.alertLevel === "ALERT");
  const cautions = rows.filter((r) => r.alertLevel === "CAUTION");
  const watches = rows.filter((r) => r.alertLevel === "WATCH");

  // ── Alert headers ──
  if (alerts.length > 0) {
    console.log("\n🚨🚨🚨 EXPLOSION ALERTS — READY TO MOVE 🚨🚨🚨");
    for (const r of alerts) {
      const volume24hUsdM = volume24hBySymbol.get(r.symbol) ?? null;
      console.log(
        `  ${r.symbol.padEnd(18)}` +
        ` +${fmt(r.changePct15m, 2)}% 15m` +
        `  vol=${fmtUsd(r.volume15mUsd)}` +
        `  24h=${volume24hUsdM != null ? `$${volume24hUsdM.toFixed(2)}M` : "n/a"}` +
        `  bid=${fmtUsd(r.bidDepthUsd)}` +
        `  wRSI=${fmt(r.weeklyRsi, 1)}` +
        `  dist=${fmt(r.distanceFromAtlPct, 1)}% from ATL` +
        `  ${r.alertReason ?? ""}`,
      );
    }
    console.log();
  }

  if (cautions.length > 0) {
    console.log("⚠️  CAUTION — Setup ready, waiting for confirmation (strict ATR/liquidity/depth/spread leverage gates applied):");
    for (const r of cautions) {
      console.log(
        `  ${r.symbol.padEnd(18)}` +
        `  wRSI=${fmt(r.weeklyRsi, 1)}` +
        `  dist=${fmt(r.distanceFromAtlPct, 1)}% ATL` +
        `  Cross#=${r.timeframeCrossCount}/5` +
        `  ATR=${fmt(r.atrPct, 1)}%` +
        `  ${r.alertReason ?? ""}`,
      );
    }
    console.log();
  }

  if (watches.length > 0) {
    console.log("👀 WATCH — Price moving:");
    for (const r of watches) {
      console.log(
        `  ${r.symbol.padEnd(18)}` +
        ` +${fmt(r.changePct15m, 2)}% 15m` +
        `  wRSI=${fmt(r.weeklyRsi, 1)}` +
        `  dist=${fmt(r.distanceFromAtlPct, 1)}% from ATL`,
      );
    }
    console.log();
  }

  // ── Full table ──
  const age = rows[0]?.snapshotAt
    ? `(snapshot ${new Date(rows[0].snapshotAt).toISOString()})`
    : "(no monitor data yet — run: npm run weekly-cap -- check)";

  console.log(`📆 WEEKLY CAPITULATION MONITOR — ${rows.length} tokens ${age}`);
  console.log(
    "  " +
    "#".padEnd(4) +
    "Symbol".padEnd(18) +
    "Cap$M".padEnd(7) +
    "wRSI".padEnd(7) +
    "Dist%ATL".padEnd(10) +
    "15mCross".padEnd(9) +
    "1hCross".padEnd(8) +
    "4hCross".padEnd(8) +
    "dCross".padEnd(8) +
    "wCross".padEnd(8) +
    "Cross#".padEnd(8) +
    "ATR%".padEnd(7) +
    "Act".padEnd(5) +
    "Price".padEnd(12) +
    "Chg15m".padEnd(9) +
    "Vol15m".padEnd(10) +
    "Vol24h".padEnd(10) +
    "BidD".padEnd(9) +
    "Fund%".padEnd(9) +
    "Fire".padEnd(6) +
    "Alert",
  );

  for (const [idx, r] of rows.entries()) {
    const badge    = alertBadge(r.alertLevel);
    const changeStr = r.changePct15m != null
      ? `${r.changePct15m >= 0 ? "+" : ""}${r.changePct15m.toFixed(2)}%`
      : "n/a";
    const fundStr  = r.fundingRate != null
      ? `${(r.fundingRate * 100).toFixed(4)}%`
      : "n/a";
    const crossCount = r.timeframeCrossCount ?? 0;
    const crossStr = crossCount > 0 ? `${crossCount}/5` : "0/5";

    // Activation score: MACD rising + price above prev close + volume elevated (>1.2x avg)
    const actScore = (r.macdHistRising ? 1 : 0) + (r.priceAbovePrevClose ? 1 : 0) + ((r.volVsAvg14d ?? 0) >= 1.2 ? 1 : 0);
    const actStr = `${actScore}/3`;

    // Pre-fire score: order book imbalance + funding rate + spread analysis
    const fireStr = `${r.preFireScore}/4`;
    const volume24hUsdM = volume24hBySymbol.get(r.symbol) ?? null;
    const volume24hStr = volume24hUsdM != null ? `$${volume24hUsdM.toFixed(2)}M` : "n/a";

    console.log(
      `${badge}${String(idx + 1).padStart(2)} `.padEnd(5) +
      r.symbol.padEnd(18) +
      fmt(r.marketCapM, 1).padEnd(7) +
      fmt(r.weeklyRsi, 1).padEnd(7) +
      `+${fmt(r.distanceFromAtlPct, 1)}%`.padEnd(10) +
      (r.stoch15mCrossUp ? "YES" : "no").padEnd(9) +
      (r.stoch1hCrossUp ? "YES" : "no").padEnd(8) +
      (r.stoch4hCrossUp ? "YES" : "no").padEnd(8) +
      (r.dailyStochCrossUp ? "YES" : "no").padEnd(8) +
      (r.weeklyStochCrossUp ? "YES" : "no").padEnd(8) +
      crossStr.padEnd(8) +
      fmt(r.atrPct, 1, "%").padEnd(7) +
      actStr.padEnd(5) +
      fmt(r.price, 6).padEnd(12) +
      changeStr.padEnd(9) +
      fmtUsd(r.volume15mUsd).padEnd(10) +
      volume24hStr.padEnd(10) +
      fmtUsd(r.bidDepthUsd).padEnd(9) +
      fundStr.padEnd(9) +
      fireStr.padEnd(6) +
      r.alertLevel,
    );
  }

  if (alerts.length === 0 && cautions.length === 0 && watches.length === 0) {
    console.log("\n  — No alerts active right now.");
  }
}

// ── "monitor" command (runs forever) ─────────────────────────────────────────

async function cmdMonitor(): Promise<void> {
  // Ensure universe is seeded before starting the loop
  const result = await buildWeeklyCapUniverse();
  console.log(`[weekly-cap:monitor] Universe: ${result.total} tokens, ${result.inCapitulation} in capitulation.`);

  if (result.inCapitulation === 0) {
    console.warn("[weekly-cap:monitor] ⚠️  No tokens in capitulation — monitor will run but produce no output.");
    console.warn("[weekly-cap:monitor]    Run `npm run weekly-cap -- refresh` to rebuild the universe.");
  }

  await startWeeklyCapMonitorService();
}

// ── Shared helper ─────────────────────────────────────────────────────────────

async function printCapitulationList(): Promise<void> {
  const tokens = await getCapitulationTokens();
  if (tokens.length === 0) {
    console.log("\nNo tokens currently in capitulation zone.");
    return;
  }

  console.log(`\n📆 CAPITULATION TOKENS (weekly RSI <38, ≤10% from ATL) — ${tokens.length} found:`);
  console.log(
    "  " +
    "#".padEnd(4) +
    "Symbol".padEnd(18) +
    "Cap$M".padEnd(7) +
    "wRSI".padEnd(7) +
    "wK/wD".padEnd(12) +
    "wCross".padEnd(8) +
    "dRSI".padEnd(7) +
    "dCross".padEnd(8) +
    "Dist%ATL".padEnd(10) +
    "Close",
  );
  for (const [i, t] of tokens.entries()) {
    console.log(
      `  ${String(i + 1).padStart(2)} ` +
      t.symbol.padEnd(18) +
      fmt(t.marketCapUsd / 1_000_000, 1).padEnd(7) +
      fmt(t.weeklyRsi, 1).padEnd(7) +
      `${fmt(t.weeklyStochK, 1)}/${fmt(t.weeklyStochD, 1)}`.padEnd(12) +
      (t.weeklyStochCrossUp ? "YES" : "no").padEnd(8) +
      fmt(t.dailyRsi, 1).padEnd(7) +
      (t.dailyStochCrossUp ? "YES" : "no").padEnd(8) +
      `+${fmt(t.distanceFromAtlPct, 1)}%`.padEnd(10) +
      fmt(t.close, 6),
    );
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

(async () => {
  switch (cmd) {
    case "refresh":
      await cmdRefresh();
      break;
    case "check":
      await cmdCheck();
      break;
    case "monitor":
      await cmdMonitor(); // never returns
      break;
    case "report":
    default:
      await cmdReport();
      break;
  }
  process.exit(0);
})().catch((err) => {
  console.error("[weekly-cap] Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
