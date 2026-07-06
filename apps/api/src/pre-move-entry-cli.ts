import "./env.js";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { fetchOrderBookExecutionRead } from "./bitunix-service.js";

type FastPumpState = {
  symbols?: Record<string, { lastScore?: number }>;
};

type EntryPhase = "READY" | "EARLY_PILOT" | "FAST_PILOT" | "NO_TRADE";

type EntryPlan = {
  symbol: string;
  phase: EntryPhase;
  scanScore: number;
  askDepth: number;
  absorption: number;
  obImbalancePct: number;
  volumeNow: number;
  volumeAvg30: number;
  volumeSpike: number;
  reasons: string[];
};

const prisma = new PrismaClient();

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase().replace(/-PERP$/i, "");
}

function readScanScore(symbol: string): number {
  try {
    const json = fs.readFileSync("./data/fast-pump-state.json", "utf8");
    const parsed = JSON.parse(json) as FastPumpState;
    return parsed.symbols?.[`${symbol}-PERP`]?.lastScore ?? 0;
  } catch {
    return 0;
  }
}

function readTrackedSymbolsFromState(minScore: number): string[] {
  try {
    const json = fs.readFileSync("./data/fast-pump-state.json", "utf8");
    const parsed = JSON.parse(json) as FastPumpState;
    const entries = Object.entries(parsed.symbols ?? {});
    return entries
      .filter(([, value]) => (value.lastScore ?? 0) >= minScore)
      .sort((a, b) => (b[1].lastScore ?? 0) - (a[1].lastScore ?? 0))
      .map(([key]) => key.replace(/-PERP$/i, ""));
  } catch {
    return [];
  }
}

