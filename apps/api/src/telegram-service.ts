import "./env.js";
import { classifyReversalPhase, type ReversalPhase } from "./reversal-phase.js";
import type { TokenRsiResult } from "./rsi.js";

type AlertStage = "READY" | "OPENED" | "CAUTION";
type EntryTiming = "EARLY" | "MID" | "LATE";
type TelegramStateSnapshot = { results: TokenRsiResult[] } | null;
type TelegramStateGetter = () => TelegramStateSnapshot;

type EntryAlertPayload = {
  stage: AlertStage;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryTiming: EntryTiming;
  reversalPhase: ReversalPhase;
  signalType: string;
  entryScore: number;
  weightedScore: number;
  signalStrength: number;
  tpFeasibility: number;
  structureConfidence: number;
  volatilityPct: number;
  takeProfitPct: number;
  stopLossPct: number;
  marketCondition: "TRENDING" | "RANGING";
};

type TelegramGetUpdatesResponse = {
  ok: boolean;
  result: Array<{
    update_id: number;
    message?: {
      chat?: { id: number };
      text?: string;
    };
  }>;
};

function resolveStringEnv(name: string, defaultValue: string): string {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }

  return raw.trim();
}

function resolveNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env ${name}: ${raw}`);
  }

  return parsed;
}

function resolveBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

const TELEGRAM_ALERTS_ENABLED = resolveBooleanEnv("TELEGRAM_ALERTS_ENABLED", false);
const TELEGRAM_BOT_TOKEN = resolveStringEnv("TELEGRAM_BOT_TOKEN", "");
const TELEGRAM_CHAT_ID = resolveStringEnv("TELEGRAM_CHAT_ID", "");
const TELEGRAM_ALERT_STAGES = resolveStringEnv("TELEGRAM_ALERT_STAGES", "READY,OPENED,CAUTION")
  .split(",")
  .map((item) => item.trim().toUpperCase())
  .filter((item) => item === "READY" || item === "OPENED" || item === "CAUTION") as AlertStage[];
const TELEGRAM_ALERT_DEDUPE_MINUTES = Math.max(1, Math.trunc(resolveNumberEnv("TELEGRAM_ALERT_DEDUPE_MINUTES", 15)));
const TELEGRAM_TOKEN_REPEAT_MINUTES = Math.max(1, Math.trunc(resolveNumberEnv("TELEGRAM_TOKEN_REPEAT_MINUTES", 180)));
const TELEGRAM_OPENED_REPEAT_MINUTES = Math.max(1, Math.trunc(resolveNumberEnv("TELEGRAM_OPENED_REPEAT_MINUTES", 30)));
const TELEGRAM_ALERT_GRAPHICS_ENABLED = resolveBooleanEnv("TELEGRAM_ALERT_GRAPHICS_ENABLED", true);
const TELEGRAM_COMMANDS_ENABLED = resolveBooleanEnv("TELEGRAM_COMMANDS_ENABLED", true);
const TELEGRAM_COMMAND_CHAT_IDS = new Set(
  resolveStringEnv("TELEGRAM_COMMAND_CHAT_IDS", "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
);

const dedupeByKey = new Map<string, number>();
const dedupeByTokenDirection = new Map<string, { sentAtMs: number; signalType: string }>();

let telegramPollingActive = false;
let telegramPollTimer: ReturnType<typeof setTimeout> | null = null;
let telegramUpdateOffset = 0;

function stageDedupeMinutes(stage: AlertStage): number {
  if (stage === "OPENED") {
    return TELEGRAM_OPENED_REPEAT_MINUTES;
  }

  return TELEGRAM_ALERT_DEDUPE_MINUTES;
}

function shouldSend(payload: EntryAlertPayload): boolean {
  if (!TELEGRAM_ALERTS_ENABLED) {
    return false;
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return false;
  }

  if (!TELEGRAM_ALERT_STAGES.includes(payload.stage)) {
    return false;
  }

  const key = `${payload.stage}:${payload.symbol}:${payload.direction}:${payload.signalType}`;
  const nowMs = Date.now();
  const previousMs = dedupeByKey.get(key) ?? 0;
  const dedupeWindowMs = stageDedupeMinutes(payload.stage) * 60 * 1000;

  if (nowMs - previousMs < dedupeWindowMs) {
    return false;
  }

  if (payload.stage !== "OPENED") {
    const tokenDirectionKey = `${payload.symbol}:${payload.direction}`;
    const previousToken = dedupeByTokenDirection.get(tokenDirectionKey);
    const currentSignalType = payload.signalType.trim().toUpperCase();
    const tokenRepeatWindowMs = TELEGRAM_TOKEN_REPEAT_MINUTES * 60 * 1000;

    if (
      previousToken &&
      nowMs - previousToken.sentAtMs < tokenRepeatWindowMs &&
      previousToken.signalType === currentSignalType
    ) {
      return false;
    }

    dedupeByTokenDirection.set(tokenDirectionKey, {
      sentAtMs: nowMs,
      signalType: currentSignalType
    });
  }

  dedupeByKey.set(key, nowMs);
  return true;
}

function toFixedSafe(value: number, digits: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return value.toFixed(digits);
}

function escapeGraphvizText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value)) {
    return "$0";
  }

  if (Math.abs(value) >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(1)}B`;
  }

  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }

  if (Math.abs(value) >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }

  return `$${value.toFixed(0)}`;
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) {
    return "$0";
  }

  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: value < 10 ? 3 : 2,
    maximumFractionDigits: value < 10 ? 3 : 2
  })}`;
}

function resolveSignalDirection(signalType: string, bias: "LONG" | "SHORT" | null): "LONG" | "SHORT" {
  if (signalType.includes("LONG")) {
    return "LONG";
  }

  if (signalType.includes("SHORT")) {
    return "SHORT";
  }

  return bias === "SHORT" ? "SHORT" : "LONG";
}

function resolveReversalPhase(row: TokenRsiResult, direction: "LONG" | "SHORT"): ReversalPhase {
  return classifyReversalPhase({
    direction,
    dailyTrend: row.timeframes.daily?.trend.direction,
    twelvehTrend: row.timeframes.twelveh?.trend.direction,
    macroTrend: row.timeframes.macro.trend.direction,
    intermediaryTrend: row.timeframes.intermediary.trend.direction,
    microTrend: row.timeframes.microTrigger.trend.direction,
    structureState: row.tradeContext.structureState
  });
}

function calculateReadiness(row: TokenRsiResult): { pct: number; label: string; color: string } {
  const ctx = row.tradeContext;
  const volScore = ctx.passedVolatility ? 25 : 0;
  const liqPct = Number.isFinite(ctx.liquidityPercentile) ? ctx.liquidityPercentile : ctx.passedLiquidity ? 100 : 0;
  const liqScore = Math.round((Math.min(liqPct, 100) / 100) * 25);
  const trendlineBoost = ctx.trendlineBreakout || ctx.trendlineBreakdown;
  const structureScore = Math.round((ctx.passedStructure ? 10 : 0) + (ctx.passedMicroTrend ? 10 : 0) + (trendlineBoost ? 5 : 0));
  const confScoreNorm = row.confluence.maxScore > 0
    ? Math.round((Math.min(row.confluence.score, row.confluence.maxScore) / row.confluence.maxScore) * 25)
    : 0;
  const total = Math.min(100, volScore + liqScore + structureScore + confScoreNorm);
  const hasSignal = row.signal.type.includes("LONG") || row.signal.type.includes("SHORT");
  const pct = hasSignal ? 100 : total;
  const color = pct >= 80 ? "#4ade80" : pct >= 50 ? "#fbbf24" : "#64748b";
  const label = hasSignal ? "Signal Active" : pct >= 80 ? "Near Entry" : pct >= 50 ? "Building" : "Watching";
  return { pct, label, color };
}

function formatTrendChip(label: string, timeframe: TokenRsiResult["timeframes"]["macro"], microTrigger: boolean = false): string {
  const dots = [
    timeframe.trend.overbought ? "OB" : null,
    timeframe.trend.oversold ? "OS" : null,
    microTrigger ? "TRG" : null
  ].filter(Boolean).join(" ");
  return `${label} ${timeframe.trend.arrow}${dots ? ` ${dots}` : ""}`;
}

function buildPanelImageUrl(payload: EntryAlertPayload): string {
  const tokenDisplay = payload.symbol.includes("-") ? payload.symbol : `${payload.symbol}-PERP`;
  const titleStage = payload.stage === "READY"
    ? "TRADE-READY"
    : payload.stage === "OPENED"
      ? "POSITION OPENED"
      : "CAUTION";
  const directionColor = payload.direction === "LONG" ? "#34d399" : "#f87171";
  const qualityColor = payload.stage === "READY" ? "#22d3ee" : payload.stage === "OPENED" ? "#fbbf24" : "#fb7185";

  const tokenLabel = escapeGraphvizText(tokenDisplay.toUpperCase());
  const signalLabel = escapeGraphvizText(payload.signalType.toUpperCase());
  const directionLabel = escapeGraphvizText(payload.direction.toUpperCase());
  const marketLabel = escapeGraphvizText(payload.marketCondition.toUpperCase());

  const dot = `digraph G {
graph [bgcolor="#07101c", rankdir=TB, pad="0.25"];
node [shape=plain];
panel [label=<
<TABLE BORDER="0" CELLBORDER="1" CELLPADDING="10" CELLSPACING="0" COLOR="#1e2a3b">
  <TR>
    <TD COLSPAN="4" BGCOLOR="#0c1728" ALIGN="LEFT">
      <FONT COLOR="#e2e8f0" POINT-SIZE="22"><B>${tokenLabel}</B></FONT>
      <FONT COLOR="#64748b" POINT-SIZE="16">  |  </FONT>
      <FONT COLOR="${directionColor}" POINT-SIZE="19"><B>${directionLabel}</B></FONT>
      <FONT COLOR="#64748b" POINT-SIZE="16">  |  </FONT>
      <FONT COLOR="#7dd3fc" POINT-SIZE="18"><B>${titleStage}</B></FONT>
      <BR/>
      <FONT COLOR="#7dd3fc" POINT-SIZE="12">SIGNAL ${signalLabel}   •   MARKET ${marketLabel}</FONT>
    </TD>
  </TR>
  <TR>
    <TD BGCOLOR="#0f1d30" ALIGN="LEFT"><FONT COLOR="#93c5fd" POINT-SIZE="11">SCORE</FONT><BR/><FONT COLOR="#f8fafc" POINT-SIZE="19"><B>${toFixedSafe(payload.entryScore, 1)}/10</B></FONT></TD>
    <TD BGCOLOR="#0f1d30" ALIGN="LEFT"><FONT COLOR="#93c5fd" POINT-SIZE="11">QUALITY</FONT><BR/><FONT COLOR="${qualityColor}" POINT-SIZE="16"><B>${titleStage}</B></FONT></TD>
    <TD BGCOLOR="#0f1d30" ALIGN="LEFT"><FONT COLOR="#93c5fd" POINT-SIZE="11">TP / SL</FONT><BR/><FONT COLOR="#f8fafc" POINT-SIZE="16"><B>${toFixedSafe(payload.takeProfitPct, 2)}% / ${toFixedSafe(payload.stopLossPct, 2)}%</B></FONT></TD>
    <TD BGCOLOR="#0f1d30" ALIGN="LEFT"><FONT COLOR="#93c5fd" POINT-SIZE="11">VOLATILITY</FONT><BR/><FONT COLOR="#f8fafc" POINT-SIZE="16"><B>${toFixedSafe(payload.volatilityPct, 2)}%</B></FONT></TD>
  </TR>
  <TR>
    <TD BGCOLOR="#132238" ALIGN="LEFT"><FONT COLOR="#93c5fd" POINT-SIZE="11">WEIGHTED</FONT><BR/><FONT COLOR="#f8fafc" POINT-SIZE="15"><B>${toFixedSafe(payload.weightedScore, 3)}</B></FONT></TD>
    <TD BGCOLOR="#132238" ALIGN="LEFT"><FONT COLOR="#93c5fd" POINT-SIZE="11">ENTRY TIMING</FONT><BR/><FONT COLOR="#f8fafc" POINT-SIZE="15"><B>${payload.entryTiming}</B></FONT></TD>
    <TD BGCOLOR="#132238" ALIGN="LEFT"><FONT COLOR="#93c5fd" POINT-SIZE="11">REVERSAL PHASE</FONT><BR/><FONT COLOR="#f8fafc" POINT-SIZE="14"><B>${payload.reversalPhase}</B></FONT></TD>
    <TD BGCOLOR="#132238" ALIGN="LEFT"><FONT COLOR="#93c5fd" POINT-SIZE="11">STRUCTURE</FONT><BR/><FONT COLOR="#f8fafc" POINT-SIZE="15"><B>${toFixedSafe(payload.structureConfidence, 3)}</B></FONT></TD>
  </TR>
</TABLE>
>];
}`;

  return `https://quickchart.io/graphviz?format=png&width=1400&height=760&graph=${encodeURIComponent(dot)}`;
}

