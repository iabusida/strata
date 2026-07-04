#!/usr/bin/env node
/**
 * CLI: Run capitulation bounce scan and send to Telegram
 * 
 * Usage:
 *   npm run scan:capitulation
 *   npm run scan:capitulation -- --rotation
 */

import "./env.js";
import { scanCapitulationBounces, formatCapitulationForTelegram } from "./capitulation-bounce-scan.js";
import { scanFastPumpCandidates } from "./fast-pump-scan.js";
import { sendTelegramMessage } from "./telegram-service.js";

function estimateRotationWindow(candidate: Awaited<ReturnType<typeof scanCapitulationBounces>>["bounceZoneCandidates"][number]): string {
  if (candidate.stage === "PRE_PUMP") {
    return "1-3d";
  }

  const fundingIsNegative = candidate.fundingRate < -0.00003;
  const fundingIsVeryNegative = candidate.fundingRate < -0.0003;

  if (candidate.prePumpScore >= 50) {
    return fundingIsNegative ? "2-5d" : "3-7d";
  }

  if (candidate.prePumpScore >= 35) {
    return fundingIsNegative ? "3-7d" : "4-10d";
  }

  if (candidate.deadZoneScore >= 65) {
    return fundingIsVeryNegative ? "4-7d" : "1-2w";
  }

  if (candidate.deadZoneScore >= 50) {
    return "1-2w";
  }

  return "2-3w";
}