async function readVolumeSpike(symbol: string): Promise<{ now: number; avg30: number; spike: number }> {
  const latest = await prisma.marketCandle.findFirst({
    where: {
      symbol,
      interval: "D1",
    },
    orderBy: { timestamp: "desc" },
    take: 1,
  });

  if (!latest || latest.volume <= 0) {
    return { now: 0, avg30: 0, spike: 0 };
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const history = await prisma.marketCandle.findMany({
    where: {
      symbol,
      interval: "D1",
      timestamp: {
        gte: thirtyDaysAgo,
        lt: latest.timestamp,
      },
    },
    orderBy: { timestamp: "desc" },
    take: 29,
  });

  if (history.length < 5) {
    return { now: latest.volume, avg30: 0, spike: 0 };
  }

  const avg30 = history.reduce((sum: number, c: { volume: number }) => sum + c.volume, 0) / history.length;
  const spike = avg30 > 0 ? latest.volume / avg30 : 0;
  return { now: latest.volume, avg30, spike };
}

function buildEntryPlan(input: {
  symbol: string;
  scanScore: number;
  askDepth: number;
  absorption: number;
  obImbalancePct: number;
  volumeNow: number;
  volumeAvg30: number;
  volumeSpike: number;
}): EntryPlan {
  const reasons: string[] = [];

  const ready =
    input.volumeSpike >= 1.3 &&
    input.scanScore >= 65 &&
    input.askDepth >= 10000 &&
    input.absorption >= 45 &&
    Math.abs(input.obImbalancePct) <= 40;

  if (ready) {
    reasons.push("All readiness gates pass");
    return { ...input, phase: "READY", reasons };
  }

  // Fast lane: enter before full structure confirmation when expansion is abrupt.
  const fastPilot =
    input.volumeSpike >= 2.2 &&
    input.scanScore >= 40 &&
    input.askDepth >= 2000 &&
    input.absorption >= 22 &&
    Math.abs(input.obImbalancePct) <= 70;

  if (fastPilot) {
    reasons.push("Fast expansion detected pre-structure; early scout entry allowed");
    if (input.absorption < 30) reasons.push(`Fragile absorption (${input.absorption.toFixed(0)})`);
    if (input.scanScore < 55) reasons.push(`Scan still immature (${input.scanScore.toFixed(0)})`);
    if (input.askDepth < 3000) reasons.push(`Shallow ask depth (${input.askDepth.toFixed(0)})`);
    return { ...input, phase: "FAST_PILOT", reasons };
  }

  const earlyPilot =
    input.volumeSpike >= 1.3 &&
    input.scanScore >= 55 &&
    input.askDepth >= 3000 &&
    input.absorption >= 30 &&
    Math.abs(input.obImbalancePct) <= 60;

  if (earlyPilot) {
    reasons.push("Early accumulation detected but full confirmation not ready");
    if (input.absorption < 45) reasons.push(`Need ABS >= 45 (now ${input.absorption.toFixed(0)})`);
    if (input.askDepth < 10000) reasons.push(`Need AskDepth >= 10000 (now ${input.askDepth.toFixed(0)})`);
    if (input.scanScore < 65) reasons.push(`Need ScanScore >= 65 (now ${input.scanScore.toFixed(0)})`);
    return { ...input, phase: "EARLY_PILOT", reasons };
  }

  reasons.push("Setup quality too weak for early entry");
  if (input.volumeSpike < 1.3) reasons.push(`Volume spike too low (${input.volumeSpike.toFixed(2)}x)`);
  if (input.askDepth < 3000) reasons.push(`Ask depth too thin (${input.askDepth.toFixed(0)})`);
  if (input.absorption < 30) reasons.push(`Absorption too weak (${input.absorption.toFixed(0)})`);
  if (Math.abs(input.obImbalancePct) > 60) reasons.push(`OB imbalance extreme (${input.obImbalancePct.toFixed(1)}%)`);
  return { ...input, phase: "NO_TRADE", reasons };
}

function printPlan(plan: EntryPlan): void {
  console.log(`\n${plan.symbol}  phase=${plan.phase}`);
  console.log(`  scan=${plan.scanScore}  askDepth=$${plan.askDepth.toFixed(0)}  abs=${plan.absorption.toFixed(0)}  ob=${plan.obImbalancePct.toFixed(1)}%`);
  console.log(`  volNow=${plan.volumeNow.toFixed(0)}  volAvg30=${plan.volumeAvg30.toFixed(0)}  spike=${plan.volumeSpike.toFixed(2)}x`);

  for (const reason of plan.reasons) {
    console.log(`  - ${reason}`);
  }

  if (plan.phase === "READY") {
    console.log("  ACTION: Enter normal size (risk unit 1.0), max 5x leverage.");
    console.log("  EXIT: Volume collapse >50% vs 30d avg OR ABS <35 for 2 consecutive checks.");
  } else if (plan.phase === "FAST_PILOT") {
    console.log("  ACTION: Fast pilot only (risk unit 0.10), max 1x-2x leverage.");
    console.log("  SCALE: Add only after EARLY_PILOT or READY gates appear.");
    console.log("  TIME-STOP: Exit fast pilot if no +0.5% move within 20-30 minutes.");
    console.log("  HARD-STOP: Exit immediately if ABS <20 OR OB goes beyond +/-75% OR spread widens >0.20%.");
  } else if (plan.phase === "EARLY_PILOT") {
    console.log("  ACTION: Pilot only (risk unit 0.25), max 2x-3x leverage.");
    console.log("  ADD-ON: Only if ABS >=45 AND AskDepth >=10000 AND scan >=65.");
    console.log("  TIME-STOP: Exit pilot if no +0.8% move within 90 minutes.");
    console.log("  HARD-STOP: Exit if volume drops >30% from today level intraday or OB goes beyond +/-70%.");
  } else {
    console.log("  ACTION: No trade. Wait for structure to improve.");
  }
}

async function analyzeSymbol(rawSymbol: string): Promise<void> {
  const symbol = normalizeSymbol(rawSymbol);
  const [ob, volume] = await Promise.all([
    fetchOrderBookExecutionRead(symbol),
    readVolumeSpike(symbol),
  ]);

  if (!ob) {
    console.log(`\n${symbol}  phase=NO_TRADE`);
    console.log("  - Could not fetch order-book data");
    return;
  }

  const plan = buildEntryPlan({
    symbol,
    scanScore: readScanScore(symbol),
    askDepth: ob.askDepthUsd,
    absorption: ob.absorptionScore ?? 0,
    obImbalancePct: ob.imbalance * 100,
    volumeNow: volume.now,
    volumeAvg30: volume.avg30,
    volumeSpike: volume.spike,
  });

  printPlan(plan);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useState = args.includes("--from-state");
  const onlyEnterable = args.includes("--only-enterable");
  const minScoreArg = args.find((arg) => arg.startsWith("--min-score="));
  const minScore = minScoreArg ? Math.max(0, Number.parseInt(minScoreArg.split("=")[1] ?? "55", 10) || 55) : 55;

  const symbols = args
    .filter((arg) => !arg.startsWith("--"))
    .map(normalizeSymbol)
    .filter(Boolean);

  const stateSymbols = useState ? readTrackedSymbolsFromState(minScore) : [];
  const targets = symbols.length > 0
    ? symbols
    : stateSymbols.length > 0
      ? stateSymbols
      : ["CKB", "OCEAN", "RPL", "TURTLE", "FOLKS", "HEI"];

  console.log("\nPRE-MOVE ENTRY GUARD");
  console.log("Rules: enter early without bleeding balance via staged sizing + invalidation");

  const plans: EntryPlan[] = [];

  for (const symbol of targets) {
    const normalized = normalizeSymbol(symbol);
    const [ob, volume] = await Promise.all([
      fetchOrderBookExecutionRead(normalized),
      readVolumeSpike(normalized),
    ]);

    if (!ob) {
      const noDataPlan: EntryPlan = {
        symbol: normalized,
        phase: "NO_TRADE",
        scanScore: readScanScore(normalized),
        askDepth: 0,
        absorption: 0,
        obImbalancePct: 0,
        volumeNow: volume.now,
        volumeAvg30: volume.avg30,
        volumeSpike: volume.spike,
        reasons: ["Could not fetch order-book data"],
      };
      plans.push(noDataPlan);
      if (!onlyEnterable) {
        printPlan(noDataPlan);
      }
      continue;
    }

    const plan = buildEntryPlan({
      symbol: normalized,
      scanScore: readScanScore(normalized),
      askDepth: ob.askDepthUsd,
      absorption: ob.absorptionScore ?? 0,
      obImbalancePct: ob.imbalance * 100,
      volumeNow: volume.now,
      volumeAvg30: volume.avg30,
      volumeSpike: volume.spike,
    });

    plans.push(plan);
    if (!onlyEnterable || plan.phase !== "NO_TRADE") {
      printPlan(plan);
    }
  }

  const ready = plans.filter((plan) => plan.phase === "READY");
  const fast = plans.filter((plan) => plan.phase === "FAST_PILOT");
  const early = plans.filter((plan) => plan.phase === "EARLY_PILOT");

  console.log("\nSCANNER SUMMARY");
  console.log(`  READY: ${ready.length}`);
  console.log(`  FAST_PILOT: ${fast.length}`);
  console.log(`  EARLY_PILOT: ${early.length}`);
  console.log(`  NO_TRADE: ${plans.length - ready.length - fast.length - early.length}`);

  if (ready.length > 0) {
    console.log("\nREADY TOKENS");
    for (const plan of ready) {
      console.log(`  ${plan.symbol}  scan=${plan.scanScore} abs=${plan.absorption.toFixed(0)} ask=$${plan.askDepth.toFixed(0)} spike=${plan.volumeSpike.toFixed(2)}x ob=${plan.obImbalancePct.toFixed(1)}%`);
    }
  }

  if (fast.length > 0) {
    console.log("\nFAST_PILOT TOKENS");
    for (const plan of fast) {
      console.log(`  ${plan.symbol}  scan=${plan.scanScore} abs=${plan.absorption.toFixed(0)} ask=$${plan.askDepth.toFixed(0)} spike=${plan.volumeSpike.toFixed(2)}x ob=${plan.obImbalancePct.toFixed(1)}%`);
    }
  }

  if (early.length > 0) {
    console.log("\nEARLY_PILOT TOKENS");
    for (const plan of early) {
      console.log(`  ${plan.symbol}  scan=${plan.scanScore} abs=${plan.absorption.toFixed(0)} ask=$${plan.askDepth.toFixed(0)} spike=${plan.volumeSpike.toFixed(2)}x ob=${plan.obImbalancePct.toFixed(1)}%`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
