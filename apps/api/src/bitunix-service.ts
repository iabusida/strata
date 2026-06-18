import "./env.js";
import { createHash, randomBytes } from "node:crypto";
import {
  applySupportFloorGuard,
  calculateLatestAtr,
  calculateLatestEma,
  calculateLatestMacdHistogram,
  calculateLatestRsi,
  calculateSupportResistance,
  calculateStochasticRsiSeries,
  calculateStochasticRsi,
  classifyRsi,
  computeConfluenceScore,
  detectCandlestickPatternSignal,
  determineSignal,
  evaluateDailyReversalBias,
  getSignalCategory,
  getSignalBadge,
  translateTimeframeTrend,
  type CandlestickPatternSignal,
  type MarketType,
  type ScanParams,
  type SkippedToken,
  type TimeframeRsi,
  type TokenRsiResult
} from "./rsi.js";
import { detectRegime } from "./regime-engine.js";
import { evaluateStructure } from "./structure-engine.js";
import { evaluateMicroTrend } from "./ema-engine.js";
import { evaluateSupportResistance } from "./sr-engine.js";
import { detectDescendingTrendlineBreakout, detectAscendingTrendlineBreakdown } from "./trendline-engine.js";
import { classifyEntryTiming, type EntryTiming } from "./entry-timing.js";
import type { LatestOhlc, OrderBookExecutionRead, PerpAssetContext, ScanResult } from "./market-data-service.js";
import { WebSocket } from "ws";

type BitunixTradingPairRow = {
  symbol?: string;
  base?: string;
  quote?: string;
  symbolStatus?: string;
  maxLeverage?: number | string;
};

type BitunixTickerRow = {
  symbol?: string;
  last?: string;
  lastPrice?: string;
  markPrice?: string;
  open?: string;
  high?: string;
  low?: string;
  quoteVol?: string;
  baseVol?: string;
  change?: string;
  chg?: string;
  changePercent?: string;
  priceChangePercent?: string;
  changeRate?: string;
  riseFallRate?: string;
  rose?: string;
};

type BitunixFundingRow = {
  symbol?: string;
  markPrice?: string;
  lastPrice?: string;
  fundingRate?: string;
  nextFundingTime?: string;
  fundingInterval?: number;
};

type BitunixDepthRow = {
  asks?: Array<[string | number, string | number]>;
  bids?: Array<[string | number, string | number]>;
};

type BitunixPrivateApiEnvelope<T> = {
  code?: string | number;
  msg?: string;
  data?: T;
};

type BitunixAccountRow = {
  marginCoin?: string;
  available?: string;
  frozen?: string;
  margin?: string;
  transfer?: string;
  positionMode?: string;
  crossUnrealizedPNL?: string;
  isolationUnrealizedPNL?: string;
  bonus?: string;
};

type BitunixPendingPositionRow = {
  positionId?: string;
  symbol?: string;
  qty?: string;
  entryValue?: string;
  side?: string;
  marginMode?: string;
  positionMode?: string;
  leverage?: number;
  fee?: string;
  funding?: string;
  realizedPNL?: string;
  margin?: string;
  unrealizedPNL?: string;
  liqPrice?: string;
  marginRate?: string;
  avgOpenPrice?: string;
  ctime?: number;
  mtime?: number;
};

type BitunixLeverageModeRow = {
  symbol?: string;
  marginCoin?: string;
  leverage?: number | string;
  marginMode?: string;
};

type BitunixPendingTpslOrderRow = {
  id?: string;
  positionId?: string;
  symbol?: string;
  tpPrice?: string;
  slPrice?: string;
  tpStopType?: string;
  slStopType?: string;
  tpOrderType?: string;
  slOrderType?: string;
  status?: string;
};

type BitunixPendingOpenOrderRow = {
  orderId?: string | number;
  clientId?: string;
  symbol?: string;
  side?: string;
  tradeSide?: string;
  orderType?: string;
  status?: string;
  qty?: string | number;
  price?: string | number;
  ctime?: string | number;
  mtime?: string | number;
  createTime?: string | number;
  updateTime?: string | number;
};

type BitunixClosedPositionHistoryRow = {
  id?: string | number;
  orderId?: string | number;
  positionId?: string | number;
  symbol?: string;
  side?: string;
  status?: string;
  marginCoin?: string;
  leverage?: string | number;
  qty?: string | number;
  closeQty?: string | number;
  avgOpenPrice?: string | number;
  avgClosePrice?: string | number;
  realizedPNL?: string | number;
  pnl?: string | number;
  roi?: string | number;
  ctime?: string | number;
  openTime?: string | number;
  mtime?: string | number;
  closeTime?: string | number;
};

export type BitunixPrivateAuthStatus = {
  configured: boolean;
  missing: string[];
  keyPreview: string | null;
};

export type BitunixAccountSnapshot = {
  provider: "BITUNIX";
  fetchedAt: string;
  marginCoin: string;
  account: BitunixAccountRow | null;
  positions: BitunixPendingPositionRow[];
  positionSummary: {
    openPositions: number;
    longPositions: number;
    shortPositions: number;
    grossNotionalUsd: number;
    netUnrealizedPnlUsd: number;
    totalMarginUsd: number;
  };
  auth: BitunixPrivateAuthStatus;
};

export type BitunixLeverageCheckResult = {
  symbol: string;
  marginCoin: string;
  currentLeverage: number;
  marginMode: string;
  minRequiredLeverage: number;
  meetsMinLeverage: boolean;
};

export type BitunixLiveOrderSide = "BUY" | "SELL";

export type BitunixLiveOrderResult = {
  orderId: string;
  clientId: string;
  symbol: string;
  side: BitunixLiveOrderSide;
  qty: number;
};

export type BitunixPendingPosition = {
  positionId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  avgOpenPrice: number;
  leverage: number;
  marginMode: string;
  margin: number;
  unrealizedPnl: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type BitunixPendingTpslOrder = {
  id: string;
  positionId: string;
  symbol: string;
  tpPrice: number;
  slPrice: number;
  status: string;
};

export type BitunixPendingOpenOrder = {
  orderId: string;
  clientId: string;
  symbol: string;
  side: "BUY" | "SELL";
  tradeSide: string;
  orderType: string;
  status: string;
  qty: number;
  price: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type BitunixClosedTradeHistoryItem = {
  dedupeKey: string;
  exchangeTradeId: string | null;
  symbol: string;
  direction: "LONG" | "SHORT";
  marginCoin: string | null;
  status: string;
  openedAt: string | null;
  closedAt: string;
  entryPrice: number | null;
  closePrice: number | null;
  leverage: number | null;
  qty: number | null;
  realizedPnlUsd: number | null;
  roiPct: number | null;
  rawPayload: Record<string, unknown>;
};

type BitunixInstrumentMeta = {
  externalSymbol: string;
  symbol: string;
  maxLeverage: number;
};

type NormalizedCandle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

function normalizeBitunixPositionSide(sideRaw: string): "LONG" | "SHORT" | null {
  const side = String(sideRaw ?? "").trim().toUpperCase();
  if (side === "LONG" || side === "BUY") {
    return "LONG";
  }
  if (side === "SHORT" || side === "SELL") {
    return "SHORT";
  }
  return null;
}

type BitunixWsPriceUpdate = {
  symbol: string;
  price: number;
  at: number;
};

const BITUNIX_API_BASE_URL = String(process.env.BITUNIX_API_BASE_URL ?? "https://fapi.bitunix.com").trim().replace(/\/$/, "");
const BITUNIX_API_KEY = String(process.env.BITUNIX_API_KEY ?? "").trim();
const BITUNIX_API_SECRET = String(process.env.BITUNIX_API_SECRET ?? "").trim();
const BITUNIX_API_LANGUAGE = String(process.env.BITUNIX_API_LANGUAGE ?? "en-US").trim() || "en-US";
const BITUNIX_ACCOUNT_MARGIN_COIN = String(process.env.BITUNIX_ACCOUNT_MARGIN_COIN ?? "USDT").trim().toUpperCase() || "USDT";
const BITUNIX_MARKET_WS_URL = String(
  process.env.BITUNIX_MARKET_WS_URL ?? "wss://api.bitunix.com/message-center-ws-market/msg_center/market"
).trim();
const BITUNIX_MARKET_WS_CHANNELS = String(
  process.env.BITUNIX_MARKET_WS_CHANNELS ?? "ticker,futures_coin_pair_change,futures_deal_remind,price_remind"
)
  .split(",")
  .map((item) => item.trim())
  .filter((item) => item.length > 0);

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

function resolveSymbolSetEnv(name: string, defaultValue: string): Set<string> {
  const raw = process.env[name] ?? defaultValue;
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter((item) => item.length > 0)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isBitunixCloudflareChallengeResponse(response: Response, bodyText?: string): boolean {
  const cfMitigated = String(response.headers.get("cf-mitigated") ?? "").trim().toLowerCase();
  if (cfMitigated === "challenge") {
    return true;
  }

  const text = String(bodyText ?? "").toLowerCase();
  return text.includes("just a moment") || text.includes("challenges.cloudflare.com");
}

function isRetryableFetchError(error: unknown): boolean {
  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes("request too frequently") ||
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("timeout") ||
    message.includes("fetch")
  );
}

async function withRetry<T>(operation: () => Promise<T>, context: string, maxAttempts: number, baseDelayMs: number): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableFetchError(error) || attempt >= maxAttempts) {
        break;
      }

      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      console.warn(`[scan:rsi:bitunix] retry ${attempt}/${maxAttempts - 1} for ${context} in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  throw new Error(`${context}: ${extractErrorMessage(lastError)}`);
}

function assertBitunixNotBlocked(context: string): void {
  if (Date.now() < _bitunixBlockedUntilMs) {
    throw new Error(`Bitunix temporarily blocked by Cloudflare challenge (${context}); retry after ${new Date(_bitunixBlockedUntilMs).toISOString()}`);
  }
}

async function bitunixGet<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  assertBitunixNotBlocked(`public ${path}`);
  const url = new URL(path, BITUNIX_API_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    if (isBitunixCloudflareChallengeResponse(response)) {
      markBitunixBlocked(`public ${path}`);
      throw new Error(`Bitunix public API blocked by Cloudflare challenge (${path})`);
    }
    throw new Error(`Bitunix request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as { code?: string | number; msg?: string; data?: T };
  if (String(payload.code) !== "0") {
    throw new Error(`Bitunix payload error: ${payload.msg ?? "unknown error"}`);
  }

  return (payload.data ?? []) as T;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildCanonicalQueryParams(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value != null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right));

  return entries.map(([key, value]) => `${key}${String(value)}`).join("");
}

function buildPrivateRequestHeaders(params: Record<string, string | undefined>, body: string): {
  headers: Record<string, string>;
  auth: BitunixPrivateAuthStatus;
} {
  const auth = getBitunixPrivateAuthStatus();
  if (!auth.configured) {
    throw new Error(`Bitunix private credentials missing: ${auth.missing.join(", ")}`);
  }

  const nonce = randomBytes(16).toString("hex");
  const timestamp = String(Date.now());
  const canonicalQuery = buildCanonicalQueryParams(params);
  const digest = sha256Hex(`${nonce}${timestamp}${BITUNIX_API_KEY}${canonicalQuery}${body}`);
  const sign = sha256Hex(`${digest}${BITUNIX_API_SECRET}`);

  return {
    headers: {
      accept: "application/json",
      "Content-Type": "application/json",
      "api-key": BITUNIX_API_KEY,
      nonce,
      timestamp,
      sign,
      language: BITUNIX_API_LANGUAGE
    },
    auth
  };
}

async function bitunixPrivateGet<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  assertBitunixNotBlocked(`private ${path}`);
  const entries = Object.entries(params)
    .filter(([, value]) => value != null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right));

  const url = new URL(path, BITUNIX_API_BASE_URL);
  for (const [key, value] of entries) {
    url.searchParams.set(key, String(value));
  }

  const body = "";
  const { headers } = buildPrivateRequestHeaders(Object.fromEntries(entries), body);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers
  });

  if (!response.ok) {
    const responseBody = await response.text();
    if (isBitunixCloudflareChallengeResponse(response, responseBody)) {
      markBitunixBlocked(`private ${path}`);
      throw new Error(`Bitunix private API blocked by Cloudflare challenge (${path})`);
    }
    throw new Error(`Bitunix private request failed: ${response.status} ${response.statusText} ${responseBody}`);
  }

  const payload = await response.json() as BitunixPrivateApiEnvelope<T>;
  if (String(payload.code) !== "0") {
    throw new Error(`Bitunix private payload error: ${payload.msg ?? "unknown error"}`);
  }

  return (payload.data ?? []) as T;
}

