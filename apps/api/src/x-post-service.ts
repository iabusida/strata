import type { ScanResult } from "./market-data-service.js";

type ServiceStateSnapshot = {
  analyzedAt?: string;
  results?: ScanResult["results"];
};

type StateGetter = () => ServiceStateSnapshot | null;

type XPostSchedulerState = {
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  totalRuns: number;
  lastPostedSymbol: string | null;
};

const X_POSTS_ENABLED = resolveBooleanEnv("X_AUTO_POST_ENABLED", false);
const X_POST_BEARER_TOKEN = resolveStringEnv("X_BEARER_TOKEN", "");
const X_POST_API_BASE = resolveStringEnv("X_API_BASE", "https://api.x.com/2").replace(/\/$/, "");
const X_POST_INTERVAL_MINUTES = Math.max(10, Math.trunc(resolveNumberEnv("X_AUTO_POST_INTERVAL_MINUTES", 180)));
const X_POST_SYMBOLS = resolveCsvEnv("X_AUTO_POST_SYMBOLS", "ETH,BTC,SOL");
const X_POST_MIN_CONFLUENCE = Math.max(0, Math.min(10, resolveNumberEnv("X_AUTO_POST_MIN_CONFLUENCE", 0)));
const X_POST_APPEND_HASHTAGS = resolveCsvEnv("X_AUTO_POST_HASHTAGS", "ETH,BTC,Strata");

const state: XPostSchedulerState = {
  enabled: false,
  nextRunAt: null,
  lastRunAt: null,
  lastError: null,
  totalRuns: 0,
  lastPostedSymbol: null
};

let schedulerTimer: NodeJS.Timeout | null = null;
let symbolCursor = 0;
const recentPostCache = new Map<string, number>();

function resolveBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  throw new Error(`Invalid boolean env ${name}: ${raw}`);
}

function resolveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env ${name}: ${raw}`);
  }
  return parsed;
}

function resolveStringEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw == null) {
    return fallback;
  }
  return raw.trim();
}

function resolveCsvEnv(name: string, fallback: string): string[] {
  const raw = resolveStringEnv(name, fallback);
  return raw
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
}

function summarizeStructure(row: NonNullable<ServiceStateSnapshot["results"]>[number]): string {
  const nearResistance = Boolean(row.levels?.nearResistance);
  const nearSupport = Boolean(row.levels?.nearSupportFloor);
  if (nearResistance) {
    return "price is near resistance";
  }
  if (nearSupport) {
    return "price is near support";
  }
  return "price is between key levels";
}

function summarizeHtf(row: NonNullable<ServiceStateSnapshot["results"]>[number]): string {
  const htf = row.tradeContext?.higherTimeframeTrend ?? "NEUTRAL";
  if (htf === "BULLISH") {
    return "higher timeframe trend is up";
  }
  if (htf === "BEARISH") {
    return "higher timeframe trend is down";
  }
  return "higher timeframe trend is mixed";
}

function summarizeContext(row: NonNullable<ServiceStateSnapshot["results"]>[number]): string {
  const counterTrend = row.tradeContext?.counterTrendContext;
  if (counterTrend?.isCounterTrend) {
    return "short-term move is counter-trend";
  }
  const structure = row.tradeContext?.structureState;
  if (structure === "CHOP") {
    return "market is choppy";
  }
  if (structure === "REVERSAL") {
    return "structure is trying to reverse";
  }
  return "waiting for cleaner alignment";
}

function buildEngagementQuestion(row: NonNullable<ServiceStateSnapshot["results"]>[number]): string {
  const signal = String(row.signal?.type ?? "NO SIGNAL");
  if (signal.includes("NO SIGNAL")) {
    return "Would you wait for alignment here or stay flat until structure confirms?";
  }
  if (signal.includes("LONG")) {
    return "Would you wait for a pullback first, or take momentum confirmation only?";
  }
  if (signal.includes("SHORT")) {
    return "Would you wait for a failed reclaim first, or take momentum confirmation only?";
  }
  return "What would need to improve before this becomes a clean setup for you?";
}

function fitTextToMax(text: string, maxLength = 280): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function buildXPostText(row: NonNullable<ServiceStateSnapshot["results"]>[number]): string {
  const symbol = String(row.symbol ?? "").toUpperCase();
  const signal = String(row.signal?.type ?? "NO SIGNAL");
  const confluenceScore = Number.isFinite(row.confluence?.score) ? row.confluence.score.toFixed(1) : "n/a";

  const lines = [
    `${symbol} check-in from Strata`,
    ``,
    `Signal: ${signal}`,
    `Confluence: ${confluenceScore}/10`,
    `Read: ${summarizeHtf(row)}, ${summarizeStructure(row)}, ${summarizeContext(row)}.`,
    ``,
    `This is market context, not financial advice.`,
    buildEngagementQuestion(row)
  ];

  const hashtags = X_POST_APPEND_HASHTAGS
    .map((tag) => tag.replace(/[^A-Z0-9]/gi, ""))
    .filter((tag) => tag.length > 0)
    .slice(0, 4)
    .map((tag) => `#${tag}`);

  if (hashtags.length > 0) {
    lines.push("", hashtags.join(" "));
  }

  return fitTextToMax(lines.join("\n"), 280);
}

