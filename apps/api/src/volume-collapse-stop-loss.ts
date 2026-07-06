/**
 * VOLUME COLLAPSE STOP LOSS
 * Monitors held positions and exits when volume dies (like BARD situation)
 * Rule: If daily volume drops >50% from 30d average = EXIT SIGNAL
 */

import "./env.js";
import { PrismaClient } from "@prisma/client";
import { fetchOrderBookExecutionRead } from "./bitunix-service.js";

const prisma = new PrismaClient();

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase().replace(/-PERP$/i, "");
}

interface VolumeAlert {
  symbol: string;
  dayNtlVolume: number;
  avg30dVolume: number;
  collapse: number; // percentage drop
  recommendation: "HOLD" | "EXIT" | "REDUCE";
  reason: string;
  usingClosedCandle: boolean;
  reboundGuardApplied?: boolean;
}

function utcStartOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Check if volume has collapsed for a symbol
 * Uses MarketCandle D1 data directly
 * BARD example: volume was 78M, dropped to 1.6M (-98%) = EXIT
 */
async function checkVolumeCollapse(symbol: string): Promise<VolumeAlert | null> {
  try {
    const normalized = normalizeSymbol(symbol);

    // Pull latest candles and choose a closed daily candle for decisioning.
    const recent = await prisma.marketCandle.findMany({
      where: {
        symbol: normalized,
        interval: "D1",
      },
      orderBy: { timestamp: "desc" },
      take: 3,
    });

    if (recent.length === 0) {
      return null;
    }

    const latest = recent[0];
    const startOfTodayUtc = utcStartOfDay(new Date());
    const latestTs = latest.timestamp instanceof Date ? latest.timestamp : new Date(latest.timestamp);
    const latestIsTodayPartial = latestTs >= startOfTodayUtc;

    // If latest D1 belongs to current UTC day, treat it as unfinished and use prior closed candle.
    const decisionCandle = latestIsTodayPartial && recent.length > 1 ? recent[1] : latest;
    if (!decisionCandle || decisionCandle.volume === 0) {
      return null;
    }

    const dayNtlVolume = decisionCandle.volume;
    const usingClosedCandle = !latestIsTodayPartial || recent.length > 1;

    // Get 30-day average (excluding today)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const historicalCandles = await prisma.marketCandle.findMany({
      where: {
        symbol: normalized,
        interval: "D1",
        timestamp: {
          gte: thirtyDaysAgo,
          lt: decisionCandle.timestamp,
        },
      },
      orderBy: { timestamp: "desc" },
      take: 29,
    });

    if (historicalCandles.length < 5) {
      return null;
    }

    const avg30dVolume =
      historicalCandles.reduce((sum, c) => sum + c.volume, 0) / historicalCandles.length;

    // Calculate collapse percentage
    const collapsePercent = ((avg30dVolume - dayNtlVolume) / avg30dVolume) * 100;

    // Thresholds (staged to reduce whipsaw exits)
    const CRITICAL_COLLAPSE = 70; // >70% drop = CRITICAL PANIC
    const SEVERE_COLLAPSE = 50; // >50% drop = EXIT IMMEDIATELY
    const WARNING_COLLAPSE = 30; // >30% drop = REDUCE EXPOSURE

    let recommendation: "HOLD" | "EXIT" | "REDUCE" = "HOLD";
    let reason = "";

    if (collapsePercent >= CRITICAL_COLLAPSE) {
      // Stage-1 protection: reduce first unless collapse is confirmed on a closed candle snapshot.
      recommendation = usingClosedCandle ? "EXIT" : "REDUCE";
      reason = usingClosedCandle
        ? `🚨 CRITICAL: Volume collapsed ${collapsePercent.toFixed(1)}% (${dayNtlVolume.toFixed(0)}M vs ${avg30dVolume.toFixed(0)}M avg) - PANIC EXIT`
        : `⚠️ CRITICAL (UNCONFIRMED): Intraday volume collapse ${collapsePercent.toFixed(1)}% - REDUCE FIRST`; 
    } else if (collapsePercent >= SEVERE_COLLAPSE) {
      recommendation = usingClosedCandle ? "EXIT" : "REDUCE";
      reason = usingClosedCandle
        ? `❌ SEVERE: Volume collapsed ${collapsePercent.toFixed(1)}% (${dayNtlVolume.toFixed(0)}M vs ${avg30dVolume.toFixed(0)}M avg) - EXIT SIGNAL`
        : `⚠️ SEVERE (UNCONFIRMED): Intraday volume collapse ${collapsePercent.toFixed(1)}% - REDUCE FIRST`;
    } else if (collapsePercent >= WARNING_COLLAPSE) {
      recommendation = "REDUCE";
      reason = `⚠️ WARNING: Volume down ${collapsePercent.toFixed(1)}% (${dayNtlVolume.toFixed(0)}M vs ${avg30dVolume.toFixed(0)}M avg) - REDUCE EXPOSURE`;
    } else {
      recommendation = "HOLD";
      reason = `✅ Volume stable (${dayNtlVolume.toFixed(0)}M vs ${avg30dVolume.toFixed(0)}M avg, down ${collapsePercent.toFixed(1)}%)`;
    }

    let reboundGuardApplied = false;
    if (recommendation === "EXIT") {
      const ob = await fetchOrderBookExecutionRead(normalized);
      if (!ob) {
        recommendation = "REDUCE";
        reboundGuardApplied = true;
        reason = `${reason} | 🔁 Rebound guard: no live OB confirmation, downgrade to REDUCE`;
      } else {
      const bullishRebound =
        ob.imbalance >= 0.2 &&
        ob.spreadPct <= 0.12 &&
        (ob.actionRecommendation ?? "WAIT") !== "SELL";

      const bearishConfirm =
        ob.imbalance <= -0.2 ||
        (ob.actionRecommendation ?? "WAIT") === "SELL";

      if (!bearishConfirm || bullishRebound) {
        recommendation = "REDUCE";
        reboundGuardApplied = true;
        reason = `${reason} | 🔁 Rebound guard: no live bearish confirmation (OB ${(ob.imbalance * 100).toFixed(1)}%, action ${ob.actionRecommendation ?? "WAIT"})`;
      }

      if (bullishRebound) {
        reason = `${reason} | ✅ bullish rebound detected`;
      }
      }
    }

    return {
      symbol: normalized,
      dayNtlVolume,
      avg30dVolume,
      collapse: collapsePercent,
      recommendation,
      reason,
      usingClosedCandle,
      reboundGuardApplied,
    };
  } catch (error) {
    console.error(`Error checking volume for ${symbol}:`, error);
    return null;
  }
}

