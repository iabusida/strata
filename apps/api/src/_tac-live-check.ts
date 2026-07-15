import "./env.js";
import { fetchPerpContexts, fetchOrderBookExecutionRead, fetchRecentCandles } from "./bitunix-service.js";

async function main() {
  const symbol = "TAC-PERP";
  const ctxMap = await fetchPerpContexts([symbol]);
  const ctx = ctxMap.get(symbol);
  const ob = await fetchOrderBookExecutionRead(symbol);
  const candles = await fetchRecentCandles(symbol, "15m", 24);

  const closes = candles.map((c) => c.close);
  const last = closes.at(-1) ?? null;
  const prev = closes.at(-2) ?? null;
  const ret15 = last != null && prev != null ? ((last - prev) / prev) * 100 : null;
  const ret1h = closes.length >= 5 ? ((last! - closes.at(-5)!) / closes.at(-5)!) * 100 : null;
  const ret4h = closes.length >= 17 ? ((last! - closes.at(-17)!) / closes.at(-17)!) * 100 : null;

  console.log(JSON.stringify({
    symbol,
    markPrice: ctx?.markPrice ?? null,
    volume24hM: ctx?.dayNtlVolume ?? null,
    fundingRate: ctx?.fundingRate ?? null,
    ret15mPct: ret15,
    ret1hPct: ret1h,
    ret4hPct: ret4h,
    ob: ob
      ? {
          spreadPct: ob.spreadPct,
          bidDepthUsd: ob.bidDepthUsd,
          askDepthUsd: ob.askDepthUsd,
          imbalance: ob.imbalance,
          combinedDepthUsd: ob.combinedDepthUsd,
          obsScoreRolling: ob.obsScoreRolling,
          liquidityRegime: ob.liquidityRegime,
          actionRecommendation: ob.actionRecommendation,
          actionConfidencePct: ob.actionConfidencePct,
        }
      : null,
  }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
