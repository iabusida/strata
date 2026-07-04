import { fetchOrderBookExecutionRead } from "./bitunix-service.js";

async function checkLiquidity() {
  const symbols = ["ONG", "ATOM"];
  
  for (const symbol of symbols) {
    const ob = await fetchOrderBookExecutionRead(symbol);
    if (!ob) {
      console.log(`❌ ${symbol}: failed to fetch orderbook`);
      continue;
    }
    
    const buyPressure = ob.imbalance > 0 ? "🟢 BUY" : "🔴 SELL";
    console.log(`\n📊 ${symbol}-PERP LIQUIDITY HEATMAP
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Bid/Ask: ${ob.bestBid.toFixed(6)} / ${ob.bestAsk.toFixed(6)}
  Spread: ${ob.spreadPct.toFixed(4)}% (${ob.spreadPct > 0.10 ? "⚠️ WIDE" : "✓ TIGHT"})
  Mark Price: ${ob.markPrice.toFixed(6)}
  
  📈 DEPTH (within 10bps):
    Bid Depth: $${ob.bidDepthUsd.toFixed(0)}
    Ask Depth: $${ob.askDepthUsd.toFixed(0)}
    Total: $${ob.combinedDepthUsd.toFixed(0)}
  
  ${buyPressure} Imbalance: ${Math.abs(ob.imbalance * 100).toFixed(1)}%
  
  💰 YOUR ORDER SIZING:
    $150 (ONG): ~${(150 / ob.markPrice).toFixed(2)} contracts
    $100 (ATOM): ~${(100 / ob.markPrice).toFixed(2)} contracts`);
  }
}

checkLiquidity().catch(console.error);
