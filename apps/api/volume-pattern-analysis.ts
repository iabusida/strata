import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const symbols = ["BARD", "TLM", "CAP", "4", "BTW", "HOT", "RESOLV"];

async function analyzeVolumePatterns() {
  for (const symbol of symbols) {
    console.log(`\n📊 ${symbol} - Volume Pattern Analysis`);
    console.log("━".repeat(60));

    // Fetch 60 days of daily candles
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    const candles = await prisma.marketCandle.findMany({
      where: {
        symbol,
        interval: "D1",
        timestamp: {
          gte: sixtyDaysAgo,
        },
      },
      orderBy: { timestamp: "asc" },
      take: 100,
    });

    if (candles.length === 0) {
      console.log("❌ No historical data available");
      continue;
    }

    // Analyze volume trend
    const volumes = candles.map((c) => c.volume);
    const avgVolume30d = volumes.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, volumes.slice(-30).length);
    const avgVolume60d = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const maxVolume = Math.max(...volumes);
    const minVolume = Math.min(...volumes);
    const lastVolume = volumes[volumes.length - 1];
    const prevVolume = volumes[volumes.length - 2] ?? 0;

    const volumeChange = prevVolume > 0 ? ((lastVolume - prevVolume) / prevVolume) * 100 : 0;
    const volumeVsAvg = avgVolume30d > 0 ? ((lastVolume - avgVolume30d) / avgVolume30d) * 100 : 0;

    console.log(`  Data points: ${candles.length} days (from ${candles[0].timestamp.toISOString().split("T")[0]})`);
    console.log(`  Min Volume: ${minVolume.toFixed(2)}`);
    console.log(`  Avg Volume (60d): ${avgVolume60d.toFixed(2)}`);
    console.log(`  Avg Volume (30d): ${avgVolume30d.toFixed(2)}`);
    console.log(`  Max Volume: ${maxVolume.toFixed(2)}`);
    console.log(`  Last Volume: ${lastVolume.toFixed(2)}`);
    console.log(`  Volume Change (1d): ${volumeChange > 0 ? "+" : ""}${volumeChange.toFixed(1)}%`);
    console.log(`  Volume vs 30d Avg: ${volumeVsAvg > 0 ? "+" : ""}${volumeVsAvg.toFixed(1)}%`);

    // Detect volume spike pattern
    const last7Days = volumes.slice(-7);
    const avg7d = last7Days.reduce((a, b) => a + b, 0) / 7;
    const spike7d = lastVolume > avg7d * 1.5; // 50% above weekly avg
    const trend = lastVolume > avgVolume30d ? "📈 RISING" : "📉 FALLING";

    console.log(`\n  Status: ${trend}`);
    if (spike7d) {
      console.log(`  🚨 VOLUME SPIKE DETECTED: ${(lastVolume / avg7d).toFixed(2)}x weekly average`);
    }

    // Show recent volume trend (last 10 days)
    console.log("\n  Recent 10-day trend:");
    const recentCandles = candles.slice(-10);
    for (let i = 0; i < recentCandles.length; i++) {
      const c = recentCandles[i];
      const dayBefore = i > 0 ? recentCandles[i - 1].volume : 0;
      const changePct =
        dayBefore > 0 ? (((c.volume - dayBefore) / dayBefore) * 100).toFixed(1) : "N/A";
      const bar =
        "█".repeat(Math.min(20, Math.max(1, Math.floor((c.volume / maxVolume) * 20))));
      console.log(
        `    ${c.timestamp.toISOString().split("T")[0]} Vol: ${c.volume.toFixed(2)} ${bar} (${changePct}%)`
      );
    }
  }

  await prisma.$disconnect();
}

analyzeVolumePatterns().catch(console.error);
