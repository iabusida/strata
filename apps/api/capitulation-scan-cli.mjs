#!/usr/bin/env node

/**
 * CLI: Run capitulation bounce scan and send to Telegram
 * 
 * Usage:
 *   node capitulation-scan-cli.mjs
 */

import { scanCapitulationBounces, formatCapitulationForTelegram } from "./dist/capitulation-bounce-scan.js";
import { sendTelegramMessage } from "./dist/telegram-service.js";

async function main() {
  try {
    console.log("[CLI] Starting capitulation bounce scan...");
    const startAt = Date.now();

    const result = await scanCapitulationBounces();
    const elapsedMs = Date.now() - startAt;

    console.log(`[CLI] Scan completed in ${(elapsedMs / 1000).toFixed(1)}s`);
    console.log(`[CLI] Found ${result.bounceZoneCandidates.length} in bounce zone`);
    console.log(`[CLI] Found ${result.nearBounceZone.length} near bounce zone`);

    // Format and send to Telegram
    const telegramMessage = formatCapitulationForTelegram(result);
    await sendTelegramMessage(telegramMessage);

    console.log("[CLI] ✅ Telegram message sent successfully");
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[CLI] ❌ Error: ${message}`);
    process.exit(1);
  }
}

main();