/**
 * Monitor multiple held positions
 */
async function monitorHeldPositions(symbols: string[]): Promise<void> {
  console.log("\n🔴 VOLUME COLLAPSE STOP LOSS MONITOR");
  console.log("━".repeat(110));
  console.log(
    "Symbol\t\tCurrent Vol\t30d Avg\t\tCollapse\tRecommendation\t\tAction"
  );
  console.log("━".repeat(110));

  const alerts: VolumeAlert[] = [];

  for (const symbol of symbols) {
    const alert = await checkVolumeCollapse(symbol);
    if (!alert) continue;

    alerts.push(alert);

    // Format output
    const volStr = alert.dayNtlVolume.toFixed(0);
    const avgStr = alert.avg30dVolume.toFixed(0);
    const collapseStr = alert.collapse.toFixed(1);
    const recStr = alert.recommendation;

    console.log(
      `${alert.symbol}\t\t${volStr}M\t\t${avgStr}M\t\t${collapseStr}%\t\t${recStr}`
    );
    console.log(`   basis=${alert.usingClosedCandle ? "CLOSED_D1" : "INTRADAY_D1"}`);
    if (alert.reboundGuardApplied) {
      console.log("   rebound_guard=ON");
    }
  }

  console.log("\n📋 ALERT SUMMARY:\n");

  const exitSignals = alerts.filter((a) => a.recommendation === "EXIT");
  if (exitSignals.length > 0) {
    console.log("🚨 IMMEDIATE EXIT REQUIRED:\n");
    for (const alert of exitSignals) {
      console.log(`   ❌ ${alert.symbol}`);
      console.log(`      ${alert.reason}\n`);
    }
  }

  const reduceSignals = alerts.filter((a) => a.recommendation === "REDUCE");
  if (reduceSignals.length > 0) {
    console.log("⚠️  REDUCE EXPOSURE:\n");
    for (const alert of reduceSignals) {
      console.log(`   ⚠️  ${alert.symbol}`);
      console.log(`      ${alert.reason}\n`);
    }
  }

  const holdSignals = alerts.filter((a) => a.recommendation === "HOLD");
  if (holdSignals.length > 0) {
    console.log("✅ POSITIONS HOLDING (Volume Stable):\n");
    for (const alert of holdSignals) {
      console.log(`   ✓ ${alert.symbol}: ${alert.reason}\n`);
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  const heldPositions = process.argv.slice(2);

  if (heldPositions.length === 0) {
    console.log("Usage: npx tsx src/volume-collapse-stop-loss.ts SYMBOL1 SYMBOL2 ...");
    console.log("Example: npx tsx src/volume-collapse-stop-loss.ts CKB OCEAN RPL BARD\n");
    console.log("This tool monitors your held positions for volume collapse signals");
    console.log("(>50% volume drop = EXIT, >30% = REDUCE)\n");
    process.exit(0);
  }

  await monitorHeldPositions(heldPositions);
  await prisma.$disconnect();
}

main().catch(console.error);
