import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function findPrePumpCandidates() {
  console.log("🔍 Scanning for pre-pump volume patterns...\n");

  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

  // Get all unique symbols with D1 candles in last 60 days
  const symbolsRaw = await prisma.marketCandle.findMany({
    where: {
      interval: "D1",
      timestamp: {
        gte: sixtyDaysAgo,
      },
    },
    distinct: ["symbol"],
    select: { symbol: true },
  });

  const symbols = symbolsRaw.map((r) => r.symbol);
  console.log(`Found ${symbols.length} symbols with recent data\n`);

  const candidates: Array<{
    symbol: string;
    avgVol30d: number;
    lastVol: number;
    spikeRatio: number;
    vol3dTrend: string;
    priceChange7d: number;
    score: number;
  }> = [];

  for (const symbol of symbols) {
    try {
      const candles = await prisma.marketCandle.findMany({
        where: {
          symbol,
          interval: "D1",
          timestamp: {
            gte: sixtyDaysAgo,
          },
        },
        orderBy: { timestamp: "asc" },
      });

      if (candles.length < 10) continue; // Skip if insufficient data

      const volumes = candles.map((c) => c.volume);
      const closes = candles.map((c) => c.close);

      // Calculate metrics
      const avgVol30d = volumes.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, volumes.length);
      const avgVol60d = volumes.reduce((a, b) => a + b, 0) / volumes.length;
      const lastVol = volumes[volumes.length - 1];
      const last3Vols = volumes.slice(-3);
      const last3Trend = last3Vols[2] > last3Vols[0] ? "UP" : "DOWN";
      const vol3dAvg = last3Vols.reduce((a, b) => a + b, 0) / 3;

      // Spike detection
      const spikeRatio = avgVol30d > 0 ? lastVol / avgVol30d : 0;

      // Price change (7 days)
      const price7dAgo = closes[Math.max(0, closes.length - 8)];
      const currentPrice = closes[closes.length - 1];
      const priceChange7d = price7dAgo > 0 ? ((currentPrice - price7dAgo) / price7dAgo) * 100 : 0;

      // Pre-pump signal scoring
      // Looking for: volume elevated (1.3-3x) but price NOT yet moved much (< 30%)
      const volumeSpikeScore = Math.min(100, Math.max(0, (spikeRatio - 1) * 50)); // 1.3x = 15, 2x = 50, 3x = 100
      const earlyStagePenalty = Math.abs(priceChange7d) > 30 ? 0 : 100; // Penalize if already moved too much
      const volumeTrendBonus = last3Trend === "UP" ? 30 : -20;

      const score = (volumeSpikeScore * 0.5 + earlyStagePenalty * 0.35 + volumeTrendBonus * 0.15) / 100;

      // Filter: volume elevated, price not yet exploded, volume trend positive
      if (spikeRatio > 1.3 && Math.abs(priceChange7d) < 30 && last3Trend === "UP") {
        candidates.push({
          symbol,
          avgVol30d,
          lastVol,
          spikeRatio,
          vol3dTrend: last3Trend,
          priceChange7d,
          score,
        });
      }
    } catch (e) {
      // Skip on error
    }
  }

  // Sort by score (highest first)
  candidates.sort((a, b) => b.score - a.score);

  console.log("🚀 PRE-PUMP CANDIDATES (Volume Spike, Early Price Move)");
  console.log("━".repeat(100));
  console.log(
    "Symbol\t\tSpike Ratio\t30d Avg Vol\tLast Vol\t\tPrice 7d\tVol Trend\tScore"
  );
  console.log("━".repeat(100));

  for (let i = 0; i < Math.min(20, candidates.length); i++) {
    const c = candidates[i];
    const spikeStr = `${c.spikeRatio.toFixed(2)}x`;
    const priceStr = `${c.priceChange7d > 0 ? "+" : ""}${c.priceChange7d.toFixed(1)}%`;
    const scoreStr = (c.score * 100).toFixed(0);

    console.log(
      `${c.symbol}\t\t${spikeStr}\t\t${c.avgVol30d.toFixed(0)}\t\t${c.lastVol.toFixed(0)}\t\t${priceStr}\t\t${c.vol3dTrend}\t\t${scoreStr}`
    );
  }

  console.log("\n💡 These tokens show elevated volume without significant price movement yet.");
  console.log("   Likely early-stage pre-pump candidates (5-10 days before potential move)\n");

  // Show top 5 detailed analysis
  if (candidates.length > 0) {
    console.log("📊 TOP 5 PRE-PUMP CANDIDATES (Detailed View)\n");
    for (let i = 0; i < Math.min(5, candidates.length); i++) {
      const c = candidates[i];
      console.log(`${i + 1}. ${c.symbol}`);
      console.log(`   Volume Spike: ${c.spikeRatio.toFixed(2)}x (30d avg: ${c.avgVol30d.toFixed(0)}, last: ${c.lastVol.toFixed(0)})`);
      console.log(`   Price 7d Change: ${c.priceChange7d > 0 ? "+" : ""}${c.priceChange7d.toFixed(1)}% (still early)`);
      console.log(`   Volume Trend: ${c.vol3dTrend} (momentum building)`);
      console.log(`   Pre-Pump Score: ${(c.score * 100).toFixed(0)}/100\n`);
    }
  }

  await prisma.$disconnect();
}

findPrePumpCandidates().catch(console.error);
