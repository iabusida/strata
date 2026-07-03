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
import { sendTelegramMessage } from "./telegram-service.js";

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
  console.log("  " + "Symbol".padEnd(14) + "Score".padEnd(8) + "Dist".padEnd(8) + "RSI".padEnd(6) + "DZ".padEnd(5) + "PP".padEnd(5) + "BO".padEnd(5) + "Fund%".padEnd(10) + "Stage");
  for (const row of ranked) {
    const c = row.c;
    const fundStr = c.fundingRate !== 0 ? `${(c.fundingRate * 100).toFixed(4)}%` : "n/a";
    const stageIcon = c.stage === "PRE_PUMP" ? "🚀" : c.stage === "EARLY_ACCUMULATION" ? "🌱" : c.stage === "DEAD_ZONE" ? "💀" : "";
    console.log(
      `  ${stageIcon} ${c.symbol.padEnd(12)}`.padEnd(18) +
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

async function main() {
  try {
    const showRotationShortlist = process.argv.includes("--rotation");

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

    if (showRotationShortlist) {
      printRotationShortlist(result);
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