async function bitunixPrivatePost<T>(path: string, bodyObj: Record<string, unknown>): Promise<T> {
  assertBitunixNotBlocked(`private ${path}`);
  const body = JSON.stringify(bodyObj);
  const { headers } = buildPrivateRequestHeaders({}, body);
  const url = new URL(path, BITUNIX_API_BASE_URL);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body
  });

  if (!response.ok) {
    const responseBody = await response.text();
    if (isBitunixCloudflareChallengeResponse(response, responseBody)) {
      markBitunixBlocked(`private ${path}`);
      throw new Error(`Bitunix private API blocked by Cloudflare challenge (${path})`);
    }
    throw new Error(`Bitunix private request failed: ${response.status} ${response.statusText} ${responseBody}`);
  }

  const payload = await response.json() as BitunixPrivateApiEnvelope<T>;
  if (String(payload.code) !== "0") {
    throw new Error(`Bitunix private payload error: ${payload.msg ?? "unknown error"}`);
  }

  return (payload.data ?? {}) as T;
}

function previewApiKey(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}***`;
  }

  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

export function getBitunixPrivateAuthStatus(): BitunixPrivateAuthStatus {
  const missing: string[] = [];
  if (!BITUNIX_API_KEY) {
    missing.push("BITUNIX_API_KEY");
  }
  if (!BITUNIX_API_SECRET) {
    missing.push("BITUNIX_API_SECRET");
  }

  return {
    configured: missing.length === 0,
    missing,
    keyPreview: previewApiKey(BITUNIX_API_KEY)
  };
}

export async function fetchBitunixAccountSnapshot(marginCoinRaw?: string): Promise<BitunixAccountSnapshot> {
  const marginCoin = (marginCoinRaw?.trim().toUpperCase() || BITUNIX_ACCOUNT_MARGIN_COIN);
  const auth = getBitunixPrivateAuthStatus();
  if (!auth.configured) {
    throw new Error(`Bitunix private credentials missing: ${auth.missing.join(", ")}`);
  }

  const [accountPayload, positions] = await Promise.all([
    bitunixPrivateGet<BitunixAccountRow[] | BitunixAccountRow>("/api/v1/futures/account", { marginCoin }),
    bitunixPrivateGet<BitunixPendingPositionRow[]>("/api/v1/futures/position/get_pending_positions", {})
  ]);

  const accountRows = Array.isArray(accountPayload)
    ? accountPayload
    : accountPayload && typeof accountPayload === "object"
      ? [accountPayload]
      : [];

  const account = accountRows.find((item) => String(item.marginCoin ?? "").toUpperCase() === marginCoin) ?? accountRows[0] ?? null;

  if (account) {
    console.log("[bitunix] Account snapshot fetched", {
      marginCoin,
      available: account.available,
      frozen: account.frozen,
      margin: account.margin,
      transfer: account.transfer,
      crossUnrealizedPNL: account.crossUnrealizedPNL,
      isolationUnrealizedPNL: account.isolationUnrealizedPNL,
      bonus: account.bonus
    });
  } else {
    console.warn("[bitunix] No account data found for marginCoin", { marginCoin, accountRowCount: accountRows.length });
  }

  const normalizedPositions = Array.isArray(positions) ? positions : [];
  let longPositions = 0;
  let shortPositions = 0;
  let grossNotionalUsd = 0;
  let netUnrealizedPnlUsd = 0;
  let totalMarginUsd = 0;

  for (const position of normalizedPositions) {
    const side = normalizeBitunixPositionSide(String(position.side ?? ""));
    if (side === "LONG") {
      longPositions += 1;
    }
    if (side === "SHORT") {
      shortPositions += 1;
    }

    const entryValue = parseNumber(position.entryValue);
    const qty = Math.abs(parseNumber(position.qty));
    const avgOpenPrice = parseNumber(position.avgOpenPrice);
    const inferredNotional = qty > 0 && avgOpenPrice > 0 ? qty * avgOpenPrice : 0;
    const notional = entryValue > 0 ? entryValue : inferredNotional;
    if (Number.isFinite(notional) && notional > 0) {
      grossNotionalUsd += notional;
    }

    const unrealized = parseNumber(position.unrealizedPNL);
    if (Number.isFinite(unrealized)) {
      netUnrealizedPnlUsd += unrealized;
    }

    const margin = parseNumber(position.margin);
    if (Number.isFinite(margin) && margin > 0) {
      totalMarginUsd += margin;
    }
  }

  return {
    provider: "BITUNIX",
    fetchedAt: new Date().toISOString(),
    marginCoin,
    account,
    positions: normalizedPositions,
    positionSummary: {
      openPositions: normalizedPositions.length,
      longPositions,
      shortPositions,
      grossNotionalUsd: Number(grossNotionalUsd.toFixed(2)),
      netUnrealizedPnlUsd: Number(netUnrealizedPnlUsd.toFixed(6)),
      totalMarginUsd: Number(totalMarginUsd.toFixed(6))
    },
    auth
  };
}

export async function fetchBitunixLeverageCheck(
  symbolRaw: string,
  minRequiredLeverage: number,
  marginCoinRaw?: string
): Promise<BitunixLeverageCheckResult> {
  const marginCoin = (marginCoinRaw?.trim().toUpperCase() || BITUNIX_ACCOUNT_MARGIN_COIN);
  const symbol = toOkxPerpInstId(symbolRaw);
  const payload = await bitunixPrivateGet<BitunixLeverageModeRow[] | BitunixLeverageModeRow>(
    "/api/v1/futures/account/get_leverage_margin_mode",
    { symbol, marginCoin }
  );

  const row = Array.isArray(payload)
    ? payload[0]
    : payload;

  const currentLeverage = Math.max(0, Math.trunc(parseNumber(row?.leverage)));
  const marginMode = String(row?.marginMode ?? "UNKNOWN").toUpperCase();
  const minRequired = Math.max(1, Math.trunc(minRequiredLeverage));

  return {
    symbol,
    marginCoin,
    currentLeverage,
    marginMode,
    minRequiredLeverage: minRequired,
    meetsMinLeverage: currentLeverage >= minRequired
  };
}

function formatBitunixDecimal(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return value.toFixed(8).replace(/\.?0+$/, "");
}

export async function changeBitunixLeverage(
  symbolRaw: string,
  leverageRaw: number,
  marginCoinRaw?: string
): Promise<{ symbol: string; marginCoin: string; leverage: number }> {
  const symbol = toOkxPerpInstId(symbolRaw);
  const marginCoin = (marginCoinRaw?.trim().toUpperCase() || BITUNIX_ACCOUNT_MARGIN_COIN);
  const leverage = Math.max(1, Math.trunc(leverageRaw));

  const payload = await bitunixPrivatePost<Array<{ symbol?: string; marginCoin?: string; leverage?: number | string }> | {
    symbol?: string;
    marginCoin?: string;
    leverage?: number | string;
  }>("/api/v1/futures/account/change_leverage", {
    symbol,
    marginCoin,
    leverage
  });

  const row = Array.isArray(payload) ? payload[0] : payload;
  return {
    symbol: String(row?.symbol ?? symbol).toUpperCase(),
    marginCoin: String(row?.marginCoin ?? marginCoin).toUpperCase(),
    leverage: Math.max(1, Math.trunc(parseNumber(row?.leverage ?? leverage)))
  };
}

export async function placeBitunixMarketOrder(input: {
  symbol: string;
  side: BitunixLiveOrderSide;
  qty: number;
  marginMode?: "ISOLATED" | "CROSSED";
  clientId?: string;
  tpPrice?: number;
  tpStopType?: "MARK" | "LAST";
  tpOrderType?: "LIMIT" | "MARKET";
  tpOrderPrice?: number;
  slPrice?: number;
  slStopType?: "MARK" | "LAST";
  slOrderType?: "LIMIT" | "MARKET";
  slOrderPrice?: number;
}): Promise<BitunixLiveOrderResult> {
  const symbol = toOkxPerpInstId(input.symbol);
  const qty = Math.max(0, Number(input.qty));
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`Invalid Bitunix market order qty: ${input.qty}`);
  }

  const body: Record<string, unknown> = {
    symbol,
    side: input.side,
    tradeSide: "OPEN",
    orderType: "MARKET",
    qty: formatBitunixDecimal(qty),
    clientId: input.clientId
  };

  if (input.marginMode) {
    body.marginMode = input.marginMode;
  }

  if (Number.isFinite(input.tpPrice) && Number(input.tpPrice) > 0) {
    body.tpPrice = formatBitunixDecimal(Number(input.tpPrice));
    body.tpStopType = input.tpStopType ?? "MARK";
    body.tpOrderType = input.tpOrderType ?? "MARKET";
    if ((input.tpOrderType ?? "MARKET") === "LIMIT" && Number.isFinite(input.tpOrderPrice) && Number(input.tpOrderPrice) > 0) {
      body.tpOrderPrice = formatBitunixDecimal(Number(input.tpOrderPrice));
    }
  }

  if (Number.isFinite(input.slPrice) && Number(input.slPrice) > 0) {
    body.slPrice = formatBitunixDecimal(Number(input.slPrice));
    body.slStopType = input.slStopType ?? "MARK";
    body.slOrderType = input.slOrderType ?? "MARKET";
    if ((input.slOrderType ?? "MARKET") === "LIMIT" && Number.isFinite(input.slOrderPrice) && Number(input.slOrderPrice) > 0) {
      body.slOrderPrice = formatBitunixDecimal(Number(input.slOrderPrice));
    }
  }

  const payload = await bitunixPrivatePost<{ orderId?: string; clientId?: string }>("/api/v1/futures/trade/place_order", body);

  return {
    orderId: String(payload.orderId ?? ""),
    clientId: String(payload.clientId ?? input.clientId ?? ""),
    symbol,
    side: input.side,
    qty
  };
}

export async function placeBitunixLimitOrder(input: {
  symbol: string;
  side: BitunixLiveOrderSide;
  qty: number;
  price: number;
  marginMode?: "ISOLATED" | "CROSSED";
  clientId?: string;
  tpPrice?: number;
  tpStopType?: "MARK" | "LAST";
  slPrice?: number;
  slStopType?: "MARK" | "LAST";
}): Promise<BitunixLiveOrderResult> {
  const symbol = toOkxPerpInstId(input.symbol);
  const qty = Math.max(0, Number(input.qty));
  const price = Number(input.price);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`Invalid Bitunix limit order qty: ${input.qty}`);
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid Bitunix limit order price: ${input.price}`);
  }

  const body: Record<string, unknown> = {
    symbol,
    side: input.side,
    tradeSide: "OPEN",
    orderType: "LIMIT",
    qty: formatBitunixDecimal(qty),
    price: formatBitunixDecimal(price),
    clientId: input.clientId
  };

  if (input.marginMode) {
    body.marginMode = input.marginMode;
  }

  if (Number.isFinite(input.tpPrice) && Number(input.tpPrice) > 0) {
    body.tpPrice = formatBitunixDecimal(Number(input.tpPrice));
    body.tpStopType = input.tpStopType ?? "MARK";
    body.tpOrderType = "MARKET";
  }

  if (Number.isFinite(input.slPrice) && Number(input.slPrice) > 0) {
    body.slPrice = formatBitunixDecimal(Number(input.slPrice));
    body.slStopType = input.slStopType ?? "MARK";
    body.slOrderType = "MARKET";
  }

  const payload = await bitunixPrivatePost<{ orderId?: string; clientId?: string }>("/api/v1/futures/trade/place_order", body);

  return {
    orderId: String(payload.orderId ?? ""),
    clientId: String(payload.clientId ?? input.clientId ?? ""),
    symbol,
    side: input.side,
    qty
  };
}

export async function fetchBitunixPendingPositions(symbolRaw?: string): Promise<BitunixPendingPosition[]> {
  const symbol = symbolRaw ? toOkxPerpInstId(symbolRaw) : undefined;
  const payload = await bitunixPrivateGet<BitunixPendingPositionRow[]>(
    "/api/v1/futures/position/get_pending_positions",
    { symbol }
  );

  const rows = Array.isArray(payload) ? payload : [];
  return rows
    .map((row) => {
      const side = normalizeBitunixPositionSide(String(row.side ?? ""));
      const qty = Math.abs(parseNumber(row.qty));
      if (!side || !Number.isFinite(qty) || qty <= 0) {
        return null;
      }

      return {
        positionId: String(row.positionId ?? ""),
        symbol: String(row.symbol ?? "").toUpperCase(),
        side,
        qty,
        avgOpenPrice: parseNumber(row.avgOpenPrice),
        leverage: Math.max(1, Math.trunc(parseNumber(row.leverage))),
        marginMode: String(row.marginMode ?? "UNKNOWN").toUpperCase(),
        margin: parseNumber(row.margin),
        unrealizedPnl: parseNumber(row.unrealizedPNL),
        createdAtMs: parseBitunixTimestampMs(row.ctime),
        updatedAtMs: parseBitunixTimestampMs(row.mtime)
      } satisfies BitunixPendingPosition;
    })
    .filter((row): row is BitunixPendingPosition => row !== null);
}

