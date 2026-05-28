import "./env.js";
import { scanRsi } from "./market-data-service.js";

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
    result[key] = value;

    if (value !== "true") {
      i += 1;
    }
  }

  return result;
}

async function main() {
  const raw = process.argv.slice(2);
  const args = parseArgs(raw);
  const positional = raw.filter((token) => !token.startsWith("--"));

  const query = args.query ?? positional[0];
  const marketValue = args.market ?? positional[1];
  const market = marketValue === "spot" ? "spot" : "perp";
  const limitTokens = Number(args.limitTokens ?? positional[2] ?? 25);
  const onlySignalsValue = args.onlySignals ?? positional[3];
  const onlySignals = onlySignalsValue === "true" || onlySignalsValue === "1";

  const scan = await scanRsi({
    query,
    market,
    limitTokens
  });

  const rows = onlySignals
    ? scan.results.filter((item) => item.signal.type !== "NO SIGNAL")
    : scan.results;

  console.log(`Scanned at: ${scan.analyzedAt}`);
  console.log(`Market: ${market} | Tokens scanned: ${rows.length}`);
  console.log("\n=== Timeframe Alignment System (Sorted by 24h Volume) ===");
  console.table(
    rows.map((item) => ({
      symbol: item.symbol,
      signal: item.signal.type,
      "24h Vol": item.volume24h > 0 ? `$${(item.volume24h / 1_000_000).toFixed(2)}M` : "N/A",
      "1h RSI": item.timeframes.intermediary.rsi.toFixed(2),
      "4h Stoch": `K:${item.timeframes.macro.stochK.toFixed(1)} D:${item.timeframes.macro.stochD.toFixed(1)}`,
      "1h Stoch": `K:${item.timeframes.intermediary.stochK.toFixed(1)} D:${item.timeframes.intermediary.stochD.toFixed(1)}`,
      "15m Stoch": `K:${item.timeframes.microTrigger.stochK.toFixed(1)} D:${item.timeframes.microTrigger.stochD.toFixed(1)}`,
      price: `$${item.close.toFixed(2)}`
    }))
  );

  if (scan.skipped.length > 0) {
    console.log("\nSkipped symbols:");
    console.table(scan.skipped);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
