import fs from "fs";

// Pre-pump tokens from volume analysis
const prePumpVolumes = [
  { symbol: "RPL", spike: 5.1, score: 90 },
  { symbol: "OCEAN", spike: 6.02, score: 90 },
  { symbol: "HEI", spike: 3.63, score: 90 },
  { symbol: "TURTLE", spike: 4.77, score: 90 },
  { symbol: "FOLKS", spike: 3.94, score: 90 },
  { symbol: "1000FLOKI", spike: 2.86, score: 86 },
  { symbol: "SHDW", spike: 2.26, score: 71 },
  { symbol: "CKB", spike: 2.18, score: 69 },
  { symbol: "JITOSOL", spike: 2.15, score: 68 },
  { symbol: "UP", spike: 2.05, score: 66 },
  { symbol: "TLM", spike: 1.89, score: 62 },
  { symbol: "ASTR", spike: 1.82, score: 60 },
];

// Load current fast-pump scan state
let scanState: any = {};
try {
  const stateJson = fs.readFileSync("./data/fast-pump-state.json", "utf8");
  scanState = JSON.parse(stateJson);
} catch (e) {
  console.log("⚠️ Could not load scan state, proceeding with volume analysis only\n");
}

console.log("🚀 PRE-PUMP VOLUME + SCAN ANALYSIS\n");
console.log("━".repeat(120));
console.log("Symbol\t\tVol Spike\tPre-Pump Score\tCurrent Scan Score\tVB1h\tStatus");
console.log("━".repeat(120));

const enhanced = prePumpVolumes.map((vol) => {
  const scanKey = `${vol.symbol}-PERP`;
  const scanData = scanState.symbols?.[scanKey];
  const scanScore = scanData?.lastScore ?? "N/A";
  const vb1h = scanData?.lastVb1h ?? "N/A";
  const status =
    scanScore >= 60
      ? "🟢 READY"
      : scanScore >= 50
      ? "🟡 WATCH"
      : scanScore > 0
      ? "🔴 WEAK"
      : "⚪ NO DATA";

  return {
    ...vol,
    scanScore,
    vb1h,
    status,
  };
});

// Display sorted by combined signal strength
enhanced.sort((a, b) => {
  const aScore =
    (typeof a.scanScore === "number" ? a.scanScore : 0) + a.spike * 10;
  const bScore =
    (typeof b.scanScore === "number" ? b.scanScore : 0) + b.spike * 10;
  return bScore - aScore;
});

for (const token of enhanced) {
  const scanScoreStr =
    typeof token.scanScore === "number"
      ? token.scanScore.toString()
      : token.scanScore;
  const vb1hStr = typeof token.vb1h === "number" ? token.vb1h.toFixed(2) : token.vb1h;

  console.log(
    `${token.symbol}\t\t${token.spike.toFixed(2)}x\t\t${token.score}\t\t${scanScoreStr}\t\t${vb1hStr}\t${token.status}`
  );
}

console.log("\n📊 INTERPRETATION\n");
console.log("🟢 GREEN (Ready to Buy):");
const green = enhanced.filter(
  (t) => typeof t.scanScore === "number" && t.scanScore >= 60 && t.spike >= 2
);
if (green.length > 0) {
  for (const t of green) {
    console.log(
      `   ✅ ${t.symbol}: ${t.spike.toFixed(2)}x volume spike + scan score ${t.scanScore} = HIGH PROBABILITY`
    );
  }
} else {
  console.log("   (None currently - volume early, wait for scan to confirm)");
}

console.log("\n🟡 YELLOW (Watch List):");
const yellow = enhanced.filter(
  (t) =>
    (typeof t.scanScore === "number" ? t.scanScore : 0) >= 50 &&
    t.spike >= 1.5
);
if (yellow.length > 0) {
  for (const t of yellow) {
    console.log(
      `   ⏳ ${t.symbol}: ${t.spike.toFixed(2)}x volume + scan ${t.scanScore || "building"}`
    );
  }
} else {
  console.log("   (None - continue monitoring)");
}

console.log("\n🎯 KEY INSIGHTS\n");
console.log("1. These tokens have VOLUME SPIKES 5-10 days before price moves");
console.log("2. Combine with scan score ≥60 for entry confirmation");
console.log("3. Volume momentum (UP trend) is the LEADING indicator");
console.log("4. Price hasn't moved much yet - still EARLY STAGE\n");

console.log("⚡ RECOMMENDED ACTION:");
console.log("   1. Watch these tokens for scan confirmations next 3-5 days");
console.log("   2. When scan score hits 60+, volume spike confirms entry");
console.log("   3. Similar to TLM/HOT pattern - early volume = early profit\n");