function buildTokenStatusImageUrl(row: TokenRsiResult): string {
  const tokenDisplay = row.symbol.includes("-") ? row.symbol : `${row.symbol}-PERP`;
  const direction = resolveSignalDirection(row.signal.type, row.confluence.bias);
  const directionColor = direction === "LONG" ? "#4ade80" : "#f87171";
  const readiness = calculateReadiness(row);
  const reversalPhase = resolveReversalPhase(row, direction);
  const statusColor = row.status === "OVERBOUGHT" ? "#f59e0b" : row.status === "OVERSOLD" ? "#38bdf8" : "#94a3b8";
  const signalColor = row.signal.type.includes("LONG") ? "#4ade80" : row.signal.type.includes("SHORT") ? "#f87171" : "#94a3b8";
  const trendMap = escapeGraphvizText([
    formatTrendChip("4H", row.timeframes.macro),
    formatTrendChip("1H", row.timeframes.intermediary),
    formatTrendChip("15M", row.timeframes.microTrigger, true)
  ].join("   •   "));
  const structureLabel = `${row.tradeContext.passedStructure ? "Pass" : "Fail"} · Micro trend: ${row.tradeContext.passedMicroTrend ? "Pass" : "Fail"}`;

  const dot = `digraph G {
graph [bgcolor="#07101c", rankdir=TB, pad="0.22"];
node [shape=plain];
panel [label=<
<TABLE BORDER="0" CELLBORDER="1" CELLPADDING="10" CELLSPACING="0" COLOR="#1e2a3b">
  <TR>
    <TD BGCOLOR="#101a29" ALIGN="LEFT"><FONT COLOR="#e2e8f0" POINT-SIZE="20"><B>${escapeGraphvizText(tokenDisplay)}</B></FONT></TD>
    <TD BGCOLOR="#101a29" ALIGN="CENTER"><FONT COLOR="${statusColor}" POINT-SIZE="13"><B>${escapeGraphvizText(row.status)}</B></FONT></TD>
    <TD BGCOLOR="#101a29" ALIGN="LEFT"><FONT COLOR="#7dd3fc" POINT-SIZE="13"><B>${escapeGraphvizText(formatUsdCompact(row.volume24h))}</B></FONT><BR/><FONT COLOR="#94a3b8" POINT-SIZE="11">24H VOLUME</FONT></TD>
    <TD BGCOLOR="#101a29" ALIGN="LEFT"><FONT COLOR="#e2e8f0" POINT-SIZE="13"><B>Vol: ${escapeGraphvizText(toFixedSafe(row.volatilityPct, 2))}%</B></FONT><BR/><FONT COLOR="#94a3b8" POINT-SIZE="11">VOLATILITY</FONT></TD>
    <TD BGCOLOR="#101a29" ALIGN="LEFT"><FONT COLOR="${readiness.color}" POINT-SIZE="18"><B>${readiness.pct}%</B></FONT><BR/><FONT COLOR="#94a3b8" POINT-SIZE="11">${escapeGraphvizText(readiness.label.toUpperCase())}</FONT></TD>
    <TD BGCOLOR="#101a29" ALIGN="LEFT"><FONT COLOR="${signalColor}" POINT-SIZE="15"><B>${escapeGraphvizText(row.signal.type)}</B></FONT></TD>
    <TD BGCOLOR="#101a29" ALIGN="CENTER"><FONT COLOR="#fbbf24" POINT-SIZE="13"><B>${escapeGraphvizText(row.entryTiming ?? "N/A")}</B></FONT><BR/><FONT COLOR="#94a3b8" POINT-SIZE="11">TIMING</FONT></TD>
    <TD BGCOLOR="#101a29" ALIGN="LEFT"><FONT COLOR="#cbd5e1" POINT-SIZE="11">${trendMap}</FONT></TD>
    <TD BGCOLOR="#101a29" ALIGN="CENTER"><FONT COLOR="#fca5a5" POINT-SIZE="16"><B>${escapeGraphvizText(toFixedSafe(row.confluence.score, 1))}/10</B></FONT><BR/><FONT COLOR="#94a3b8" POINT-SIZE="11">SCORE</FONT></TD>
    <TD BGCOLOR="#101a29" ALIGN="RIGHT"><FONT COLOR="#93c5fd" POINT-SIZE="18"><B>${escapeGraphvizText(formatPrice(row.close))}</B></FONT></TD>
  </TR>
  <TR>
    <TD COLSPAN="2" BGCOLOR="#162231" ALIGN="LEFT">
      <FONT COLOR="#cbd5e1" POINT-SIZE="12"><B>MACRO (4H)</B></FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">K: ${escapeGraphvizText(toFixedSafe(row.timeframes.macro.stochK, 1))}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">D: ${escapeGraphvizText(toFixedSafe(row.timeframes.macro.stochD, 1))}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">RSI: ${escapeGraphvizText(toFixedSafe(row.timeframes.macro.rsi, 1))}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">MACD Hist: ${escapeGraphvizText(toFixedSafe(row.timeframes.macro.macdHist, 4))}</FONT>
    </TD>
    <TD COLSPAN="2" BGCOLOR="#162231" ALIGN="LEFT">
      <FONT COLOR="#cbd5e1" POINT-SIZE="12"><B>INTERMEDIARY (1H)</B></FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">K: ${escapeGraphvizText(toFixedSafe(row.timeframes.intermediary.stochK, 1))}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">D: ${escapeGraphvizText(toFixedSafe(row.timeframes.intermediary.stochD, 1))}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">RSI: ${escapeGraphvizText(toFixedSafe(row.timeframes.intermediary.rsi, 1))}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">MACD Hist: ${escapeGraphvizText(toFixedSafe(row.timeframes.intermediary.macdHist, 4))}</FONT>
    </TD>
    <TD COLSPAN="2" BGCOLOR="#162231" ALIGN="LEFT">
      <FONT COLOR="#cbd5e1" POINT-SIZE="12"><B>MICRO TRIGGER (15M)</B></FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">K: ${escapeGraphvizText(toFixedSafe(row.timeframes.microTrigger.stochK, 1))}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">D: ${escapeGraphvizText(toFixedSafe(row.timeframes.microTrigger.stochD, 1))}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">RSI: ${escapeGraphvizText(toFixedSafe(row.timeframes.microTrigger.rsi, 1))}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">Prev K/D: ${escapeGraphvizText(toFixedSafe(row.timeframes.microTrigger.prevStochK, 1))} / ${escapeGraphvizText(toFixedSafe(row.timeframes.microTrigger.prevStochD, 1))}</FONT>
    </TD>
    <TD COLSPAN="4" BGCOLOR="#162231" ALIGN="LEFT">
      <FONT COLOR="#cbd5e1" POINT-SIZE="12"><B>SUPPORT / RESISTANCE</B></FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">Entry Timing: ${escapeGraphvizText(row.entryTiming ?? "N/A")}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">Support: ${escapeGraphvizText(row.levels.localSupport.toLocaleString())}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">Resistance: ${escapeGraphvizText(row.levels.localResistance.toLocaleString())}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">Distance to Support: ${escapeGraphvizText(toFixedSafe(row.levels.supportDistancePct, 3))}%</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">Near Support Floor: ${row.levels.nearSupportFloor ? "YES" : "NO"}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">Spread: ${escapeGraphvizText(toFixedSafe(row.tradeContext.orderBookSpreadPct, 4))}%</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">Depth (${escapeGraphvizText(String(row.tradeContext.orderBookDepthBps ?? 10))}bps): ${escapeGraphvizText(formatUsdCompact(row.tradeContext.orderBookCombinedDepthUsd))}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">Imbalance: ${escapeGraphvizText(toFixedSafe(row.tradeContext.orderBookImbalance, 3))}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#e2e8f0" POINT-SIZE="11">Structure: ${escapeGraphvizText(structureLabel)}</FONT><BR ALIGN="LEFT"/>
      <FONT COLOR="#94a3b8" POINT-SIZE="10">Reversal Phase: ${escapeGraphvizText(reversalPhase)}</FONT>
    </TD>
  </TR>
</TABLE>
>];
}`;

  return `https://quickchart.io/graphviz?format=png&width=1700&height=760&graph=${encodeURIComponent(dot)}`;
}

