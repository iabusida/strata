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

    // Format and send to Telegram
    const telegramMessage = formatCapitulationForTelegram(result);
    await sendTelegramMessage(telegramMessage);

    console.log("[capitulation-scan] ✅ Sent to Telegram successfully");
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[capitulation-scan] ❌ Error: ${message}`);
    console.error(error);
    process.exit(1);
  }
}

main();
