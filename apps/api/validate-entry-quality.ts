/**
 * LIQUIDITY QUALITY VALIDATOR
 * Scans all tracked symbols for proper entry conditions
 * 
 * Entry Criteria (ALL must pass):
 * 1. Ask Depth > $10,000
 * 2. Absorption Score ≥ 45
 * 3. OB Imbalance between -40% and +40% (not extreme)
 * 4. Scan Score ≥ 65 (strong technical setup)
 */

import fs from "fs";
import { execSync } from "child_process";

interface FastPumpState {
  symbols: {
    [key: string]: {
      lastScore: number;
      lastOb: number;
      inList: boolean;
    };
  };
}

interface LiquidityData {
  symbol: string;
  askDepth: number | null;
  absorption: number | null;
  obImbalance: number | null;
  scanScore: number;
  passes: boolean;
  issues: string[];
}

function parseAskDepth(output: string): number | null {
  const match = output.match(/Ask Depth:\s*\$([0-9,]+)/);
  if (!match) return null;
  return parseInt(match[1].replace(/,/g, ""), 10);
}

function parseAbsorption(output: string): number | null {
  // Look for "ABS: XX" on any line
  const match = output.match(/\bABS:\s*(\d+)/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

function parseOBImbalance(output: string): number | null {
  const match = output.match(/OB Current:\s*([\+\-][\d.]+)%/);
  if (!match) return null;
  return parseFloat(match[1]);
}

async function validateSymbol(symbol: string, scanScore: number): Promise<LiquidityData> {
  const issues: string[] = [];
  let askDepth: number | null = null;
  let absorption: number | null = null;
  let obImbalance: number | null = null;

  try {
    const output = execSync(
      `npx tsx src/liquidity-check-cli.ts ${symbol} 2>&1`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], cwd: "/Users/786212/dev/strata-trading/apps/api" }
    );

    askDepth = parseAskDepth(output);
    absorption = parseAbsorption(output);
    obImbalance = parseOBImbalance(output);
  } catch (error) {
    issues.push("Failed to fetch liquidity data");
  }

  // Check all criteria
  if (askDepth === null || askDepth < 10000) {
    issues.push(`Ask Depth: ${askDepth ? "$" + askDepth.toLocaleString() : "N/A"} (need >$10k)`);
  }

  if (absorption === null || absorption < 45) {
    issues.push(`Absorption: ${absorption ?? "N/A"} (need ≥45)`);
  }

  if (obImbalance === null || obImbalance < -40 || obImbalance > 40) {
    issues.push(`OB Imbalance: ${obImbalance?.toFixed(1) ?? "N/A"}% (need -40% to +40%)`);
  }

  if (scanScore < 65) {
    issues.push(`Scan Score: ${scanScore} (need ≥65)`);
  }

  return {
    symbol,
    askDepth,
    absorption,
    obImbalance,
    scanScore,
    passes: issues.length === 0,
    issues,
  };
}

async function main() {
  try {
    const stateJson = fs.readFileSync("/Users/786212/dev/strata-trading/apps/api/data/fast-pump-state.json", "utf8");
    const state = JSON.parse(stateJson) as FastPumpState;

    const symbols = Object.entries(state.symbols)
      .filter(([, data]) => data.inList && data.lastScore >= 55) // Focus on decent scan scores
      .map(([key]) => key.replace("-PERP", ""))
      .slice(0, 30); // Limit to avoid timeout

    console.log(`\n🔍 VALIDATING ${symbols.length} CANDIDATES FOR ENTRY\n`);
    console.log("Entry Criteria:");
    console.log("  1. Ask Depth > $10,000");
    console.log("  2. Absorption ≥ 45");
    console.log("  3. OB Imbalance -40% to +40%");
    console.log("  4. Scan Score ≥ 65");
    console.log("\n━".repeat(100));

    const results: LiquidityData[] = [];

    for (const symbol of symbols) {
      const scanScore = state.symbols[`${symbol}-PERP`]?.lastScore ?? 0;
      console.log(`Checking ${symbol}...`);
      const result = await validateSymbol(symbol, scanScore);
      results.push(result);
    }

    console.log("\n━".repeat(100));
    console.log("\n✅ QUALIFIED (All 4 criteria passed):\n");

    const qualified = results.filter((r) => r.passes);
    if (qualified.length === 0) {
      console.log("   ❌ NONE QUALIFIED — No tokens meet all entry criteria right now\n");
      console.log("🎯 RECOMMENDATION:");
      console.log("   Wait 2-3 more days for absorption to build on volume spike candidates");
      console.log("   (OCEAN, RPL, TURTLE, FOLKS, HEI are pre-pumping but not ready to trade yet)\n");
    } else {
      for (const token of qualified) {
        console.log(`   ✅ ${token.symbol}`);
        console.log(`      Ask Depth: $${(token.askDepth ?? 0).toLocaleString()} | Absorption: ${token.absorption} | OB: ${token.obImbalance?.toFixed(1)}% | Score: ${token.scanScore}`);
      }
    }

    console.log("\n⚠️  CLOSE (failed 1 criterion):\n");
    const closeCall = results.filter((r) => !r.passes && r.issues.length === 1);
    if (closeCall.length === 0) {
      console.log("   (None)\n");
    } else {
      for (const token of closeCall) {
        console.log(`   🟡 ${token.symbol}: ${token.issues[0]}`);
      }
    }

    console.log("\n❌ FAILED (2+ criteria):\n");
    const failed = results.filter((r) => !r.passes && r.issues.length >= 2);
    if (failed.length > 0) {
      for (const token of failed.slice(0, 10)) {
        console.log(`   ${token.symbol}: ${token.issues.join(" | ")}`);
      }
      if (failed.length > 10) {
        console.log(`   ... and ${failed.length - 10} more`);
      }
    }

    console.log("\n");
  } catch (error) {
    console.error("Error:", error);
  }
}

main();
