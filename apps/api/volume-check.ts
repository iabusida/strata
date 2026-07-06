import { fetchOrderBookExecutionRead, fetchPerpContexts } from "./src/bitunix-service.js";

const symbols = ["BARD", "TLM", "CAP", "4", "BTW", "HOT", "RESOLV"];

// Populate volume cache by fetching perp contexts first
console.log("Fetching market data...");
await fetchPerpContexts(symbols);

console.log("\nSymbol\t\tDaily Vol (M)\tTier\t\tOB Imbalance\tAction");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

for (const symbol of symbols) {
  try {
    const ob = await fetchOrderBookExecutionRead(symbol);
    if (!ob) {
      console.log(`${symbol}\t\tFailed to fetch`);
      continue;
    }

    const vol = ob.dayNtlVolume;
    if (vol === undefined) {
      console.log(`${symbol}\t\tN/A\t\tN/A\t\t${(ob.imbalance * 100).toFixed(1)}%\t\t${ob.actionRecommendation}`);
      continue;
    }

    const tier =
      vol >= 100 ? "MEGA" :
      vol >= 30 ? "LARGE" :
      vol >= 5 ? "MID" :
      "SMALL";

    const imbPct = (ob.imbalance * 100).toFixed(1);
    const imbDir = ob.imbalance >= 0 ? "+" : "";

    console.log(
      `${symbol}\t\t${vol.toFixed(2)}\t\t${tier}\t\t${imbDir}${imbPct}%\t\t${ob.actionRecommendation}`
    );
  } catch (e) {
    console.log(`${symbol}\t\tError: ${e instanceof Error ? e.message : String(e)}`);
  }
}


