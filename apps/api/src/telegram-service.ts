import "./env.js";
import { fetchBitunixAccountSnapshot, fetchBitunixPendingTpslOrders } from "./bitunix-service.js";
import { classifyReversalPhase, type ReversalPhase } from "./reversal-phase.js";
import type { TokenRsiResult } from "./rsi.js";
import { getCurrentTpSlPercentages } from "./strategy-config.js";
import { addWatchSymbol, listWatchSymbols, removeWatchSymbol } from "./telegram-watchlist-prisma.js";
import { getTokenName } from "./token-metadata.js";
import { getTradeRejectionLog, type TradeRejectionEntry } from "./trade-rejection-log.js";
import {
  addManualWatchSymbol,
  listManualWatchSymbols,
  removeManualWatchSymbol,
  serializeManualWatchSymbols
} from "./live-manual-position-watch.js";
import { recordTelegramAlertSent, wasTelegramAlertRecentlySent } from "./telegram-alert-prisma.js";
import { updateRuntimeSettings } from "./runtime-settings.js";
import { isLiveTradingEnabled, setLiveTradingEnabled } from "./live-trading-switch.js";
import { runPrePumpScan, formatPrePumpScanTelegram } from "./pre-pump-scan.js";

type AlertStage = "READY" | "OPENED" | "CLOSED" | "CAUTION";
type EntryTiming = "EARLY" | "MID" | "LATE";
type TelegramStateSnapshot = {
  results: TokenRsiResult[];
  analyzedAt?: string;
  service?: {
    lastSignalScanAt?: string;
  };
  tradeSimulation?: {
    stats?: {
      totalTrades?: number;
      activeTrades?: number;
      wins?: number;
      losses?: number;
      winRate?: number;
      accountBalanceUsd?: number;
      equityUsd?: number;
      unrealizedPnlUsd?: number;
    };
    activeTrades?: Array<{
      token?: string;
      direction?: "LONG" | "SHORT";
      signalType?: string;
      entryPrice?: number;
      tpPrice?: number;
      slPrice?: number;
      takeProfitPct?: number;
      stopLossPct?: number;
      currentPnlPct?: number;
      openTime?: string;
      status?: string;
    }>;
    recentClosedTrades?: Array<{
      token?: string;
      direction?: "LONG" | "SHORT";
      signalType?: string;
      closeReason?: string;
      result?: number;
      resultUsd?: number;
      entryPrice?: number;
      tpPrice?: number;
      slPrice?: number;
      closeTime?: string;
      timeToClose?: number;
    }>;
  };
} | null;
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
  asOf?: string;
  entryPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  closeReason?: string;
  resultPct?: number;
  resultUsd?: number;
  marketStatus?: "OVERBOUGHT" | "OVERSOLD" | "NEUTRAL";
  setupConflictNote?: string;
  dedupeKey?: string;
};

type RecentReadySignal = {
  symbol: string;
  direction: "LONG" | "SHORT";
  signalType: string;
  entryTiming: EntryTiming;
  reversalPhase: ReversalPhase;
  entryScore: number;
  weightedScore: number;
  tpFeasibility: number;
  sentAt: string;
  sentAtMs: number;
};

type TokenStatusContext = {
  snapshotAsOf: string | null;
  recentReady: RecentReadySignal | null;
  recentAlert: RecentAlertSignal | null;
};

type RecentCautionSignal = {
  symbol: string;
  direction: "LONG" | "SHORT";
  signalType: string;
  sentAt: string;
  sentAtMs: number;
};

type RecentAlertSignal = {
  symbol: string;
  stage: AlertStage;
  direction: "LONG" | "SHORT";
  signalType: string;
  sentAt: string;
  sentAtMs: number;
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
const TELEGRAM_ALERT_STAGES = resolveStringEnv("TELEGRAM_ALERT_STAGES", "READY,OPENED,CLOSED,CAUTION")
  .split(",")
  .map((item) => item.trim().toUpperCase())
  .filter((item) => item === "READY" || item === "OPENED" || item === "CLOSED" || item === "CAUTION") as AlertStage[];
const TELEGRAM_ALERT_DEDUPE_MINUTES = Math.max(1, Math.trunc(resolveNumberEnv("TELEGRAM_ALERT_DEDUPE_MINUTES", 15)));
const TELEGRAM_RATE_LIMIT_CAUTION_DEDUPE_MINUTES = Math.max(
  TELEGRAM_ALERT_DEDUPE_MINUTES,
  Math.trunc(resolveNumberEnv("TELEGRAM_RATE_LIMIT_CAUTION_DEDUPE_MINUTES", 15))
);
const TELEGRAM_TOKEN_REPEAT_MINUTES = Math.max(1, Math.trunc(resolveNumberEnv("TELEGRAM_TOKEN_REPEAT_MINUTES", 180)));
const TELEGRAM_OPENED_REPEAT_MINUTES = Math.max(1, Math.trunc(resolveNumberEnv("TELEGRAM_OPENED_REPEAT_MINUTES", 30)));
// Alert images are always-on: graphics toggle was removed to keep Telegram alerts visually consistent.
const TELEGRAM_ALERT_GRAPHICS_ENABLED = true;
const TELEGRAM_COMMANDS_ENABLED = resolveBooleanEnv("TELEGRAM_COMMANDS_ENABLED", true);
const TELEGRAM_RECENT_READY_WINDOW_MS = TELEGRAM_TOKEN_REPEAT_MINUTES * 60 * 1000;
const TELEGRAM_RECENT_CAUTION_WINDOW_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_TOKEN_ALERT_MATCH_WINDOW_MS = Math.max(10, Math.trunc(resolveNumberEnv("TELEGRAM_TOKEN_ALERT_MATCH_WINDOW_SECONDS", 180))) * 1000;
const TELEGRAM_COMMAND_CHAT_IDS = new Set(
  resolveStringEnv("TELEGRAM_COMMAND_CHAT_IDS", "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
);
const LIQUIDITY_HUNT_SWEEP_BUFFER_PCT = 0.25;
const TELEGRAM_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
  timeZoneName: "short"
});
const PROGRESS_FALLBACK_MARGIN_COIN = resolveStringEnv("LIVE_BITUNIX_MARGIN_COIN", "USDT").toUpperCase();
const PROGRESS_FALLBACK_DEFAULT_TP_PCT = 2;
const PROGRESS_FALLBACK_DEFAULT_SL_PCT = 1.5;

const dedupeByKey = new Map<string, number>();
const dedupeByTokenDirection = new Map<string, { sentAtMs: number; signalType: string }>();
const rateLimitCautionDedupeByKey = new Map<string, number>();
const recentReadyBySymbol = new Map<string, RecentReadySignal>();
const recentCautionBySymbol = new Map<string, RecentCautionSignal>();
const recentAlertBySymbol = new Map<string, RecentAlertSignal>();

let runtimeAlertsEnabled = true;
let runtimeMutedUntilMs = 0;
let runtimeAlertStages = new Set<AlertStage>(TELEGRAM_ALERT_STAGES);

let telegramPollingActive = false;
let telegramPollTimer: ReturnType<typeof setTimeout> | null = null;
let telegramUpdateOffset = 0;

function stageDedupeMinutes(stage: AlertStage): number {
  if (stage === "OPENED") {
    return TELEGRAM_OPENED_REPEAT_MINUTES;
  }

  return TELEGRAM_ALERT_DEDUPE_MINUTES;
}

function isExchangeRateLimitCaution(payload: EntryAlertPayload): boolean {
  if (payload.stage !== "CAUTION") {
    return false;
  }

  const signal = payload.signalType.trim().toUpperCase();
  const note = payload.setupConflictNote?.trim().toUpperCase() ?? "";
  return signal.startsWith("LIVE_EXECUTION_") && note.includes("REQUEST TOO FREQUENTLY");
}

async function shouldSend(payload: EntryAlertPayload): Promise<boolean> {
  if (!TELEGRAM_ALERTS_ENABLED) {
    return false;
  }

  if (!runtimeAlertsEnabled) {
    return false;
  }

  if (Date.now() < runtimeMutedUntilMs) {
    return false;
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return false;
  }

  if (!runtimeAlertStages.has(payload.stage)) {
    return false;
  }

  const key = payload.dedupeKey ?? `${payload.stage}:${payload.symbol}:${payload.direction}:${payload.signalType}`;
  const nowMs = Date.now();

  if (isExchangeRateLimitCaution(payload)) {
    const rateLimitKey = `RATE_LIMIT:${payload.signalType.trim().toUpperCase()}`;
    const previousRateLimitMs = rateLimitCautionDedupeByKey.get(rateLimitKey) ?? 0;
    const rateLimitWindowMs = TELEGRAM_RATE_LIMIT_CAUTION_DEDUPE_MINUTES * 60 * 1000;
    if (nowMs - previousRateLimitMs < rateLimitWindowMs) {
      return false;
    }

    rateLimitCautionDedupeByKey.set(rateLimitKey, nowMs);
  }

  const previousMs = dedupeByKey.get(key) ?? 0;
  const dedupeWindowMs = stageDedupeMinutes(payload.stage) * 60 * 1000;

  if (nowMs - previousMs < dedupeWindowMs) {
    return false;
  }

  if (payload.stage === "READY" || payload.stage === "CAUTION") {
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
  }

  const persisted = await wasTelegramAlertRecentlySent(
    {
      dedupeKey: key,
      stage: payload.stage,
      symbol: payload.symbol,
      direction: payload.direction,
      signalType: payload.signalType.trim().toUpperCase()
    },
    {
      dedupeWindowMs,
      tokenRepeatWindowMs: TELEGRAM_TOKEN_REPEAT_MINUTES * 60 * 1000
    }
  );

  if (persisted.duplicateKey || persisted.duplicateTokenDirection) {
    return false;
  }

  if (payload.stage === "READY" || payload.stage === "CAUTION") {
    const tokenDirectionKey = `${payload.symbol}:${payload.direction}`;
    dedupeByTokenDirection.set(tokenDirectionKey, {
      sentAtMs: nowMs,
      signalType: payload.signalType.trim().toUpperCase()
    });
  }

  dedupeByKey.set(key, nowMs);
  return true;
}

function formatIsoCompact(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return "N/A";
  }

  return TELEGRAM_TIMESTAMP_FORMATTER.format(new Date(ms));
}

function rememberRecentReady(payload: EntryAlertPayload, sentAtMs: number): void {
  if (payload.stage !== "READY") {
    return;
  }

  const key = normalizeSymbol(payload.symbol);
  recentReadyBySymbol.set(key, {
    symbol: payload.symbol,
    direction: payload.direction,
    signalType: payload.signalType,
    entryTiming: payload.entryTiming,
    reversalPhase: payload.reversalPhase,
    entryScore: payload.entryScore,
    weightedScore: payload.weightedScore,
    tpFeasibility: payload.tpFeasibility,
    sentAt: payload.asOf ?? new Date(sentAtMs).toISOString(),
    sentAtMs
  });
}

function rememberRecentCaution(payload: EntryAlertPayload, sentAtMs: number): void {
  if (payload.stage !== "CAUTION") {
    return;
  }

  const key = normalizeSymbol(payload.symbol);
  recentCautionBySymbol.set(key, {
    symbol: payload.symbol,
    direction: payload.direction,
    signalType: payload.signalType,
    sentAt: payload.asOf ?? new Date(sentAtMs).toISOString(),
    sentAtMs
  });
}

function rememberRecentAlert(payload: EntryAlertPayload, sentAtMs: number): void {
  if (payload.stage === "CLOSED") {
    return;
  }

  const key = normalizeSymbol(payload.symbol);
  recentAlertBySymbol.set(key, {
    symbol: payload.symbol,
    stage: payload.stage,
    direction: payload.direction,
    signalType: payload.signalType,
    sentAt: payload.asOf ?? new Date(sentAtMs).toISOString(),
    sentAtMs
  });
}

function getRecentReady(symbol: string): RecentReadySignal | null {
  const key = normalizeSymbol(symbol);
  const cached = recentReadyBySymbol.get(key);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.sentAtMs > TELEGRAM_RECENT_READY_WINDOW_MS) {
    recentReadyBySymbol.delete(key);
    return null;
  }

  return cached;
}

function getRecentCaution(symbol: string): RecentCautionSignal | null {
  const key = normalizeSymbol(symbol);
  const cached = recentCautionBySymbol.get(key);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.sentAtMs > TELEGRAM_RECENT_CAUTION_WINDOW_MS) {
    recentCautionBySymbol.delete(key);
    return null;
  }

  return cached;
}

