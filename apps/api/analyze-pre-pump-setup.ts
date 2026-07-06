import { scanRsi } from "./src/market-data-service.js";

const prePumpTokens = [
  "RPL",
  "OCEAN",
  "HEI",
  "TURTLE",
  "FOLKS",
  "1000FLOKI",
  "SHDW",
  "CKB",
  "JITOSOL",
  "UP",
  "TLM",
  "ASTR",
];

async function analyzePrePumpCandidates() {
  console.log("📊 Analyzing Pre-Pump Candidates with Technical Setup\n");
  console.log("━".repeat(120));
  console.log(
    "Symbol\t\tRSI\tStoch\tSignal\t\tStage\t\t\tScore\tConfidence"
  );
  console.log("━".repeat(120));

  const results = await scanRsi("PERP", prePumpTokens);

  for (const token of results) {
    const rsi = token.rsi1h?.stochRsi ?? 0;
    const stoch = token.stochRsi ?? 0;
    const signal = token.signal?.type ?? "NONE";
    const stage = token.reversalPhase ?? "UNKNOWN";
    const score = token.confluence?.score ?? 0;

    console.log(
      `${token.symbol}\t\t${rsi.toFixed(0)}\t${stoch.toFixed(0)}\t${signal}\t\t${stage}\t\t\t${score.toFixed(1)}\t${token.confluence?.confidence ?? "N/A"}%`
    );
  }

  console.log("\n💡 Match Analysis:");
  console.log("   🟢 GREEN: Volume spike + Good technical setup = HIGH PRIORITY");
  console.log("   🟡 YELLOW: Volume spike + OK technical setup = WATCH");
  console.log("   🔴 RED: Volume spike but poor technical = AVOID\n");

  const goodCandidates = results.filter(
    (t) =>
      (t.confluence?.score ?? 0) >= 6 &&
      (t.signal?.type ?? "NONE") !== "NONE"
  );

  if (goodCandidates.length > 0) {
    console.log("🎯 HIGHEST PROBABILITY PLAYS:\n");
    goodCandidates.sort((a, b) => (b.confluence?.score ?? 0) - (a.confluence?.score ?? 0));

    for (const token of goodCandidates.slice(0, 5)) {
      console.log(`✅ ${token.symbol}`);
      console.log(
        `   Signal: ${token.signal?.type} | Score: ${(token.confluence?.score ?? 0).toFixed(1)}/10`
      );
      console.log(`   RSI: ${(token.rsi1h?.stochRsi ?? 0).toFixed(0)} | Stage: ${token.reversalPhase}`);
      console.log("");
    }
  }
}

analyzePrePumpCandidates().catch(console.error);
