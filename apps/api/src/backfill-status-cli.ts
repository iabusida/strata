#!/usr/bin/env node

import "./env.js";
import { PrismaClient } from "@prisma/client";
import {
  getPendingTokens,
  getCompletedTokens,
  getBackfillStatus,
  getSummary,
  initializeOrUpdateStatus,
  markBackfillSkipped
} from "./backfill-token-tracking.js";

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    const command = process.argv[2];

    if (command === "status") {
      const symbol = process.argv[3];
      if (!symbol) {
        console.error("Usage: backfill-status.ts status <symbol>");
        process.exit(1);
      }

      const status = await getBackfillStatus(prisma, symbol);
      if (!status) {
        console.log(`No backfill record for ${symbol} (never backfilled)`);
      } else {
        console.log(JSON.stringify(status, null, 2));
      }
    } else if (command === "summary") {
      const counts = await getSummary(prisma);
      console.log("Backfill Status Summary:");
      console.log(JSON.stringify(counts, null, 2));
    } else if (command === "pending") {
      const limit = process.argv[3] ? parseInt(process.argv[3], 10) : 50;
      const pending = await getPendingTokens(prisma, limit);
      console.log(`Pending backfill (${pending.length}):`, pending.join(", "));
    } else if (command === "completed") {
      const limit = process.argv[3] ? parseInt(process.argv[3], 10) : 50;
      const completed = await getCompletedTokens(prisma, limit);
      console.log(`Completed backfill (${completed.length}):`, completed.join(", "));
    } else if (command === "skip") {
      const symbol = process.argv[3];
      const reason = process.argv[4] ?? "User marked as skipped (too new or available via other source)";
      if (!symbol) {
        console.error("Usage: backfill-status.ts skip <symbol> [reason]");
        process.exit(1);
      }

      await markBackfillSkipped(prisma, symbol, reason);
      console.log(`Marked ${symbol} as SKIPPED: ${reason}`);
    } else if (command === "init") {
      const symbols = process.argv.slice(3);
      if (symbols.length === 0) {
        console.error("Usage: backfill-status.ts init <symbol1> [symbol2] ...");
        process.exit(1);
      }

      for (const symbol of symbols) {
        await initializeOrUpdateStatus(prisma, symbol, "PENDING");
      }
      console.log(`Initialized backfill tracking for: ${symbols.join(", ")}`);
    } else {
      console.log("Available commands:");
      console.log("  status <symbol>         - check backfill status for a symbol");
      console.log("  summary                 - show overall backfill status counts");
      console.log("  pending [limit]         - list pending symbols (default: 50)");
      console.log("  completed [limit]       - list completed symbols (default: 50)");
      console.log("  skip <symbol> [reason]  - mark a symbol as skipped (too new/no data)");
      console.log("  init <sym1> [sym2] ...- initialize backfill tracking for symbols");
      process.exit(0);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
