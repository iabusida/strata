import "./env.js";
type AlertStage = "READY" | "OPENED";

type EntryAlertPayload = {
  stage: AlertStage;
  symbol: string;
  direction: "LONG" | "SHORT";
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
const TELEGRAM_ALERT_STAGES = resolveStringEnv("TELEGRAM_ALERT_STAGES", "READY,OPENED")
  .split(",")
  .map((item) => item.trim().toUpperCase())
  .filter((item) => item === "READY" || item === "OPENED") as AlertStage[];
const TELEGRAM_ALERT_DEDUPE_MINUTES = Math.max(
  1,
  Math.trunc(resolveNumberEnv("TELEGRAM_ALERT_DEDUPE_MINUTES", 15))
);
const TELEGRAM_ALERT_GRAPHICS_ENABLED = resolveBooleanEnv("TELEGRAM_ALERT_GRAPHICS_ENABLED", true);

const dedupeByKey = new Map<string, number>();

function shouldSend(stage: AlertStage, symbol: string, direction: "LONG" | "SHORT"): boolean {
  if (!TELEGRAM_ALERTS_ENABLED) {
    return false;
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return false;
  }

  if (!TELEGRAM_ALERT_STAGES.includes(stage)) {
    return false;
  }

  const key = `${stage}:${symbol}:${direction}`;
  const nowMs = Date.now();
  const previousMs = dedupeByKey.get(key) ?? 0;
  const dedupeWindowMs = TELEGRAM_ALERT_DEDUPE_MINUTES * 60 * 1000;

  if (nowMs - previousMs < dedupeWindowMs) {
    return false;
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

function clamp(value: number, minValue: number, maxValue: number): number {
  if (!Number.isFinite(value)) {
    return minValue;
  }

  return Math.max(minValue, Math.min(maxValue, value));
}

function toPercentScore(value: number, maxValue: number): number {
  if (!Number.isFinite(value) || maxValue <= 0) {
    return 0;
  }

  return Number(clamp((value / maxValue) * 100, 0, 100).toFixed(2));
}

function escapeGraphvizText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildPanelImageUrl(payload: EntryAlertPayload): string {
  const tokenDisplay = payload.symbol.includes("-") ? payload.symbol : `${payload.symbol}-PERP`;
  const titleStage = payload.stage === "READY" ? "TRADE-READY" : "POSITION OPENED";
  const directionColor = payload.direction === "LONG" ? "#34d399" : "#f87171";
  const qualityColor = payload.stage === "READY" ? "#22d3ee" : "#fbbf24";

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
    <TD BGCOLOR="#132238" ALIGN="LEFT"><FONT COLOR="#93c5fd" POINT-SIZE="11">SIGNAL STRENGTH</FONT><BR/><FONT COLOR="#f8fafc" POINT-SIZE="15"><B>${toFixedSafe(payload.signalStrength, 3)}</B></FONT></TD>
    <TD BGCOLOR="#132238" ALIGN="LEFT"><FONT COLOR="#93c5fd" POINT-SIZE="11">STRUCTURE</FONT><BR/><FONT COLOR="#f8fafc" POINT-SIZE="15"><B>${toFixedSafe(payload.structureConfidence, 3)}</B></FONT></TD>
    <TD BGCOLOR="#132238" ALIGN="LEFT"><FONT COLOR="#93c5fd" POINT-SIZE="11">TP FEASIBILITY</FONT><BR/><FONT COLOR="#f8fafc" POINT-SIZE="15"><B>${toFixedSafe(payload.tpFeasibility, 3)}</B></FONT></TD>
  </TR>
</TABLE>
>];
}`;

  return `https://quickchart.io/graphviz?format=png&width=1400&height=760&graph=${encodeURIComponent(dot)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildMessage(payload: EntryAlertPayload): string {
  const symbol = escapeHtml(payload.symbol);
  const signalType = escapeHtml(payload.signalType);
  const stageLabel = payload.stage === "READY" ? "READY SETUP" : "TRADE OPENED";
  const directionLabel = payload.direction === "LONG" ? "LONG ▲" : "SHORT ▼";
  const tokenDisplay = symbol.includes("-") ? symbol : `${symbol}-PERP`;

  return [
    `<b>SIGNETIX | ${stageLabel}</b>`,
    `<b>${tokenDisplay}</b> | <b>${directionLabel}</b> | <b>${escapeHtml(payload.marketCondition)}</b>`,
    `Signal: <b>${signalType}</b>`,
    `Score: <b>${toFixedSafe(payload.entryScore, 1)}/10</b> | Weighted: <b>${toFixedSafe(payload.weightedScore, 3)}</b>`,
    `TP/SL: <b>${toFixedSafe(payload.takeProfitPct, 3)}%</b> / <b>${toFixedSafe(payload.stopLossPct, 3)}%</b>`,
    `Vol: <b>${toFixedSafe(payload.volatilityPct, 3)}%</b> | Feasibility: <b>${toFixedSafe(payload.tpFeasibility, 3)}</b>`
  ].join("\n");
}

async function sendTelegramMessage(text: string): Promise<void> {
  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram send failed (${response.status}): ${body}`);
  }
}

async function sendTelegramPhoto(photoUrl: string, caption: string): Promise<void> {
  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      photo: photoUrl,
      caption,
      parse_mode: "HTML"
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendPhoto failed (${response.status}): ${body}`);
  }
}

export function notifyTelegramEntry(payload: EntryAlertPayload): void {
  if (!shouldSend(payload.stage, payload.symbol, payload.direction)) {
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