export async function fetchBitunixPendingTpslOrders(input: {
  symbol?: string;
  positionId?: string;
} = {}): Promise<BitunixPendingTpslOrder[]> {
  const symbol = input.symbol ? toOkxPerpInstId(input.symbol) : undefined;
  const positionId = String(input.positionId ?? "").trim() || undefined;
  const payload = await bitunixPrivateGet<BitunixPendingTpslOrderRow[]>(
    "/api/v1/futures/tpsl/get_pending_orders",
    {
      symbol,
      positionId
    }
  );

  const rows = Array.isArray(payload) ? payload : [];
  return rows
    .map((row) => {
      const id = String(row.id ?? "").trim();
      const rowPositionId = String(row.positionId ?? "").trim();
      const rowSymbol = String(row.symbol ?? "").trim().toUpperCase();
      if (!rowPositionId || !rowSymbol) {
        return null;
      }

      return {
        id,
        positionId: rowPositionId,
        symbol: rowSymbol,
        tpPrice: parseNumber(row.tpPrice),
        slPrice: parseNumber(row.slPrice),
        status: String(row.status ?? "").toUpperCase()
      } satisfies BitunixPendingTpslOrder;
    })
    .filter((row): row is BitunixPendingTpslOrder => row !== null);
}

function normalizeBitunixOrderSide(sideRaw: string): "BUY" | "SELL" | null {
  const side = String(sideRaw ?? "").trim().toUpperCase();
  if (side === "BUY" || side === "LONG") {
    return "BUY";
  }
  if (side === "SELL" || side === "SHORT") {
    return "SELL";
  }
  return null;
}