function buildMessage(payload: EntryAlertPayload): string {
  const symbol = escapeHtml(payload.symbol);
  const signalType = escapeHtml(payload.signalType);
  const stageLabel = payload.stage === "READY"
    ? "READY SETUP"
    : payload.stage === "OPENED"
      ? "TRADE OPENED"
      : "CAUTION";
  const directionLabel = payload.direction === "LONG" ? "LONG ▲" : "SHORT ▼";
  const signalLabel = signalType.startsWith("CONTINUATION")
    ? `${payload.direction} (Continuation)`
    : signalType.startsWith("STRONG")
      ? `${payload.direction} (Strong)`
      : signalType.startsWith("REVERSAL")
        ? `${payload.direction} (Reversal)`
        : payload.direction;
  const tokenDisplay = symbol.includes("-") ? symbol : `${symbol}-PERP`;

  return [
    `<b>${tokenDisplay}</b>  <b>${directionLabel}</b>`,
    `${stageLabel} • <b>${escapeHtml(payload.marketCondition)}</b>`,
    `Signal: <b>${escapeHtml(signalLabel)}</b>`,
    `Entry Timing: <b>${escapeHtml(payload.entryTiming)}</b>`,
    `Reversal Phase: <b>${escapeHtml(payload.reversalPhase)}</b>`,
    `Score: <b>${toFixedSafe(payload.entryScore, 1)}/10</b> | Weighted: <b>${toFixedSafe(payload.weightedScore, 3)}</b>`,
    `TP/SL: <b>${toFixedSafe(payload.takeProfitPct, 3)}%</b> / <b>${toFixedSafe(payload.stopLossPct, 3)}%</b>`,
    `Vol: <b>${toFixedSafe(payload.volatilityPct, 3)}%</b> | Feasibility: <b>${toFixedSafe(payload.tpFeasibility, 3)}</b>`,
    `Axiom Bot`
  ].join("\n");
}