function printRotationShortlist(result: Awaited<ReturnType<typeof scanCapitulationBounces>>) {
  const pool = [...result.bounceZoneCandidates, ...result.nearBounceZone]
    .filter((c) => c.breakoutScore < 60) // exclude confirmed breakout-style names
    .filter((c) => c.distanceFromZeroFib >= 5 && c.distanceFromZeroFib <= 13)
    .filter((c) => c.rsi14 >= 28 && c.rsi14 <= 50)
    .filter((c) => c.stage !== "IGNORE");

  const ranked = pool
    .map((c) => {
      const fundingPenalty = c.fundingRate > 0.00012 ? 12 : c.fundingRate > 0.00008 ? 7 : 0;
      const fundingBonus = c.fundingRate < -0.00008 ? 10 : c.fundingRate < -0.00003 ? 5 : 0;
      const score =
        c.prePumpScore * 0.45 +
        c.deadZoneScore * 0.35 +
        (50 - Math.abs(c.rsi14 - 36)) * 0.2 +
        fundingBonus - fundingPenalty;
      return { c, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  if (ranked.length === 0) {
    console.log("\n🔁 NEXT ROTATION SHORTLIST: none (current filter produced no early candidates)");
    return;
  }

  console.log("\n🔁 NEXT ROTATION SHORTLIST (EARLY ONLY):");
  console.log("  " + "Symbol".padEnd(14) + "ETA".padEnd(7) + "Score".padEnd(8) + "Dist".padEnd(8) + "RSI".padEnd(6) + "DZ".padEnd(5) + "PP".padEnd(5) + "BO".padEnd(5) + "Fund%".padEnd(10) + "Stage");
  for (const row of ranked) {
    const c = row.c;
    const eta = estimateRotationWindow(c);
    const fundStr = c.fundingRate !== 0 ? `${(c.fundingRate * 100).toFixed(4)}%` : "n/a";
    const stageIcon = c.stage === "PRE_PUMP" ? "🚀" : c.stage === "EARLY_ACCUMULATION" ? "🌱" : c.stage === "DEAD_ZONE" ? "💀" : "";
    console.log(
      `  ${stageIcon} ${c.symbol.padEnd(12)}`.padEnd(18) +
      eta.padEnd(7) +
      `${row.score.toFixed(1)}`.padEnd(8) +
      `+${c.distanceFromZeroFib.toFixed(1)}%`.padEnd(8) +
      `${c.rsi14.toFixed(0)}`.padEnd(6) +
      `${c.deadZoneScore}`.padEnd(5) +
      `${c.prePumpScore}`.padEnd(5) +
      `${c.breakoutScore}`.padEnd(5) +
      fundStr.padEnd(10) +
      c.stage
    );
  }
}

async function printFastPumpShortlist(result: Awaited<ReturnType<typeof scanCapitulationBounces>>) {
  const ranked = await scanFastPumpCandidates(result);
  if (ranked.length === 0) {
    console.log("\n⚡ FAST PUMP SHORTLIST: none (no same-day / next-day candidates passed)");
    return;
  }

  console.log("\n⚡ FAST PUMP SHORTLIST (TODAY / TOMORROW):");
  console.log("  " + "Symbol".padEnd(14) + "ETA".padEnd(10) + "Pot".padEnd(7) + "Score".padEnd(8) + "ΔS".padEnd(7) + "1h".padEnd(7) + "4h".padEnd(7) + "VB1h".padEnd(7) + "ΔVB".padEnd(7) + "Fund%".padEnd(10) + "OB".padEnd(7) + "ΔOB".padEnd(7) + "Stage");
  for (const item of ranked) {
    console.log(
      `  ${item.symbol.padEnd(12)}`.padEnd(16) +
      item.window.padEnd(10) +
      item.potential.padEnd(7) +
      `${item.score.toFixed(1)}`.padEnd(8) +
      `${item.deltaScore >= 0 ? "+" : ""}${item.deltaScore.toFixed(1)}`.padEnd(7) +
      `${item.oneHourChangePct.toFixed(1)}%`.padEnd(7) +
      `${item.fourHourChangePct.toFixed(1)}%`.padEnd(7) +
      `${item.oneHourVolumeBurst.toFixed(2)}x`.padEnd(7) +
      `${item.deltaOneHourVolumeBurst >= 0 ? "+" : ""}${item.deltaOneHourVolumeBurst.toFixed(2)}`.padEnd(7) +
      `${(item.fundingRate * 100).toFixed(4)}%`.padEnd(10) +
      `${item.orderbookImbalance.toFixed(2)}`.padEnd(7) +
      `${item.deltaOrderbookImbalance >= 0 ? "+" : ""}${item.deltaOrderbookImbalance.toFixed(2)}`.padEnd(7) +
      item.dailyStage
    );
  }
}

async function main() {
  try {
    const showRotationShortlist = process.argv.includes("--rotation");
    const showFastPumpShortlist = process.argv.includes("--fast-pump");

    console.log("[capitulation-scan] Starting bounce scan on Bitunix...");
    const startAt = Date.now();

    const result = await scanCapitulationBounces();
    const elapsedMs = Date.now() - startAt;

    console.log(
      `[capitulation-scan] ✅ Scan completed in ${(elapsedMs / 1000).toFixed(1)}s`
    );
    console.log(
      `[capitulation-scan] Found ${result.bounceZoneCandidates.length} in BOUNCE ZONE (5-10% above ATL)`
    );
    console.log(
      `[capitulation-scan] Found ${result.nearBounceZone.length} in NEAR ZONE (3-15% above ATL)`
    );
    console.log(
      `[capitulation-scan] Found ${result.ultraCapitulationCandidates.length} in ULTRA CAPITULATION (0-3% above ATL)`
    );

    // Log bounce zone tokens to terminal
    if (result.bounceZoneCandidates.length > 0) {
      console.log("\n🎯 BOUNCE ZONE (5-10% above ATL):");
      console.log("  " + "Symbol".padEnd(14) + "Dist".padEnd(8) + "RSI".padEnd(6) + "DZ".padEnd(5) + "PP".padEnd(5) + "BO".padEnd(5) + "Fund%".padEnd(10) + "Stage");
      for (const candidate of result.bounceZoneCandidates.slice(0, 20)) {
        const icon = candidate.rsi14 < 30 ? "🔥" : "⚠️";
        const fundStr = candidate.fundingRate !== 0
          ? (candidate.fundingRate * 100).toFixed(4) + "%"
          : "n/a";
        console.log(
          `  ${icon} ${candidate.symbol.padEnd(12)} +${candidate.distanceFromZeroFib.toFixed(1)}%`.padEnd(24) +
          `RSI ${candidate.rsi14.toFixed(0)}`.padEnd(9) +
          `DZ:${candidate.deadZoneScore}`.padEnd(8) +
          `PP:${candidate.prePumpScore}`.padEnd(8) +
          `BO:${candidate.breakoutScore}`.padEnd(8) +
          fundStr.padEnd(12) +
          candidate.stage
        );
      }
    }

    // Log near zone tokens to terminal
    if (result.nearBounceZone.length > 0) {
      console.log("\n👀 NEAR ZONE (3-15% above ATL):");
      console.log("  " + "Symbol".padEnd(14) + "Dist".padEnd(8) + "RSI".padEnd(6) + "DZ".padEnd(5) + "PP".padEnd(5) + "Fund%".padEnd(10) + "Stage");
      for (const candidate of result.nearBounceZone.slice(0, 20)) {
        const stageIcon = candidate.stage === "PRE_PUMP" ? "🚀" : candidate.stage === "EARLY_ACCUMULATION" ? "🌱" : "";
        const fundStr = candidate.fundingRate !== 0
          ? (candidate.fundingRate * 100).toFixed(4) + "%"
          : "n/a";
        console.log(
          `  ${stageIcon} ${candidate.symbol.padEnd(12)} +${candidate.distanceFromZeroFib.toFixed(1)}%`.padEnd(26) +
          `RSI ${candidate.rsi14.toFixed(0)}`.padEnd(9) +
          `DZ:${candidate.deadZoneScore}`.padEnd(8) +
          `PP:${candidate.prePumpScore}`.padEnd(8) +
          fundStr.padEnd(12) +
          candidate.stage
        );
      }
    }

    // Log ultra capitulation tokens to terminal
    if (result.ultraCapitulationCandidates.length > 0) {
      console.log("\n🧊 ULTRA CAPITULATION (0-3% above ATL):");
      console.log("  " + "Symbol".padEnd(14) + "Dist".padEnd(8) + "RSI".padEnd(6) + "DZ".padEnd(5) + "PP".padEnd(5) + "Fund%".padEnd(10) + "Stage");
      for (const candidate of result.ultraCapitulationCandidates.slice(0, 20)) {
        const stageIcon = candidate.stage === "PRE_PUMP" ? "🚀" : candidate.stage === "EARLY_ACCUMULATION" ? "🌱" : candidate.stage === "DEAD_ZONE" ? "💀" : "";
        const fundStr = candidate.fundingRate !== 0
          ? (candidate.fundingRate * 100).toFixed(4) + "%"
          : "n/a";
        console.log(
          `  ${stageIcon} ${candidate.symbol.padEnd(12)} +${candidate.distanceFromZeroFib.toFixed(1)}%`.padEnd(26) +
          `RSI ${candidate.rsi14.toFixed(0)}`.padEnd(9) +
          `DZ:${candidate.deadZoneScore}`.padEnd(8) +
          `PP:${candidate.prePumpScore}`.padEnd(8) +
          fundStr.padEnd(12) +
          candidate.stage
        );
      }
    }

    // Ordered ranking for the next run
    if (result.topNextRunCandidates.length > 0) {
      console.log("\n🏁 TOP NEXT-RUN CANDIDATES (ORDERED):");
      console.log("  " + "#".padEnd(4) + "Symbol".padEnd(14) + "Score".padEnd(8) + "Dist".padEnd(8) + "RSI".padEnd(6) + "DZ".padEnd(5) + "PP".padEnd(5) + "Fund%".padEnd(10) + "Stage");
      for (const [idx, candidate] of result.topNextRunCandidates.slice(0, 20).entries()) {
        const fundStr = candidate.fundingRate !== 0
          ? (candidate.fundingRate * 100).toFixed(4) + "%"
          : "n/a";
        console.log(
          `${String(idx + 1).padStart(3)} `.padEnd(4) +
          `${candidate.symbol.padEnd(13)}`.padEnd(14) +
          `${candidate.score.toFixed(1)}`.padEnd(8) +
          `+${candidate.distanceFromZeroFib.toFixed(1)}%`.padEnd(8) +
          `${candidate.rsi14.toFixed(0)}`.padEnd(6) +
          `${candidate.deadZoneScore}`.padEnd(5) +
          `${candidate.prePumpScore}`.padEnd(5) +
          fundStr.padEnd(10) +
          candidate.stage
        );
      }
    }

    if (showRotationShortlist) {
      printRotationShortlist(result);
    }

    if (showFastPumpShortlist) {
      await printFastPumpShortlist(result);
    }

    // Format and send to Telegram
    const telegramMessage = formatCapitulationForTelegram(result);
    await sendTelegramMessage(telegramMessage);

    console.log("\n[capitulation-scan] ✅ Sent to Telegram successfully");
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[capitulation-scan] ❌ Error: ${message}`);
    console.error(error);
    process.exit(1);
  }
}

main();