function getRecentAlert(symbol: string): RecentAlertSignal | null {
  const key = normalizeSymbol(symbol);
  const cached = recentAlertBySymbol.get(key);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.sentAtMs > TELEGRAM_TOKEN_ALERT_MATCH_WINDOW_MS) {
    recentAlertBySymbol.delete(key);
    return null;
  }

  return cached;
}

function listRecentCautions(limit = 8): RecentCautionSignal[] {
  const nowMs = Date.now();
  const all = [...recentCautionBySymbol.values()].filter((item) => nowMs - item.sentAtMs <= TELEGRAM_RECENT_CAUTION_WINDOW_MS);
  all.sort((a, b) => b.sentAtMs - a.sentAtMs);
  return all.slice(0, Math.max(1, limit));
}

function formatDirectionSignal(signalType: string): string {
  const upper = signalType.toUpperCase();
  if (upper.includes("LONG")) {
    return "LONG";
  }
  if (upper.includes("SHORT")) {
    return "SHORT";
  }
  return "NEUTRAL";
}

function resolveSnapshotAsOf(snapshot: TelegramStateSnapshot): string | null {
  if (!snapshot) {
    return null;
  }

  return snapshot.service?.lastSignalScanAt ?? snapshot.analyzedAt ?? null;
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

function formatUsdAmount(value: number): string {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
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

function resolveSetupConflictNoteFromPayload(payload: EntryAlertPayload): string | null {
  if (payload.setupConflictNote && payload.setupConflictNote.trim().length > 0) {
    return payload.setupConflictNote.trim();
  }

  if (!payload.marketStatus) {
    return null;
  }

  if (payload.direction === "LONG" && payload.marketStatus === "OVERBOUGHT") {
    return "Overbought vs long reversal: setup is contested";
  }

  if (payload.direction === "SHORT" && payload.marketStatus === "OVERSOLD") {
    return "Oversold vs short reversal: setup is contested";
  }

  return null;
}

function isLiveExecutionFailureCaution(payload: EntryAlertPayload): boolean {
  if (payload.stage !== "CAUTION") {
    return false;
  }

  const signal = payload.signalType.trim().toUpperCase();
  if (signal.startsWith("LIVE_EXECUTION_")) {
    return true;
  }

  const note = payload.setupConflictNote?.trim().toUpperCase() ?? "";
  return note.includes("LIVE OPEN FAILED") || note.includes("LIVE CLOSE FAILED");
}

function resolveSetupConflictNoteFromRow(row: TokenRsiResult, direction: "LONG" | "SHORT"): string | null {
  if (direction === "LONG" && row.status === "OVERBOUGHT") {
    return "Overbought vs long reversal: setup is contested";
  }

  if (direction === "SHORT" && row.status === "OVERSOLD") {
    return "Oversold vs short reversal: setup is contested";
  }

  return null;
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

function calculatePrePumpProximity(row: TokenRsiResult): {
  score: number;
  label: "NEAR" | "BUILDING" | "WATCH";
} {
  const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
  const hasDirectionalSignal = row.signal.type.includes("LONG") || row.signal.type.includes("SHORT");
  if (hasDirectionalSignal) {
    return { score: 0, label: "WATCH" };
  }

  const volPctile = Number(row.tradeContext?.volatilityPercentile ?? 0);
  const volScore = clamp01(volPctile / 100);

  const volume24h = Number(row.volume24h ?? 0);
  const lowLiquidityBias = volume24h > 0 ? clamp01(1 - Math.min(volume24h, 80_000_000) / 80_000_000) : 0;

  const intermediaryRsi = Number(row.timeframes.intermediary?.rsi ?? 50);
  const rsiInsideRange = intermediaryRsi >= 55 && intermediaryRsi <= 78;
  const rsiCenterDistance = Math.abs(intermediaryRsi - 64);
  const rsiScore = rsiInsideRange ? clamp01(1 - rsiCenterDistance / 24) : 0;

  const emaSlope = Number(row.tradeContext?.emaSlope ?? 0);
  const trendScore = emaSlope > 0 ? clamp01(0.5 + Math.min(emaSlope, 0.8) / 1.6) : 0;

  const inter = row.timeframes.intermediary;
  const stochUp = Number(inter?.stochK ?? 0) > Number(inter?.stochD ?? 0)
    || Number(inter?.stochK ?? 0) > Number(inter?.prevStochK ?? 0);
  const stochScore = stochUp ? 1 : 0.35;

  const structureScore = row.tradeContext?.passedStructure ? 1 : 0.5;

  const weighted = clamp01(
    volScore * 0.24
    + lowLiquidityBias * 0.2
    + rsiScore * 0.24
    + trendScore * 0.16
    + stochScore * 0.1
    + structureScore * 0.06
  );

  const score = Math.round(weighted * 100);
  const label = score >= 72 ? "NEAR" : score >= 58 ? "BUILDING" : "WATCH";
  return { score, label };
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
  const panelBase = payload.symbol.trim().toUpperCase().replace(/-PERP$/i, "").replace(/-USDT-SWAP$/i, "").replace(/-USDT$/i, "");
  const panelTokenName = getTokenName(panelBase);
  const isLimitStagedReady =
    payload.stage === "READY" && payload.signalType.toUpperCase().startsWith("LIQUIDITY_HUNT_LIMIT_CREATED");
  const titleStage = payload.stage === "READY"
    ? (isLimitStagedReady ? "LIMIT STAGED" : "ENTER NOW")
    : payload.stage === "OPENED"
      ? "POSITION OPENED"
      : payload.stage === "CLOSED"
        ? "TRADE CLOSED"
        : "CAUTION";
  const directionColor = payload.direction === "LONG" ? "#34d399" : "#f87171";
  const qualityColor = payload.stage === "READY" ? "#22d3ee" : payload.stage === "OPENED" ? "#fbbf24" : "#fb7185";

  const tokenLabel = escapeGraphvizText(panelBase);
  const tokenNameLabel = escapeGraphvizText(panelTokenName);
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
      <FONT COLOR="#e2e8f0" POINT-SIZE="22"><B>${tokenLabel}</B></FONT><FONT COLOR="#94a3b8" POINT-SIZE="14">  ${tokenNameLabel}</FONT>
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

function buildTokenStatusImageUrl(row: TokenRsiResult, signalTypeOverride?: string): string {
  const tokenDisplay = row.symbol.includes("-") ? row.symbol : `${row.symbol}-PERP`;
  const displaySignalType = signalTypeOverride ?? row.signal.type;
  const direction = resolveSignalDirection(displaySignalType, row.confluence.bias);
  const directionColor = direction === "LONG" ? "#4ade80" : "#f87171";
  const readiness = calculateReadiness(row);
  const reversalPhase = resolveReversalPhase(row, direction);
  const statusColor = row.status === "OVERBOUGHT" ? "#f59e0b" : row.status === "OVERSOLD" ? "#38bdf8" : "#94a3b8";
  const signalColor = displaySignalType.includes("LONG") ? "#4ade80" : displaySignalType.includes("SHORT") ? "#f87171" : "#94a3b8";
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
    <TD BGCOLOR="#101a29" ALIGN="LEFT"><FONT COLOR="${signalColor}" POINT-SIZE="15"><B>${escapeGraphvizText(displaySignalType)}</B></FONT></TD>
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
  if (payload.stage === "OPENED") {
    return buildOpenedTradeMessage(payload);
  }

  if (isLiveExecutionFailureCaution(payload)) {
    const baseSymbol = payload.symbol.trim().toUpperCase().replace(/-PERP$/i, "").replace(/-USDT-SWAP$/i, "").replace(/-USDT$/i, "");
    const tokenDisplay = `${escapeHtml(baseSymbol)} · ${escapeHtml(getTokenName(baseSymbol))}`;
    const directionLabel = payload.direction === "LONG" ? "LONG ▲" : "SHORT ▼";
    const setupConflictNote = resolveSetupConflictNoteFromPayload(payload) ?? "Live execution failure";
    const lines = [
      `<b>${tokenDisplay}</b>  <b>${directionLabel}</b>`,
      `CAUTION • <b>LIVE EXECUTION RETRY</b>`,
      `As Of: <b>${escapeHtml(formatIsoCompact(payload.asOf ?? new Date().toISOString()))}</b>`,
      `Signal: <b>${escapeHtml(payload.signalType)}</b>`,
      `Reason: <b>${escapeHtml(setupConflictNote)}</b>`,
      "Action: <b>No order placed. Bot will retry on next cycle.</b>"
    ];

    if (Number.isFinite(payload.entryPrice)) {
      lines.push(`Mark: <b>${escapeHtml(formatPrice(Number(payload.entryPrice)))}</b>`);
    }

    lines.push("Ciphora Bot");
    return lines.join("\n");
  }

  const symbol = escapeHtml(payload.symbol);
  const signalType = escapeHtml(payload.signalType);
  const isLimitStagedReady =
    payload.stage === "READY" && payload.signalType.toUpperCase().startsWith("LIQUIDITY_HUNT_LIMIT_CREATED");
  const stageLabel = payload.stage === "READY"
    ? (isLimitStagedReady ? "LIMIT STAGED (WAITING FILL)" : "ENTER NOW")
    : payload.stage === "CLOSED"
        ? "TRADE CLOSED"
        : "CAUTION";
  const directionLabel = payload.direction === "LONG" ? "LONG ▲" : "SHORT ▼";
  const signalLabel = signalType.startsWith("CONTINUATION")
    ? `${payload.direction} (Continuation)`
    : signalType.startsWith("STRONG")
      ? `${payload.direction} (Strong)`
      : signalType.startsWith("REVERSAL")
        ? `${payload.direction} (Reversal)`
        : signalType.startsWith("PRE_PUMP_WATCH")
          ? `${payload.direction} (Pre-pump watch)`
        : payload.direction;
  const baseSymbol = payload.symbol.trim().toUpperCase().replace(/-PERP$/i, "").replace(/-USDT-SWAP$/i, "").replace(/-USDT$/i, "");
  const tokenDisplay = `${escapeHtml(baseSymbol)} · ${escapeHtml(getTokenName(baseSymbol))}`;
  const setupConflictNote = resolveSetupConflictNoteFromPayload(payload);

  const lines = [
    `<b>${tokenDisplay}</b>  <b>${directionLabel}</b>`,
    `${stageLabel} • <b>${escapeHtml(payload.marketCondition)}</b>`,
    `As Of: <b>${escapeHtml(formatIsoCompact(payload.asOf ?? new Date().toISOString()))}</b>`,
    `Signal: <b>${escapeHtml(signalLabel)}</b>`,
    `Entry Timing: <b>${escapeHtml(payload.entryTiming)}</b>`,
    `Reversal Phase: <b>${escapeHtml(payload.reversalPhase)}</b>`,
    `Score: <b>${toFixedSafe(payload.entryScore, 1)}/10</b> | Weighted: <b>${toFixedSafe(payload.weightedScore, 3)}</b>`,
    `TP/SL: <b>${toFixedSafe(payload.takeProfitPct, 3)}%</b> / <b>${toFixedSafe(payload.stopLossPct, 3)}%</b>`,
    `Vol: <b>${toFixedSafe(payload.volatilityPct, 3)}%</b> | Feasibility: <b>${toFixedSafe(payload.tpFeasibility, 3)}</b>`,
  ];

  if (setupConflictNote) {
    lines.push(`Risk: <b>${escapeHtml(setupConflictNote)}</b>`);
  }

  if (isLimitStagedReady) {
    lines.push("Status: <b>Order created only. Position opens after exchange fill.</b>");
  }

  if (Number.isFinite(payload.entryPrice)) {
    lines.push(`Entry: <b>${escapeHtml(formatPrice(Number(payload.entryPrice)))}</b>`);
  }
  if (Number.isFinite(payload.tpPrice) || Number.isFinite(payload.slPrice)) {
    lines.push(
      `Targets: TP <b>${escapeHtml(formatPrice(Number(payload.tpPrice ?? 0)))}</b> / SL <b>${escapeHtml(formatPrice(Number(payload.slPrice ?? 0)))}</b>`
    );
  }
  if (payload.stage === "CLOSED") {
    const resultPct = Number(payload.resultPct ?? 0);
    const resultUsd = Number(payload.resultUsd ?? 0);
    const pnlLabel = resultPct >= 0 ? "PROFIT" : "LOSS";
    const pctPrefix = resultPct >= 0 ? "+" : "";
    const usdPrefix = resultUsd >= 0 ? "+" : "";

    lines.push(
      `Close: <b>${escapeHtml(payload.closeReason ?? "CLOSE")}</b>`,
      `P/L: <b>${escapeHtml(pnlLabel)}</b> • <b>${pctPrefix}${toFixedSafe(resultPct, 2)}%</b> • <b>${usdPrefix}${toFixedSafe(resultUsd, 2)} USD</b>`
    );
  }

  lines.push("Ciphora Bot");
  return lines.join("\n");
}

function buildOpenedTradeMessage(payload: EntryAlertPayload): string {
  const baseSymbol = payload.symbol.trim().toUpperCase().replace(/-PERP$/i, "").replace(/-USDT-SWAP$/i, "").replace(/-USDT$/i, "");
  const tokenName = getTokenName(baseSymbol);
  const directionArrow = payload.direction === "LONG" ? "▲" : "▼";
  const entry = Number.isFinite(payload.entryPrice) ? formatPrice(Number(payload.entryPrice)) : "N/A";
  const tp = Number.isFinite(payload.tpPrice) ? formatPrice(Number(payload.tpPrice)) : "N/A";
  const sl = Number.isFinite(payload.slPrice) ? formatPrice(Number(payload.slPrice)) : "N/A";
  const setupConflictNote = resolveSetupConflictNoteFromPayload(payload);

  const lines = [
    `<b>${escapeHtml(baseSymbol)} · ${escapeHtml(tokenName)}  ${escapeHtml(payload.direction)} ${directionArrow}</b>`,
    `<b>OPEN</b> • ${escapeHtml(payload.marketCondition)} • ${escapeHtml(payload.signalType)}`,
    "",
    `<b>Entry</b> ${escapeHtml(entry)}`,
    `<b>TP / SL</b> ${escapeHtml(tp)} / ${escapeHtml(sl)}`,
    `<b>TP% / SL%</b> ${toFixedSafe(payload.takeProfitPct, 3)}% / ${toFixedSafe(payload.stopLossPct, 3)}%`,
    `<b>Score</b> ${toFixedSafe(payload.entryScore, 1)}/10 • W ${toFixedSafe(payload.weightedScore, 3)}`,
    `<b>Timing</b> ${escapeHtml(payload.entryTiming)} • <b>Phase</b> ${escapeHtml(payload.reversalPhase)}`,
    `<b>Vol</b> ${toFixedSafe(payload.volatilityPct, 3)}% • <b>Feasibility</b> ${toFixedSafe(payload.tpFeasibility, 3)}`,
    `<b>As Of</b> ${escapeHtml(formatIsoCompact(payload.asOf ?? new Date().toISOString()))}`,
    "Ciphora Bot"
  ];

  if (setupConflictNote) {
    lines.splice(lines.length - 1, 0, `<b>Risk</b> ${escapeHtml(setupConflictNote)}`);
  }

  return lines.join("\n");
}

async function handleOpenCommand(chatId: number, getState: TelegramStateGetter): Promise<void> {
  const snapshot = getState();
  const active = snapshot?.tradeSimulation?.activeTrades ?? [];

  if (!Array.isArray(active) || active.length === 0) {
    await sendTelegramMessage("No active simulated trades right now.", chatId);
    return;
  }

  const lines = ["<b>Open Simulated Trades</b>"];
  for (const trade of active) {
    const token = escapeHtml(String(trade.token ?? "UNKNOWN"));
    const direction = escapeHtml(String(trade.direction ?? "N/A"));
    const entry = Number.isFinite(trade.entryPrice) ? formatPrice(Number(trade.entryPrice)) : "$0";
    const tp = Number.isFinite(trade.tpPrice) ? formatPrice(Number(trade.tpPrice)) : "$0";
    const sl = Number.isFinite(trade.slPrice) ? formatPrice(Number(trade.slPrice)) : "$0";
    const pnl = Number.isFinite(trade.currentPnlPct) ? toFixedSafe(Number(trade.currentPnlPct), 2) : "0.00";
    lines.push(`${token} ${direction} • Entry ${escapeHtml(entry)} • TP ${escapeHtml(tp)} / SL ${escapeHtml(sl)} • PnL ${pnl}%`);
  }

  await sendTelegramMessage(lines.join("\n"), chatId);
}

function normalizeTradeDirection(raw: unknown): "LONG" | "SHORT" {
  return String(raw ?? "").toUpperCase() === "LONG" ? "LONG" : "SHORT";
}

function normalizeProgressSymbol(raw: string | undefined): string {
  const upper = String(raw ?? "").trim().toUpperCase();
  if (!upper) {
    return "";
  }

  if (upper.endsWith("-PERP")) {
    return upper.slice(0, -5);
  }
  if (upper.endsWith("USDT")) {
    return upper.slice(0, -4);
  }

  return upper;
}

function formatProgressLine(trade: {
  token?: string;
  direction?: "LONG" | "SHORT";
  currentPnlPct?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  signalType?: string;
}): string {
  const token = escapeHtml(String(trade.token ?? "UNKNOWN"));
  const direction = normalizeTradeDirection(trade.direction);
  const currentPnlPct = Number(trade.currentPnlPct ?? 0);
  const takeProfitPct = Math.max(0.0001, Math.abs(Number(trade.takeProfitPct ?? 0)));
  const stopLossPct = Math.max(0, Math.abs(Number(trade.stopLossPct ?? 0)));
  const completionPctRaw = takeProfitPct > 0 ? (currentPnlPct / takeProfitPct) * 100 : 0;
  const completionPct = Math.max(-250, Math.min(250, completionPctRaw));
  const pnlPrefix = currentPnlPct > 0 ? "+" : "";
  const completionSuffix = Math.abs(completionPctRaw) > 250 ? " (capped)" : "";

  return [
    `<b>${token} ${escapeHtml(direction)}</b>`,
    `ROE: <b>${pnlPrefix}${toFixedSafe(currentPnlPct, 2)}%</b>`,
    `TP Goal (ROE): <b>${toFixedSafe(takeProfitPct, 2)}%</b> • SL (ROE): <b>${toFixedSafe(stopLossPct, 2)}%</b>`,
    `Progress To TP: <b>${toFixedSafe(completionPct, 1)}%${completionSuffix}</b>`,
    `Signal: <b>${escapeHtml(String(trade.signalType ?? "N/A"))}</b>`
  ].join("\n");
}

function buildProgressImageUrl(input: {
  heading: string;
  sourceLabel?: string;
  trades: Array<{
    token?: string;
    direction?: "LONG" | "SHORT";
    currentPnlPct?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
  }>;
}): string {
  const rows = input.trades.slice(0, 10).map((trade) => {
    const token = escapeGraphvizText(String(trade.token ?? "UNKNOWN"));
    const direction = escapeGraphvizText(normalizeTradeDirection(trade.direction));
    const currentPnlPct = Number(trade.currentPnlPct ?? 0);
    const takeProfitPct = Math.max(0.0001, Math.abs(Number(trade.takeProfitPct ?? 0)));
    const stopLossPct = Math.max(0, Math.abs(Number(trade.stopLossPct ?? 0)));
    const completionPctRaw = takeProfitPct > 0 ? (currentPnlPct / takeProfitPct) * 100 : 0;
    const completionPct = Math.max(-250, Math.min(250, completionPctRaw));
    const roeLabel = `${currentPnlPct > 0 ? "+" : ""}${toFixedSafe(currentPnlPct, 2)}%`;
    const roeColor = currentPnlPct >= 0 ? "#4ade80" : "#f87171";

    return `<TR>
      <TD BGCOLOR="#0f1d30" ALIGN="LEFT"><FONT COLOR="#e2e8f0" POINT-SIZE="12"><B>${token}</B></FONT><BR/><FONT COLOR="#94a3b8" POINT-SIZE="10">${direction}</FONT></TD>
      <TD BGCOLOR="#0f1d30" ALIGN="CENTER"><FONT COLOR="${roeColor}" POINT-SIZE="12"><B>${escapeGraphvizText(roeLabel)}</B></FONT></TD>
      <TD BGCOLOR="#0f1d30" ALIGN="CENTER"><FONT COLOR="#f8fafc" POINT-SIZE="12"><B>${escapeGraphvizText(toFixedSafe(takeProfitPct, 2))}%</B></FONT></TD>
      <TD BGCOLOR="#0f1d30" ALIGN="CENTER"><FONT COLOR="#f8fafc" POINT-SIZE="12"><B>${escapeGraphvizText(toFixedSafe(stopLossPct, 2))}%</B></FONT></TD>
      <TD BGCOLOR="#0f1d30" ALIGN="CENTER"><FONT COLOR="#7dd3fc" POINT-SIZE="12"><B>${escapeGraphvizText(toFixedSafe(completionPct, 1))}%</B></FONT></TD>
    </TR>`;
  }).join("\n");

  const sourceLine = input.sourceLabel ? `<BR/><FONT COLOR="#93c5fd" POINT-SIZE="11">${escapeGraphvizText(input.sourceLabel)}</FONT>` : "";
  const dot = `digraph G {
graph [bgcolor="#07101c", rankdir=TB, pad="0.25"];
node [shape=plain];
panel [label=<
<TABLE BORDER="0" CELLBORDER="1" CELLPADDING="10" CELLSPACING="0" COLOR="#1e2a3b">
  <TR>
    <TD COLSPAN="5" BGCOLOR="#0c1728" ALIGN="LEFT">
      <FONT COLOR="#e2e8f0" POINT-SIZE="20"><B>${escapeGraphvizText(input.heading)}</B></FONT>${sourceLine}
    </TD>
  </TR>
  <TR>
    <TD BGCOLOR="#162231" ALIGN="LEFT"><FONT COLOR="#93c5fd" POINT-SIZE="11"><B>POSITION</B></FONT></TD>
    <TD BGCOLOR="#162231" ALIGN="CENTER"><FONT COLOR="#93c5fd" POINT-SIZE="11"><B>ROE</B></FONT></TD>
    <TD BGCOLOR="#162231" ALIGN="CENTER"><FONT COLOR="#93c5fd" POINT-SIZE="11"><B>TP (ROE)</B></FONT></TD>
    <TD BGCOLOR="#162231" ALIGN="CENTER"><FONT COLOR="#93c5fd" POINT-SIZE="11"><B>SL (ROE)</B></FONT></TD>
    <TD BGCOLOR="#162231" ALIGN="CENTER"><FONT COLOR="#93c5fd" POINT-SIZE="11"><B>PROGRESS</B></FONT></TD>
  </TR>
  ${rows}
</TABLE>
>];
}`;

  return `https://quickchart.io/graphviz?format=png&width=1400&height=820&graph=${encodeURIComponent(dot)}`;
}

function computeDistancePct(entryPrice: number, targetPrice: number): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(targetPrice) || targetPrice <= 0) {
    return 0;
  }

  return Math.abs(((targetPrice - entryPrice) / entryPrice) * 100);
}

function normalizeBitunixPositionToken(symbolRaw: string): string {
  const rawSymbol = String(symbolRaw ?? "").toUpperCase();
  return rawSymbol.endsWith("USDT") ? `${rawSymbol.slice(0, -4)}-PERP` : rawSymbol;
}

async function loadBitunixExchangeProgressRows(filterSymbolRaw?: string): Promise<Array<{
  token: string;
  direction: "LONG" | "SHORT";
  currentPnlPct: number;
  takeProfitPct: number;
  stopLossPct: number;
  signalType: string;
}>> {
  let fallbackTpPct = PROGRESS_FALLBACK_DEFAULT_TP_PCT;
  let fallbackSlPct = PROGRESS_FALLBACK_DEFAULT_SL_PCT;
  try {
    const tpSl = await getCurrentTpSlPercentages();
    fallbackTpPct = Math.max(0.1, Math.abs(Number(tpSl.tpPct ?? PROGRESS_FALLBACK_DEFAULT_TP_PCT)));
    fallbackSlPct = Math.max(0.1, Math.abs(Number(tpSl.slPct ?? PROGRESS_FALLBACK_DEFAULT_SL_PCT)));
  } catch (error) {
    console.warn("[telegram] /progress using default TP/SL fallback percentages", {
      tpPct: PROGRESS_FALLBACK_DEFAULT_TP_PCT,
      slPct: PROGRESS_FALLBACK_DEFAULT_SL_PCT,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const [snapshot, pendingTpslOrders] = await Promise.all([
    fetchBitunixAccountSnapshot(PROGRESS_FALLBACK_MARGIN_COIN),
    fetchBitunixPendingTpslOrders()
  ]);

  const tpslByPositionId = new Map<string, {
    tpPrice: number;
    slPrice: number;
  }>();
  for (const order of pendingTpslOrders) {
    const key = String(order.positionId ?? "").trim();
    if (!key) {
      continue;
    }

    const existing = tpslByPositionId.get(key);
    const nextTp = Number.isFinite(order.tpPrice) && order.tpPrice > 0
      ? order.tpPrice
      : existing?.tpPrice ?? 0;
    const nextSl = Number.isFinite(order.slPrice) && order.slPrice > 0
      ? order.slPrice
      : existing?.slPrice ?? 0;
    tpslByPositionId.set(key, {
      tpPrice: nextTp,
      slPrice: nextSl
    });
  }

  const targetSymbol = normalizeProgressSymbol(filterSymbolRaw);
  return snapshot.positions
    .map((position) => {
      const token = normalizeBitunixPositionToken(String(position.symbol ?? ""));
      const direction = normalizeTradeDirection(position.side);
      const entryPrice = Number(position.avgOpenPrice ?? NaN);
      const qty = Math.abs(Number(position.qty ?? NaN));
      const leverage = Number(position.leverage ?? NaN);
      const unrealizedPnl = Number(position.unrealizedPNL ?? NaN);

      if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(leverage) || leverage <= 0 || !Number.isFinite(unrealizedPnl)) {
        return null;
      }

      const movePct = unrealizedPnl / (entryPrice * qty);
      const currentPnlPct = movePct * leverage * 100;
      const positionId = String(position.positionId ?? "").trim();
      const tpsl = positionId ? tpslByPositionId.get(positionId) : undefined;

      const takeProfitPct = tpsl?.tpPrice && tpsl.tpPrice > 0
        ? Math.max(0.1, computeDistancePct(entryPrice, tpsl.tpPrice) * leverage)
        : fallbackTpPct;
      const stopLossPct = tpsl?.slPrice && tpsl.slPrice > 0
        ? Math.max(0.1, computeDistancePct(entryPrice, tpsl.slPrice) * leverage)
        : fallbackSlPct;

      return {
        token,
        direction,
        currentPnlPct,
        takeProfitPct,
        stopLossPct,
        signalType: "LIVE_EXCHANGE_POSITION"
      };
    })
    .filter((row): row is {
      token: string;
      direction: "LONG" | "SHORT";
      currentPnlPct: number;
      takeProfitPct: number;
      stopLossPct: number;
      signalType: string;
    } => row !== null)
    .filter((row) => !targetSymbol || normalizeProgressSymbol(row.token) === targetSymbol);
}

async function loadExchangeProgressFallback(
  filterSymbolRaw?: string
): Promise<Array<{
  token: string;
  direction: "LONG" | "SHORT";
  currentPnlPct: number;
  takeProfitPct: number;
  stopLossPct: number;
  signalType: string;
}>> {
  try {
    return await loadBitunixExchangeProgressRows(filterSymbolRaw);
  } catch (error) {
    console.error("[telegram] /progress exchange fallback failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

async function handleProgressCommand(chatId: number, args: string[], getState: TelegramStateGetter): Promise<void> {
  const snapshot = getState();
  const active = snapshot?.tradeSimulation?.activeTrades ?? [];
  const filterSymbolRaw = args[0]?.trim();
  let exchangeRows: Array<{
    token: string;
    direction: "LONG" | "SHORT";
    currentPnlPct: number;
    takeProfitPct: number;
    stopLossPct: number;
    signalType: string;
  }> = [];
  try {
    exchangeRows = await loadBitunixExchangeProgressRows(filterSymbolRaw);
  } catch (error) {
    console.error("[telegram] /progress exchange enrichment failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  const exchangeByKey = new Map(exchangeRows.map((row) => [`${normalizeProgressSymbol(row.token)}:${row.direction}`, row]));
  let usingExchangeFallback = false;
  let usingExchangeEnrichment = false;

  let sourceTrades = Array.isArray(active) ? active : [];
  if (sourceTrades.length > 0) {
    sourceTrades = sourceTrades.map((trade) => {
      const direction = normalizeTradeDirection(trade.direction);
      const key = `${normalizeProgressSymbol(String(trade.token ?? ""))}:${direction}`;
      const exchange = exchangeByKey.get(key);
      if (!exchange) {
        return trade;
      }

      usingExchangeEnrichment = true;

      return {
        ...trade,
        currentPnlPct: exchange.currentPnlPct,
        takeProfitPct: exchange.takeProfitPct,
        stopLossPct: exchange.stopLossPct
      };
    });
  }
  if (sourceTrades.length === 0) {
    sourceTrades = exchangeRows.length > 0 ? exchangeRows : await loadExchangeProgressFallback(filterSymbolRaw);
    usingExchangeFallback = sourceTrades.length > 0;
  }

  if (!Array.isArray(sourceTrades) || sourceTrades.length === 0) {
    await sendTelegramMessage("No active positions right now.", chatId);
    return;
  }

  const filtered = filterSymbolRaw
    ? sourceTrades.filter((trade) => normalizeProgressSymbol(String(trade.token ?? "")) === normalizeProgressSymbol(filterSymbolRaw))
    : sourceTrades;

  if (filtered.length === 0) {
    await sendTelegramMessage(`No active position found for <b>${escapeHtml(normalizeSymbol(filterSymbolRaw ?? ""))}</b>.`, chatId);
    return;
  }

  const heading = filterSymbolRaw
    ? `<b>Position Progress · ${escapeHtml(normalizeSymbol(filterSymbolRaw))}</b>`
    : "<b>Open Position Progress</b>";
  const lines = [heading];
  let imageSourceLabel: string | undefined;
  if (usingExchangeEnrichment) {
    const sourceText = "Source: <b>Bitunix live positions + TPSL orders</b> (enriched activeTrades)";
    lines.push(sourceText);
    imageSourceLabel = "Bitunix live positions + TPSL orders (enriched activeTrades)";
  }
  if (usingExchangeFallback) {
    const sourceText = "Source: <b>Bitunix live positions + TPSL orders</b>";
    lines.push(sourceText);
    imageSourceLabel = "Bitunix live positions + TPSL orders";
  }

  for (const trade of filtered) {
    lines.push(formatProgressLine(trade));
    lines.push("");
  }

  lines.push("Use <b>/progress SYMBOL</b> for one token (example: /progress YGG).");
  const text = lines.join("\n");

  if (TELEGRAM_ALERT_GRAPHICS_ENABLED) {
    try {
      await sendTelegramPhoto(
        buildProgressImageUrl({
          heading: filterSymbolRaw
            ? `Position Progress · ${normalizeSymbol(filterSymbolRaw)}`
            : "Open Position Progress",
          sourceLabel: imageSourceLabel,
          trades: filtered
        }),
        text,
        chatId
      );
      return;
    } catch (error) {
      console.warn("[telegram] /progress image send failed; falling back to text", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await sendTelegramMessage(text, chatId);
}

function parseBalanceValue(raw: unknown): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

async function handleBalanceCommand(chatId: number, getState: TelegramStateGetter): Promise<void> {
  const lines = ["<b>Current Balance</b>"];

  let exchangeSectionAdded = false;
  try {
    const snapshot = await fetchBitunixAccountSnapshot(PROGRESS_FALLBACK_MARGIN_COIN);
    const available = parseBalanceValue(snapshot.account?.available);
    const frozen = parseBalanceValue(snapshot.account?.frozen);
    const totalMargin = Number(snapshot.positionSummary.totalMarginUsd ?? Number.NaN);
    const unrealized = Number(snapshot.positionSummary.netUnrealizedPnlUsd ?? Number.NaN);
    const estimatedEquity = Number.isFinite(available) && Number.isFinite(totalMargin) && Number.isFinite(unrealized)
      ? available + totalMargin + unrealized
      : Number.NaN;

    lines.push("<b>Exchange (Bitunix)</b>");
    lines.push(`Margin Coin: <b>${escapeHtml(snapshot.marginCoin)}</b>`);
    lines.push(`Available: <b>${escapeHtml(formatUsdAmount(available))}</b>`);
    lines.push(`Frozen: <b>${escapeHtml(formatUsdAmount(frozen))}</b>`);
    lines.push(`In Positions (Margin): <b>${escapeHtml(formatUsdAmount(totalMargin))}</b>`);
    lines.push(`Unrealized PnL: <b>${escapeHtml(formatUsdAmount(unrealized))}</b>`);
    if (Number.isFinite(estimatedEquity)) {
      lines.push(`Estimated Equity: <b>${escapeHtml(formatUsdAmount(estimatedEquity))}</b>`);
    }

    exchangeSectionAdded = true;
  } catch (error) {
    console.warn("[telegram] /balance exchange fetch failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const simulationStats = getState()?.tradeSimulation?.stats;
  if (simulationStats) {
    if (exchangeSectionAdded) {
      lines.push("");
    }
    lines.push("<b>Simulation</b>");
    lines.push(`Balance: <b>${escapeHtml(formatUsdAmount(Number(simulationStats.accountBalanceUsd ?? Number.NaN)))}</b>`);
    lines.push(`Equity: <b>${escapeHtml(formatUsdAmount(Number(simulationStats.equityUsd ?? Number.NaN)))}</b>`);
    lines.push(`Unrealized PnL: <b>${escapeHtml(formatUsdAmount(Number(simulationStats.unrealizedPnlUsd ?? Number.NaN)))}</b>`);
  }

  if (!exchangeSectionAdded && !simulationStats) {
    await sendTelegramMessage("Balance is not available yet. Scanner/account snapshot may still be warming up.", chatId);
    return;
  }

  await sendTelegramMessage(lines.join("\n"), chatId);
}

function parseCommand(rawText: string): { command: string; args: string[] } {
  const parts = rawText.trim().split(/\s+/).filter((item) => item.length > 0);
  const commandWithBot = (parts[0] ?? "").toLowerCase();
  const command = commandWithBot.split("@")[0] ?? commandWithBot;
  const args = parts.slice(1);
  return { command, args };
}

function getDirectionalRows(snapshot: TelegramStateSnapshot): TokenRsiResult[] {
  if (!snapshot) {
    return [];
  }

  return snapshot.results
    .filter((row) => row.signal.type.includes("LONG") || row.signal.type.includes("SHORT"))
    .sort((a, b) => (b.confluence.score ?? 0) - (a.confluence.score ?? 0));
}

function getLiquidityHuntProfile(row: TokenRsiResult): {
  huntScore: number;
  likelySide: "UPPER_SWEEP" | "LOWER_SWEEP" | "BALANCED";
  targetLevel: number | null;
  longStopSweepPrice: number | null;
  shortStopSweepPrice: number | null;
  longStopLiquidityUsd: number | null;
  shortStopLiquidityUsd: number | null;
  totalStopLiquidityUsd: number | null;
  estimatedLongPct: number;
  estimatedShortPct: number;
} {
  const support = Number(row.levels.localSupport ?? 0);
  const resistance = Number(row.levels.localResistance ?? 0);
  const close = Number(row.close ?? 0);
  const validRange = Number.isFinite(support)
    && Number.isFinite(resistance)
    && Number.isFinite(close)
    && support > 0
    && resistance > support
    && close > 0;

  const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

  if (!validRange) {
    return {
      huntScore: 0,
      likelySide: "BALANCED",
      targetLevel: null,
      longStopSweepPrice: null,
      shortStopSweepPrice: null,
      longStopLiquidityUsd: null,
      shortStopLiquidityUsd: null,
      totalStopLiquidityUsd: null,
      estimatedLongPct: 50,
      estimatedShortPct: 50
    };
  }

  const supportDistance = Number(row.levels.supportDistancePct ?? 100);
  const resistanceDistance = Number(row.levels.resistanceDistancePct ?? 100);
  const supportCloseness = clamp01(1 - supportDistance / 2.5);
  const resistanceCloseness = clamp01(1 - resistanceDistance / 2.5);
  const volatilityPctile = Number(row.tradeContext?.volatilityPercentile ?? 0);
  const volatilityFactor = clamp01(volatilityPctile / 100);
  const imbalance = Math.max(-1, Math.min(1, Number(row.tradeContext?.orderBookImbalance ?? 0)));
  const bidDominance = Math.max(0, imbalance);
  const askDominance = Math.max(0, -imbalance);
  const intermediaryRsi = Number(row.timeframes.intermediary?.rsi ?? 50);
  const upperMomentum = intermediaryRsi < 45 ? 0.08 : intermediaryRsi > 70 ? -0.06 : 0;
  const lowerMomentum = intermediaryRsi > 60 ? 0.08 : intermediaryRsi < 30 ? -0.06 : 0;
  const emaSlope = Number(row.tradeContext?.emaSlope ?? 0);
  const trendForUpper = emaSlope > 0 ? 0.05 : 0;
  const trendForLower = emaSlope < 0 ? 0.05 : 0;

  const upperScore = clamp01(
    resistanceCloseness * 0.45
    + askDominance * 0.2
    + volatilityFactor * 0.2
    + trendForUpper
    + upperMomentum
    + (row.levels.nearResistance ? 0.1 : 0)
  );

  const lowerScore = clamp01(
    supportCloseness * 0.45
    + bidDominance * 0.2
    + volatilityFactor * 0.2
    + trendForLower
    + lowerMomentum
    + (row.levels.nearSupportFloor ? 0.1 : 0)
  );

  const diff = upperScore - lowerScore;
  const likelySide = Math.abs(diff) < 0.08
    ? "BALANCED"
    : diff > 0
      ? "UPPER_SWEEP"
      : "LOWER_SWEEP";

  const sweepBuffer = LIQUIDITY_HUNT_SWEEP_BUFFER_PCT / 100;
  const volatilityBufferMultiplier = 1 + volatilityFactor * 0.6;
  const longStopSweepPrice = support * (1 - sweepBuffer * volatilityBufferMultiplier);
  const shortStopSweepPrice = resistance * (1 + sweepBuffer * volatilityBufferMultiplier);

  const orderBookLongTilt = clamp01((imbalance + 1) / 2);
  const estimatedLongRaw = lowerScore * 0.72 + orderBookLongTilt * 0.28;
  const estimatedShortRaw = upperScore * 0.72 + (1 - orderBookLongTilt) * 0.28;
  const estimateTotal = Math.max(0.0001, estimatedLongRaw + estimatedShortRaw);
  const estimatedLongPct = Math.round((estimatedLongRaw / estimateTotal) * 100);
  const estimatedShortPct = Math.max(0, 100 - estimatedLongPct);

  const orderBookCombinedDepthUsd = Number(row.tradeContext?.orderBookCombinedDepthUsd ?? 0);
  const liquidityPercentile = clamp01(Number(row.tradeContext?.liquidityPercentile ?? 0) / 100);
  const volume24h = Math.max(0, Number(row.tradeContext?.volume24h ?? row.volume24h ?? 0));
  const estimatedProxyDepthUsd = volume24h > 0
    ? volume24h * (0.015 + (liquidityPercentile * 0.045))
    : null;
  const totalStopLiquidityUsd = orderBookCombinedDepthUsd > 0
    ? orderBookCombinedDepthUsd
    : estimatedProxyDepthUsd;
  const longStopLiquidityUsd = totalStopLiquidityUsd == null ? null : totalStopLiquidityUsd * (estimatedLongPct / 100);
  const shortStopLiquidityUsd = totalStopLiquidityUsd == null ? null : totalStopLiquidityUsd * (estimatedShortPct / 100);

  const targetLevel = likelySide === "UPPER_SWEEP"
    ? shortStopSweepPrice
    : likelySide === "LOWER_SWEEP"
      ? longStopSweepPrice
      : close;

  return {
    huntScore: Math.round(Math.max(upperScore, lowerScore) * 100),
    likelySide,
    targetLevel,
    longStopSweepPrice,
    shortStopSweepPrice,
    longStopLiquidityUsd,
    shortStopLiquidityUsd,
    totalStopLiquidityUsd,
    estimatedLongPct,
    estimatedShortPct
  };
}

async function handleHelpCommand(chatId: number): Promise<void> {
  const lines = [
    "<b>Ciphora Bot Commands</b>",
    "/help - show this menu",
    "/balance - show current exchange + simulation balances",
    "/status SYMBOL - entry diagnostics with pass/fail checks (e.g. /status BNB)",
    "/token SYMBOL - full snapshot for a token (e.g. /token NEAR)",
    "/open - list currently open simulated trades",
    "/progress [SYMBOL] - ROE vs TP goal progress for open positions",
    "/signals [long|short] - directional signals ranked by score",
    "/prepump - list current pre-pump watch tokens",
    "/pumpscan - full-universe daily pre-pump scan (deterministic, tiered)",
    "/hunt [symbol] - liquidity-hunt heat map view (all or one token)",
    "/top - top 5 directional setups",
    "/ready - near-entry tokens",
    "/caution - latest caution list",
    "/shift - latest direction-shift cautions",
    "/closed [N] - latest closed trades",
    "/stats - simulation summary",
    "/watch SYMBOL - add token to watchlist",
    "/unwatch SYMBOL - remove token from watchlist",
    "/watchlist - view watched tokens",
    "/when SYMBOL - last ready/caution timing for token",
    "/alerts - show alert settings",
    "/alerts on|off - toggle alerts",
    "/alerts ready opened closed caution - set alert stages",
    "/trade_on - alias for /trading_on",
    "/trade_off - alias for /trading_off",
    "/trading_on - enable live trading (remote kill switch release)",
    "/trading_off - disable live trading immediately (remote kill switch)",
    "/watch_trade SYMBOL - allow bot protection/auto-close for manual live position symbol",
    "/unwatch_trade SYMBOL - remove symbol from manual live position management",
    "/watch_trades - list manual live position symbols currently managed",
    "/mute [minutes] - mute alerts (default 60m)",
    "/unmute - resume alerts"
  ];

  await sendTelegramMessage(lines.join("\n"), chatId);
}

async function handlePumpScanCommand(chatId: number): Promise<void> {
  await sendTelegramMessage("🔍 Running full-universe pre-pump scan (daily)... this takes a moment.", chatId);
  try {
    const result = await runPrePumpScan({ topN: 50 });
    await sendTelegramMessage(formatPrePumpScanTelegram(result), chatId);
  } catch (error) {
    await sendTelegramMessage(
      `Pre-pump scan failed: ${error instanceof Error ? error.message : String(error)}`,
      chatId
    );
  }
}

async function handlePrePumpCommand(chatId: number, getState: TelegramStateGetter): Promise<void> {
  const snapshot = getState();
  if (!snapshot) {
    await sendTelegramMessage("Scanner is still warming up.", chatId);
    return;
  }

  const rows = snapshot.results
    .filter((row) => String(row.signal.type ?? "").toUpperCase().includes("PRE_PUMP_WATCH"))
    .sort((a, b) => Number(b.confluence.score ?? 0) - Number(a.confluence.score ?? 0))
    .slice(0, 15);

  if (rows.length === 0) {
    const candidates = snapshot.results
      .map((row) => {
        const proximity = calculatePrePumpProximity(row);
        const confluence = Number(row.confluence.score ?? 0);
        const resistanceDistancePct = Number(row.levels?.resistanceDistancePct ?? 0);
        const twelvehTrend = row.timeframes.twelveh?.trend.direction ?? "MIXED";
        const stochK = Number(row.timeframes.intermediary?.stochK ?? 0);
        const intermediaryRsi = Number(row.timeframes.intermediary?.rsi ?? 0);
        const emaSlope = Number(row.tradeContext?.emaSlope ?? 0);
        const volPctile = Number(row.tradeContext?.volatilityPercentile ?? 0);

        const qualityEligible =
          confluence >= 3.5
          && resistanceDistancePct >= 6
          && twelvehTrend !== "DOWN"
          && stochK <= 78
          && intermediaryRsi >= 52
          && intermediaryRsi <= 72
          && emaSlope > -0.0002;

        const qualityScore =
          proximity.score * 0.65
          + Math.min(10, confluence) * 3
          + Math.max(0, Math.min(10, resistanceDistancePct)) * 0.8;

        return {
          row,
          proximity,
          confluence,
          volPctile,
          stochK,
          qualityEligible,
          qualityScore
        };
      })
      .filter((item) => item.proximity.score >= 58 && item.qualityEligible)
      .sort((a, b) => b.qualityScore - a.qualityScore);

    const speculativeEarly = snapshot.results
      .map((row) => {
        const proximity = calculatePrePumpProximity(row);
        const confluence = Number(row.confluence.score ?? 0);
        const resistanceDistancePct = Number(row.levels?.resistanceDistancePct ?? 0);
        const twelvehTrend = row.timeframes.twelveh?.trend.direction ?? "MIXED";
        const stochK = Number(row.timeframes.intermediary?.stochK ?? 0);
        const intermediaryRsi = Number(row.timeframes.intermediary?.rsi ?? 0);
        const emaSlope = Number(row.tradeContext?.emaSlope ?? 0);
        const volPctile = Number(row.tradeContext?.volatilityPercentile ?? 0);

        const qualityEligible =
          confluence >= 3.5
          && resistanceDistancePct >= 6
          && twelvehTrend !== "DOWN"
          && stochK <= 78
          && intermediaryRsi >= 52
          && intermediaryRsi <= 72
          && emaSlope > -0.0002;

        const speculativeEligible =
          proximity.score >= 62
          && confluence >= 2
          && resistanceDistancePct >= 4
          && twelvehTrend !== "DOWN"
          && volPctile >= 10;

        const cautionFlags: string[] = [];
        if (confluence < 3.5) {
          cautionFlags.push("low score");
        }
        if (stochK > 78) {
          cautionFlags.push("hot stoch");
        }
        if (emaSlope <= -0.0002) {
          cautionFlags.push("weak slope");
        }

        return {
          row,
          proximity,
          confluence,
          qualityEligible,
          speculativeEligible,
          cautionFlags
        };
      })
      .filter((item) => item.speculativeEligible && !item.qualityEligible)
      .sort((a, b) => b.proximity.score - a.proximity.score || b.confluence - a.confluence)
      .slice(0, 6);

    const readyQuality = candidates
      .filter((item) => item.proximity.score >= 72)
      .slice(0, 8);

    const earlyQuality = candidates
      .filter((item) => item.proximity.score >= 58 && item.proximity.score < 72)
      .slice(0, 8);

    if (readyQuality.length === 0 && earlyQuality.length === 0 && speculativeEarly.length === 0) {
      await sendTelegramMessage("No pre-pump watch tokens right now, and no quality early/ready candidates yet.", chatId);
      return;
    }

    const lines = ["<b>Pre-Pump Candidates</b>"];

    lines.push("<b>Ready Quality</b>");
    if (readyQuality.length === 0) {
      lines.push("None right now");
    } else {
      for (const item of readyQuality) {
        lines.push(
          `${escapeHtml(normalizeSymbol(item.row.symbol))} • <b>NEAR</b> ${item.proximity.score}% • Score ${toFixedSafe(item.confluence, 1)}/10 • ${escapeHtml(formatPrice(Number(item.row.close ?? 0)))}`
        );
      }
    }

    lines.push("<b>Early Quality</b>");
    if (earlyQuality.length === 0) {
      lines.push("None right now");
    } else {
      for (const item of earlyQuality) {
        lines.push(
          `${escapeHtml(normalizeSymbol(item.row.symbol))} • <b>BUILDING</b> ${item.proximity.score}% • Score ${toFixedSafe(item.confluence, 1)}/10 • ${escapeHtml(formatPrice(Number(item.row.close ?? 0)))}`
        );
      }
    }

    lines.push("<b>Speculative Early (High Risk)</b>");
    if (speculativeEarly.length === 0) {
      lines.push("None right now");
    } else {
      for (const item of speculativeEarly) {
        const cautionText = item.cautionFlags.length > 0
          ? ` • Caution: ${item.cautionFlags.join(", ")}`
          : "";
        lines.push(
          `${escapeHtml(normalizeSymbol(item.row.symbol))} • <b>EARLY</b> ${item.proximity.score}% • Score ${toFixedSafe(item.confluence, 1)}/10 • ${escapeHtml(formatPrice(Number(item.row.close ?? 0)))}${escapeHtml(cautionText)}`
        );
      }
    }

    const snapshotAsOf = resolveSnapshotAsOf(snapshot);
    if (snapshotAsOf) {
      lines.push(`As of: <b>${escapeHtml(formatIsoCompact(snapshotAsOf))}</b>`);
    }

    await sendTelegramMessage(lines.join("\n"), chatId);
    return;
  }

  const lines = ["<b>Pre-Pump Watch Tokens</b>"];
  for (const row of rows) {
    lines.push(
      `${escapeHtml(normalizeSymbol(row.symbol))} • <b>${escapeHtml(row.signal.type)}</b> • Score ${toFixedSafe(Number(row.confluence.score ?? 0), 1)}/10 • ${escapeHtml(formatPrice(Number(row.close ?? 0)))}`
    );
  }

  const snapshotAsOf = resolveSnapshotAsOf(snapshot);
  if (snapshotAsOf) {
    lines.push(`As of: <b>${escapeHtml(formatIsoCompact(snapshotAsOf))}</b>`);
  }

  await sendTelegramMessage(lines.join("\n"), chatId);
}

async function handleTradingToggleCommand(chatId: number, enabled: boolean): Promise<void> {
  try {
    await updateRuntimeSettings([
      {
        key: "LIVE_TRADING_ENABLED",
        value: enabled ? "true" : "false"
      }
    ]);

    setLiveTradingEnabled(enabled);

    await sendTelegramMessage(
      enabled
        ? "Live trading is now <b>ENABLED</b>."
        : "Live trading is now <b>DISABLED</b>. Kill switch is active.",
      chatId
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await sendTelegramMessage(
      `Failed to update live trading kill switch: <b>${escapeHtml(reason)}</b>`,
      chatId
    );
  }
}

async function persistManualWatchSymbols(): Promise<void> {
  const symbols = listManualWatchSymbols();
  await updateRuntimeSettings([
    {
      key: "LIVE_MANUAL_POSITION_WATCH_SYMBOLS",
      value: serializeManualWatchSymbols(symbols)
    }
  ]);
}

async function handleWatchTradeCommand(chatId: number, args: string[]): Promise<void> {
  const symbol = args[0]?.trim();
  if (!symbol) {
    await sendTelegramMessage("Usage: <b>/watch_trade BTC</b>", chatId);
    return;
  }

  try {
    const result = addManualWatchSymbol(symbol);
    await persistManualWatchSymbols();
    await sendTelegramMessage(
      result.added
        ? `Manual position management enabled for <b>${escapeHtml(result.symbol)}</b>.`
        : `<b>${escapeHtml(result.symbol)}</b> was already managed.`,
      chatId
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await sendTelegramMessage(`Failed to add manual trade watch: <b>${escapeHtml(reason)}</b>`, chatId);
  }
}

async function handleUnwatchTradeCommand(chatId: number, args: string[]): Promise<void> {
  const symbol = args[0]?.trim();
  if (!symbol) {
    await sendTelegramMessage("Usage: <b>/unwatch_trade BTC</b>", chatId);
    return;
  }

  try {
    const result = removeManualWatchSymbol(symbol);
    await persistManualWatchSymbols();
    await sendTelegramMessage(
      result.removed
        ? `Manual position management disabled for <b>${escapeHtml(result.symbol)}</b>.`
        : `<b>${escapeHtml(result.symbol)}</b> was not managed.`,
      chatId
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await sendTelegramMessage(`Failed to remove manual trade watch: <b>${escapeHtml(reason)}</b>`, chatId);
  }
}

async function handleWatchTradesCommand(chatId: number): Promise<void> {
  const symbols = listManualWatchSymbols();
  if (symbols.length === 0) {
    await sendTelegramMessage("Manual trade management watchlist is empty.", chatId);
    return;
  }

  await sendTelegramMessage([
    "<b>Managed Manual Live Symbols</b>",
    ...symbols.map((item) => escapeHtml(item))
  ].join("\n"), chatId);
}

async function handleHuntCommand(chatId: number, args: string[], getState: TelegramStateGetter): Promise<void> {
  const snapshot = getState();
  if (!snapshot) {
    await sendTelegramMessage("Scanner is still warming up.", chatId);
    return;
  }

  const symbol = args[0]?.trim();
  if (symbol) {
    const row = findTokenResult(snapshot, symbol);
    if (!row) {
      await sendTelegramMessage(`No current scan snapshot found for <b>${escapeHtml(normalizeSymbol(symbol))}</b>.`, chatId);
      return;
    }

    const profile = getLiquidityHuntProfile(row);
    const sideText = profile.likelySide === "UPPER_SWEEP"
      ? "Short stops likely above"
      : profile.likelySide === "LOWER_SWEEP"
        ? "Long stops likely below"
        : "Balanced stop pressure";

    const lines = [
      `<b>Liquidity Hunt Heatmap · ${escapeHtml(normalizeSymbol(row.symbol))}</b>`,
      `Bias: <b>${escapeHtml(sideText)}</b>`,
      `Confidence: <b>${profile.huntScore}%</b>`,
      `Long SL avg: <b>${escapeHtml(profile.longStopSweepPrice != null ? formatPrice(profile.longStopSweepPrice) : "n/a")}</b>`,
      `Short hunt top: <b>${escapeHtml(profile.shortStopSweepPrice != null ? formatPrice(profile.shortStopSweepPrice) : "n/a")}</b>`,
      `Target level: <b>${escapeHtml(profile.targetLevel != null ? formatPrice(profile.targetLevel) : "n/a")}</b>`,
      `Positioning est: <b>${profile.estimatedLongPct}% long / ${profile.estimatedShortPct}% short</b>`,
      `Long stop liq est: <b>${escapeHtml(profile.longStopLiquidityUsd != null ? formatUsdCompact(profile.longStopLiquidityUsd) : "n/a")}</b>`,
      `Short stop liq est: <b>${escapeHtml(profile.shortStopLiquidityUsd != null ? formatUsdCompact(profile.shortStopLiquidityUsd) : "n/a")}</b>`,
      `Stop liquidity pool est: <b>${escapeHtml(profile.totalStopLiquidityUsd != null ? formatUsdCompact(profile.totalStopLiquidityUsd) : "n/a")}</b>`
    ];

    await sendTelegramMessage(lines.join("\n"), chatId);
    return;
  }

  const rows = getDirectionalRows(snapshot).slice(0, 10);
  if (rows.length === 0) {
    await sendTelegramMessage("No directional rows available for hunt heatmap.", chatId);
    return;
  }

  const lines = ["<b>Liquidity Hunt Heatmap (Top 10)</b>"];
  for (const row of rows) {
    const profile = getLiquidityHuntProfile(row);
    const sideShort = profile.likelySide === "UPPER_SWEEP"
      ? "SHORT_SIDE"
      : profile.likelySide === "LOWER_SWEEP"
        ? "LONG_SIDE"
        : "BALANCED";
    lines.push(
      `${escapeHtml(normalizeSymbol(row.symbol))} • <b>${sideShort}</b> • C ${profile.huntScore}% • L ${escapeHtml(profile.longStopLiquidityUsd != null ? formatUsdCompact(profile.longStopLiquidityUsd) : "n/a")} / S ${escapeHtml(profile.shortStopLiquidityUsd != null ? formatUsdCompact(profile.shortStopLiquidityUsd) : "n/a")}`
    );
  }
  lines.push("Use <b>/hunt SYMBOL</b> for full levels and liquidity breakdown.");
  await sendTelegramMessage(lines.join("\n"), chatId);
}

async function handleSignalsCommand(chatId: number, args: string[], getState: TelegramStateGetter, topOnly = false): Promise<void> {
  const snapshot = getState();
  const mode = (args[0] ?? "").toLowerCase();
  const rows = getDirectionalRows(snapshot).filter((row) => {
    if (mode === "long") return row.signal.type.includes("LONG");
    if (mode === "short") return row.signal.type.includes("SHORT");
    return true;
  });

  if (rows.length === 0) {
    await sendTelegramMessage("No directional signals right now.", chatId);
    return;
  }

  const limit = topOnly ? 5 : 10;
  const lines = [topOnly ? "<b>Top Setups</b>" : "<b>Directional Signals</b>"];
  for (const row of rows.slice(0, limit)) {
    lines.push(
      `${escapeHtml(row.symbol)} • <b>${escapeHtml(formatDirectionSignal(row.signal.type))}</b> • ${escapeHtml(row.signal.type)} • Score ${toFixedSafe(row.confluence.score, 1)}/10 • ${escapeHtml(formatPrice(row.close))}`
    );
  }
  await sendTelegramMessage(lines.join("\n"), chatId);
}

async function handleReadyCommand(chatId: number, getState: TelegramStateGetter): Promise<void> {
  const snapshot = getState();
  if (!snapshot) {
    await sendTelegramMessage("Scanner is still warming up.", chatId);
    return;
  }

  const rows = snapshot.results
    .filter((row) => !row.signal.type.includes("LONG") && !row.signal.type.includes("SHORT"))
    .filter((row) => calculateReadiness(row).pct >= 70)
    .sort((a, b) => calculateReadiness(b).pct - calculateReadiness(a).pct)
    .slice(0, 10);

  if (rows.length === 0) {
    await sendTelegramMessage("No high-readiness setups right now.", chatId);
    return;
  }

  const lines = ["<b>Near-Entry Setups</b>"];
  for (const row of rows) {
    const readiness = calculateReadiness(row);
    lines.push(`${escapeHtml(row.symbol)} • ${readiness.pct}% ${escapeHtml(readiness.label)} • Score ${toFixedSafe(row.confluence.score, 1)}/10 • ${escapeHtml(formatPrice(row.close))}`);
  }
  await sendTelegramMessage(lines.join("\n"), chatId);
}

async function handleCautionCommand(chatId: number): Promise<void> {
  const cautions = listRecentCautions(10);
  if (cautions.length === 0) {
    await sendTelegramMessage("No recent caution events.", chatId);
    return;
  }

  const lines = ["<b>Recent Caution Events</b>"];
  for (const item of cautions) {
    lines.push(
      `${escapeHtml(item.symbol)} • <b>${escapeHtml(item.direction)}</b> • ${escapeHtml(item.signalType)} • ${escapeHtml(formatIsoCompact(item.sentAt))}`
    );
  }
  await sendTelegramMessage(lines.join("\n"), chatId);
}

async function handleShiftCommand(chatId: number): Promise<void> {
  const shifts = listRecentCautions(20).filter((item) => item.signalType.startsWith("DIRECTION_SHIFT_"));
  if (shifts.length === 0) {
    await sendTelegramMessage("No recent direction shifts.", chatId);
    return;
  }

  const lines = ["<b>Direction Shifts</b>"];
  for (const item of shifts.slice(0, 10)) {
    lines.push(`${escapeHtml(item.symbol)} • ${escapeHtml(item.signalType)} • ${escapeHtml(formatIsoCompact(item.sentAt))}`);
  }
  await sendTelegramMessage(lines.join("\n"), chatId);
}

async function handleClosedCommand(chatId: number, args: string[], getState: TelegramStateGetter): Promise<void> {
  const snapshot = getState();
  const limitRaw = Number(args[0] ?? 8);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, Math.trunc(limitRaw))) : 8;
  const closed = snapshot?.tradeSimulation?.recentClosedTrades ?? [];

  if (closed.length === 0) {
    await sendTelegramMessage("No closed simulated trades yet.", chatId);
    return;
  }

  const lines = ["<b>Recent Closed Trades</b>"];
  for (const trade of closed.slice(0, limit)) {
    lines.push(
      `${escapeHtml(String(trade.token ?? "UNKNOWN"))} ${escapeHtml(String(trade.direction ?? "N/A"))} • Result ${toFixedSafe(Number(trade.result ?? 0), 2)}% • ${escapeHtml(String(trade.closeReason ?? "CLOSE"))}`
    );
  }
  await sendTelegramMessage(lines.join("\n"), chatId);
}

async function handleStatsCommand(chatId: number, getState: TelegramStateGetter): Promise<void> {
  const stats = getState()?.tradeSimulation?.stats;
  if (!stats) {
    await sendTelegramMessage("Simulation stats are not available yet.", chatId);
    return;
  }

  const total = Number(stats.totalTrades ?? 0);
  const wins = Number(stats.wins ?? 0);
  const losses = Number(stats.losses ?? 0);
  const lossRate = total > 0 ? (losses / total) * 100 : 0;

  await sendTelegramMessage([
    "<b>Simulation Stats</b>",
    `Active: <b>${Number(stats.activeTrades ?? 0)}</b>`,
    `Total: <b>${total}</b>`,
    `Win Rate: <b>${toFixedSafe(Number(stats.winRate ?? 0), 2)}%</b>`,
    `Loss Rate: <b>${toFixedSafe(lossRate, 2)}%</b>`,
    `Wins/Losses: <b>${wins} / ${losses}</b>`
  ].join("\n"), chatId);
}

async function handleWatchCommand(chatId: number, args: string[]): Promise<void> {
  const symbol = args[0]?.trim();
  if (!symbol) {
    await sendTelegramMessage("Usage: <b>/watch NEAR</b>", chatId);
    return;
  }

  const normalized = normalizeSymbol(symbol);

  try {
    await addWatchSymbol(chatId, normalized);
    await sendTelegramMessage(`Added <b>${escapeHtml(normalized)}</b> to watchlist.`, chatId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await sendTelegramMessage(`Unable to persist watchlist entry: <b>${escapeHtml(reason)}</b>`, chatId);
  }
}

async function handleUnwatchCommand(chatId: number, args: string[]): Promise<void> {
  const symbol = args[0]?.trim();
  if (!symbol) {
    await sendTelegramMessage("Usage: <b>/unwatch NEAR</b>", chatId);
    return;
  }

  const normalized = normalizeSymbol(symbol);

  try {
    const removed = await removeWatchSymbol(chatId, normalized);
    if (!removed) {
      await sendTelegramMessage(`<b>${escapeHtml(normalized)}</b> was not in your watchlist.`, chatId);
      return;
    }

    await sendTelegramMessage(`Removed <b>${escapeHtml(normalized)}</b> from watchlist.`, chatId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await sendTelegramMessage(`Unable to update watchlist: <b>${escapeHtml(reason)}</b>`, chatId);
  }
}

async function handleWatchlistCommand(chatId: number, getState: TelegramStateGetter): Promise<void> {
  const snapshot = getState();
  let watchlist: string[] = [];

  try {
    watchlist = await listWatchSymbols(chatId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await sendTelegramMessage(`Unable to load watchlist: <b>${escapeHtml(reason)}</b>`, chatId);
    return;
  }

  if (watchlist.length === 0) {
    await sendTelegramMessage("Watchlist is empty. Add with <b>/watch SYMBOL</b>.", chatId);
    return;
  }

  const lines = ["<b>Your Watchlist</b>"];
  for (const symbol of watchlist) {
    const row = snapshot ? findTokenResult(snapshot, symbol) : null;
    if (!row) {
      lines.push(`${escapeHtml(symbol)} • no live row`);
      continue;
    }
    lines.push(`${escapeHtml(symbol)} • ${escapeHtml(row.signal.type)} • ${escapeHtml(formatPrice(row.close))}`);
  }
  await sendTelegramMessage(lines.join("\n"), chatId);
}

async function handleWhenCommand(chatId: number, args: string[], getState: TelegramStateGetter): Promise<void> {
  const symbol = args[0]?.trim();
  if (!symbol) {
    await sendTelegramMessage("Usage: <b>/when NEAR</b>", chatId);
    return;
  }

  const snapshot = getState();
  const normalized = normalizeSymbol(symbol);
  const recentReady = getRecentReady(normalized);
  const recentCaution = getRecentCaution(normalized);
  const snapshotAsOf = resolveSnapshotAsOf(snapshot);
  const row = snapshot ? findTokenResult(snapshot, normalized) : null;

  const lines = [
    `<b>${escapeHtml(normalized)}</b>`,
    `Snapshot As Of: <b>${escapeHtml(snapshotAsOf ? formatIsoCompact(snapshotAsOf) : "N/A")}</b>`,
    `Current Signal: <b>${escapeHtml(row?.signal.type ?? "N/A")}</b>`
  ];

  if (recentReady) {
    lines.push(`Last READY: <b>${escapeHtml(recentReady.signalType)}</b> at <b>${escapeHtml(formatIsoCompact(recentReady.sentAt))}</b>`);
  } else {
    lines.push("Last READY: <b>None</b>");
  }

  if (recentCaution) {
    lines.push(`Last CAUTION: <b>${escapeHtml(recentCaution.signalType)}</b> at <b>${escapeHtml(formatIsoCompact(recentCaution.sentAt))}</b>`);
  } else {
    lines.push("Last CAUTION: <b>None</b>");
  }

  await sendTelegramMessage(lines.join("\n"), chatId);
}

async function handleAlertsCommand(chatId: number, args: string[]): Promise<void> {
  if (args.length === 0) {
    const muted = runtimeMutedUntilMs > Date.now();
    const mutedUntil = muted ? formatIsoCompact(new Date(runtimeMutedUntilMs).toISOString()) : "not muted";
    await sendTelegramMessage([
      "<b>Alert Settings</b>",
      `Enabled: <b>${runtimeAlertsEnabled ? "ON" : "OFF"}</b>`,
      `Stages: <b>${[...runtimeAlertStages].join(", ")}</b>`,
      `Mute: <b>${escapeHtml(mutedUntil)}</b>`
    ].join("\n"), chatId);
    return;
  }

  const first = args[0].toLowerCase();
  if (first === "on") {
    runtimeAlertsEnabled = true;
    await sendTelegramMessage("Alerts turned <b>ON</b>.", chatId);
    return;
  }

  if (first === "off") {
    runtimeAlertsEnabled = false;
    await sendTelegramMessage("Alerts turned <b>OFF</b>.", chatId);
    return;
  }

  const parsedStages = args
    .map((item) => item.trim().toUpperCase())
    .filter((item): item is AlertStage => item === "READY" || item === "OPENED" || item === "CLOSED" || item === "CAUTION");
  if (parsedStages.length === 0) {
    await sendTelegramMessage("Usage: <b>/alerts on</b>, <b>/alerts off</b>, or <b>/alerts ready opened closed caution</b>", chatId);
    return;
  }

  runtimeAlertStages = new Set(parsedStages);
  await sendTelegramMessage(`Alert stages set to <b>${parsedStages.join(", ")}</b>.`, chatId);
}

async function handleMuteCommand(chatId: number, args: string[]): Promise<void> {
  const minutesRaw = Number(args[0] ?? 60);
  const minutes = Number.isFinite(minutesRaw) ? Math.max(1, Math.min(1440, Math.trunc(minutesRaw))) : 60;
  runtimeMutedUntilMs = Date.now() + minutes * 60 * 1000;
  await sendTelegramMessage(`Alerts muted for <b>${minutes} minutes</b>.`, chatId);
}

async function handleUnmuteCommand(chatId: number): Promise<void> {
  runtimeMutedUntilMs = 0;
  await sendTelegramMessage("Alerts unmuted.", chatId);
}

async function dispatchCommand(chatId: number, text: string, getState: TelegramStateGetter): Promise<void> {
  const { command, args } = parseCommand(text);

  if (command === "/help" || command === "/start") {
    await handleHelpCommand(chatId);
    return;
  }

  if (command === "/token") {
    await handleTokenCommand(chatId, text, getState);
    return;
  }

  if (command === "/status") {
    await handleStatusCommand(chatId, args, getState);
    return;
  }

  if (command === "/open") {
    await handleOpenCommand(chatId, getState);
    return;
  }

  if (command === "/progress") {
    await handleProgressCommand(chatId, args, getState);
    return;
  }

  if (command === "/balance") {
    await handleBalanceCommand(chatId, getState);
    return;
  }

  if (command === "/signals") {
    await handleSignalsCommand(chatId, args, getState);
    return;
  }

  if (command === "/prepump" || command === "/pre_pump") {
    await handlePrePumpCommand(chatId, getState);
    return;
  }

  if (command === "/pumpscan" || command === "/pump_scan") {
    await handlePumpScanCommand(chatId);
    return;
  }

  if (command === "/hunt") {
    await handleHuntCommand(chatId, args, getState);
    return;
  }

  if (command === "/top") {
    await handleSignalsCommand(chatId, args, getState, true);
    return;
  }

  if (command === "/ready") {
    await handleReadyCommand(chatId, getState);
    return;
  }

  if (command === "/caution") {
    await handleCautionCommand(chatId);
    return;
  }

  if (command === "/shift") {
    await handleShiftCommand(chatId);
    return;
  }

  if (command === "/closed") {
    await handleClosedCommand(chatId, args, getState);
    return;
  }

  if (command === "/stats") {
    await handleStatsCommand(chatId, getState);
    return;
  }

  if (command === "/watch") {
    await handleWatchCommand(chatId, args);
    return;
  }

  if (command === "/unwatch") {
    await handleUnwatchCommand(chatId, args);
    return;
  }

  if (command === "/watchlist") {
    await handleWatchlistCommand(chatId, getState);
    return;
  }

  if (command === "/when") {
    await handleWhenCommand(chatId, args, getState);
    return;
  }

  if (command === "/alerts") {
    await handleAlertsCommand(chatId, args);
    return;
  }

  if (command === "/trading_on" || command === "/trade_on") {
    if (isLiveTradingEnabled()) {
      await sendTelegramMessage("Live trading is already <b>ENABLED</b>.", chatId);
      return;
    }

    await handleTradingToggleCommand(chatId, true);
    return;
  }

  if (command === "/trading_off" || command === "/trade_off") {
    if (!isLiveTradingEnabled()) {
      await sendTelegramMessage("Live trading is already <b>DISABLED</b>.", chatId);
      return;
    }

    await handleTradingToggleCommand(chatId, false);
    return;
  }

  if (command === "/watch_trade") {
    await handleWatchTradeCommand(chatId, args);
    return;
  }

  if (command === "/unwatch_trade") {
    await handleUnwatchTradeCommand(chatId, args);
    return;
  }

  if (command === "/watch_trades") {
    await handleWatchTradesCommand(chatId);
    return;
  }

  if (command === "/mute") {
    await handleMuteCommand(chatId, args);
    return;
  }

  if (command === "/unmute") {
    await handleUnmuteCommand(chatId);
    return;
  }
}

function buildTokenStatusCaption(row: TokenRsiResult, context: TokenStatusContext): string {
  const readiness = calculateReadiness(row);
  const displaySignalType = context.recentAlert?.signalType ?? row.signal.type;
  const direction = resolveSignalDirection(displaySignalType, row.confluence.bias);
  const setupConflictNote = resolveSetupConflictNoteFromRow(row, direction);
  const reversalPhase = resolveReversalPhase(row, direction);
  const lines = [
    `<b>${escapeHtml(row.symbol.trim().toUpperCase().replace(/-PERP$/i, "").replace(/-USDT-SWAP$/i, "").replace(/-USDT$/i, ""))}</b> · ${escapeHtml(getTokenName(row.symbol.trim().toUpperCase().replace(/-PERP$/i, "").replace(/-USDT-SWAP$/i, "").replace(/-USDT$/i, "")))}`,
    `Signal: <b>${escapeHtml(displaySignalType)}</b>`,
    `Readiness: <b>${readiness.pct}%</b> • Entry Timing: <b>${escapeHtml(row.entryTiming ?? "N/A")}</b>`,
    `Reversal Phase: <b>${escapeHtml(reversalPhase)}</b>`,
    `Price: <b>${escapeHtml(formatPrice(row.close))}</b> • Score: <b>${escapeHtml(toFixedSafe(row.confluence.score, 1))}/10</b>`
  ];

  if (setupConflictNote) {
    lines.push(`Risk: <b>${escapeHtml(setupConflictNote)}</b>`);
  }

  if (context.recentAlert) {
    lines.push(
      `Alert Match: <b>${escapeHtml(context.recentAlert.stage)}</b> • ${escapeHtml(formatIsoCompact(context.recentAlert.sentAt))}`
    );
  }

  if (context.snapshotAsOf) {
    lines.push(`Snapshot As Of: <b>${escapeHtml(formatIsoCompact(context.snapshotAsOf))}</b>`);
  }

  if (context.recentReady) {
    lines.push(
      `Last READY: <b>${escapeHtml(context.recentReady.signalType)}</b> ${escapeHtml(context.recentReady.direction)} • Score <b>${escapeHtml(toFixedSafe(context.recentReady.entryScore, 1))}/10</b> • At <b>${escapeHtml(formatIsoCompact(context.recentReady.sentAt))}</b>`
    );
  }

  return lines.join("\n");
}

function buildTokenStatusText(row: TokenRsiResult, context: TokenStatusContext): string {
  const readiness = calculateReadiness(row);
  const displaySignalType = context.recentAlert?.signalType ?? row.signal.type;
  const direction = resolveSignalDirection(displaySignalType, row.confluence.bias);
  const setupConflictNote = resolveSetupConflictNoteFromRow(row, direction);
  const reversalPhase = resolveReversalPhase(row, direction);
  const lines = [
    `<b>${escapeHtml(row.symbol.trim().toUpperCase().replace(/-PERP$/i, "").replace(/-USDT-SWAP$/i, "").replace(/-USDT$/i, ""))}</b> · ${escapeHtml(getTokenName(row.symbol.trim().toUpperCase().replace(/-PERP$/i, "").replace(/-USDT-SWAP$/i, "").replace(/-USDT$/i, "")))}`,
    `Status: <b>${escapeHtml(row.status)}</b> • Signal: <b>${escapeHtml(displaySignalType)}</b>`,
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
  ];

  if (setupConflictNote) {
    lines.push(`Risk: <b>${escapeHtml(setupConflictNote)}</b>`);
  }

  if (context.recentAlert) {
    lines.push(
      `Alert Match: <b>${escapeHtml(context.recentAlert.stage)}</b> • At <b>${escapeHtml(formatIsoCompact(context.recentAlert.sentAt))}</b>`
    );
  }

  if (context.snapshotAsOf) {
    lines.push(`Snapshot As Of: <b>${escapeHtml(formatIsoCompact(context.snapshotAsOf))}</b>`);
  }

  if (context.recentReady) {
    lines.push(
      `Last READY: <b>${escapeHtml(context.recentReady.signalType)}</b> ${escapeHtml(context.recentReady.direction)} • Timing <b>${escapeHtml(context.recentReady.entryTiming)}</b> • Score <b>${escapeHtml(toFixedSafe(context.recentReady.entryScore, 1))}/10</b> • Weighted <b>${escapeHtml(toFixedSafe(context.recentReady.weightedScore, 3))}</b> • Feasibility <b>${escapeHtml(toFixedSafe(context.recentReady.tpFeasibility, 3))}</b> • At <b>${escapeHtml(formatIsoCompact(context.recentReady.sentAt))}</b>`
    );
  }

  return lines.join("\n");
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
  const enrichedPayload = {
    ...payload,
    asOf: payload.asOf ?? new Date().toISOString()
  };
  const sendPromise = (async () => {
    if (!(await shouldSend(enrichedPayload))) {
      return;
    }

    const text = buildMessage(enrichedPayload);
    if (!TELEGRAM_ALERT_GRAPHICS_ENABLED) {
      await sendTelegramMessage(text);
    } else {
      try {
        await sendTelegramPhoto(buildPanelImageUrl(enrichedPayload), text);
      } catch (photoError) {
        console.warn("[telegram] alert image send failed; falling back to text", {
          stage: payload.stage,
          symbol: payload.symbol,
          direction: payload.direction,
          error: photoError instanceof Error ? photoError.message : String(photoError)
        });
        await sendTelegramMessage(text);
      }
    }

    const sentAtMs = Date.now();
    rememberRecentReady(enrichedPayload, sentAtMs);
    rememberRecentCaution(enrichedPayload, sentAtMs);
    rememberRecentAlert(enrichedPayload, sentAtMs);

    await recordTelegramAlertSent({
      dedupeKey: enrichedPayload.dedupeKey ?? `${enrichedPayload.stage}:${enrichedPayload.symbol}:${enrichedPayload.direction}:${enrichedPayload.signalType}`,
      stage: enrichedPayload.stage,
      symbol: enrichedPayload.symbol,
      direction: enrichedPayload.direction,
      signalType: enrichedPayload.signalType.trim().toUpperCase()
    });
  })();

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

function findLatestRejectionForSymbol(symbol: string): TradeRejectionEntry | null {
  const normalized = normalizeSymbol(symbol);
  const all = getTradeRejectionLog();
  return all.find((entry) => normalizeSymbol(entry.symbol) === normalized) ?? null;
}

const GLOBAL_RUNTIME_REJECTION_REASONS = new Set<string>([
  "session block",
  "global trade throttle",
  "global cooldown active",
  "rolling drawdown circuit active",
  "daily drawdown limit reached",
  "global kill switch active",
  "concurrent risk cap",
  "max active trades reached",
  "duplicate active trade",
  "duplicate window cooldown",
  "flip cooldown active",
  "cluster exposure cap",
  "directional cluster exposure cap",
  "invalid price data",
  "invalid position size",
  "insufficient balance for fees"
]);

function findLatestGlobalRuntimeRejection(): TradeRejectionEntry | null {
  const all = getTradeRejectionLog();
  const systemEntry = all.find((entry) => normalizeSymbol(entry.symbol) === "SYSTEM") ?? null;
  if (!systemEntry) {
    return null;
  }

  return GLOBAL_RUNTIME_REJECTION_REASONS.has(systemEntry.reason) ? systemEntry : null;
}

function getSignalDirection(signalType: string): "LONG" | "SHORT" | null {
  const upper = signalType.toUpperCase();
  if (upper.includes("LONG")) {
    return "LONG";
  }

  if (upper.includes("SHORT")) {
    return "SHORT";
  }

  return null;
}

function statusEmoji(status: "PASS" | "WARN" | "FAIL"): string {
  if (status === "PASS") {
    return "✅";
  }

  if (status === "WARN") {
    return "⚠️";
  }

  return "❌";
}

function formatUnknownValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? `${value}` : value.toFixed(4);
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return String(value);
  }

  if (value == null) {
    return "n/a";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getNearestFibLevelFromRow(
  row: TokenRsiResult,
  direction: "LONG" | "SHORT"
): { level: string; price: number; distancePct: number } | null {
  const support = Number(row.levels.localSupport ?? 0);
  const resistance = Number(row.levels.localResistance ?? 0);
  const close = Number(row.close ?? 0);

  const highPoint = Math.max(support, resistance, close);
  const lowPoint = Math.min(support, resistance, close);
  const diff = highPoint - lowPoint;

  if (!Number.isFinite(highPoint) || !Number.isFinite(lowPoint) || !Number.isFinite(close) || close <= 0 || diff <= 0) {
    return null;
  }

  const levels = direction === "LONG"
    ? [
      { level: "0%", price: highPoint },
      { level: "23.6%", price: highPoint - diff * 0.236 },
      { level: "38.2%", price: highPoint - diff * 0.382 },
      { level: "50%", price: highPoint - diff * 0.5 },
      { level: "61.8%", price: highPoint - diff * 0.618 },
      { level: "78.6%", price: highPoint - diff * 0.786 },
      { level: "100%", price: lowPoint }
    ]
    : [
      { level: "0%", price: lowPoint },
      { level: "23.6%", price: lowPoint + diff * 0.236 },
      { level: "38.2%", price: lowPoint + diff * 0.382 },
      { level: "50%", price: lowPoint + diff * 0.5 },
      { level: "61.8%", price: lowPoint + diff * 0.618 },
      { level: "78.6%", price: lowPoint + diff * 0.786 },
      { level: "100%", price: highPoint }
    ];

  let nearest = levels[0];
  let nearestDistance = Math.abs(close - nearest.price);

  for (const candidate of levels) {
    const distance = Math.abs(close - candidate.price);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }

  return {
    level: nearest.level,
    price: nearest.price,
    distancePct: (nearestDistance / close) * 100
  };
}

function buildStatusDiagnosticsText(row: TokenRsiResult, rejection: TradeRejectionEntry | null): string {
  const minScore = 5;
  const score = Number(row.confluence.score ?? 0);
  const globalRuntimeRejection = findLatestGlobalRuntimeRejection();
  const hasDirectionalSignal = row.signal.type.includes("LONG") || row.signal.type.includes("SHORT");
  const signalDirection = getSignalDirection(row.signal.type);
  const signal = row.signal.type;
  const nearestFib = signalDirection ? getNearestFibLevelFromRow(row, signalDirection) : null;
  const fibLine = nearestFib
    ? `Nearest ${nearestFib.level} @ ${toFixedSafe(nearestFib.price, 6)} (${toFixedSafe(nearestFib.distancePct, 3)}%)`
    : "Unavailable";
  const fibStatus: "PASS" | "WARN" = nearestFib && nearestFib.distancePct <= 1 ? "PASS" : "WARN";
  const regimeRejected = rejection?.reason === "regime rules";
  const expectedValueRaw = rejection?.details?.expectedValue;
  const minExpectedValueRaw = rejection?.details?.minExpectedValue;
  const hasEvRejection = rejection?.reason === "non-positive EV";

  const lines = [
    `<b>${escapeHtml(normalizeSymbol(row.symbol))} Entry Diagnostics</b>`,
    `Signal ${escapeHtml(signal)} • Score ${escapeHtml(toFixedSafe(score, 1))}/10 • Entry ${escapeHtml(row.entryTiming ?? "N/A")}`,
    "",
    `${statusEmoji(score >= minScore ? "PASS" : "FAIL")} <b>Score</b> ${escapeHtml(toFixedSafe(score, 1))}/10 (threshold ${minScore})`,
    `${statusEmoji(hasDirectionalSignal ? "PASS" : "FAIL")} <b>Signal</b> ${escapeHtml(signal)}${hasDirectionalSignal ? " • directSignalQualified" : ""}`,
    `${statusEmoji((row.entryTiming === "EARLY" || row.entryTiming === "MID") ? "PASS" : "WARN")} <b>Entry Timing</b> ${escapeHtml(row.entryTiming ?? "N/A")}`,
    `${statusEmoji(row.tradeContext.passedVolatility ? "PASS" : "FAIL")} <b>Volatility</b> ${escapeHtml(toFixedSafe(row.volatilityPct, 2))}%`,
    `${statusEmoji(row.tradeContext.passedLiquidity ? "PASS" : "FAIL")} <b>Liquidity</b> ${escapeHtml(formatUsdCompact(row.volume24h))}`,
    `${statusEmoji(row.tradeContext.passedStructure ? "PASS" : "FAIL")} <b>Structure</b> ${row.tradeContext.passedStructure ? "Valid" : "Not valid"}`,
    `${statusEmoji(row.tradeContext.passedMicroTrend ? "PASS" : "FAIL")} <b>MicroTrend</b> ${row.tradeContext.passedMicroTrend ? "Aligned" : "Not aligned"}`,
    `${statusEmoji(regimeRejected ? "FAIL" : "PASS")} <b>Regime</b> ${escapeHtml(row.tradeContext.regime)}${regimeRejected && rejection?.details?.reason ? ` • ${escapeHtml(formatUnknownValue(rejection.details.reason))}` : ""}`,
    `${statusEmoji(fibStatus)} <b>Fib Level Reach</b> ${escapeHtml(fibLine)}`,
    `${statusEmoji(hasEvRejection ? "FAIL" : "PASS")} <b>Expected Value</b> ${hasEvRejection
      ? `${escapeHtml(formatUnknownValue(expectedValueRaw))} (min ${escapeHtml(formatUnknownValue(minExpectedValueRaw))})`
      : "No EV rejection"}`
  ];

  if (globalRuntimeRejection) {
    const runtimeDetails = globalRuntimeRejection.details && Object.keys(globalRuntimeRejection.details).length > 0
      ? ` • ${escapeHtml(formatUnknownValue(globalRuntimeRejection.details))}`
      : "";
    lines.splice(2, 0, `${statusEmoji("WARN")} <b>Global blocker</b> ${escapeHtml(globalRuntimeRejection.reason)}${runtimeDetails}`);
  }

  if (rejection) {
    lines.push(`${statusEmoji("WARN")} <b>Last Rejection</b> ${escapeHtml(rejection.reason)} • ${escapeHtml(formatIsoCompact(rejection.rejectedAt))}`);
    if (rejection.details && Object.keys(rejection.details).length > 0) {
      lines.push("", "<b>Latest Rejection Payload</b>");
      for (const [key, value] of Object.entries(rejection.details)) {
        lines.push(`${escapeHtml(key)}: ${escapeHtml(formatUnknownValue(value))}`);
      }
    }
  }

  return lines.join("\n");
}

async function handleStatusCommand(chatId: number, args: string[], getState: TelegramStateGetter): Promise<void> {
  const symbol = args[0]?.trim();
  if (!symbol) {
    await sendTelegramMessage("Usage: <b>/status BNB</b>", chatId);
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

  const rejection = findLatestRejectionForSymbol(symbol);
  await sendTelegramMessage(buildStatusDiagnosticsText(row, rejection), chatId);
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

  const context: TokenStatusContext = {
    snapshotAsOf: resolveSnapshotAsOf(snapshot),
    recentReady: getRecentReady(symbol),
    recentAlert: getRecentAlert(symbol)
  };

  if (TELEGRAM_ALERT_GRAPHICS_ENABLED) {
    await sendTelegramPhoto(buildTokenStatusImageUrl(row, context.recentAlert?.signalType), buildTokenStatusCaption(row, context), chatId);
    return;
  }

  await sendTelegramMessage(buildTokenStatusText(row, context), chatId);
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

      if (!text.startsWith("/")) {
        continue;
      }

      await dispatchCommand(chatId, text, getState);
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
  console.log("Telegram command listener started (polling user commands)");
  void pollTelegramCommands(getState);
}

export function stopTelegramCommandListener(): void {
  telegramPollingActive = false;
  if (telegramPollTimer) {
    clearTimeout(telegramPollTimer);
    telegramPollTimer = null;
  }
}