function buildTokenStatusCaption(row: TokenRsiResult): string {
  const readiness = calculateReadiness(row);
  const direction = resolveSignalDirection(row.signal.type, row.confluence.bias);
  const reversalPhase = resolveReversalPhase(row, direction);
  return [
    `<b>${escapeHtml(row.symbol.includes("-") ? row.symbol : `${row.symbol}-PERP`)}</b>`,
    `Signal: <b>${escapeHtml(row.signal.type)}</b>`,
    `Readiness: <b>${readiness.pct}%</b> • Entry Timing: <b>${escapeHtml(row.entryTiming ?? "N/A")}</b>`,
    `Reversal Phase: <b>${escapeHtml(reversalPhase)}</b>`,
    `Price: <b>${escapeHtml(formatPrice(row.close))}</b> • Score: <b>${escapeHtml(toFixedSafe(row.confluence.score, 1))}/10</b>`
  ].join("\n");
}

function buildTokenStatusText(row: TokenRsiResult): string {
  const readiness = calculateReadiness(row);
  const direction = resolveSignalDirection(row.signal.type, row.confluence.bias);
  const reversalPhase = resolveReversalPhase(row, direction);
  return [
    `<b>${escapeHtml(row.symbol.includes("-") ? row.symbol : `${row.symbol}-PERP`)}</b>`,
    `Status: <b>${escapeHtml(row.status)}</b> • Signal: <b>${escapeHtml(row.signal.type)}</b>`,
    `24H Volume: <b>${escapeHtml(formatUsdCompact(row.volume24h))}</b> • Volatility: <b>${escapeHtml(toFixedSafe(row.volatilityPct, 2))}%</b>`,
    `Readiness: <b>${readiness.pct}%</b> (${escapeHtml(readiness.label)}) • Score: <b>${escapeHtml(toFixedSafe(row.confluence.score, 1))}/10</b>`,
    `Entry Timing: <b>${escapeHtml(row.entryTiming ?? "N/A")}</b> • Reversal Phase: <b>${escapeHtml(reversalPhase)}</b>`,
    `4H: K ${escapeHtml(toFixedSafe(row.timeframes.macro.stochK, 1))} | D ${escapeHtml(toFixedSafe(row.timeframes.macro.stochD, 1))} | RSI ${escapeHtml(toFixedSafe(row.timeframes.macro.rsi, 1))} | MACD ${escapeHtml(toFixedSafe(row.timeframes.macro.macdHist, 4))}`,
    `1H: K ${escapeHtml(toFixedSafe(row.timeframes.intermediary.stochK, 1))} | D ${escapeHtml(toFixedSafe(row.timeframes.intermediary.stochD, 1))} | RSI ${escapeHtml(toFixedSafe(row.timeframes.intermediary.rsi, 1))} | MACD ${escapeHtml(toFixedSafe(row.timeframes.intermediary.macdHist, 4))}`,
    `15M: K ${escapeHtml(toFixedSafe(row.timeframes.microTrigger.stochK, 1))} | D ${escapeHtml(toFixedSafe(row.timeframes.microTrigger.stochD, 1))} | RSI ${escapeHtml(toFixedSafe(row.timeframes.microTrigger.rsi, 1))} | Prev ${escapeHtml(toFixedSafe(row.timeframes.microTrigger.prevStochK, 1))}/${escapeHtml(toFixedSafe(row.timeframes.microTrigger.prevStochD, 1))}`,
    `Support: <b>${escapeHtml(row.levels.localSupport.toLocaleString())}</b> • Resistance: <b>${escapeHtml(row.levels.localResistance.toLocaleString())}</b>`,
    `Distance to Support: <b>${escapeHtml(toFixedSafe(row.levels.supportDistancePct, 3))}%</b> • Near Support Floor: <b>${row.levels.nearSupportFloor ? "YES" : "NO"}</b>`,
    `Spread: <b>${escapeHtml(toFixedSafe(row.tradeContext.orderBookSpreadPct, 4))}%</b> • Depth: <b>${escapeHtml(formatUsdCompact(row.tradeContext.orderBookCombinedDepthUsd))}</b> • Imbalance: <b>${escapeHtml(toFixedSafe(row.tradeContext.orderBookImbalance, 3))}</b>`,
    `Structure: <b>${row.tradeContext.passedStructure ? "Pass" : "Fail"}</b> • Micro trend: <b>${row.tradeContext.passedMicroTrend ? "Pass" : "Fail"}</b>`
  ].join("\n");
}

