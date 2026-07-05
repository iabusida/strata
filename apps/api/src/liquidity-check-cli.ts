import { fetchOrderBookExecutionRead } from "./bitunix-service.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkLiquidity() {
  const symbols = process.argv.slice(2)
    .map((raw) => raw.trim().toUpperCase())
    .filter((raw) => raw.length > 0)
    .map((raw) => raw.endsWith("-PERP") ? raw.slice(0, -5) : raw);
  const targets = symbols.length > 0 ? symbols : ["BARD"];
  const samples = Math.max(1, Math.min(10, Number.parseInt(process.env.LIQUIDITY_CHECK_SAMPLES ?? "3", 10) || 3));
  const sampleDelayMs = Math.max(500, Number.parseInt(process.env.LIQUIDITY_CHECK_SAMPLE_DELAY_MS ?? "2000", 10) || 2000);
  
  for (const symbol of targets) {
    let ob = null;
    for (let i = 0; i < samples; i++) {
      ob = await fetchOrderBookExecutionRead(symbol);
      if (i < samples - 1) {
        await sleep(sampleDelayMs);
      }
    }
    if (!ob) {
      console.log(`❌ ${symbol}: failed to fetch orderbook`);
      continue;
    }
    
    const buyPressure = ob.imbalance > 0 ? "🟢 BUY" : "🔴 SELL";
    const obCurrentPct = ob.imbalance * 100;
    const ob1mPct = (ob.imbalanceAvg1m ?? ob.imbalance) * 100;
    const ob5mPct = (ob.imbalanceAvg5m ?? ob.imbalance) * 100;
    const ob15mPct = (ob.imbalanceAvg15m ?? ob.imbalance) * 100;
    const missingConditions = ob.actionMissingConditions ?? [];
    const readinessTotal = 6;
    const readinessMet = ob.actionRecommendation === "BUY"
      ? readinessTotal
      : Math.max(0, readinessTotal - Math.min(readinessTotal, missingConditions.length));
    const nextCondition = missingConditions[0] ?? "Maintain current conditions";
    console.log(`\n📊 ${symbol}-PERP LIQUIDITY HEATMAP
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Bid/Ask: ${ob.bestBid.toFixed(6)} / ${ob.bestAsk.toFixed(6)}
  Spread: ${ob.spreadPct.toFixed(4)}% (${ob.spreadPct > 0.10 ? "⚠️ WIDE" : "✓ TIGHT"})
  Mark Price: ${ob.markPrice.toFixed(6)}
  
  📈 DEPTH (within 10bps):
    Bid Depth: $${ob.bidDepthUsd.toFixed(0)}
    Ask Depth: $${ob.askDepthUsd.toFixed(0)}
    Total: $${ob.combinedDepthUsd.toFixed(0)}

  🧠 TIME-WEIGHTED LIQUIDITY:
    OBS: ${(ob.obsScoreRolling ?? 50).toFixed(0)}
    ABS: ${(ob.absorptionScore ?? 50).toFixed(0)}
    AWS: ${(ob.askWallScore ?? 50).toFixed(0)} (${ob.askWallLabel ?? "WEAK_ASK_WALL"})
    BWS: ${(ob.bidWallScore ?? 50).toFixed(0)} (${ob.bidWallLabel ?? "WEAK_SUPPORT"})
    DST: ${(ob.distributionScore ?? 50).toFixed(0)}
    SDS: ${(ob.supportDefenseScore ?? 50).toFixed(0)}
    PCS: ${(ob.priceConfirmationScore ?? 50).toFixed(0)}
    Regime: ${ob.liquidityRegime ?? "NEUTRAL"}
    Divergence: ${ob.liquidityDivergence ?? "NONE"}
    Final Score: ${(ob.finalLiquidityScore ?? 50).toFixed(0)}
    Action: ${ob.actionRecommendation ?? "WAIT"} (${(ob.actionConfidencePct ?? 50).toFixed(0)}%)
    Promotion Readiness: ${readinessMet}/${readinessTotal} conditions met
    Next Condition: ${nextCondition}
    Reason: ${ob.actionReason ?? "Conflicting liquidity signals"}
    ${ob.actionRecommendation === "WAIT" && (ob.actionMissingConditions?.length ?? 0) > 0
      ? `What is preventing BUY?\n    Missing Conditions:\n      - ${(ob.actionMissingConditions ?? []).slice(0, 5).join("\n      - ")}\n    Primary blocker: ${ob.actionPrimaryBlocker ?? "Confirmation is incomplete."}`
      : ""}
    OB Current: ${obCurrentPct >= 0 ? "+" : ""}${obCurrentPct.toFixed(1)}%
    OB 1m Avg: ${ob1mPct >= 0 ? "+" : ""}${ob1mPct.toFixed(1)}%
    OB 5m Avg: ${ob5mPct >= 0 ? "+" : ""}${ob5mPct.toFixed(1)}%
    OB 15m Avg: ${ob15mPct >= 0 ? "+" : ""}${ob15mPct.toFixed(1)}%
    Stability: ${(ob.liquidityStabilityScore ?? 50).toFixed(0)} (${ob.liquidityStabilityLabel ?? "MEDIUM"})
  
  ${buyPressure} Imbalance: ${Math.abs(obCurrentPct).toFixed(1)}%
  
  `);
  }
}

checkLiquidity().catch(console.error);
