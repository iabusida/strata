#!/usr/bin/env node
/**
 * CLI: Run capitulation bounce scan and send to Telegram
 * 
 * Usage:
 *   npm run scan:capitulation
 */

import "./env.js";
import { scanCapitulationBounces, formatCapitulationForTelegram } from "./capitulation-bounce-scan.js";
import { sendTelegramMessage } from "./telegram-service.js";

async function main() {
  try {
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
      for (const candidate of result.bounceZoneCandidates.slice(0, 10)) {
        const icon = candidate.rsi14 < 30 ? "🔥" : "⚠️";
        console.log(
          `  ${icon} ${candidate.symbol.padEnd(10)} +${candidate.distanceFromZeroFib.toFixed(1)}% | RSI ${candidate.rsi14.toFixed(0)} | Strength ${candidate.strength}/100`
        );
      }
    }

    // Log near zone tokens to terminal
    if (result.nearBounceZone.length > 0) {
      console.log("\n👀 NEAR ZONE (3-15% above ATL):");
      for (const candidate of result.nearBounceZone.slice(0, 10)) {
        console.log(
          `  ${candidate.symbol.padEnd(10)} +${candidate.distanceFromZeroFib.toFixed(1)}% | Strength ${candidate.strength}/100`
        );
      }
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