async function postTelegram(endpoint: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Telegram ${endpoint} failed (${response.status}): ${responseBody}`);
  }
}

export async function sendTelegramMessage(text: string, chatId: string | number = TELEGRAM_CHAT_ID): Promise<void> {
  await postTelegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function sendTelegramPhoto(
  photoUrl: string,
  caption: string,
  chatId: string | number = TELEGRAM_CHAT_ID
): Promise<void> {
  await postTelegram("sendPhoto", {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: "HTML"
  });
}

export function notifyTelegramEntry(payload: EntryAlertPayload): void {
  if (!shouldSend(payload)) {
    return;
  }

  const text = buildMessage(payload);
  const sendPromise = TELEGRAM_ALERT_GRAPHICS_ENABLED
    ? sendTelegramPhoto(buildPanelImageUrl(payload), text)
    : sendTelegramMessage(text);

  void sendPromise.catch((error) => {
    console.error("[telegram] alert send failed", {
      stage: payload.stage,
      symbol: payload.symbol,
      direction: payload.direction,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase().replace(/-PERP$/i, "");
}

function isAllowedCommandChat(chatId: number): boolean {
  if (TELEGRAM_COMMAND_CHAT_IDS.size === 0) {
    return true;
  }

  return TELEGRAM_COMMAND_CHAT_IDS.has(String(chatId));
}

function findTokenResult(snapshot: TelegramStateSnapshot, symbol: string): TokenRsiResult | null {
  if (!snapshot) {
    return null;
  }

  const normalized = normalizeSymbol(symbol);
  return snapshot.results.find((row) => normalizeSymbol(row.symbol) === normalized) ?? null;
}

async function handleTokenCommand(chatId: number, rawText: string, getState: TelegramStateGetter): Promise<void> {
  const parts = rawText.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase() ?? "";
  if (command !== "/token" && !command.startsWith("/token@")) {
    return;
  }

  const symbol = parts[1]?.trim();
  if (!symbol) {
    await sendTelegramMessage("Usage: <b>/token NEAR</b>", chatId);
    return;
  }

  const snapshot = getState();
  if (!snapshot) {
    await sendTelegramMessage("Scanner is still warming up. No scan snapshot is available yet.", chatId);
    return;
  }

  const row = findTokenResult(snapshot, symbol);
  if (!row) {
    await sendTelegramMessage(`No current scan snapshot found for <b>${escapeHtml(normalizeSymbol(symbol))}</b>.`, chatId);
    return;
  }

  if (TELEGRAM_ALERT_GRAPHICS_ENABLED) {
    await sendTelegramPhoto(buildTokenStatusImageUrl(row), buildTokenStatusCaption(row), chatId);
    return;
  }

  await sendTelegramMessage(buildTokenStatusText(row), chatId);
}

async function fetchTelegramUpdates(): Promise<TelegramGetUpdatesResponse> {
  const params = new URLSearchParams({
    timeout: "25",
    allowed_updates: JSON.stringify(["message"])
  });

  if (telegramUpdateOffset > 0) {
    params.set("offset", String(telegramUpdateOffset));
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?${params.toString()}`);
  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Telegram getUpdates failed (${response.status}): ${responseBody}`);
  }

  return response.json() as Promise<TelegramGetUpdatesResponse>;
}

async function pollTelegramCommands(getState: TelegramStateGetter): Promise<void> {
  try {
    const payload = await fetchTelegramUpdates();
    if (!payload.ok) {
      throw new Error("Telegram getUpdates returned ok=false");
    }

    for (const update of payload.result) {
      telegramUpdateOffset = Math.max(telegramUpdateOffset, update.update_id + 1);

      const message = update.message;
      const chatId = message?.chat?.id;
      const text = message?.text?.trim();

      if (!chatId || !text) {
        continue;
      }

      if (!isAllowedCommandChat(chatId)) {
        continue;
      }

      if (!text.startsWith("/token")) {
        continue;
      }

      await handleTokenCommand(chatId, text, getState);
    }
  } catch (error) {
    console.error("[telegram] command polling failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (telegramPollingActive) {
      telegramPollTimer = setTimeout(() => {
        void pollTelegramCommands(getState);
      }, 2_000);
    }
  }
}

export function startTelegramCommandListener(getState: TelegramStateGetter): void {
  if (!TELEGRAM_COMMANDS_ENABLED || !TELEGRAM_BOT_TOKEN) {
    return;
  }

  if (telegramPollingActive) {
    return;
  }

  telegramPollingActive = true;
  console.log("Telegram command listener started (polling /token commands)");
  void pollTelegramCommands(getState);
}

export function stopTelegramCommandListener(): void {
  telegramPollingActive = false;
  if (telegramPollTimer) {
    clearTimeout(telegramPollTimer);
    telegramPollTimer = null;
  }
}