function hashRowForDedupe(row: NonNullable<ServiceStateSnapshot["results"]>[number]): string {
  return [
    String(row.symbol ?? "").toUpperCase(),
    String(row.signal?.type ?? "NO_SIGNAL"),
    Number.isFinite(row.confluence?.score) ? row.confluence.score.toFixed(1) : "na",
    String(row.tradeContext?.higherTimeframeTrend ?? "NEUTRAL"),
    String(row.levels?.nearSupportFloor ?? false),
    String(row.levels?.nearResistance ?? false)
  ].join("|");
}

function pickNextRow(snapshot: ServiceStateSnapshot): NonNullable<ServiceStateSnapshot["results"]>[number] | null {
  const rows = Array.isArray(snapshot.results) ? snapshot.results : [];
  if (rows.length === 0) {
    return null;
  }

  const symbolPriority = X_POST_SYMBOLS.length > 0 ? X_POST_SYMBOLS : ["ETH", "BTC"];

  for (let attempt = 0; attempt < symbolPriority.length; attempt += 1) {
    const symbol = symbolPriority[symbolCursor % symbolPriority.length];
    symbolCursor += 1;

    const row = rows.find((item) => String(item.symbol ?? "").toUpperCase() === symbol);
    if (!row) {
      continue;
    }
    if (Number(row.confluence?.score ?? 0) < X_POST_MIN_CONFLUENCE) {
      continue;
    }

    const dedupeKey = hashRowForDedupe(row);
    const lastPostedAt = recentPostCache.get(dedupeKey) ?? 0;
    const now = Date.now();
    if (now - lastPostedAt < X_POST_INTERVAL_MINUTES * 60 * 1000) {
      continue;
    }

    return row;
  }

  return null;
}

async function postToX(text: string): Promise<{ id: string; text: string }> {
  if (!X_POST_BEARER_TOKEN) {
    throw new Error("X_BEARER_TOKEN is required to publish posts");
  }

  const response = await fetch(`${X_POST_API_BASE}/tweets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${X_POST_BEARER_TOKEN}`
    },
    body: JSON.stringify({ text })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`X post failed (${response.status}): ${raw}`);
  }

  const parsed = JSON.parse(raw) as { data?: { id?: string; text?: string } };
  const id = String(parsed?.data?.id ?? "");
  if (!id) {
    throw new Error("X post succeeded but response did not include tweet id");
  }

  return { id, text: String(parsed?.data?.text ?? text) };
}

export async function postSignalContextToX(getState: StateGetter): Promise<{
  posted: boolean;
  reason?: string;
  symbol?: string;
  text?: string;
  postId?: string;
}> {
  const snapshot = getState();
  if (!snapshot?.results || snapshot.results.length === 0) {
    return { posted: false, reason: "no_snapshot" };
  }

  const row = pickNextRow(snapshot);
  if (!row) {
    return { posted: false, reason: "no_eligible_symbol" };
  }

  const text = buildXPostText(row);
  const result = await postToX(text);

  const dedupeKey = hashRowForDedupe(row);
  recentPostCache.set(dedupeKey, Date.now());

  return {
    posted: true,
    symbol: row.symbol,
    text: result.text,
    postId: result.id
  };
}

function scheduleNextRun(getState: StateGetter): void {
  if (!state.enabled) {
    return;
  }

  const delayMs = X_POST_INTERVAL_MINUTES * 60 * 1000;
  const runAt = new Date(Date.now() + delayMs).toISOString();
  state.nextRunAt = runAt;

  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
  }

  schedulerTimer = setTimeout(() => {
    void postSignalContextToX(getState)
      .then((result) => {
        state.lastRunAt = new Date().toISOString();
        state.lastError = null;
        state.totalRuns += 1;
        if (result.posted && result.symbol) {
          state.lastPostedSymbol = result.symbol;
          console.info("[x-post] published signal context", {
            symbol: result.symbol,
            postId: result.postId
          });
        } else {
          console.info("[x-post] skipped scheduled publish", { reason: result.reason });
        }
      })
      .catch((error) => {
        const details = error instanceof Error ? error.message : String(error);
        state.lastError = details;
        state.lastRunAt = new Date().toISOString();
        state.totalRuns += 1;
        console.error("[x-post] scheduled publish failed", { error: details });
      })
      .finally(() => {
        scheduleNextRun(getState);
      });
  }, delayMs);
}

export function startXPostScheduler(getState: StateGetter): void {
  if (state.enabled) {
    return;
  }

  if (!X_POSTS_ENABLED) {
    console.info("[x-post] scheduler disabled via X_AUTO_POST_ENABLED=false");
    return;
  }

  state.enabled = true;
  console.info("[x-post] scheduler started", {
    everyMinutes: X_POST_INTERVAL_MINUTES,
    symbols: X_POST_SYMBOLS
  });

  // Immediate first pass so startup can publish if state is already warm.
  void postSignalContextToX(getState)
    .then((result) => {
      state.lastRunAt = new Date().toISOString();
      state.lastError = null;
      state.totalRuns += 1;
      if (result.posted && result.symbol) {
        state.lastPostedSymbol = result.symbol;
      }
      console.info("[x-post] startup publish result", result);
    })
    .catch((error) => {
      state.lastRunAt = new Date().toISOString();
      state.lastError = error instanceof Error ? error.message : String(error);
      state.totalRuns += 1;
      console.error("[x-post] startup publish failed", { error: state.lastError });
    })
    .finally(() => scheduleNextRun(getState));
}

export function stopXPostScheduler(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  state.enabled = false;
  state.nextRunAt = null;
}

export function getXPostSchedulerState(): XPostSchedulerState {
  return { ...state };
}