function parseBitunixTimestampMs(raw: unknown): number {
  const n = Number(raw);
  if (Number.isFinite(n)) {
    if (n > 1_000_000_000_000) {
      return Math.trunc(n);
    }
    if (n > 1_000_000_000) {
      return Math.trunc(n * 1000);
    }
  }

  const asString = String(raw ?? "").trim();
  if (!asString) {
    return 0;
  }
  const parsed = Date.parse(asString);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function fetchBitunixPendingOpenOrders(input: {
  symbol?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<BitunixPendingOpenOrder[]> {
  const symbol = input.symbol ? toOkxPerpInstId(input.symbol) : undefined;
  const page = Number.isFinite(Number(input.page)) ? Math.max(1, Math.trunc(Number(input.page))) : 1;
  const pageSize = Number.isFinite(Number(input.pageSize))
    ? Math.min(200, Math.max(1, Math.trunc(Number(input.pageSize))))
    : 100;

  const candidates: Array<{ endpoint: string; params: Record<string, string | undefined> }> = [
    {
      endpoint: "/api/v1/futures/trade/get_pending_orders",
      params: { page: String(page), pageSize: String(pageSize), symbol }
    },
    {
      endpoint: "/api/v1/futures/order/get_pending_orders",
      params: { page: String(page), pageSize: String(pageSize), symbol }
    },
    {
      endpoint: "/api/v1/futures/trade/get_current_orders",
      params: { page: String(page), pageSize: String(pageSize), symbol }
    },
    {
      endpoint: "/api/v1/futures/order/get_current_orders",
      params: { page: String(page), pageSize: String(pageSize), symbol }
    }
  ];

  let lastError: string | null = null;
  for (const candidate of candidates) {
    const sanitizedParams = Object.fromEntries(
      Object.entries(candidate.params).filter(([, value]) => value != null && value !== "")
    ) as Record<string, string>;

    try {
      const payload = await bitunixPrivateGet<
        BitunixPendingOpenOrderRow[] | { rows?: BitunixPendingOpenOrderRow[]; list?: BitunixPendingOpenOrderRow[] }
      >(candidate.endpoint, sanitizedParams);

      const rowsRaw = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.rows)
          ? payload.rows
          : Array.isArray(payload?.list)
            ? payload.list
            : [];

      return rowsRaw
        .map((row) => {
          const orderId = String(row.orderId ?? "").trim();
          const normalizedSymbol = String(row.symbol ?? "").trim().toUpperCase();
          const side = normalizeBitunixOrderSide(String(row.side ?? ""));
          if (!orderId || !normalizedSymbol || !side) {
            return null;
          }

          const createdAtMs = parseBitunixTimestampMs(row.ctime ?? row.createTime);
          const updatedAtMs = parseBitunixTimestampMs(row.mtime ?? row.updateTime);
          return {
            orderId,
            clientId: String(row.clientId ?? "").trim(),
            symbol: normalizedSymbol,
            side,
            tradeSide: String(row.tradeSide ?? "").trim().toUpperCase(),
            orderType: String(row.orderType ?? "").trim().toUpperCase(),
            status: String(row.status ?? "").trim().toUpperCase(),
            qty: Math.max(0, parseNumber(row.qty)),
            price: Math.max(0, parseNumber(row.price)),
            createdAtMs,
            updatedAtMs
          } satisfies BitunixPendingOpenOrder;
        })
        .filter((row): row is BitunixPendingOpenOrder => row !== null);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`Bitunix pending open orders fetch failed across endpoints: ${lastError ?? "unknown error"}`);
}

export async function cancelBitunixOpenOrder(input: {
  orderId: string;
  symbol?: string;
}): Promise<{ orderId: string }> {
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) {
    throw new Error("Bitunix cancel order requires orderId");
  }

  const symbol = input.symbol ? toOkxPerpInstId(input.symbol) : undefined;
  const candidates: Array<{ endpoint: string; payload: Record<string, unknown> }> = [
    {
      endpoint: "/api/v1/futures/trade/cancel_order",
      payload: { orderId, symbol }
    },
    {
      endpoint: "/api/v1/futures/order/cancel_order",
      payload: { orderId, symbol }
    }
  ];

  let lastError: string | null = null;
  for (const candidate of candidates) {
    const sanitizedPayload = Object.fromEntries(
      Object.entries(candidate.payload).filter(([, value]) => value != null && value !== "")
    ) as Record<string, unknown>;
    try {
      await bitunixPrivatePost<unknown>(candidate.endpoint, sanitizedPayload);
      return { orderId };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`Bitunix cancel order failed for ${orderId}: ${lastError ?? "unknown error"}`);
}

export async function fetchBitunixClosedTradeHistory(input: {
  page?: number;
  pageSize?: number;
  symbol?: string;
} = {}): Promise<{
  rows: BitunixClosedTradeHistoryItem[];
  endpointUsed: string | null;
  attempts: Array<{ endpoint: string; ok: boolean; count?: number; error?: string }>;
}> {
  const symbol = input.symbol ? toOkxPerpInstId(input.symbol) : undefined;
  const page = Number.isFinite(Number(input.page)) ? Math.max(1, Math.trunc(Number(input.page))) : 1;
  const pageSize = Number.isFinite(Number(input.pageSize))
    ? Math.min(200, Math.max(1, Math.trunc(Number(input.pageSize))))
    : 100;

  const candidates: Array<{ endpoint: string; params: Record<string, string | undefined> }> = [
    {
      endpoint: "/api/v1/futures/position/get_history_positions",
      params: { page: String(page), pageSize: String(pageSize), symbol }
    },
    {
      endpoint: "/api/v1/futures/position/get_history_position",
      params: { page: String(page), pageSize: String(pageSize), symbol }
    },
    {
      endpoint: "/api/v1/futures/trade/get_history_orders",
      params: { page: String(page), pageSize: String(pageSize), symbol }
    },
    {
      endpoint: "/api/v1/futures/order/get_history_orders",
      params: { page: String(page), pageSize: String(pageSize), symbol }
    }
  ];

  const attempts: Array<{ endpoint: string; ok: boolean; count?: number; error?: string }> = [];

  for (const candidate of candidates) {
    const sanitizedParams = Object.fromEntries(
      Object.entries(candidate.params).filter(([, value]) => value != null && value !== "")
    ) as Record<string, string>;

    try {
      const payload = await bitunixPrivateGet<
        BitunixClosedPositionHistoryRow[] | { rows?: BitunixClosedPositionHistoryRow[]; list?: BitunixClosedPositionHistoryRow[] }
      >(candidate.endpoint, sanitizedParams);

      const rowsRaw = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.rows)
          ? payload.rows
          : Array.isArray(payload?.list)
            ? payload.list
            : [];

      const rows = rowsRaw
        .map((row) => normalizeClosedTradeHistoryRow(row))
        .filter((row): row is BitunixClosedTradeHistoryItem => row !== null)
        .sort((left, right) => Date.parse(right.closedAt) - Date.parse(left.closedAt));

      attempts.push({ endpoint: candidate.endpoint, ok: true, count: rows.length });
      return {
        rows,
        endpointUsed: candidate.endpoint,
        attempts
      };
    } catch (error) {
      attempts.push({
        endpoint: candidate.endpoint,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  throw new Error(
    `Bitunix closed trade history fetch failed across endpoints: ${attempts
      .map((item) => `${item.endpoint}: ${item.error ?? "unknown error"}`)
      .join(" | ")}`
  );
}

export async function flashCloseBitunixPosition(positionId: string): Promise<{ positionId: string }> {
  const normalized = String(positionId ?? "").trim();
  if (!normalized) {
    throw new Error("Bitunix flash close requires a positionId");
  }

  const payload = await bitunixPrivatePost<{ positionId?: string }>("/api/v1/futures/trade/flash_close_position", {
    positionId: normalized
  });

  return {
    positionId: String(payload.positionId ?? normalized)
  };
}

export async function attachBitunixPositionTpSlDebug(input: {
  positionId: string;
  tpPrice: number;
  slPrice: number;
  symbol?: string;
  side?: "LONG" | "SHORT";
}): Promise<{
  success: boolean;
  attempts: Array<{
    endpoint: string;
    payload: Record<string, unknown>;
    ok: boolean;
    result?: unknown;
    error?: string;
  }>;
}> {
  const positionId = String(input.positionId ?? "").trim();
  if (!positionId) {
    throw new Error("attachBitunixPositionTpSlDebug requires positionId");
  }

  const tpPrice = Number(input.tpPrice);
  const slPrice = Number(input.slPrice);
  if (!Number.isFinite(tpPrice) || tpPrice <= 0 || !Number.isFinite(slPrice) || slPrice <= 0) {
    throw new Error(`Invalid TP/SL prices tp=${input.tpPrice} sl=${input.slPrice}`);
  }

  const symbol = input.symbol ? toOkxPerpInstId(input.symbol) : undefined;
  const side = input.side ? String(input.side).toUpperCase() : undefined;

  const candidates: Array<{ endpoint: string; payload: Record<string, unknown> }> = [
    {
      endpoint: "/api/v1/futures/tpsl/position/place_order",
      payload: {
        positionId,
        symbol,
        side,
        tpPrice: formatBitunixDecimal(tpPrice),
        tpStopType: "MARK",
        slPrice: formatBitunixDecimal(slPrice),
        slStopType: "MARK"
      }
    },
    {
      endpoint: "/api/v1/futures/tpsl/place_order",
      payload: {
        positionId,
        symbol,
        side,
        tpPrice: formatBitunixDecimal(tpPrice),
        tpStopType: "MARK",
        slPrice: formatBitunixDecimal(slPrice),
        slStopType: "MARK",
        tpOrderType: "MARKET",
        slOrderType: "MARKET",
        tpQty: "0",
        slQty: "0"
      }
    }
  ];

  const attempts: Array<{
    endpoint: string;
    payload: Record<string, unknown>;
    ok: boolean;
    result?: unknown;
    error?: string;
  }> = [];

  for (const candidate of candidates) {
    const sanitizedPayload = Object.fromEntries(
      Object.entries(candidate.payload).filter(([, value]) => value !== undefined && value !== null && value !== "")
    );
    try {
      const result = await bitunixPrivatePost<unknown>(candidate.endpoint, sanitizedPayload);
      attempts.push({
        endpoint: candidate.endpoint,
        payload: sanitizedPayload,
        ok: true,
        result
      });
      return { success: true, attempts };
    } catch (error) {
      attempts.push({
        endpoint: candidate.endpoint,
        payload: sanitizedPayload,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    success: false,
    attempts
  };
}

const VOLATILITY_LOOKBACK_CANDLES = Math.max(10, Math.trunc(resolveNumberEnv("VOLATILITY_LOOKBACK_CANDLES", 14)));
const MIN_VOLATILITY_PCT = resolveNumberEnv("MIN_VOLATILITY_PCT", 1.5);
const SCAN_MIN_24H_CHANGE_PCT = Math.max(0, resolveNumberEnv("LIQUIDITY_HUNT_MIN_24H_CHANGE_PCT", 8));
const SCAN_MAX_24H_CHANGE_PCT = Math.max(
  SCAN_MIN_24H_CHANGE_PCT,
  resolveNumberEnv("LIQUIDITY_HUNT_MAX_24H_CHANGE_PCT", 35)
);
const MIN_VOLUME_USD = resolveNumberEnv("MIN_VOLUME_USD", 7_000_000);
const MIN_VOLUME_USD_MAJOR_ALT = resolveNumberEnv("MIN_VOLUME_USD_MAJOR_ALT", 3_000_000);
const MAJOR_ALT_SYMBOLS = resolveSymbolSetEnv(
  "MAJOR_ALT_SYMBOLS",
  "SOL,BNB,XRP,DOGE,ADA,TON,AVAX,LINK,DOT,LTC,TRX,BCH,APT,ARB,OP,INJ,ONDO,SUI,NEAR"
);
const MICRO_TREND_EMA_PERIOD = 20;
const ORDERBOOK_DEPTH_BPS = Math.max(1, Math.trunc(resolveNumberEnv("ORDERBOOK_DEPTH_BPS", 10)));
const ORDERBOOK_REFERENCE_NOTIONAL_USD = Math.max(100, resolveNumberEnv("ORDERBOOK_REFERENCE_NOTIONAL_USD", 2000));
const ORDERBOOK_MIN_DEPTH_MULTIPLIER = Math.max(1, resolveNumberEnv("ORDERBOOK_MIN_DEPTH_MULTIPLIER", 2));
const ORDERBOOK_MAX_SPREAD_PCT_LARGE = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_LARGE", 0.03));
const ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT", 0.08));
const ORDERBOOK_MAX_SPREAD_PCT_ALT = Math.max(0.001, resolveNumberEnv("ORDERBOOK_MAX_SPREAD_PCT_ALT", 0.06));
const ORDERBOOK_MAX_AGAINST_IMBALANCE = Math.max(0, Math.min(1, resolveNumberEnv("ORDERBOOK_MAX_AGAINST_IMBALANCE", 0.25)));
const ORDERBOOK_MAX_AGAINST_IMBALANCE_MAJOR_ALT = Math.max(
  0,
  Math.min(1, resolveNumberEnv("ORDERBOOK_MAX_AGAINST_IMBALANCE_MAJOR_ALT", 0.35))
);
const SCAN_FETCH_MAX_ATTEMPTS = Math.max(1, Math.trunc(resolveNumberEnv("SCAN_FETCH_MAX_ATTEMPTS", 4)));
const SCAN_FETCH_BACKOFF_MS = Math.max(50, Math.trunc(resolveNumberEnv("SCAN_FETCH_BACKOFF_MS", 250)));
const SCAN_SYMBOL_CONCURRENCY = Math.max(1, Math.trunc(resolveNumberEnv("BITUNIX_SCAN_SYMBOL_CONCURRENCY", 1)));

// Stocks, ETFs, and commodity perpetuals listed on Bitunix — excluded from all crypto scanning.
// Overrideable via BITUNIX_NON_CRYPTO_SYMBOLS env var (comma-separated base symbols to block).
const BITUNIX_NON_CRYPTO_SYMBOLS: Set<string> = resolveSymbolSetEnv(
  "BITUNIX_NON_CRYPTO_SYMBOLS",
  "AAPL,AMD,AMZN,AVGO,BABA,BRKB,C,CL,COIN,COST,EWJ,EWY,F,GC,GOOGL,HOOD,INTC,JPM,META,MRVL,MSFT,MSTR,NATGAS,NFLX,NVDA,ORCL,PAXG,PLTR,QCOM,QQQ,RKLB,SI,SNDK,SOXL,SPX,SPY,TSLA,TSM,USO,WMT,XAG,XAU,XAUT,XPD,XPT"
);
const SCAN_CHUNK_DELAY_MS = Math.max(0, Math.trunc(resolveNumberEnv("SCAN_CHUNK_DELAY_MS", 120)));
const VOLUME_CACHE_TTL_MS = Math.max(5_000, Math.trunc(resolveNumberEnv("VOLUME_CACHE_TTL_MS", 60_000)));
const ASSET_LIST_CACHE_TTL_MS = Math.max(10_000, Math.trunc(resolveNumberEnv("ASSET_LIST_CACHE_TTL_MS", 300_000)));
const FUNDING_CACHE_TTL_MS = Math.max(10_000, Math.trunc(resolveNumberEnv("BITUNIX_FUNDING_CACHE_TTL_MS", 60_000)));
const INSTRUMENT_CACHE_TTL_MS = Math.max(60_000, Math.trunc(resolveNumberEnv("BITUNIX_INSTRUMENT_CACHE_TTL_MS", 300_000)));
const BITUNIX_WS_PRICE_MAX_AGE_MS = Math.max(2_000, Math.trunc(resolveNumberEnv("BITUNIX_WS_PRICE_MAX_AGE_MS", 30_000)));
const BITUNIX_WS_RECONNECT_DELAY_MS = Math.max(1_000, Math.trunc(resolveNumberEnv("BITUNIX_WS_RECONNECT_DELAY_MS", 3_000)));
const PERP_CTX_REST_REFRESH_MS = Math.max(1_000, Math.trunc(resolveNumberEnv("BITUNIX_PERP_CTX_REST_REFRESH_MS", 20_000)));
const PERP_CTX_CACHE_TTL_MS = Math.max(1_000, Math.trunc(resolveNumberEnv("BITUNIX_PERP_CTX_CACHE_TTL_MS", 4_000)));
const BITUNIX_WS_STATS_LOG_INTERVAL_MS = Math.max(10_000, Math.trunc(resolveNumberEnv("BITUNIX_WS_STATS_LOG_INTERVAL_MS", 60_000)));
const BITUNIX_CLOUDFLARE_BACKOFF_MS = 5 * 60 * 1000;

let _volumeCache: Map<string, number> | null = null;
let _volumeCacheAt = 0;
let _changeCache: Map<string, number> | null = null;
let _changeCacheAt = 0;
let _assetListCache: { perp: string[]; spot: string[] } | null = null;
let _assetListCacheAt = 0;
let _perpInstrumentCache: Map<string, BitunixInstrumentMeta> | null = null;
let _perpInstrumentByInstId: Map<string, BitunixInstrumentMeta> | null = null;
let _perpInstrumentCacheAt = 0;
let _fundingCache = new Map<string, { rate: number; at: number }>();
let _perpCtxCache: Map<string, PerpAssetContext> | null = null;
let _perpCtxCacheAt = 0;
let _bitunixMarketWs: WebSocket | null = null;
let _bitunixMarketWsConnected = false;
let _bitunixMarketWsReconnectTimer: NodeJS.Timeout | null = null;
let _bitunixBlockedUntilMs = 0;
const _bitunixWsPriceBySymbol = new Map<string, BitunixWsPriceUpdate>();
let _wsOverlayLookupsTotal = 0;
let _wsOverlayHits = 0;
let _lastWsStatsLoggedAt = 0;
let _lastBitunixBlockLoggedAt = 0;

function markBitunixBlocked(source: string): void {
  const now = Date.now();
  _bitunixBlockedUntilMs = Math.max(_bitunixBlockedUntilMs, now + BITUNIX_CLOUDFLARE_BACKOFF_MS);

  if (now - _lastBitunixBlockLoggedAt < 30_000) {
    return;
  }

  _lastBitunixBlockLoggedAt = now;
  console.warn("[scan:rsi:bitunix] Bitunix blocked by Cloudflare challenge; backing off", {
    source,
    backoffMs: BITUNIX_CLOUDFLARE_BACKOFF_MS,
    resumeAt: new Date(_bitunixBlockedUntilMs).toISOString()
  });
}

const BITUNIX_BAR_MAP: Record<string, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "12h": "12h",
  "1d": "1d"
};

function normalizePerpSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (!upper) {
    return upper;
  }

  if (upper.endsWith("-PERP")) {
    return upper;
  }

  if (upper.endsWith("USDT")) {
    return `${upper.slice(0, -4)}-PERP`;
  }

  return `${upper}-PERP`;
}

function getBaseSymbol(symbol: string): string {
  const normalized = normalizePerpSymbol(symbol);
  return normalized.endsWith("-PERP") ? normalized.slice(0, -5) : normalized;
}

function toOkxPerpInstId(symbol: string): string {
  return `${getBaseSymbol(symbol)}USDT`;
}

function toExternalPerpSymbol(instId: string): string {
  const upper = instId.trim().toUpperCase();
  if (upper.endsWith("USDT")) {
    return `${upper.slice(0, -4)}-PERP`;
  }

  return upper;
}

function isLargeCapSymbol(symbol: string): boolean {
  const base = getBaseSymbol(symbol);
  return base === "BTC" || base === "ETH";
}

function isMajorAltSymbol(symbol: string): boolean {
  const base = getBaseSymbol(symbol);
  return MAJOR_ALT_SYMBOLS.has(base);
}

function getMinVolumeUsdForSymbol(symbol: string): number {
  if (isLargeCapSymbol(symbol)) {
    return MIN_VOLUME_USD;
  }

  if (isMajorAltSymbol(symbol)) {
    return MIN_VOLUME_USD_MAJOR_ALT;
  }

  return MIN_VOLUME_USD;
}

function getOrderBookSpreadLimitPct(symbol: string): number {
  if (isLargeCapSymbol(symbol)) {
    return ORDERBOOK_MAX_SPREAD_PCT_LARGE;
  }

  if (isMajorAltSymbol(symbol)) {
    return ORDERBOOK_MAX_SPREAD_PCT_MAJOR_ALT;
  }

  return ORDERBOOK_MAX_SPREAD_PCT_ALT;
}

function getOrderBookMaxAgainstImbalance(symbol: string): number {
  if (isMajorAltSymbol(symbol) && !isLargeCapSymbol(symbol)) {
    return ORDERBOOK_MAX_AGAINST_IMBALANCE_MAJOR_ALT;
  }

  return ORDERBOOK_MAX_AGAINST_IMBALANCE;
}

function signalToDirection(signalType: string): "LONG" | "SHORT" | null {
  if (signalType.includes("LONG")) {
    return "LONG";
  }
  if (signalType.includes("SHORT")) {
    return "SHORT";
  }
  return null;
}

function parseNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseBitunixTimestampToIso(value: unknown): string | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  const asDate = new Date(ms);
  const asMs = asDate.getTime();
  if (!Number.isFinite(asMs) || asMs <= 0) {
    return null;
  }

  return asDate.toISOString();
}

function normalizeClosedTradeHistoryRow(row: BitunixClosedPositionHistoryRow): BitunixClosedTradeHistoryItem | null {
  const symbol = String(row.symbol ?? "").trim().toUpperCase();
  const direction = normalizeBitunixPositionSide(String(row.side ?? ""));
  const openedAt = parseBitunixTimestampToIso(row.openTime ?? row.ctime);
  const closedAt = parseBitunixTimestampToIso(row.closeTime ?? row.mtime);
  const idCandidate = String(row.id ?? row.orderId ?? row.positionId ?? "").trim();
  const entryPrice = parseNumber(row.avgOpenPrice);
  const closePrice = parseNumber(row.avgClosePrice);
  const qty = Math.abs(parseNumber(row.closeQty ?? row.qty));
  const leverage = parseNumber(row.leverage);
  const realizedPnlUsd = parseNumber(row.realizedPNL ?? row.pnl);
  const roiRaw = parseNumber(row.roi);
  const roiPct = Math.abs(roiRaw) > 1 ? roiRaw : roiRaw * 100;

  if (!symbol || !direction || !closedAt) {
    return null;
  }

  const dedupeKey = [
    "BITUNIX",
    symbol,
    direction,
    idCandidate || "NO_ID",
    openedAt ?? "NO_OPEN",
    closedAt,
    qty.toFixed(8),
    closePrice.toFixed(8)
  ].join(":");

  return {
    dedupeKey,
    exchangeTradeId: idCandidate || null,
    symbol,
    direction,
    marginCoin: String(row.marginCoin ?? "").trim().toUpperCase() || null,
    status: String(row.status ?? "CLOSED").trim().toUpperCase() || "CLOSED",
    openedAt,
    closedAt,
    entryPrice: Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : null,
    closePrice: Number.isFinite(closePrice) && closePrice > 0 ? closePrice : null,
    leverage: Number.isFinite(leverage) && leverage > 0 ? leverage : null,
    qty: Number.isFinite(qty) && qty > 0 ? qty : null,
    realizedPnlUsd: Number.isFinite(realizedPnlUsd) ? realizedPnlUsd : null,
    roiPct: Number.isFinite(roiPct) ? roiPct : null,
    rawPayload: row as unknown as Record<string, unknown>
  };
}

function normalizeWsSymbol(rawSymbol: unknown): string {
  const candidate = String(rawSymbol ?? "").trim().toUpperCase();
  if (!candidate) {
    return "";
  }

  if (candidate.endsWith("-PERP")) {
    return candidate;
  }

  if (candidate.endsWith("USDT")) {
    return toExternalPerpSymbol(candidate);
  }

  return normalizePerpSymbol(candidate);
}

function extractWsSymbol(node: unknown): string {
  if (!node || typeof node !== "object") {
    return "";
  }

  const record = node as Record<string, unknown>;
  const direct = normalizeWsSymbol(record.symbol ?? record.instId ?? record.s ?? record.baseCoin);
  if (direct) {
    return direct;
  }

  return "";
}

function extractWsPrice(node: unknown): number {
  if (!node || typeof node !== "object") {
    return 0;
  }

  const record = node as Record<string, unknown>;
  const direct = parseNumber(record.markPrice ?? record.lastPrice ?? record.last ?? record.price ?? record.p ?? record.c);
  if (direct > 0) {
    return direct;
  }

  return 0;
}

function recordWsPriceUpdate(payload: unknown): void {
  const queue: unknown[] = [payload];
  const now = Date.now();

  while (queue.length > 0) {
    const current = queue.pop();
    if (Array.isArray(current)) {
      for (const entry of current) {
        queue.push(entry);
      }
      continue;
    }

    if (!current || typeof current !== "object") {
      continue;
    }

    const symbol = extractWsSymbol(current);
    const price = extractWsPrice(current);
    if (symbol && price > 0) {
      _bitunixWsPriceBySymbol.set(symbol, { symbol, price, at: now });
    }

    const record = current as Record<string, unknown>;
    for (const nested of [record.data, record.content, record.result, record.list, record.rows, record.payload]) {
      if (nested != null && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }
}

function scheduleBitunixWsReconnect(): void {
  if (_bitunixMarketWsReconnectTimer) {
    return;
  }

  const now = Date.now();
  const delayMs = now < _bitunixBlockedUntilMs
    ? Math.max(BITUNIX_WS_RECONNECT_DELAY_MS, _bitunixBlockedUntilMs - now)
    : BITUNIX_WS_RECONNECT_DELAY_MS;

  _bitunixMarketWsReconnectTimer = setTimeout(() => {
    _bitunixMarketWsReconnectTimer = null;
    startBitunixMarketWs();
  }, delayMs);
}

function startBitunixMarketWs(): void {
  if (_bitunixMarketWs) {
    return;
  }

  if (Date.now() < _bitunixBlockedUntilMs) {
    scheduleBitunixWsReconnect();
    return;
  }

  try {
    const ws = new WebSocket(BITUNIX_MARKET_WS_URL, { handshakeTimeout: 10_000 });
    _bitunixMarketWs = ws;

    ws.on("open", () => {
      _bitunixMarketWsConnected = true;
      for (const channel of BITUNIX_MARKET_WS_CHANNELS) {
        ws.send(JSON.stringify({ event: "sub", channel }));
      }
      console.info("[scan:rsi:bitunix] market websocket connected", {
        url: BITUNIX_MARKET_WS_URL,
        channels: BITUNIX_MARKET_WS_CHANNELS
      });
    });

    ws.on("message", (data) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return;
      }

      const record = payload as Record<string, unknown>;
      if (record?.event === "ping") {
        try {
          ws.send(JSON.stringify({ event: "pong", ping: record.ping, pong: record.ping }));
        } catch {
          // noop
        }
      }

      recordWsPriceUpdate(payload);
    });

    ws.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Unexpected server response: 403")) {
        markBitunixBlocked("market websocket");
      }
      console.warn("[scan:rsi:bitunix] market websocket error", {
        error: message
      });
    });

    ws.on("close", () => {
      _bitunixMarketWsConnected = false;
      _bitunixMarketWs = null;
      scheduleBitunixWsReconnect();
      console.warn("[scan:rsi:bitunix] market websocket disconnected; scheduling reconnect");
    });
  } catch (error) {
    _bitunixMarketWs = null;
    _bitunixMarketWsConnected = false;
    scheduleBitunixWsReconnect();
    console.warn("[scan:rsi:bitunix] failed to start market websocket", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function getFreshWsPrice(symbol: string): number {
  const update = _bitunixWsPriceBySymbol.get(symbol);
  if (!update) {
    return 0;
  }

  if (Date.now() - update.at > BITUNIX_WS_PRICE_MAX_AGE_MS) {
    return 0;
  }

  return update.price;
}

function countFreshWsPrices(): number {
  const now = Date.now();
  let count = 0;
  for (const update of _bitunixWsPriceBySymbol.values()) {
    if (now - update.at <= BITUNIX_WS_PRICE_MAX_AGE_MS) {
      count += 1;
    }
  }
  return count;
}

function maybeLogWsOverlayStats(): void {
  const now = Date.now();
  if (now - _lastWsStatsLoggedAt < BITUNIX_WS_STATS_LOG_INTERVAL_MS) {
    return;
  }

  _lastWsStatsLoggedAt = now;
  const lookups = _wsOverlayLookupsTotal;
  const hits = _wsOverlayHits;
  const hitRate = lookups > 0 ? Number(((hits / lookups) * 100).toFixed(2)) : 0;
  console.info("[scan:rsi:bitunix] ws overlay stats", {
    connected: _bitunixMarketWsConnected,
    lookups,
    hits,
    hitRatePct: hitRate,
    freshSymbols: countFreshWsPrices(),
    trackedSymbols: _bitunixWsPriceBySymbol.size
  });
}

function applyWsPriceOverlay(context: PerpAssetContext): PerpAssetContext {
  if (_bitunixWsPriceBySymbol.size === 0) {
    return context;
  }

  _wsOverlayLookupsTotal += 1;
  const wsPrice = getFreshWsPrice(context.symbol);
  if (wsPrice <= 0) {
    return context;
  }

  _wsOverlayHits += 1;

  return {
    ...context,
    markPrice: wsPrice,
    oraclePrice: wsPrice,
    midPrice: wsPrice
  };
}

export function getBitunixMarketWsStatus(): {
  enabled: boolean;
  url: string;
  channels: string[];
  connected: boolean;
  trackedSymbols: number;
  freshSymbols: number;
  overlayLookups: number;
  overlayHits: number;
  overlayHitRatePct: number;
} {
  const lookups = _wsOverlayLookupsTotal;
  const hits = _wsOverlayHits;
  const hitRate = lookups > 0 ? Number(((hits / lookups) * 100).toFixed(2)) : 0;

  return {
    enabled: true,
    url: BITUNIX_MARKET_WS_URL,
    channels: [...BITUNIX_MARKET_WS_CHANNELS],
    connected: _bitunixMarketWsConnected,
    trackedSymbols: _bitunixWsPriceBySymbol.size,
    freshSymbols: countFreshWsPrices(),
    overlayLookups: lookups,
    overlayHits: hits,
    overlayHitRatePct: hitRate
  };
}

export function getBitunixMarketWsPrice(symbolRaw: string): {
  symbol: string;
  price: number;
  at: string | null;
  ageMs: number | null;
  fresh: boolean;
} {
  const symbol = normalizePerpSymbol(symbolRaw);
  const update = _bitunixWsPriceBySymbol.get(symbol);
  if (!update) {
    return {
      symbol,
      price: 0,
      at: null,
      ageMs: null,
      fresh: false
    };
  }

  const now = Date.now();
  const ageMs = Math.max(0, now - update.at);
  return {
    symbol,
    price: update.price,
    at: new Date(update.at).toISOString(),
    ageMs,
    fresh: ageMs <= BITUNIX_WS_PRICE_MAX_AGE_MS
  };
}

function parseCandleRow(row: unknown): NormalizedCandle | null {
  if (!Array.isArray(row) || row.length < 6) {
    return null;
  }

  const t = parseNumber(row[0]);
  const o = parseNumber(row[1]);
  const h = parseNumber(row[2]);
  const l = parseNumber(row[3]);
  const c = parseNumber(row[4]);
  const v = parseNumber(row[7] ?? row[6] ?? row[5]);
  if (![t, o, h, l, c].every((item) => Number.isFinite(item) && item > 0)) {
    return null;
  }

  return { t, o, h, l, c, v: Number.isFinite(v) && v >= 0 ? v : 0 };
}

async function getPerpInstruments(): Promise<{ bySymbol: Map<string, BitunixInstrumentMeta>; byInstId: Map<string, BitunixInstrumentMeta> }> {
  const now = Date.now();
  if (_perpInstrumentCache && _perpInstrumentByInstId && now - _perpInstrumentCacheAt < INSTRUMENT_CACHE_TTL_MS) {
    return { bySymbol: _perpInstrumentCache, byInstId: _perpInstrumentByInstId };
  }

  const rows = await withRetry(
    () => bitunixGet<BitunixTradingPairRow[]>("/api/v1/futures/market/trading_pairs", {}),
    "fetch Bitunix trading pairs",
    SCAN_FETCH_MAX_ATTEMPTS,
    SCAN_FETCH_BACKOFF_MS
  );

  const bySymbol = new Map<string, BitunixInstrumentMeta>();
  const byInstId = new Map<string, BitunixInstrumentMeta>();
  for (const row of rows) {
    const instId = String(row.symbol ?? "").trim().toUpperCase();
    if (!instId.endsWith("USDT")) {
      continue;
    }
    if (String(row.symbolStatus ?? "").toUpperCase() !== "OPEN") {
      continue;
    }

    // Strip trailing USDT to get the base symbol and reject non-crypto instruments
    const baseForFilter = instId.endsWith("USDT") ? instId.slice(0, -4) : instId;
    if (BITUNIX_NON_CRYPTO_SYMBOLS.has(baseForFilter)) {
      continue;
    }

    const meta: BitunixInstrumentMeta = {
      externalSymbol: toExternalPerpSymbol(instId),
      symbol: instId,
      maxLeverage: Math.max(1, Math.trunc(parseNumber(row.maxLeverage)))
    };
    bySymbol.set(meta.externalSymbol, meta);
    byInstId.set(instId, meta);
  }

  _perpInstrumentCache = bySymbol;
  _perpInstrumentByInstId = byInstId;
  // Only cache if the result looks like a full universe (guards against Cloudflare partial/blocked responses)
  if (bySymbol.size >= 50) {
    _perpInstrumentCacheAt = Date.now();
  } else {
    console.warn("[scan:bitunix] getPerpInstruments returned suspiciously small result; skipping cache", { size: bySymbol.size });
    _perpInstrumentCacheAt = 0; // force re-fetch next call
  }
  return { bySymbol, byInstId };
}

async function fetchSpotSymbols(): Promise<string[]> {
  return [];
}

/**
 * Returns the set of normalized external symbols (-PERP suffix) that currently
 * have an active (symbolStatus=OPEN) perpetual contract on Bitunix.
 * Uses the same instrument cache as getPerpInstruments().
 */
export async function fetchActiveBitunixPerpSymbols(): Promise<Set<string>> {
  const { bySymbol } = await getPerpInstruments();
  return new Set(bySymbol.keys());
}

async function fetchCandlesByInstId(instId: string, interval: keyof typeof BITUNIX_BAR_MAP, count: number): Promise<NormalizedCandle[]> {
  const bar = BITUNIX_BAR_MAP[interval];
  const dedup = new Map<number, NormalizedCandle>();
  let cursor: string | undefined;

  while (dedup.size < count) {
    const limit = String(Math.min(100, Math.max(10, count - dedup.size + 5)));
    const rows = await withRetry(
      () => bitunixGet<Array<{ open?: number; high?: number; low?: number; close?: number; time?: number; quoteVol?: string; baseVol?: string }>>(
        "/api/v1/futures/market/kline",
        {
          symbol: instId,
          interval: bar,
          limit,
          endTime: cursor
        }
      ),
      `${instId} ${interval} candles`,
      SCAN_FETCH_MAX_ATTEMPTS,
      SCAN_FETCH_BACKOFF_MS
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      break;
    }

    const parsed = rows
      .map((row) => {
        const t = parseNumber(row.time);
        const o = parseNumber(row.open);
        const h = parseNumber(row.high);
        const l = parseNumber(row.low);
        const c = parseNumber(row.close);
        const v = parseNumber(row.quoteVol ?? row.baseVol);
        if (![t, o, h, l, c].every((item) => Number.isFinite(item) && item > 0)) {
          return null;
        }
        return { t, o, h, l, c, v: Number.isFinite(v) && v >= 0 ? v : 0 } satisfies NormalizedCandle;
      })
      .filter((row): row is NormalizedCandle => row != null)
      .sort((left, right) => left.t - right.t);

    if (parsed.length === 0) {
      break;
    }

    for (const candle of parsed) {
      dedup.set(candle.t, candle);
    }

    const oldestTs = parsed[0]?.t;
    if (!Number.isFinite(oldestTs) || String(oldestTs) === cursor) {
      break;
    }

    cursor = String(oldestTs);
    if (rows.length < Number(limit)) {
      break;
    }
  }

  return Array.from(dedup.values()).sort((left, right) => left.t - right.t).slice(-count);
}

async function fetchPerpFundingRate(instId: string): Promise<number> {
  const cached = _fundingCache.get(instId);
  if (cached && Date.now() - cached.at < FUNDING_CACHE_TTL_MS) {
    return cached.rate;
  }

  const rows = await withRetry(
    () => bitunixGet<BitunixFundingRow[]>("/api/v1/futures/market/funding_rate", { symbol: instId }),
    `${instId} funding rate`,
    SCAN_FETCH_MAX_ATTEMPTS,
    SCAN_FETCH_BACKOFF_MS
  );

  const rate = parseNumber(rows[0]?.fundingRate);
  _fundingCache.set(instId, { rate, at: Date.now() });
  return rate;
}

function calculateVolumeUsdFromTicker(ticker: BitunixTickerRow, _instrument: BitunixInstrumentMeta | undefined): number {
  const last = parseNumber(ticker.lastPrice ?? ticker.last);
  const quoteVol = parseNumber(ticker.quoteVol);
  const baseVol = parseNumber(ticker.baseVol);

  if (quoteVol > 0) {
    return Number(quoteVol.toFixed(2));
  }
  if (baseVol > 0 && last > 0) {
    return Number((baseVol * last).toFixed(2));
  }
  return 0;
}

function parseTickerChangePct(ticker: BitunixTickerRow): number | null {
  const parseMaybe = (value: unknown): number | null => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  // Preferred path: derive 24h change from open and latest price, which exists on Bitunix tickers.
  const open = parseMaybe(ticker.open);
  const last = parseMaybe(ticker.lastPrice ?? ticker.last);
  if (open != null && last != null && open > 0) {
    const pct = ((last - open) / open) * 100;
    const abs = Math.abs(pct);
    if (Number.isFinite(pct) && abs <= 400) {
      return Number(pct.toFixed(3));
    }
  }

  const directPercentCandidates: Array<number | null> = [
    parseMaybe(ticker.changePercent),
    parseMaybe(ticker.priceChangePercent),
    parseMaybe(ticker.change),
    parseMaybe(ticker.chg)
  ];
  for (const candidate of directPercentCandidates) {
    if (candidate != null) {
      const abs = Math.abs(candidate);
      if (abs <= 400) {
        return Number(candidate.toFixed(3));
      }
    }
  }

  const ratioCandidates: Array<number | null> = [
    parseMaybe(ticker.changeRate),
    parseMaybe(ticker.riseFallRate),
    parseMaybe(ticker.rose)
  ];
  for (const candidate of ratioCandidates) {
    if (candidate != null) {
      const pct = candidate * 100;
      const abs = Math.abs(pct);
      if (abs <= 400) {
        return Number(pct.toFixed(3));
      }
    }
  }

  return null;
}

function resolveEntryTiming(signalType: string, item: Pick<TokenRsiResult, "close" | "levels" | "tradeContext">): EntryTiming | null {
  const direction = signalToDirection(signalType);
  if (!direction) {
    return null;
  }

  return classifyEntryTiming({
    direction,
    price: item.close,
    atr: item.tradeContext.atr,
    supportDistancePct: item.levels.supportDistancePct,
    resistanceDistancePct: item.levels.resistanceDistancePct,
    ema20: item.tradeContext.ema20
  });
}

export async function fetchLatestOhlc(symbol: string, interval: "1m" | "5m" | "15m" | "1h" | "4h" = "5m"): Promise<LatestOhlc | null> {
  const candles = await fetchCandlesByInstId(toOkxPerpInstId(symbol), interval, 4);
  const latest = candles.at(-1);
  if (!latest) {
    return null;
  }

  return {
    open: latest.o,
    high: latest.h,
    low: latest.l,
    close: latest.c,
    time: latest.t
  };
}

export async function fetchPerpContexts(symbols: string[]): Promise<Map<string, PerpAssetContext>> {
  startBitunixMarketWs();

  const normalizedSymbols = symbols.map((symbol) => normalizePerpSymbol(symbol)).filter((symbol) => symbol.length > 0);
  const wanted = new Set(normalizedSymbols);
  if (wanted.size === 0) {
    return new Map();
  }

  const now = Date.now();
  const hasFreshWsData = countFreshWsPrices() > 0;
  const restRefreshIntervalMs = _bitunixMarketWsConnected && hasFreshWsData
    ? PERP_CTX_REST_REFRESH_MS
    : PERP_CTX_CACHE_TTL_MS;
  if (_perpCtxCache && now - _perpCtxCacheAt < restRefreshIntervalMs) {
    const cached = new Map<string, PerpAssetContext>();
    for (const symbol of wanted) {
      const entry = _perpCtxCache.get(symbol);
      if (entry) {
        cached.set(symbol, applyWsPriceOverlay(entry));
      }
    }
    maybeLogWsOverlayStats();
    return cached;
  }

  const [{ byInstId, bySymbol }, tickers, fundingRows] = await Promise.all([
    getPerpInstruments(),
    withRetry(
      () => bitunixGet<BitunixTickerRow[]>("/api/v1/futures/market/tickers", {}),
      "fetch Bitunix tickers",
      SCAN_FETCH_MAX_ATTEMPTS,
      SCAN_FETCH_BACKOFF_MS
    ),
    withRetry(
      () => bitunixGet<BitunixFundingRow[]>("/api/v1/futures/market/funding_rate/batch", {}),
      "fetch Bitunix funding batch",
      SCAN_FETCH_MAX_ATTEMPTS,
      SCAN_FETCH_BACKOFF_MS
    )
  ]);

  const tickerMap = new Map(tickers.map((row) => [String(row.symbol ?? "").trim().toUpperCase(), row]));
  const fundingBatchMap = new Map(fundingRows.map((row) => [String(row.symbol ?? "").trim().toUpperCase(), row]));

  const fundingEntries = await Promise.all(
    Array.from(wanted).map(async (symbol) => {
      const instrument = bySymbol.get(symbol);
      if (!instrument) {
        return [symbol, 0] as const;
      }
      try {
        const batchRate = parseNumber(fundingBatchMap.get(instrument.symbol)?.fundingRate);
        if (Number.isFinite(batchRate)) {
          return [symbol, batchRate] as const;
        }
        return [symbol, await fetchPerpFundingRate(instrument.symbol)] as const;
      } catch {
        return [symbol, 0] as const;
      }
    })
  );
  const fundingMap = new Map(fundingEntries);

  const fullCache = new Map<string, PerpAssetContext>();
  for (const [instId, instrument] of byInstId.entries()) {
    const ticker = tickerMap.get(instId);
    if (!ticker) {
      continue;
    }

    const fundingRow = fundingBatchMap.get(instId);
    const lastPrice = parseNumber(ticker.lastPrice ?? ticker.last);
    const markPrice = parseNumber(ticker.markPrice ?? fundingRow?.markPrice) || lastPrice;
    const midPrice = markPrice;
    const openInterest = 0;
    const openInterestUsd = 0;
    const dayNtlVolume = calculateVolumeUsdFromTicker(ticker, instrument);

    fullCache.set(instrument.externalSymbol, {
      symbol: instrument.externalSymbol,
      fundingRate: fundingMap.get(instrument.externalSymbol) ?? 0,
      markPrice,
      oraclePrice: markPrice,
      midPrice,
      openInterest,
      openInterestUsd,
      dayNtlVolume,
      maxLeverage: instrument.maxLeverage
    });
  }

  _perpCtxCache = fullCache;
  _perpCtxCacheAt = Date.now();

  const result = new Map<string, PerpAssetContext>();
  for (const symbol of wanted) {
    const entry = fullCache.get(symbol);
    if (entry) {
      result.set(symbol, applyWsPriceOverlay(entry));
    }
  }

  maybeLogWsOverlayStats();

  return result;
}

function sumDepthUsdWithinBps(levels: string[][] | undefined, markPrice: number, bps: number): number {
  if (!levels || levels.length === 0 || !Number.isFinite(markPrice) || markPrice <= 0) {
    return 0;
  }

  const limitPct = bps / 10_000;
  let total = 0;
  for (const level of levels) {
    const px = parseNumber(level?.[0]);
    const sz = parseNumber(level?.[1]);
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(sz) || sz <= 0) {
      continue;
    }
    const distancePct = Math.abs(px - markPrice) / markPrice;
    if (distancePct <= limitPct) {
      total += px * sz;
    }
  }

  return Number(total.toFixed(2));
}

export async function fetchOrderBookExecutionRead(symbol: string): Promise<OrderBookExecutionRead | null> {
  const normalized = normalizePerpSymbol(symbol);
  if (!normalized) {
    return null;
  }

  const { bySymbol } = await getPerpInstruments();
  const instrument = bySymbol.get(normalized);
  if (!instrument) {
    return null;
  }

  const rows = await withRetry(
    () => bitunixGet<BitunixDepthRow>("/api/v1/futures/market/depth", { symbol: instrument.symbol, limit: "50" }),
    `${instrument.symbol} order book`,
    SCAN_FETCH_MAX_ATTEMPTS,
    SCAN_FETCH_BACKOFF_MS
  );

  const bidsRaw = Array.isArray(rows?.bids) ? rows.bids : [];
  const asksRaw = Array.isArray(rows?.asks) ? rows.asks : [];
  const bids = bidsRaw.map((level) => [String(level?.[0] ?? ""), String(level?.[1] ?? "")]);
  const asks = asksRaw.map((level) => [String(level?.[0] ?? ""), String(level?.[1] ?? "")]);
  const bestBid = parseNumber(bids[0]?.[0]);
  const bestAsk = parseNumber(asks[0]?.[0]);
  if (!Number.isFinite(bestBid) || bestBid <= 0 || !Number.isFinite(bestAsk) || bestAsk <= 0 || bestAsk < bestBid) {
    return null;
  }

  const markPrice = Number((((bestBid + bestAsk) / 2)).toFixed(6));
  const spreadPct = Number((((bestAsk - bestBid) / markPrice) * 100).toFixed(5));
  const bidDepthUsd = sumDepthUsdWithinBps(bids, markPrice, ORDERBOOK_DEPTH_BPS);
  const askDepthUsd = sumDepthUsdWithinBps(asks, markPrice, ORDERBOOK_DEPTH_BPS);
  const combinedDepthUsd = Number((bidDepthUsd + askDepthUsd).toFixed(2));
  const imbalance = combinedDepthUsd > 0
    ? Number((((bidDepthUsd - askDepthUsd) / combinedDepthUsd)).toFixed(5))
    : 0;

  return {
    symbol: normalized,
    bestBid,
    bestAsk,
    markPrice,
    spreadPct,
    bidDepthUsd,
    askDepthUsd,
    combinedDepthUsd,
    imbalance,
    depthBps: ORDERBOOK_DEPTH_BPS
  };
}

export async function searchTokens(query: string | undefined, market: MarketType): Promise<string[]> {
  const now = Date.now();
  if (_assetListCache && now - _assetListCacheAt < ASSET_LIST_CACHE_TTL_MS) {
    const list = market === "perp" ? _assetListCache.perp : _assetListCache.spot;
    if (!query) {
      return list;
    }

    const q = query.trim().toUpperCase();
    return list.filter((symbol) => symbol.toUpperCase().includes(q));
  }

  const [{ bySymbol }, spot] = await Promise.all([getPerpInstruments(), fetchSpotSymbols()]);
  _assetListCache = {
    perp: [...bySymbol.keys()].sort(),
    spot: [...spot].sort()
  };
  _assetListCacheAt = Date.now();

  const list = market === "perp" ? _assetListCache.perp : _assetListCache.spot;
  if (!query) {
    return list;
  }

  const q = query.trim().toUpperCase();
  return list.filter((symbol) => symbol.toUpperCase().includes(q));
}

async function fetchAndCalculateTimeframeRsi(symbol: string, interval: "1d" | "12h" | "4h" | "1h" | "15m", lookbackCandles: number): Promise<TimeframeRsi | null> {
  const candles = await fetchCandlesByInstId(toOkxPerpInstId(symbol), interval, lookbackCandles + 30);
  const closes = candles.map((candle) => candle.c).filter((value) => Number.isFinite(value));
  if (closes.length < 30) {
    return null;
  }

  const rsi = calculateLatestRsi(closes, 14);
  if (rsi === null) {
    return null;
  }

  const macdHist = calculateLatestMacdHistogram(closes);
  if (macdHist === null) {
    return null;
  }

  const stochRsi = calculateStochasticRsi(closes, 14, 3, 3);
  if (stochRsi === null) {
    return null;
  }

  return {
    interval,
    rsi: Number(rsi.toFixed(2)),
    macdHist,
    stochRsi: stochRsi.stochRsi,
    stochK: stochRsi.k,
    stochD: stochRsi.d,
    prevStochK: stochRsi.prevK,
    prevStochD: stochRsi.prevD,
    trend: translateTimeframeTrend(
      stochRsi.k,
      stochRsi.d,
      stochRsi.prevK,
      stochRsi.prevD,
      Number(rsi.toFixed(2))
    )
  };
}

async function fetchAllVolumes24h(market: MarketType): Promise<Map<string, number>> {
  const now = Date.now();
  if (_volumeCache && now - _volumeCacheAt < VOLUME_CACHE_TTL_MS) {
    return new Map(_volumeCache);
  }

  const volumeMap = new Map<string, number>();

  if (market === "perp") {
    const [{ byInstId }, tickers] = await Promise.all([
      getPerpInstruments(),
      withRetry(
        () => bitunixGet<BitunixTickerRow[]>("/api/v1/futures/market/tickers", {}),
        "fetch Bitunix tickers for volume",
        SCAN_FETCH_MAX_ATTEMPTS,
        SCAN_FETCH_BACKOFF_MS
      )
    ]);

    for (const ticker of tickers) {
      const instId = String(ticker.symbol ?? "").trim().toUpperCase();
      const instrument = byInstId.get(instId);
      if (!instrument) {
        continue;
      }
      const volumeUsd = calculateVolumeUsdFromTicker(ticker, instrument);
      if (volumeUsd > 0) {
        volumeMap.set(instrument.externalSymbol, volumeUsd);
      }
    }
  } else {
    return volumeMap;
  }

  _volumeCache = new Map(volumeMap);
  _volumeCacheAt = Date.now();
  return volumeMap;
}

async function fetchAllChanges24h(market: MarketType): Promise<Map<string, number>> {
  const now = Date.now();
  if (_changeCache && now - _changeCacheAt < VOLUME_CACHE_TTL_MS) {
    return new Map(_changeCache);
  }

  const changeMap = new Map<string, number>();

  if (market === "perp") {
    const [{ byInstId }, tickers] = await Promise.all([
      getPerpInstruments(),
      withRetry(
        () => bitunixGet<BitunixTickerRow[]>("/api/v1/futures/market/tickers", {}),
        "fetch Bitunix tickers for 24h change",
        SCAN_FETCH_MAX_ATTEMPTS,
        SCAN_FETCH_BACKOFF_MS
      )
    ]);

    for (const ticker of tickers) {
      const instId = String(ticker.symbol ?? "").trim().toUpperCase();
      const instrument = byInstId.get(instId);
      if (!instrument) {
        continue;
      }

      const changePct = parseTickerChangePct(ticker);
      if (changePct != null) {
        changeMap.set(instrument.externalSymbol, changePct);
      }
    }
  } else {
    return changeMap;
  }

  _changeCache = new Map(changeMap);
  _changeCacheAt = Date.now();
  return changeMap;
}

function calculateVolatilityPctFromCandles(candles: NormalizedCandle[], lookbackCandles: number): number {
  const window = candles.slice(-lookbackCandles);
  if (window.length === 0) {
    return 0;
  }

  let highestHigh = Number.NEGATIVE_INFINITY;
  let lowestLow = Number.POSITIVE_INFINITY;
  for (const candle of window) {
    if (candle.h > highestHigh) highestHigh = candle.h;
    if (candle.l < lowestLow) lowestLow = candle.l;
  }

  if (!Number.isFinite(highestHigh) || !Number.isFinite(lowestLow) || lowestLow <= 0) {
    return 0;
  }

  return Number((((highestHigh - lowestLow) / lowestLow) * 100).toFixed(3));
}

function calculateAtrFromCandles(candles: NormalizedCandle[], period: number = 14): number {
  const atr = calculateLatestAtr(
    candles.map((candle) => candle.h),
    candles.map((candle) => candle.l),
    candles.map((candle) => candle.c),
    period
  );
  return atr != null && Number.isFinite(atr) && atr > 0 ? atr : 0;
}

function calculateTrendPersistenceFromCandles(candles: NormalizedCandle[], lookback: number = 6): number {
  const closes = candles.map((candle) => candle.c);
  const stochSeries = calculateStochasticRsiSeries(closes);
  if (stochSeries.length === 0) {
    return 0;
  }

  const window = stochSeries.slice(-Math.max(lookback, 3));
  let upCount = 0;
  let downCount = 0;
  for (const point of window) {
    if (point.k > point.d) upCount += 1;
    if (point.k < point.d) downCount += 1;
  }
  return Math.max(upCount, downCount);
}

function percentileRank(value: number, samples: number[]): number {
  if (!Number.isFinite(value) || samples.length === 0) {
    return 0;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  let belowOrEqual = 0;
  for (const sample of sorted) {
    if (sample <= value) {
      belowOrEqual += 1;
    }
  }

  return Number(((belowOrEqual / sorted.length) * 100).toFixed(2));
}

function buildContextualCandlestickSignal(params: {
  candles: NormalizedCandle[];
  nearSupportFloor: boolean;
  nearResistance: boolean;
  trendlineBreakout: boolean;
  trendlineBreakdown: boolean;
  higherTimeframeTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
}): CandlestickPatternSignal {
  const {
    candles,
    nearSupportFloor,
    nearResistance,
    trendlineBreakout,
    trendlineBreakdown,
    higherTimeframeTrend
  } = params;

  const base = detectCandlestickPatternSignal(candles);
  let bullishScore = base.bullishScore;
  let bearishScore = base.bearishScore;

  if (bullishScore > 0) {
    if (nearSupportFloor) bullishScore += 0.35;
    if (trendlineBreakout) bullishScore += 0.35;
    if (higherTimeframeTrend === "BEARISH") bullishScore = Math.max(0, bullishScore - 0.35);
  }

  if (bearishScore > 0) {
    if (nearResistance) bearishScore += 0.35;
    if (trendlineBreakdown) bearishScore += 0.35;
    if (higherTimeframeTrend === "BULLISH") bearishScore = Math.max(0, bearishScore - 0.35);
  }

  return {
    ...base,
    bullishScore: Number(Math.min(2.5, bullishScore).toFixed(3)),
    bearishScore: Number(Math.min(2.5, bearishScore).toFixed(3))
  };
}

export async function scanRsi(params: ScanParams): Promise<ScanResult> {
  const explicitSymbols = Array.isArray(params.symbols)
    ? params.symbols.map((symbol) => symbol.trim()).filter((symbol) => symbol.length > 0)
    : [];
  const matching = explicitSymbols.length > 0
    ? Array.from(new Set(explicitSymbols.map((symbol) => params.market === "perp" ? normalizePerpSymbol(symbol) : symbol.toUpperCase())))
    : await searchTokens(params.query, params.market);
  const skipped: SkippedToken[] = [];

  const [allVolumes, allChanges24h] = await Promise.all([
    fetchAllVolumes24h(params.market),
    fetchAllChanges24h(params.market)
  ]);
  const volumeBySymbol = new Map<string, number>();
  const changeBySymbol = new Map<string, number>();
  for (const symbol of matching) {
    const vol = allVolumes.get(symbol);
    if (vol != null) {
      volumeBySymbol.set(symbol, vol);
    } else {
      skipped.push({
        symbol,
        reason: "FETCH_ERROR",
        details: "No 24h volume data available"
      });
    }

    // Capture 24h change for downstream use (hunt evaluator) but do NOT filter here.
    // Filtering at scan level would cut the visible token universe from ~750 to ~47,
    // preventing normal RSI/signal computation for all other tokens.
    const changePct = allChanges24h.get(symbol);
    if (changePct != null) {
      changeBySymbol.set(symbol, changePct);
    }
  }

  const includeSymbols = Array.isArray(params.includeSymbols)
    ? params.includeSymbols
        .map((symbol) => symbol.trim())
        .filter((symbol) => symbol.length > 0)
        .map((symbol) => params.market === "perp" ? normalizePerpSymbol(symbol) : symbol.toUpperCase())
    : [];

  for (const symbol of includeSymbols) {
    if (volumeBySymbol.has(symbol)) {
      continue;
    }

    const vol = allVolumes.get(symbol);
    if (vol != null) {
      volumeBySymbol.set(symbol, vol);
      const changePct = allChanges24h.get(symbol);
      if (changePct != null) {
        changeBySymbol.set(symbol, changePct);
      }
      continue;
    }

    skipped.push({
      symbol,
      reason: "FETCH_ERROR",
      details: "Included symbol has no 24h volume data available"
    });
  }

  const topByVolume = matching
    .filter((symbol) => volumeBySymbol.has(symbol))
    .sort((left, right) => (volumeBySymbol.get(right) ?? 0) - (volumeBySymbol.get(left) ?? 0))
    .slice(0, params.limitTokens);

  const symbolsToScan = explicitSymbols.length > 0
    ? matching.filter((symbol) => volumeBySymbol.has(symbol))
    : [...topByVolume];
  for (const symbol of includeSymbols) {
    if (!symbolsToScan.includes(symbol) && volumeBySymbol.has(symbol)) {
      symbolsToScan.push(symbol);
    }
  }

  // Pre-compute recent volatility to prioritize high-vol tokens in scan order
  const volatilityBySymbol = new Map<string, number>();
  const volatilityFetches = await Promise.allSettled(
    symbolsToScan.slice(0, 50).map(async (symbol) => {
      try {
        const candles = await fetchCandlesByInstId(toOkxPerpInstId(symbol), "1h", 4);
        if (candles.length > 0) {
          let high = Number.NEGATIVE_INFINITY;
          let low = Number.POSITIVE_INFINITY;
          for (const c of candles) {
            if (c.h > high) high = c.h;
            if (c.l < low) low = c.l;
          }
          if (low > 0) {
            const vol = ((high - low) / low) * 100;
            return { symbol, vol };
          }
        }
      } catch {
        // Ignore fetch errors, use 0 volatility
      }
      return { symbol, vol: 0 };
    })
  );

  for (const result of volatilityFetches) {
    if (result.status === 'fulfilled' && result.value) {
      volatilityBySymbol.set(result.value.symbol, result.value.vol);
    }
  }

  // Re-sort symbolsToScan: high volatility first
  symbolsToScan.sort((left, right) => {
    const leftVol = volatilityBySymbol.get(left) ?? 0;
    const rightVol = volatilityBySymbol.get(right) ?? 0;
    if (Math.abs(leftVol - rightVol) > 0.1) {
      return rightVol - leftVol; // High volatility first
    }
    // Tie-break by volume
    return (volumeBySymbol.get(right) ?? 0) - (volumeBySymbol.get(left) ?? 0);
  });

  const settled: Array<PromiseSettledResult<{ result?: TokenRsiResult; skipped?: SkippedToken }>> = [];

  for (let startIndex = 0; startIndex < symbolsToScan.length; startIndex += SCAN_SYMBOL_CONCURRENCY) {
    const chunk = symbolsToScan.slice(startIndex, startIndex + SCAN_SYMBOL_CONCURRENCY);
    const chunkSettled = await Promise.allSettled(
      chunk.map(async (symbol) => {
        const lookbackCandles = 200;
        const volume24h = volumeBySymbol.get(symbol);
        if (volume24h == null) {
          throw new Error("Missing ranked volume for symbol");
        }

        const daily = await fetchAndCalculateTimeframeRsi(symbol, "1d", lookbackCandles);
        const twelveh = await fetchAndCalculateTimeframeRsi(symbol, "12h", lookbackCandles);
        const macro = await fetchAndCalculateTimeframeRsi(symbol, "4h", lookbackCandles);
        const intermediary = await fetchAndCalculateTimeframeRsi(symbol, "1h", lookbackCandles);
        const microTrigger = await fetchAndCalculateTimeframeRsi(symbol, "15m", lookbackCandles);
        const fourHourCandles = await fetchCandlesByInstId(toOkxPerpInstId(symbol), "4h", 230);
        const supportWindowCandles = await fetchCandlesByInstId(toOkxPerpInstId(symbol), "1h", 56);
        const microWindowCandles = await fetchCandlesByInstId(toOkxPerpInstId(symbol), "15m", lookbackCandles + 30);

        if (!macro || !intermediary || !microTrigger) {
          return {
            skipped: {
              symbol,
              reason: "INSUFFICIENT_CANDLES" as const,
              details: `Could not fetch all three key timeframes (macro: ${macro ? "ok" : "fail"}, intermediary: ${intermediary ? "ok" : "fail"}, micro: ${microTrigger ? "ok" : "fail"})`
            }
          };
        }

        const baseSignal = determineSignal(macro, intermediary, microTrigger, {
          daily: daily ?? null,
          twelveh: twelveh ?? null
        });
        const dailyReversalBias = evaluateDailyReversalBias(daily ?? null);
        const close = fourHourCandles.length > 0 ? fourHourCandles.at(-1)?.c ?? 0 : 0;
        const levelsCalc = calculateSupportResistance(supportWindowCandles.slice(-48).map((candle) => ({ h: candle.h, l: candle.l })));
        const volatilityPct = calculateVolatilityPctFromCandles(supportWindowCandles, VOLATILITY_LOOKBACK_CANDLES);
        const passedVolatility = volatilityPct >= MIN_VOLATILITY_PCT;
        const minVolumeUsd = getMinVolumeUsdForSymbol(symbol);
        const passedLiquidity = volume24h >= minVolumeUsd;
        const latestOneHour = supportWindowCandles.at(-1);
        const previousOneHour = supportWindowCandles.at(-2);
        const latestHigh = Number(latestOneHour?.h ?? NaN);
        const latestLow = Number(latestOneHour?.l ?? NaN);
        const previousHigh = Number(previousOneHour?.h ?? NaN);
        const previousLow = Number(previousOneHour?.l ?? NaN);

        const highs1h = supportWindowCandles.slice(-12).map((candle) => candle.h);
        const lows1h = supportWindowCandles.slice(-12).map((candle) => candle.l);
        const trendlineHighs = supportWindowCandles.slice(-40).map((candle) => candle.h);
        const trendlineLows = supportWindowCandles.slice(-40).map((candle) => candle.l);
        const trendlineBreakoutResult = detectDescendingTrendlineBreakout(trendlineHighs, close);
        const trendlineBreakdownResult = detectAscendingTrendlineBreakdown(trendlineLows, close);
        const trendlineBreakout = trendlineBreakoutResult.detected;
        const trendlineBreakdown = trendlineBreakdownResult.detected;
        const lowerHighOn1h = Number.isFinite(latestHigh) && Number.isFinite(previousHigh) && latestHigh < previousHigh;
        const higherLowOn1h = Number.isFinite(latestLow) && Number.isFinite(previousLow) && latestLow > previousLow;
        const structureBreakShort = Number.isFinite(latestLow) && Number.isFinite(previousLow) && latestLow < previousLow;
        const structureBreakLong = Number.isFinite(latestHigh) && Number.isFinite(previousHigh) && latestHigh > previousHigh;

        const oneHourTrendDirection: "BULLISH" | "BEARISH" | "NEUTRAL" = macro.trend.direction === "UP" && intermediary.trend.direction === "UP"
          ? "BULLISH"
          : macro.trend.direction === "DOWN" && intermediary.trend.direction === "DOWN"
            ? "BEARISH"
            : "NEUTRAL";
        const alignLongCount = [macro.trend.direction, intermediary.trend.direction, microTrigger.trend.direction].filter((item) => item === "UP").length;
        const alignShortCount = [macro.trend.direction, intermediary.trend.direction, microTrigger.trend.direction].filter((item) => item === "DOWN").length;
        const structureState: TokenRsiResult["tradeContext"]["structureState"] = Math.max(alignLongCount, alignShortCount) >= 2
          ? "TRENDING"
          : (microTrigger.trend.direction === "UP" || microTrigger.trend.direction === "DOWN")
            ? "BREAKOUT"
            : "CHOP";

        const microCloses = microWindowCandles.map((candle) => candle.c).filter((value) => Number.isFinite(value) && value > 0);
        const ema20Current = calculateLatestEma(microCloses, MICRO_TREND_EMA_PERIOD) ?? close;
        const ema20Previous = calculateLatestEma(microCloses.slice(0, -1), MICRO_TREND_EMA_PERIOD) ?? ema20Current;
        const emaSlope = Number((ema20Current - ema20Previous).toFixed(8));
        const atr1h = calculateAtrFromCandles(supportWindowCandles, 14);
        const atr4h = calculateAtrFromCandles(fourHourCandles, 14);
        const trendPersistence4h = calculateTrendPersistenceFromCandles(fourHourCandles, 6);
        const recentHigh1h = supportWindowCandles.slice(-12).reduce((max, candle) => Math.max(max, candle.h), 0);
        const recentLow1hRaw = supportWindowCandles.slice(-12).reduce((min, candle) => Math.min(min, candle.l), Number.POSITIVE_INFINITY);
        const recentLow1h = Number.isFinite(recentLow1hRaw) ? recentLow1hRaw : 0;
        const regimeInfo = detectRegime({
          price: close,
          atr1h,
          atr4h,
          recentHigh1h,
          recentLow1h,
          volatilityPct,
          trendPersistence: trendPersistence4h
        });

        let signal = baseSignal;
        if (signal === "REVERSAL SHORT") {
          const strong4hTrend = macro.trend.direction === "UP" && trendPersistence4h >= 3;
          if (strong4hTrend && !structureBreakShort && !trendlineBreakdown) signal = "NO SIGNAL";
          if (signal === "REVERSAL SHORT" && !lowerHighOn1h && !trendlineBreakdown) signal = "NO SIGNAL";
        }
        if (signal === "REVERSAL LONG") {
          const strong4hTrend = macro.trend.direction === "DOWN" && trendPersistence4h >= 3;
          if (strong4hTrend && !structureBreakLong && !trendlineBreakout) signal = "NO SIGNAL";
          if (signal === "REVERSAL LONG" && !higherLowOn1h && !trendlineBreakout) signal = "NO SIGNAL";
        }

        let filteredSignal = signal;
        const structureOk = filteredSignal === "NO SIGNAL"
          ? true
          : evaluateStructure({ highs1h, lows1h }, filteredSignal)
            || (filteredSignal.includes("LONG") ? trendlineBreakout : false)
            || (filteredSignal.includes("SHORT") ? trendlineBreakdown : false);
        const emaOk = filteredSignal === "NO SIGNAL"
          ? true
          : evaluateMicroTrend({ price: close, ema20: ema20Current, prevEma20: ema20Previous }, filteredSignal);
        const srOk = filteredSignal === "NO SIGNAL"
          ? true
          : evaluateSupportResistance(
              {
                price: close,
                high1h: Number.isFinite(latestHigh) ? latestHigh : close,
                low1h: Number.isFinite(latestLow) ? latestLow : close
              },
              filteredSignal
            );
        const directionalSignal = filteredSignal.endsWith("LONG") || filteredSignal.endsWith("SHORT");
        const trendlineAligned =
          (filteredSignal.includes("LONG") && trendlineBreakout) ||
          (filteredSignal.includes("SHORT") && trendlineBreakdown);
        if (directionalSignal) {
          const failCount = Number(!structureOk) + Number(!emaOk) + Number(!srOk);
          const continuationSignal = filteredSignal.startsWith("CONTINUATION");
          const weakStructureMomentum = !structureOk && !emaOk;
          const strictSrMiss = !srOk && !trendlineAligned;
          if (weakStructureMomentum || failCount >= 3 || (continuationSignal && strictSrMiss)) {
            filteredSignal = "NO SIGNAL";
          }
        }

        let direction: "LONG" | "SHORT" | null = filteredSignal.includes("LONG")
          ? "LONG"
          : filteredSignal.includes("SHORT")
            ? "SHORT"
            : null;
        if (dailyReversalBias === "SHORT" && direction === "LONG") {
          direction = null;
        } else if (dailyReversalBias === "LONG" && direction === "SHORT") {
          direction = null;
        }

        const originalDirectional = filteredSignal.endsWith("LONG") || filteredSignal.endsWith("SHORT");
        const passedStructure = !originalDirectional ? true : structureOk;
        const passedMicroTrend = !originalDirectional ? true : emaOk;
        const effectiveStructureState: TokenRsiResult["tradeContext"]["structureState"] = filteredSignal.startsWith("REVERSAL") ? "REVERSAL" : structureState;
        const guarded = applySupportFloorGuard(filteredSignal, close, levelsCalc.localSupport, levelsCalc.localResistance, 0.003);
        const candlestick = buildContextualCandlestickSignal({
          candles: microWindowCandles,
          nearSupportFloor: guarded.nearSupportFloor,
          nearResistance: guarded.nearResistance,
          trendlineBreakout,
          trendlineBreakdown,
          higherTimeframeTrend: oneHourTrendDirection
        });
        const adjustedSignalBadge = getSignalBadge(guarded.adjustedSignal);
        const signalCategory = getSignalCategory(guarded.adjustedSignal);

        const commonTradeContext: TokenRsiResult["tradeContext"] = {
          volatilityPct,
          volume24h,
          passedVolatility,
          passedLiquidity,
          passedOrderBook: true,
          orderBookSpreadPct: 0,
          orderBookCombinedDepthUsd: 0,
          orderBookImbalance: 0,
          orderBookReferenceNotionalUsd: 0,
          orderBookDepthBps: 0,
          passedStructure,
          passedMicroTrend,
          ema20: ema20Current,
          emaSlope,
          atr1h,
          atr4h,
          atr: atr1h,
          trendPersistence4h,
          regime: regimeInfo.regime,
          atrExpansion: regimeInfo.atrExpansion,
          rangeCompression: regimeInfo.rangeCompression,
          volatilityPercentile: 0,
          liquidityPercentile: 0,
          higherTimeframeTrend: oneHourTrendDirection,
          structureState: effectiveStructureState,
          trendlineBreakout,
          trendlineBreakdown,
          candlestick
        };

        const result: TokenRsiResult = {
          symbol,
          market: params.market,
          entryTiming: resolveEntryTiming(guarded.adjustedSignal, {
            close,
            levels: {
              localSupport: levelsCalc.localSupport,
              localResistance: levelsCalc.localResistance,
              nearSupportFloor: guarded.nearSupportFloor,
              nearResistance: guarded.nearResistance,
              supportDistancePct: guarded.supportDistancePct,
              resistanceDistancePct: guarded.resistanceDistancePct
            },
            tradeContext: commonTradeContext
          }),
          rsi: intermediary.rsi,
          close,
          volume24h,
          volatilityPct,
          change24hPct: changeBySymbol.get(symbol) ?? undefined,
          tradeContext: commonTradeContext,
          confluence: {
            score: 0,
            bias: direction,
            maxScore: 10
          },
          levels: {
            localSupport: levelsCalc.localSupport,
            localResistance: levelsCalc.localResistance,
            nearSupportFloor: guarded.nearSupportFloor,
            nearResistance: guarded.nearResistance,
            supportDistancePct: guarded.supportDistancePct,
            resistanceDistancePct: guarded.resistanceDistancePct
          },
          status: classifyRsi(intermediary.rsi, 70, 30),
          signal: adjustedSignalBadge,
          signalCategory,
          timeframes: {
            daily: daily ?? null,
            twelveh: twelveh ?? null,
            macro,
            intermediary,
            microTrigger
          }
        };

        return { result };
      })
    );

    settled.push(...chunkSettled);
    if (SCAN_CHUNK_DELAY_MS > 0 && startIndex + SCAN_SYMBOL_CONCURRENCY < symbolsToScan.length) {
      await sleep(SCAN_CHUNK_DELAY_MS);
    }
  }

  const results: TokenRsiResult[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const item = settled[i];
    const symbol = symbolsToScan[i];
    if (item.status === "rejected") {
      skipped.push({
        symbol,
        reason: "FETCH_ERROR",
        details: item.reason instanceof Error ? item.reason.message : String(item.reason)
      });
      continue;
    }
    if (item.value.result) {
      results.push(item.value.result);
      continue;
    }
    if (item.value.skipped) {
      skipped.push(item.value.skipped);
    }
  }

  // Filter out non-crypto symbols (stocks, ETFs, commodities) from results
  const cryptoOnlyResults = results.filter((item) => {
    const baseForFilter = item.symbol.endsWith("USDT") ? item.symbol.slice(0, -4) : item.symbol;
    if (BITUNIX_NON_CRYPTO_SYMBOLS.has(baseForFilter)) {
      skipped.push({
        symbol: item.symbol,
        reason: "NON_CRYPTO_FILTERED",
        details: "Excluded non-crypto (stock, ETF, or commodity) from scan results"
      });
      return false;
    }
    return true;
  });

  const averageMarketVolume = cryptoOnlyResults.length > 0 ? cryptoOnlyResults.reduce((sum, item) => sum + item.volume24h, 0) / cryptoOnlyResults.length : 0;
  const volatilitySamples = cryptoOnlyResults.map((item) => item.volatilityPct).filter((value) => Number.isFinite(value) && value >= 0);
  const liquiditySamples = cryptoOnlyResults.map((item) => item.volume24h).filter((value) => Number.isFinite(value) && value >= 0);

  const scoredResults = cryptoOnlyResults.map((item) => ({
    ...item,
    tradeContext: {
      ...item.tradeContext,
      volatilityPercentile: percentileRank(item.volatilityPct, volatilitySamples),
      liquidityPercentile: percentileRank(item.volume24h, liquiditySamples)
    },
    confluence: computeConfluenceScore({
      daily: item.timeframes.daily,
      twelveh: item.timeframes.twelveh,
      macro: item.timeframes.macro,
      intermediary: item.timeframes.intermediary,
      microTrigger: item.timeframes.microTrigger,
      signalType: item.signal.type,
      volume24h: item.volume24h,
      averageMarketVolume,
      volatilityPct: item.volatilityPct,
      trendlineBreakout: item.tradeContext.trendlineBreakout,
      trendlineBreakdown: item.tradeContext.trendlineBreakdown,
      candlestickSignal: item.tradeContext.candlestick,
      candlestickInfluenceMultiplier: 0.6
    })
  })).map((item) => {
    const passedVolatility = item.volatilityPct >= MIN_VOLATILITY_PCT;
    const passedLiquidity = item.volume24h >= getMinVolumeUsdForSymbol(item.symbol);
    const tradeContext = {
      ...item.tradeContext,
      passedVolatility,
      passedLiquidity
    };

    let adjustedSignal = item.signal.type;
    if (
      adjustedSignal.startsWith("NO SIGNAL") &&
      item.confluence.bias &&
      item.confluence.score >= 4 &&
      passedVolatility &&
      passedLiquidity
    ) {
      adjustedSignal = item.confluence.bias === "LONG" ? "REVERSAL LONG" : "REVERSAL SHORT";
    }

    return {
      ...item,
      tradeContext,
      signal: getSignalBadge(adjustedSignal),
      signalCategory: getSignalCategory(adjustedSignal),
      entryTiming: resolveEntryTiming(adjustedSignal, {
        close: item.close,
        levels: item.levels,
        tradeContext
      })
    };
  });

  return {
    analyzedAt: new Date().toISOString(),
    params,
    results: scoredResults,
    skipped
  };
}
