import "./env.js";
import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { getAppAccessState, getEffectiveScanLimit, getFeatureLock, isFeatureEnabled, type AccessFeature } from "./app-access.js";
import { saveLicense, invalidateLicenseCache, getLicenseFilePath } from "./license-store.js";
import { fetchPerpContexts, scanRsi, searchTokens } from "./market-data-service.js";
import { MARKET_DATA_PROVIDER } from "./market-data-service.js";
import { getCoinbaseWebSocketClient, initializeCoinbaseWebSocket, closeCoinbaseWebSocket } from "./coinbase-websocket.js";
import {
  attachBitunixPositionTpSlDebug,
  fetchBitunixAccountSnapshot,
  fetchBitunixClosedTradeHistory,
  fetchLatestOhlc,
  getBitunixMarketWsPrice,
  getBitunixMarketWsStatus,
  getBitunixPrivateAuthStatus,
  placeBitunixLimitOrder
} from "./bitunix-service.js";
import { fetchRecentCandles } from "./bitunix-service.js";
import { fetchStockCandles } from "./yahoo-finance-service.js";
import {
  forceClearCooldown,
  forceCloseOpenTradesBySymbol,
  forceOpenManualTrade,
  detectPrePumpWatchCandidates,
  forceSimulatePrePumpWatchTrades,
  forceRemoveClosedTrade,
  forceResetTradingRuntime,
  forceReopenLastClosedTrade,
  getTradeSimulationSnapshot,
  processTradeSimulation,
  refreshTradeSimulation,
  getTradeRejectionLog,
  clearTradeRejections,
  getTradeEngineProfile,
  buildLiveAccountSnapshot
} from "./trade-engine.js";
import { getTokenLeverageProfile } from "./trade-engine.js";
import {
  ensureLatestServiceState,
  getLatestServiceState,
  setLatestServiceState,
  startScanService,
  stopScanService,
  subscribeStateUpdates
} from "./scan-service.js";
import { getSimulationStorageBackend } from "./simulation-store.js";
import { getBackfillStatus } from "./backfill-token-tracking.js";
import { PrismaClient } from "@prisma/client";

let _backfillPrisma: PrismaClient | null = null;
function backfillPrismaClient(): PrismaClient {
  if (!_backfillPrisma) _backfillPrisma = new PrismaClient();
  return _backfillPrisma;
}
import { sendTelegramMessage, startTelegramCommandListener, stopTelegramCommandListener } from "./telegram-service.js";
import {
  getStrategyConfig,
  updateStrategyConfig,
  setTradingMode,
  invalidateCache
} from "./strategy-config.js";
import {
  listRuntimeSettings,
  updateRuntimeSettings,
  REQUIRED_RUNTIME_SETTING_KEYS
} from "./runtime-settings.js";
import { getRuntimeSettingsAudit } from "./runtime-settings-audit.js";
import {
  analyzePrePumpPatterns,
  type PrePumpAnalysisOptions,
  formatPrePumpAnalysisReport
} from "./pre-pump-patterns.js";
import {
  runPrePumpScan,
  formatPrePumpScanTelegram,
  type PrePumpScanResult
} from "./pre-pump-scan.js";
import {
  clearDryRunExecutionPlans,
  listDryRunExecutionPlans,
  subscribeDryRunExecutionPlans
} from "./dry-run-execution.js";
import { listExchangeTradeHistory, upsertExchangeTradeHistory } from "./exchange-trade-history-prisma.js";
import { formatTokenDisplay } from "./token-metadata.js";
import { getMomentumCandidatesSnapshot } from "./momentum-candidates.js";
import { fetchFinnhubStockQuote, getPopularStockSymbols } from "./finnhub-service.js";

// SaaS API routes
import configApiRouter from "./routes/config-api.js";
import signalsApiV1Router from "./routes/signals-api-v1.js";
import brokerApiV1Router from "./routes/broker-api-v1.js";
import marketDataApiV1Router from "./routes/market-data-api-v1.js";
import positionsApiV1Router from "./routes/positions-api-v1.js";
import alertEventsApiV1Router from "./routes/alert-events-api-v1.js";
import { router as kalshiApiV1Router } from "./routes/kalshi-api-v1.js";
import forecastApiV1Router from "./routes/forecast-api-v1.js";
import authApiRouter from "./routes/auth-api.js";
import userApiRouter from "./routes/user-api.js";
import { optionalJwtAuthMiddleware, requireJWTAuth } from "./middleware/auth.js";

const app = express();
const server = createServer(app);
const wsServer = new WebSocketServer({ noServer: true });
const bitunixAccountWsServer = new WebSocketServer({ noServer: true });
const dryRunWsServer = new WebSocketServer({ noServer: true });
const stockPricesWsServer = new WebSocketServer({ noServer: true });
const saasDashboardWsServer = new WebSocketServer({ noServer: true });
const port = Number(process.env.PORT ?? 8787);
const defaultScanLimitTokensRaw = Number(process.env.SCAN_LIMIT_TOKENS ?? 25);
const DEFAULT_SCAN_LIMIT_TOKENS = Number.isFinite(defaultScanLimitTokensRaw)
  ? Math.max(1, Math.min(200, Math.trunc(defaultScanLimitTokensRaw)))
  : 15;
const bitunixAccountWsPollMsRaw = Number(process.env.BITUNIX_ACCOUNT_WS_POLL_MS ?? 2000);
const BITUNIX_ACCOUNT_WS_POLL_MS = Number.isFinite(bitunixAccountWsPollMsRaw)
  ? Math.max(750, Math.min(30_000, Math.trunc(bitunixAccountWsPollMsRaw)))
  : 2000;
const DEFAULT_TRADE_TENANT_ID = (process.env.TRADING_TENANT_ID ?? "default").trim() || "default";
let shutdownInProgress = false;

type CachedStockQuotesSnapshot = {
  timestamp: string;
  requestedCount: number;
  quotes: Awaited<ReturnType<typeof fetchFinnhubStockQuote>>[];
  failedSymbols: Array<{ symbol: string; reason: string }>;
};

let latestStockQuotesSnapshot: CachedStockQuotesSnapshot | null = null;

type StockQuotesResponsePayload = {
  provider: "FINNHUB";
  assetClass: "STOCK";
  timestamp: string;
  count: number;
  requestedCount: number;
  quotes: Awaited<ReturnType<typeof fetchFinnhubStockQuote>>[];
  failedSymbols: Array<{ symbol: string; reason: string }>;
  stale: boolean;
  staleReason?: string;
};

function resolveStockSymbols(rawSymbols: string, limitRaw: number): string[] {
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.trunc(limitRaw))) : 50;
  return rawSymbols
    ? rawSymbols.split(",").map((s) => s.trim()).filter(Boolean)
    : getPopularStockSymbols().slice(0, limit);
}

async function buildStockQuotesPayload(symbols: string[]): Promise<StockQuotesResponsePayload> {
  try {
    const settled = await Promise.allSettled(symbols.map((symbol) => fetchFinnhubStockQuote(symbol)));
    const quotes = settled
      .filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchFinnhubStockQuote>>> => item.status === "fulfilled")
      .map((item) => item.value);
    const failedSymbols = settled
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => item.status === "rejected")
      .map(({ idx, item }) => ({
        symbol: symbols[idx],
        reason: item.status === "rejected" ? String(item.reason) : "unknown"
      }));

    if (quotes.length === 0) {
      if (latestStockQuotesSnapshot) {
        return {
          provider: "FINNHUB",
          assetClass: "STOCK",
          timestamp: new Date().toISOString(),
          count: latestStockQuotesSnapshot.quotes.length,
          requestedCount: symbols.length,
          quotes: latestStockQuotesSnapshot.quotes,
          failedSymbols,
          stale: true,
          staleReason: "Provider returned zero fresh quotes"
        };
      }

      throw new Error("No stock quotes returned from provider and no cached snapshot available");
    }

    const payload: StockQuotesResponsePayload = {
      provider: "FINNHUB",
      assetClass: "STOCK",
      timestamp: new Date().toISOString(),
      count: quotes.length,
      requestedCount: symbols.length,
      quotes,
      failedSymbols,
      stale: false
    };

    latestStockQuotesSnapshot = {
      timestamp: payload.timestamp,
      requestedCount: payload.requestedCount,
      quotes: payload.quotes,
      failedSymbols: payload.failedSymbols
    };

    return payload;
  } catch (error) {
    if (latestStockQuotesSnapshot) {
      return {
        provider: "FINNHUB",
        assetClass: "STOCK",
        timestamp: new Date().toISOString(),
        count: latestStockQuotesSnapshot.quotes.length,
        requestedCount: symbols.length,
        quotes: latestStockQuotesSnapshot.quotes,
        failedSymbols: latestStockQuotesSnapshot.failedSymbols,
        stale: true,
        staleReason: error instanceof Error ? error.message : String(error)
      };
    }

    throw error;
  }
}

function extractAndValidateJwtFromUpgradeRequest(request: any): { valid: boolean; decoded?: any } {
  const cookieHeader = request.headers?.cookie ?? "";
  const cookies = Object.fromEntries(
    cookieHeader
      .split(";")
      .map((item: string) => {
        const [key, value] = item.trim().split("=");
        return [key, decodeURIComponent(value || "")];
      })
      .filter((item: any) => item[0] && item[1])
  );

  const token =
    cookies.token ||
    (request.headers?.authorization ?? "").replace(/^Bearer\s+/i, "");

  if (!token) {
    return { valid: false };
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET ?? "fallback-secret");
    return { valid: true, decoded };
  } catch {
    return { valid: false };
  }
}

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url ?? "/", `http://localhost:${port}`);

  if (requestUrl.pathname === "/ws/state") {
    const auth = extractAndValidateJwtFromUpgradeRequest(request);
    if (!auth.valid) {
      console.log("[WebSocket /ws/state] Rejected unauthorized upgrade attempt");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    request.organizationId = auth.decoded?.organizationId;
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit("connection", ws, request);
    });
    return;
  }

  if (requestUrl.pathname === "/ws/bitunix-account") {
    bitunixAccountWsServer.handleUpgrade(request, socket, head, (ws) => {
      bitunixAccountWsServer.emit("connection", ws, request);
    });
    return;
  }

  if (requestUrl.pathname === "/ws/execution-dry-run") {
    dryRunWsServer.handleUpgrade(request, socket, head, (ws) => {
      dryRunWsServer.emit("connection", ws, request);
    });
    return;
  }

  if (requestUrl.pathname === "/ws/prices/stocks") {
    stockPricesWsServer.handleUpgrade(request, socket, head, (ws) => {
      stockPricesWsServer.emit("connection", ws, request);
    });
    return;
  }

  if (requestUrl.pathname === "/ws/saas-dashboard") {
    saasDashboardWsServer.handleUpgrade(request, socket, head, (ws) => {
      saasDashboardWsServer.emit("connection", ws, request);
    });
    return;
  }

  socket.destroy();
});

function requireFeature(feature: AccessFeature): express.RequestHandler {
  return (_req, res, next) => {
    const lock = getFeatureLock(feature);
    if (!lock.allowed) {
      res.status(lock.statusCode).json(lock.body);
      return;
    }

    next();
  };
}

async function syncLatestTradeSimulation(snapshot: Awaited<ReturnType<typeof refreshTradeSimulation>>): Promise<void> {
  const latest = getLatestServiceState();
  if (!latest) {
    return;
  }

  const { service: _service, ...stateWithoutService } = latest;
  await setLatestServiceState({
    ...stateWithoutService,
    tradeSimulation: snapshot
  });
}

function toTestTradeSimulationSnapshot(snapshot: Awaited<ReturnType<typeof refreshTradeSimulation>> | null | undefined) {
  if (!snapshot) {
    return snapshot ?? null;
  }

  const activeTrades = Array.isArray(snapshot.activeTrades)
    ? snapshot.activeTrades.filter((trade) => !trade?.isLiveTrade)
    : [];
  const recentClosedTrades = Array.isArray(snapshot.recentClosedTrades)
    ? snapshot.recentClosedTrades.filter((trade) => !trade?.isLiveTrade)
    : [];
  const wins = recentClosedTrades.filter((trade) => trade?.status === "WIN").length;
  const losses = recentClosedTrades.filter((trade) => trade?.status === "LOSS").length;
  const settled = wins + losses;
  const closeReasonCounts = recentClosedTrades.reduce<Record<string, number>>((acc, trade) => {
    const reason = String(trade?.closeReason ?? "UNKNOWN").trim() || "UNKNOWN";
    acc[reason] = (acc[reason] ?? 0) + 1;
    return acc;
  }, {});
  const totalSimulatedPnl = Number(
    recentClosedTrades.reduce((sum, trade) => sum + Number(trade?.result ?? 0), 0).toFixed(2)
  );
  const totalPnlUsd = Number(
    recentClosedTrades.reduce((sum, trade) => sum + Number(trade?.resultUsd ?? 0), 0).toFixed(2)
  );
  const unrealizedPnlUsd = Number(
    activeTrades.reduce((sum, trade) => sum + Number(trade?.currentPnlUsd ?? 0), 0).toFixed(2)
  );
  const initialCapitalUsd = Number(snapshot.stats?.initialCapitalUsd ?? 350);
  const accountBalanceUsd = Number((initialCapitalUsd + totalPnlUsd).toFixed(2));
  const equityUsd = Number((accountBalanceUsd + unrealizedPnlUsd).toFixed(2));
  const totalPnlPct = initialCapitalUsd > 0 ? Number(((totalPnlUsd / initialCapitalUsd) * 100).toFixed(2)) : 0;

  return {
    ...snapshot,
    stats: {
      ...snapshot.stats,
      totalTrades: activeTrades.length + recentClosedTrades.length,
      activeTrades: activeTrades.length,
      wins,
      losses,
      winRate: settled > 0 ? Number(((wins / settled) * 100).toFixed(2)) : 0,
      totalSimulatedPnl,
      totalSimulatedPnlUsd: totalPnlUsd,
      totalPnlUsd,
      totalPnlPct,
      unrealizedPnlUsd,
      equityUsd,
      accountBalanceUsd,
      estimatedBalanceUsd: accountBalanceUsd,
      closeReasonCounts,
      sentimentShiftClosedTrades: closeReasonCounts.SENTIMENT_SHIFT_OPPOSITE_SIGNAL ?? 0
    },
    activeTrades,
    recentClosedTrades
  };
}

function normalizeTenantId(value?: string | null): string {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : DEFAULT_TRADE_TENANT_ID;
}

function normalizePriceSymbol(value: string | null | undefined): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/-(USDT|USDC|USD)-?(SWAP|PERP)?$/i, "")
    .replace(/-(SWAP|PERP)$/i, "")
    .trim();
}

function toCoinbaseProductIdFromToken(tokenRaw: string | null | undefined): string {
  const base = normalizePriceSymbol(tokenRaw);
  return base ? `${base}-USD` : "";
}

function applyLatestResultPricesToTrades<T extends { token?: string; entryPrice?: number; currentPrice?: number; direction?: string; leverage?: number; stakeUsd?: number; tpPrice?: number; slPrice?: number; currentPnlPct?: number; currentPnlUsd?: number; positionValueUsd?: number; distanceToTP?: number; distanceToSL?: number; roePct?: number; markPrice?: number }>(
  trades: T[],
  results: Array<{ symbol?: string; close?: number }> | null | undefined,
  overridePrices?: Map<string, number>
): T[] {
  if (!Array.isArray(trades) || trades.length === 0) {
    return trades;
  }

  const priceBySymbol = new Map<string, number>();
  if (Array.isArray(results) && results.length > 0) {
    for (const row of results) {
      const key = normalizePriceSymbol(row?.symbol);
      const price = Number(row?.close ?? Number.NaN);
      if (key && Number.isFinite(price) && price > 0) {
        priceBySymbol.set(key, price);
      }
    }
  }

  if (overridePrices && overridePrices.size > 0) {
    for (const [symbol, price] of overridePrices.entries()) {
      const key = normalizePriceSymbol(symbol);
      if (key && Number.isFinite(price) && price > 0) {
        priceBySymbol.set(key, price);
      }
    }
  }

  if (priceBySymbol.size === 0) {
    return trades;
  }

  return trades.map((trade) => {
    const key = normalizePriceSymbol(trade?.token);
    const currentPriceCandidate = priceBySymbol.get(key);
    const entryPrice = Number(trade?.entryPrice ?? Number.NaN);
    const leverage = Number(trade?.leverage ?? 1);
    const stakeUsd = Number(trade?.stakeUsd ?? 0);
    if (!key || currentPriceCandidate == null || !Number.isFinite(currentPriceCandidate) || currentPriceCandidate <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      return trade;
    }
    const currentPrice = Number(currentPriceCandidate);

    const isLong = String(trade?.direction ?? "LONG").toUpperCase() !== "SHORT";
    const movePct = isLong
      ? (currentPrice - entryPrice) / entryPrice
      : (entryPrice - currentPrice) / entryPrice;
    const currentPnlPct = Number((movePct * leverage * 100).toFixed(3));
    const currentPnlUsd = Number((stakeUsd * (currentPnlPct / 100)).toFixed(2));
    const positionValueUsd = Number(
      (
        isLong
          ? stakeUsd * (currentPrice / entryPrice)
          : stakeUsd * (entryPrice / currentPrice)
      ).toFixed(2)
    );
    const distanceToTP = Number(
      (
        isLong
          ? ((Number(trade?.tpPrice ?? currentPrice) - currentPrice) / currentPrice) * 100
          : ((currentPrice - Number(trade?.tpPrice ?? currentPrice)) / currentPrice) * 100
      ).toFixed(3)
    );
    const distanceToSL = Number(
      (
        isLong
          ? ((currentPrice - Number(trade?.slPrice ?? currentPrice)) / currentPrice) * 100
          : ((Number(trade?.slPrice ?? currentPrice) - currentPrice) / currentPrice) * 100
      ).toFixed(3)
    );

    return {
      ...trade,
      currentPrice,
      currentPnlPct,
      currentPnlUsd,
      positionValueUsd,
      distanceToTP,
      distanceToSL,
      roePct: currentPnlPct,
      markPrice: currentPrice
    };
  });
}

function getTradeTenantId(trade: { tenantId?: string } | null | undefined): string {
  return normalizeTenantId(trade?.tenantId);
}

function toTenantTradeSimulationSnapshot(
  snapshot: Awaited<ReturnType<typeof refreshTradeSimulation>> | null | undefined,
  tenantIdRaw: string,
  results?: Array<{ symbol?: string; close?: number }> | null
) {
  if (!snapshot) {
    return snapshot ?? null;
  }

  const tenantId = normalizeTenantId(tenantIdRaw);
  const coinbasePriceOverrides = new Map<string, number>();
  if (MARKET_DATA_PROVIDER === "COINBASE") {
    const wsPrices = getCoinbaseWebSocketClient().getPrices();
    for (const [productId, priceRaw] of wsPrices.entries()) {
      const price = Number(priceRaw);
      if (Number.isFinite(price) && price > 0) {
        coinbasePriceOverrides.set(productId, price);
      }
    }
  }
  const bitunixPriceOverrides = new Map<string, number>();
  if (MARKET_DATA_PROVIDER === "BITUNIX") {
    for (const trade of Array.isArray(snapshot.activeTrades) ? snapshot.activeTrades : []) {
      const symbol = String(trade?.token ?? "").trim();
      if (!symbol) {
        continue;
      }
      const quote = getBitunixMarketWsPrice(symbol);
      if (quote.fresh && Number.isFinite(quote.price) && quote.price > 0) {
        bitunixPriceOverrides.set(symbol, quote.price);
      }
    }
  }
  const mergedPriceOverrides = new Map<string, number>([...coinbasePriceOverrides, ...bitunixPriceOverrides]);
  const activeTrades = Array.isArray(snapshot.activeTrades)
    ? snapshot.activeTrades.filter((trade) => getTradeTenantId(trade) === tenantId)
    : [];
  const pricedActiveTrades = applyLatestResultPricesToTrades(activeTrades, results, mergedPriceOverrides);
  const recentClosedTrades = Array.isArray(snapshot.recentClosedTrades)
    ? snapshot.recentClosedTrades.filter((trade) => getTradeTenantId(trade) === tenantId)
    : [];
  const wins = recentClosedTrades.filter((trade) => trade?.status === "WIN").length;
  const losses = recentClosedTrades.filter((trade) => trade?.status === "LOSS").length;
  const settled = wins + losses;
  const closeReasonCounts = recentClosedTrades.reduce<Record<string, number>>((acc, trade) => {
    const reason = String(trade?.closeReason ?? "UNKNOWN").trim() || "UNKNOWN";
    acc[reason] = (acc[reason] ?? 0) + 1;
    return acc;
  }, {});
  const totalSimulatedPnl = Number(
    recentClosedTrades.reduce((sum, trade) => sum + Number(trade?.result ?? 0), 0).toFixed(2)
  );
  const totalPnlUsd = Number(
    recentClosedTrades.reduce((sum, trade) => sum + Number(trade?.resultUsd ?? 0), 0).toFixed(2)
  );
  const unrealizedPnlUsd = Number(
    pricedActiveTrades.reduce((sum, trade) => sum + Number(trade?.currentPnlUsd ?? 0), 0).toFixed(2)
  );
  const initialCapitalUsd = Number(snapshot.stats?.initialCapitalUsd ?? 350);
  const accountBalanceUsd = Number((initialCapitalUsd + totalPnlUsd).toFixed(2));
  const equityUsd = Number((accountBalanceUsd + unrealizedPnlUsd).toFixed(2));
  const totalPnlPct = initialCapitalUsd > 0 ? Number(((totalPnlUsd / initialCapitalUsd) * 100).toFixed(2)) : 0;

  return {
    ...snapshot,
    stats: {
      ...snapshot.stats,
      totalTrades: activeTrades.length + recentClosedTrades.length,
      activeTrades: activeTrades.length,
      wins,
      losses,
      winRate: settled > 0 ? Number(((wins / settled) * 100).toFixed(2)) : 0,
      totalSimulatedPnl,
      totalSimulatedPnlUsd: totalPnlUsd,
      totalPnlUsd,
      totalPnlPct,
      unrealizedPnlUsd,
      equityUsd,
      accountBalanceUsd,
      estimatedBalanceUsd: accountBalanceUsd,
      closeReasonCounts,
      sentimentShiftClosedTrades: closeReasonCounts.SENTIMENT_SHIFT_OPPOSITE_SIGNAL ?? 0
    },
    activeTrades: pricedActiveTrades,
    recentClosedTrades
  };
}

function toStateForMode(
  state: ReturnType<typeof getLatestServiceState>,
  mode: "test" | "live",
  tenantIdRaw: string
) {
  if (!state) {
    return state;
  }

  const tenantSnapshot = toTenantTradeSimulationSnapshot(state.tradeSimulation, tenantIdRaw, state.results);

  if (mode !== "test") {
    const liveState = {
      ...state,
      tradeSimulation: tenantSnapshot
    };

    // WebSocket payload hardening: apply freshest Coinbase WS prices at send time
    // so clients do not wait for the next full scan cycle to see live ticks.
    if (MARKET_DATA_PROVIDER === "COINBASE" && Array.isArray(liveState.results) && liveState.results.length > 0) {
      const wsClient = getCoinbaseWebSocketClient();
      const wsPrices = wsClient.getPrices();
      if (wsPrices.size > 0) {
        const nextResults = liveState.results.map((row) => {
          const base = String(row.symbol)
            .toUpperCase()
            .replace(/-(USDT|USDC|USD)-?(SWAP|PERP)?$/i, "")
            .replace(/-(SWAP|PERP)$/i, "");
          const wsPrice = wsPrices.get(`${base}-USD`);
          if (!wsPrice) {
            return row;
          }
          const parsed = Number(wsPrice);
          if (!Number.isFinite(parsed) || parsed <= 0 || parsed === row.close) {
            return row;
          }
          return {
            ...row,
            close: parsed
          };
        });

        return {
          ...liveState,
          results: nextResults
        };
      }
    }

    return liveState;
  }

  return {
    ...state,
    results: [],
    liveAccount: null,
    tradeSimulation: toTestTradeSimulationSnapshot(tenantSnapshot)
  };
}

function resolveTradeMode(req: express.Request): "test" | "live" {
  const queryMode = typeof req.query["mode"] === "string" ? req.query["mode"] : "";
  const bodyObj = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : null;
  const bodyMode = typeof bodyObj?.mode === "string" ? bodyObj.mode : "";
  const mode = String(queryMode || bodyMode || "live").trim().toLowerCase();
  return mode === "test" ? "test" : "live";
}

function resolveEffectiveTenantId(req: express.Request & { organizationId?: string }): string {
  const explicitTenantId = resolveTenantId(req);
  if (resolveTradeMode(req) === "test" && explicitTenantId) {
    return explicitTenantId;
  }
  // If user is authenticated, use their organizationId for isolation
  if (req.organizationId) {
    return req.organizationId;
  }
  // Otherwise fall back to query parameter (for backward compatibility)
  return explicitTenantId;
}

function resolveTenantId(req: express.Request): string {
  const queryTenantId = typeof req.query["tenantId"] === "string" ? req.query["tenantId"] : "";
  const bodyObj = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : null;
  const bodyTenantId = typeof bodyObj?.tenantId === "string" ? bodyObj.tenantId : "";
  const headerTenantId = typeof req.header("x-tenant-id") === "string" ? req.header("x-tenant-id") : "";
  return normalizeTenantId(queryTenantId || bodyTenantId || headerTenantId || DEFAULT_TRADE_TENANT_ID);
}

async function syncLiveAccountData(): Promise<void> {
  try {
    const liveAccountSnapshot = await buildLiveAccountSnapshot();

    const latest = getLatestServiceState();
    if (!latest) {
      return;
    }

    const { service: _service, ...stateWithoutService } = latest;
    await setLatestServiceState({
      ...stateWithoutService,
      liveAccount: liveAccountSnapshot
    });
  } catch (error) {
    console.error("[server] Failed to sync live account data:", error);
  }
}

const wsClientPreferences = new WeakMap<WebSocket, { mode: "test" | "live"; tenantId: string }>();

function broadcastStateToWsClients(state: ReturnType<typeof getLatestServiceState>): void {
  if (!state) {
    return;
  }

  for (const client of wsServer.clients) {
    if (client.readyState === WebSocket.OPEN) {
      const preference = wsClientPreferences.get(client) ?? { mode: "live" as const, tenantId: DEFAULT_TRADE_TENANT_ID };
      const filtered = toStateForMode(state, preference.mode, preference.tenantId);
      client.send(JSON.stringify(filtered));
    }
  }
}

wsServer.on("connection", (socket, request) => {
  const requestUrl = new URL(request.url ?? "/ws/state", `http://localhost:${port}`);
  const mode = String(requestUrl.searchParams.get("mode") ?? "live").trim().toLowerCase();
  const rawTenantId = requestUrl.searchParams.get("tenantId") ?? undefined;
  const tenantId = normalizeTenantId(rawTenantId);
  
  console.log("[WebSocket /ws/state] Connection - mode:", mode, "rawTenantId:", rawTenantId, "normalizedTenantId:", tenantId);
  
  wsClientPreferences.set(socket, { mode: mode === "test" ? "test" : "live", tenantId });

  const state = getLatestServiceState();
  if (state) {
    const filtered = toStateForMode(state, mode === "test" ? "test" : "live", tenantId);
    console.log("[WebSocket /ws/state] Sending filtered state - mode:", mode, "tenantId:", tenantId, "activeTradesCount:", filtered?.tradeSimulation?.activeTrades?.length ?? 0);
    socket.send(JSON.stringify(filtered));
  }
});

subscribeStateUpdates((state) => {
  broadcastStateToWsClients(state);
});

bitunixAccountWsServer.on("connection", (socket, request) => {
  const requestUrl = new URL(request.url ?? "/ws/bitunix-account", `http://localhost:${port}`);
  const marginCoin = String(requestUrl.searchParams.get("marginCoin") ?? "USDT").trim().toUpperCase() || "USDT";

  const sendSnapshot = async (): Promise<void> => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (MARKET_DATA_PROVIDER !== "BITUNIX") {
      socket.send(JSON.stringify({
        error: "Bitunix account websocket unavailable for current provider",
        provider: MARKET_DATA_PROVIDER,
        expectedProvider: "BITUNIX"
      }));
      return;
    }

    const auth = getBitunixPrivateAuthStatus();
    if (!auth.configured) {
      socket.send(JSON.stringify({
        error: "Bitunix private API credentials are not configured",
        auth
      }));
      return;
    }

    try {
      const snapshot = await fetchBitunixAccountSnapshot(marginCoin);
      socket.send(JSON.stringify(snapshot));
    } catch (error) {
      socket.send(JSON.stringify({
        error: "Failed to fetch Bitunix account snapshot",
        details: error instanceof Error ? error.message : String(error),
        auth
      }));
    }
  };

  void sendSnapshot();
  const timer = setInterval(() => {
    void sendSnapshot();
  }, BITUNIX_ACCOUNT_WS_POLL_MS);

  socket.on("close", () => {
    clearInterval(timer);
  });

  socket.on("error", () => {
    clearInterval(timer);
  });
});

dryRunWsServer.on("connection", (socket, request) => {
  const requestUrl = new URL(request.url ?? "/ws/execution-dry-run", `http://localhost:${port}`);
  const limitRaw = Number(requestUrl.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 500) : 50;

  const sendPlans = (plans = listDryRunExecutionPlans(limit)): void => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({
      count: plans.length,
      plans: plans.slice(0, limit)
    }));
  };

  sendPlans();
  const unsubscribe = subscribeDryRunExecutionPlans((plans) => {
    sendPlans(plans);
  });

  socket.on("close", () => {
    unsubscribe();
  });

  socket.on("error", () => {
    unsubscribe();
  });
});

stockPricesWsServer.on("connection", (socket, request) => {
  const requestUrl = new URL(request.url ?? "/ws/prices/stocks", `http://localhost:${port}`);
  const rawSymbols = String(requestUrl.searchParams.get("symbols") ?? "").trim();
  const limitRaw = Number(requestUrl.searchParams.get("limit") ?? 50);
  const pollMsRaw = Number(requestUrl.searchParams.get("pollMs") ?? 30000);
  const pollMs = Number.isFinite(pollMsRaw) ? Math.max(5_000, Math.min(120_000, Math.trunc(pollMsRaw))) : 30_000;
  const symbols = resolveStockSymbols(rawSymbols, limitRaw);

  if (symbols.length === 0) {
    socket.send(JSON.stringify({
      error: "No symbols provided",
      hint: "Use ?symbols=AAPL,MSFT,NVDA"
    }));
    socket.close();
    return;
  }

  const sendCachedSnapshotIfAvailable = (): void => {
    if (socket.readyState !== WebSocket.OPEN || !latestStockQuotesSnapshot) {
      return;
    }

    const requestedSet = new Set(symbols);
    const cachedQuotes = latestStockQuotesSnapshot.quotes.filter((quote) => requestedSet.has(quote.symbol));

    if (cachedQuotes.length === 0) {
      return;
    }

    const failedSymbols = latestStockQuotesSnapshot.failedSymbols.filter((entry) => requestedSet.has(entry.symbol));
    const payload: StockQuotesResponsePayload = {
      provider: "FINNHUB",
      assetClass: "STOCK",
      timestamp: new Date().toISOString(),
      count: cachedQuotes.length,
      requestedCount: symbols.length,
      quotes: cachedQuotes,
      failedSymbols,
      stale: true,
      staleReason: "Using cached snapshot while fresh quotes load"
    };

    socket.send(JSON.stringify(payload));
  };

  const sendSnapshot = async (): Promise<void> => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const payload = await buildStockQuotesPayload(symbols);
      socket.send(JSON.stringify(payload));
    } catch (error) {
      socket.send(JSON.stringify({
        error: "Failed to fetch stock prices from Finnhub",
        details: error instanceof Error ? error.message : String(error)
      }));
    }
  };

  sendCachedSnapshotIfAvailable();
  void sendSnapshot();
  const timer = setInterval(() => {
    void sendSnapshot();
  }, pollMs);

  socket.on("close", () => {
    clearInterval(timer);
  });

  socket.on("error", () => {
    clearInterval(timer);
  });
});

saasDashboardWsServer.on("connection", (socket, request) => {
  const requestUrl = new URL(request.url ?? "/ws/saas-dashboard", `http://localhost:${port}`);
  const scope = String(requestUrl.searchParams.get("scope") ?? "full").trim().toLowerCase();
  const pollMsRaw = Number(requestUrl.searchParams.get("pollMs") ?? 30_000);
  const pollMs = Number.isFinite(pollMsRaw) ? Math.max(5_000, Math.min(120_000, Math.trunc(pollMsRaw))) : 30_000;

  // Extract JWT from Authorization header or query parameter
  let tokenString: string | null = null;
  
  const authHeader = String(request.headers.authorization ?? "").trim();
  if (authHeader.startsWith("Bearer ")) {
    tokenString = authHeader.slice(7);
  }
  
  // Fallback: try query parameter (for clients that can't set headers)
  if (!tokenString) {
    tokenString = String(requestUrl.searchParams.get("token") ?? "").trim() || null;
  }

  if (!tokenString) {
    socket.send(JSON.stringify({
      error: "Missing or invalid authorization",
      details: "Bearer token required in Authorization header or token query parameter"
    }));
    socket.close();
    return;
  }

  let userId: string;
  let organizationId: string;

  try {
    const jwtSecret = process.env.JWT_SECRET || "dev-secret-key-change-in-prod";
    const decoded = jwt.verify(tokenString, jwtSecret) as {
      userId: string;
      organizationId: string;
    };
    userId = decoded.userId;
    organizationId = decoded.organizationId;
  } catch (error) {
    socket.send(JSON.stringify({
      error: "Invalid or expired token",
      details: String(error instanceof Error ? error.message : "JWT verification failed")
    }));
    socket.close();
    return;
  }

  const apiBase = `http://localhost:${port}/api/v1`;
  const authHeaders = { Authorization: `Bearer ${tokenString}` };

  const sendSnapshot = async (): Promise<void> => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      if (scope === "positions") {
        const response = await fetch(`${apiBase}/positions/${encodeURIComponent(userId)}`, {
          headers: authHeaders
        });
        const payload = (await response.json().catch(() => ({}))) as { success?: boolean; positions?: unknown; error?: string };
        if (!response.ok || !payload.success) {
          socket.send(JSON.stringify({
            error: payload.error ?? `Positions request failed (${response.status})`
          }));
          return;
        }

        socket.send(JSON.stringify({
          kind: "saas-dashboard",
          scope: "positions",
          timestamp: new Date().toISOString(),
          positions: Array.isArray(payload.positions) ? payload.positions : []
        }));
        return;
      }

      const [posResponse, alertsResponse, summaryResponse] = await Promise.all([
        fetch(`${apiBase}/positions/${encodeURIComponent(userId)}`, { headers: authHeaders }),
        fetch(`${apiBase}/alerts/user/${encodeURIComponent(userId)}?limit=20`, { headers: authHeaders }),
        fetch(`${apiBase}/alerts/summary/${encodeURIComponent(userId)}?daysBack=7`, { headers: authHeaders })
      ]);

      const posPayload = (await posResponse.json().catch(() => ({}))) as { success?: boolean; positions?: unknown; error?: string };
      const alertsPayload = (await alertsResponse.json().catch(() => ({}))) as { success?: boolean; events?: unknown; error?: string };
      const summaryPayload = (await summaryResponse.json().catch(() => ({}))) as { success?: boolean; summary?: unknown; error?: string };

      const hasFailure = !posResponse.ok || !alertsResponse.ok || !summaryResponse.ok
        || !posPayload.success || !alertsPayload.success || !summaryPayload.success;

      if (hasFailure) {
        socket.send(JSON.stringify({
          error: posPayload.error ?? alertsPayload.error ?? summaryPayload.error ?? "Failed to refresh SaaS dashboard stream"
        }));
        return;
      }

      socket.send(JSON.stringify({
        kind: "saas-dashboard",
        scope: "full",
        timestamp: new Date().toISOString(),
        positions: Array.isArray(posPayload.positions) ? posPayload.positions : [],
        alerts: Array.isArray(alertsPayload.events) ? alertsPayload.events : [],
        summary: summaryPayload.summary ?? null
      }));
    } catch (error) {
      socket.send(JSON.stringify({
        error: "Failed to refresh SaaS dashboard stream",
        details: error instanceof Error ? error.message : String(error)
      }));
    }
  };

  void sendSnapshot();
  const timer = setInterval(() => {
    void sendSnapshot();
  }, pollMs);

  socket.on("close", () => {
    clearInterval(timer);
  });

  socket.on("error", () => {
    clearInterval(timer);
  });
});

app.use(cors());
app.use(express.json());

// Auth routes (no authentication required)
app.use("/api/auth", authApiRouter);

// Apply JWT middleware to all other /api/* routes (parses token if present, doesn't block)
app.use("/api", optionalJwtAuthMiddleware);

// User routes (require JWT authentication)
app.use("/api/v1/user", userApiRouter);

// SaaS API v1 routes (with authentication)
app.use("/api/v1/config", configApiRouter);
app.use("/api/v1/signals", signalsApiV1Router);
app.use("/api/v1/broker", brokerApiV1Router);
app.use("/api/v1/data", marketDataApiV1Router);
app.use("/api/v1/positions", positionsApiV1Router);
app.use("/api/v1/alerts", alertEventsApiV1Router);
app.use("/api/v1/forecast", forecastApiV1Router);
app.use("/api/v1/kalshi", kalshiApiV1Router);

const querySchema = z.object({
  query: z.string().optional(),
  market: z.enum(["perp", "spot"]).default("perp"),
  limitTokens: z.coerce.number().int().min(1).max(200).default(DEFAULT_SCAN_LIMIT_TOKENS),
  onlySignals: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((value) => value === "true"),
  refresh: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((value) => value === "true"),
  publish: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((value) => value === "true")
});

const momentumQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
  refresh: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((value) => value === "true")
});

const bitunixAccountQuerySchema = z.object({
  marginCoin: z.string().trim().min(1).max(12).optional()
});

const bitunixAttachTpSlSchema = z.object({
  positionId: z.string().trim().min(1),
  tpPrice: z.coerce.number().positive(),
  slPrice: z.coerce.number().positive(),
  symbol: z.string().trim().min(1).optional(),
  side: z.enum(["LONG", "SHORT"]).optional()
});

const bitunixHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  symbol: z.string().trim().min(1).max(32).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "strata-api", now: new Date().toISOString(), access: getAppAccessState() });
});

app.get("/api/access", (_req, res) => {
  res.json(getAppAccessState());
});

app.get("/api/bitunix/account", requireJWTAuth, async (req, res) => {
  if (MARKET_DATA_PROVIDER !== "BITUNIX") {
    res.status(409).json({
      error: "Bitunix account endpoint unavailable for current provider",
      provider: MARKET_DATA_PROVIDER,
      expectedProvider: "BITUNIX"
    });
    return;
  }

  const parsed = bitunixAccountQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const auth = getBitunixPrivateAuthStatus();
  if (!auth.configured) {
    res.status(503).json({
      error: "Bitunix private API credentials are not configured",
      auth
    });
    return;
  }

  try {
    const snapshot = await fetchBitunixAccountSnapshot(parsed.data.marginCoin);
    res.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /401|403|unauthorized|forbidden|sign|api-key/i.test(message) ? 502 : 500;
    console.error("[/api/bitunix/account] Fetch failed", {
      provider: MARKET_DATA_PROVIDER,
      marginCoin: parsed.data.marginCoin ?? null,
      authConfigured: auth.configured,
      error: message
    });
    res.status(status).json({
      error: "Failed to fetch Bitunix account snapshot",
      details: message,
      auth
    });
  }
});

app.post("/api/bitunix/history/sync", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  if (MARKET_DATA_PROVIDER !== "BITUNIX") {
    res.status(409).json({
      error: "Bitunix history endpoint unavailable for current provider",
      provider: MARKET_DATA_PROVIDER,
      expectedProvider: "BITUNIX"
    });
    return;
  }

  const parsed = bitunixHistoryQuerySchema.safeParse(req.body ?? req.query ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query/body", details: parsed.error.flatten() });
    return;
  }

  const auth = getBitunixPrivateAuthStatus();
  if (!auth.configured) {
    res.status(503).json({
      error: "Bitunix private API credentials are not configured",
      auth
    });
    return;
  }

  try {
    const fetched = await fetchBitunixClosedTradeHistory({
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      symbol: parsed.data.symbol
    });

    const persisted = await upsertExchangeTradeHistory("BITUNIX", fetched.rows);
    res.json({
      provider: "BITUNIX",
      synced: true,
      fetchedCount: fetched.rows.length,
      persistedCount: persisted.insertedOrUpdated,
      endpointUsed: fetched.endpointUsed,
      attempts: fetched.attempts
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[/api/bitunix/history/sync] Sync failed", {
      page: parsed.data.page ?? 1,
      pageSize: parsed.data.pageSize ?? 100,
      symbol: parsed.data.symbol ?? null,
      error: message
    });
    res.status(500).json({
      error: "Failed to sync Bitunix closed trade history",
      details: message,
      auth
    });
  }
});

app.get("/api/bitunix/history", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  const parsed = bitunixHistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  try {
    const rows = await listExchangeTradeHistory({
      provider: "BITUNIX",
      symbol: parsed.data.symbol,
      limit: parsed.data.limit
    });
    res.json({
      provider: "BITUNIX",
      count: rows.length,
      rows
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to load persisted Bitunix trade history",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Test-only route: places a $10 SUI LONG limit order at $1 with TP and SL to verify
// that limit orders with TP/SL land correctly on the exchange before using them in production.
app.post("/api/bitunix/test/limit-order", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  if (MARKET_DATA_PROVIDER !== "BITUNIX") {
    res.status(409).json({
      error: "Bitunix test endpoint unavailable for current provider",
      provider: MARKET_DATA_PROVIDER,
      expectedProvider: "BITUNIX"
    });
    return;
  }

  // Fixed test parameters — $10 stake, 10x leverage, SUI LONG at $1.
  // qty = stakeUsd * leverage / price = 10 * 10 / 1 = 100
  const testSymbol   = "SUI-PERP";
  const testSide     = "BUY" as const;
  const entryPrice   = 1.0;       // limit trigger price
  const leverage     = 10;
  const stakeUsd     = 10;
  const tpRoePct     = 10.3;      // % ROE
  const slRoePct     = 20.0;      // % ROE
  const tpPriceMoveP = tpRoePct / leverage / 100;
  const slPriceMoveP = slRoePct / leverage / 100;
  const clientId     = `TEST-SUI-LONG-LMT-${Date.now()}`;

  try {
    const placeAtPrice = async (price: number) => {
      const latest = await fetchLatestOhlc(testSymbol, "1m").catch(() => null);
      const lastPrice = Number(latest?.close ?? 0);
      const testQty = (stakeUsd * leverage) / price;
      const testTpPrice = Number((price * (1 + tpPriceMoveP)).toFixed(6));
      const testSlPrice = Number((price * (1 - slPriceMoveP)).toFixed(6));
      const safeTpPrice = Number.isFinite(lastPrice) && lastPrice > 0
        ? Number(Math.max(testTpPrice, lastPrice * 1.005).toFixed(6))
        : testTpPrice;
      const safeSlPrice = Number.isFinite(lastPrice) && lastPrice > 0
        ? Number(Math.min(testSlPrice, lastPrice * 0.995).toFixed(6))
        : testSlPrice;
      const order = await placeBitunixLimitOrder({
        symbol: testSymbol,
        side: testSide,
        qty: testQty,
        price,
        clientId,
        tpPrice: safeTpPrice,
        slPrice: safeSlPrice
      });
      return {
        order,
        params: {
          symbol: testSymbol,
          side: testSide,
          entryPrice: price,
          qty: testQty,
          tpPrice: safeTpPrice,
          slPrice: safeSlPrice,
          exchangeLastPrice: Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : null,
          leverage,
          stakeUsd
        }
      };
    };

    let usedExchangeCap = false;
    let requestedEntryPrice = entryPrice;
    let result;

    // Bitunix can reject a BUY limit above exchange max allowed price.
    // For test convenience, retry automatically at the reported cap.
    // Example error: "Buy price cannot exceed 0.8435".
    try {
      result = await placeAtPrice(entryPrice);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const capMatch = message.match(/buy\s+price\s+cannot\s+exceed\s+([0-9]+(?:\.[0-9]+)?)/i);
      const cap = capMatch ? Number(capMatch[1]) : NaN;
      if (Number.isFinite(cap) && cap > 0) {
        usedExchangeCap = true;
        requestedEntryPrice = entryPrice;
        result = await placeAtPrice(cap);
      } else {
        throw error;
      }
    }

    res.json({
      ok: true,
      note: "Test limit order placed. Verify on Bitunix that TP/SL cover the full position qty.",
      usedExchangeCap,
      requestedEntryPrice,
      params: result.params,
      order: result.order
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/bitunix/position/attach-tpsl", requireJWTAuth, async (req, res) => {
  if (MARKET_DATA_PROVIDER !== "BITUNIX") {
    res.status(409).json({
      error: "Bitunix TP/SL endpoint unavailable for current provider",
      provider: MARKET_DATA_PROVIDER,
      expectedProvider: "BITUNIX"
    });
    return;
  }

  const parsed = bitunixAttachTpSlSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  const auth = getBitunixPrivateAuthStatus();
  if (!auth.configured) {
    res.status(503).json({
      error: "Bitunix private API credentials are not configured",
      auth
    });
    return;
  }

  try {
    const result = await attachBitunixPositionTpSlDebug(parsed.data);
    res.json({
      ok: result.success,
      ...result
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[/api/bitunix/position/attach-tpsl] Request failed", {
      positionId: parsed.data.positionId,
      symbol: parsed.data.symbol ?? null,
      side: parsed.data.side ?? null,
      tpPrice: parsed.data.tpPrice,
      slPrice: parsed.data.slPrice,
      error: message
    });
    res.status(500).json({
      error: "Failed to attach TP/SL to Bitunix position",
      details: message,
      auth
    });
  }
});

app.post("/api/access", (req, res) => {
  const parsed = z
    .object({
      mode: z.enum(["open", "licensed"]).optional(),
      plan: z.enum(["FREE", "PRO", "ELITE"]).optional(),
      status: z.enum(["ACTIVE", "TRIALING", "PAST_DUE", "INACTIVE"]).optional(),
      maxScanTokensOverride: z.number().int().min(1).max(200).nullable().optional(),
      maxActiveTradesOverride: z.number().int().min(0).max(20).nullable().optional(),
      note: z.string().max(500).nullable().optional()
    })
    .safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  try {
    const updated = saveLicense(parsed.data);
    invalidateLicenseCache();
    res.json({ saved: true, license: updated, access: getAppAccessState() });
  } catch (error) {
    res.status(500).json({
      error: "Failed to save license",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/access/license-path", (_req, res) => {
  res.json({ path: getLicenseFilePath() });
});

app.get("/api/tokens", async (req, res) => {
  const parsed = querySchema.pick({ query: true, market: true }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  try {
    const tokens = await searchTokens(parsed.data.query, parsed.data.market);
    res.json({
      market: parsed.data.market,
      query: parsed.data.query ?? "",
      total: tokens.length,
      tokens,
      tokenDetails: tokens.map((token) => ({
        symbol: token,
        display: formatTokenDisplay(token),
        leverageProfile: getTokenLeverageProfile(token)
      }))
    });
  } catch (error) {
    console.error("[/api/tokens] Search failed", {
      market: parsed.data.market,
      query: parsed.data.query ?? "",
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({
      error: "Failed to search tokens",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/rsi", async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const scanLimit = getEffectiveScanLimit(parsed.data.limitTokens);

  try {
    const tenantId = resolveTenantId(req);
    const mode = resolveTradeMode(req);
    const runtimeMode = mode === "test" ? "SIM" : "LIVE";
    const latest = getLatestServiceState();
    const shouldUseCachedState =
      !parsed.data.refresh &&
      latest &&
      latest.params.market === parsed.data.market &&
      latest.params.limitTokens === scanLimit;

    if (shouldUseCachedState) {
      const unfilteredResults = latest.results;
      const filteredOutNoSignal = parsed.data.onlySignals
        ? unfilteredResults.filter((item) => item.signal.type.startsWith("NO SIGNAL")).length
        : 0;
      const results = parsed.data.onlySignals
        ? unfilteredResults.filter((item) => !item.signal.type.startsWith("NO SIGNAL"))
        : unfilteredResults;

      res.json({
        ...latest,
        meta: {
          onlySignals: parsed.data.onlySignals,
          filteredOutNoSignal
        },
        results
      });
      return;
    }

    const scan = await scanRsi({
      query: undefined,
      market: parsed.data.market,
      limitTokens: scanLimit
    });

    const unfilteredCounts = {
      strongShort: scan.results.filter((item) => item.signal.type === "STRONG SHORT").length,
      strongLong: scan.results.filter((item) => item.signal.type === "STRONG LONG").length,
      continuationShort: scan.results.filter((item) => item.signal.type === "CONTINUATION SHORT").length,
      continuationLong: scan.results.filter((item) => item.signal.type === "CONTINUATION LONG").length,
      reversalShort: scan.results.filter((item) => item.signal.type === "REVERSAL SHORT").length,
      reversalLong: scan.results.filter((item) => item.signal.type === "REVERSAL LONG").length,
      noSignal: scan.results.filter((item) => item.signal.type.startsWith("NO SIGNAL")).length
    };

    const results = parsed.data.onlySignals
        ? scan.results.filter(
            (item) => !item.signal.type.startsWith("NO SIGNAL")
          )
      : scan.results;

    const tradeSimulation = await processTradeSimulation(scan.results, { tenantId, runtimeMode });
    const globalTradeSimulation = parsed.data.publish ? await refreshTradeSimulation() : tradeSimulation;
    
    // Only fetch perp contexts for perp markets; spot markets don't have leverage
    const perpContexts = parsed.data.market === "spot" 
      ? new Map() 
      : await fetchPerpContexts(results.map((row) => row.symbol));

    const filteredOutNoSignal = parsed.data.onlySignals ? unfilteredCounts.noSignal : 0;
    const resultsWithLeverage = results.map((row) => {
      const leverage = perpContexts.get(row.symbol)?.maxLeverage;
      return {
        ...row,
        maxLeverage: parsed.data.market === "perp" && typeof leverage === "number" && Number.isFinite(leverage) && leverage > 0 ? leverage : undefined
      };
    });

    console.info("[/api/rsi] Scan completed", {
      market: parsed.data.market,
      query: parsed.data.query ?? "",
      requestedLimitTokens: parsed.data.limitTokens,
      effectiveLimitTokens: scanLimit,
      onlySignals: parsed.data.onlySignals,
      totalUnfiltered: scan.results.length,
      returned: results.length,
      filteredOutNoSignal,
      skipped: scan.skipped.length,
      signalCounts: unfilteredCounts
    });

    if (scan.skipped.length > 0) {
      console.warn("[/api/rsi] Skipped symbols", scan.skipped.slice(0, 10));
    }

    if (parsed.data.onlySignals && results.length === 0 && filteredOutNoSignal > 0) {
      console.warn("[/api/rsi] No directional signals found in this scan", {
        filteredOutNoSignal
      });
    }

    const response = {
      ...scan,
      meta: {
        onlySignals: parsed.data.onlySignals,
        filteredOutNoSignal
      },
      signalCounts: {
        strongShort: results.filter((item) => item.signal.type === "STRONG SHORT").length,
        strongLong: results.filter((item) => item.signal.type === "STRONG LONG").length,
        continuationShort: results.filter((item) => item.signal.type === "CONTINUATION SHORT").length,
        continuationLong: results.filter((item) => item.signal.type === "CONTINUATION LONG").length,
        reversalShort: results.filter((item) => item.signal.type === "REVERSAL SHORT").length,
        reversalLong: results.filter((item) => item.signal.type === "REVERSAL LONG").length,
        noSignal: results.filter((item) => item.signal.type.startsWith("NO SIGNAL")).length
      },
      results: resultsWithLeverage,
      tradeSimulation
    };

    if (parsed.data.publish) {
      await setLatestServiceState({
        ...response,
        tradeSimulation: globalTradeSimulation
      });
    }

    res.json(response);
  } catch (error) {
    console.error("[/api/rsi] Scan failed", {
      market: parsed.data.market,
      query: parsed.data.query ?? "",
      requestedLimitTokens: parsed.data.limitTokens,
      effectiveLimitTokens: scanLimit,
      onlySignals: parsed.data.onlySignals,
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({
      error: "Failed to calculate RSI",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/momentum/early-runs", requireJWTAuth, async (req, res) => {
  const parsed = momentumQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  try {
    const payload = await getMomentumCandidatesSnapshot({
      limit: parsed.data.limit,
      forceRefresh: parsed.data.refresh
    });

    res.json(payload);
  } catch (error) {
    console.error("[/api/momentum/early-runs] Scan failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({
      error: "Failed to compute momentum candidates",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

function detectConfiguredExchangeProviders(exchangeCredentials: unknown): string[] {
  if (!exchangeCredentials || typeof exchangeCredentials !== "object") {
    return [];
  }

  const entries = Object.entries(exchangeCredentials as Record<string, unknown>);
  return entries
    .filter(([, value]) => {
      if (!value || typeof value !== "object") return false;
      return Object.values(value as Record<string, unknown>).some((item) => {
        if (typeof item !== "string") return false;
        const trimmed = item.trim();
        return trimmed.length > 0 && !trimmed.startsWith("YOUR_");
      });
    })
    .map(([key]) => key.toUpperCase());
}

app.get("/api/ui/context", async (_req, res) => {
  try {
    const platform = await backfillPrismaClient().platformConfiguration.findFirst({
      select: { exchangeCredentials: true }
    });

    const configuredProviders = detectConfiguredExchangeProviders(platform?.exchangeCredentials);
    const preferredProvider = configuredProviders[0] ?? MARKET_DATA_PROVIDER;

    res.json({
      marketDataProvider: MARKET_DATA_PROVIDER,
      exchangeProviderLabel: preferredProvider,
      configuredCredentialProviders: configuredProviders
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to load UI context",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * Get real-time crypto prices from Coinbase WebSocket cache
 * Crypto-only endpoint.
 */
app.get("/api/prices/coinbase", (_req, res) => {
  try {
    const client = getCoinbaseWebSocketClient();
    if (!client.isConnected()) {
      res.status(503).json({
        error: "Coinbase WebSocket not connected",
        connected: false
      });
      return;
    }

    const prices = client.getPrices();
    const pricesObj: Record<string, string> = {};
    prices.forEach((price, productId) => {
      pricesObj[productId] = price;
    });

    res.json({
      provider: "COINBASE",
      assetClass: "CRYPTO",
      connected: true,
      timestamp: new Date().toISOString(),
      prices: pricesObj,
      count: prices.size
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to get prices",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * Get stock quotes from Finnhub.
 * Stock-only endpoint (crypto symbols are rejected).
 */
app.get("/api/prices/stocks", async (req, res) => {
  const rawSymbols = String(req.query["symbols"] ?? "").trim();
  const limitRaw = Number(req.query["limit"] ?? 50);
  const symbols = resolveStockSymbols(rawSymbols, limitRaw);

  if (symbols.length === 0) {
    res.status(400).json({
      error: "No symbols provided",
      hint: "Use ?symbols=AAPL,MSFT,NVDA"
    });
    return;
  }

  try {
    const payload = await buildStockQuotesPayload(symbols);
    if (payload.stale) {
      res.setHeader("x-stock-data-source", "stale-cache");
    }
    res.json(payload);
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch stock prices from Finnhub",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/trades", requireJWTAuth, async (req: express.Request & { organizationId?: string }, res) => {
  try {
    const mode = resolveTradeMode(req);
    const tenantId = resolveEffectiveTenantId(req);
    const skipRefresh = req.query["refresh"] === "0" || req.query["summaryOnly"] === "1";
    const latestState = getLatestServiceState();
    const tradeSimulation = skipRefresh && mode === "test"
      ? getTradeSimulationSnapshot({ tenantId })
      : await refreshTradeSimulation({ tenantId });
    const tenantSnapshot = toTenantTradeSimulationSnapshot(tradeSimulation, tenantId, latestState?.results);

    console.log("[GET /api/trades]", {
      mode,
      tenantId,
      skipRefresh,
      organizationId: req.organizationId,
      userId: (req as any).userId,
      activeTrades: (mode === "test"
        ? toTestTradeSimulationSnapshot(tenantSnapshot)?.stats?.activeTrades ?? 0
        : tenantSnapshot?.stats?.activeTrades ?? 0),
      totalTrades: (mode === "test"
        ? toTestTradeSimulationSnapshot(tenantSnapshot)?.stats?.totalTrades ?? 0
        : tenantSnapshot?.stats?.totalTrades ?? 0)
    });

    res.json(mode === "test" ? toTestTradeSimulationSnapshot(tenantSnapshot) : tenantSnapshot);
  } catch (error) {
    res.status(500).json({
      error: "Failed to refresh trade simulation",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/trades/rejections", requireJWTAuth, (req, res) => {
  const limitRaw = Number(req.query["limit"] ?? 50);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 200) : 50;
  const symbolFilter = typeof req.query["symbol"] === "string" ? req.query["symbol"].trim().toUpperCase() : null;
  let log = getTradeRejectionLog();
  if (symbolFilter) {
    log = log.filter((entry) => entry.symbol.toUpperCase() === symbolFilter);
  }
  res.json({ count: log.length, rejections: log.slice(0, limit) });
});

app.post("/api/trades/rejections/clear", requireJWTAuth, requireFeature("manualTradeControls"), (_req, res) => {
  clearTradeRejections();
  res.json({ cleared: true });
});

app.get("/api/execution/dry-run", requireJWTAuth, requireFeature("manualTradeControls"), (req, res) => {
  const limitRaw = Number(req.query["limit"] ?? 50);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 500) : 50;
  const plans = listDryRunExecutionPlans(limit);
  res.json({
    count: plans.length,
    plans
  });
});

app.post("/api/execution/dry-run/clear", requireJWTAuth, requireFeature("manualTradeControls"), (_req, res) => {
  const cleared = clearDryRunExecutionPlans();
  res.json(cleared);
});

app.get("/api/backfill/status", requireJWTAuth, async (req, res) => {
  const symbolRaw = typeof req.query["symbol"] === "string" ? req.query["symbol"].trim().toUpperCase() : null;
  if (!symbolRaw) {
    res.status(400).json({ error: "symbol query param required" });
    return;
  }

  try {
    const record = await getBackfillStatus(backfillPrismaClient(), symbolRaw);
    if (!record) {
      res.json({ symbol: symbolRaw, status: "NOT_FOUND", candleCount: 0, dataAvailableFrom: null, lastError: null });
      return;
    }

    res.json({
      symbol: record.symbol,
      status: record.status,
      candleCount: record.candleCount,
      dataAvailableFrom: record.dataAvailableFrom,
      lastSuccessAt: record.lastSuccessAt,
      lastError: record.lastError
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/trades/profile", (_req, res) => {
  res.json(getTradeEngineProfile());
});

app.post("/api/trades/close-symbol", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  const parsed = z
    .object({
      symbol: z.string().trim().min(1)
    })
    .safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  try {
    const mode = resolveTradeMode(req);
    const tenantId = resolveEffectiveTenantId(req);
    const simulateOnly = mode === "test";
    const result = await forceCloseOpenTradesBySymbol(parsed.data.symbol, { simulateOnly, tenantId });
    const latestSnapshot = await refreshTradeSimulation();
    await syncLatestTradeSimulation(latestSnapshot);
    const tenantSnapshot = await refreshTradeSimulation({ tenantId });
    const responseSnapshot = simulateOnly ? toTestTradeSimulationSnapshot(tenantSnapshot) : tenantSnapshot;
    res.json({
      symbol: parsed.data.symbol,
      closedCount: result.closedCount,
      ...responseSnapshot
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to close open trades for symbol",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/reopen-last", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  const parsed = z
    .object({
      symbol: z.string().trim().min(1).optional()
    })
    .safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  try {
    const mode = resolveTradeMode(req);
    const tenantId = resolveEffectiveTenantId(req);
    const simulateOnly = mode === "test";
    const result = await forceReopenLastClosedTrade(parsed.data.symbol, { simulateOnly, tenantId });
    const latestSnapshot = await refreshTradeSimulation();
    await syncLatestTradeSimulation(latestSnapshot);
    const tenantSnapshot = await refreshTradeSimulation({ tenantId });
    const responseSnapshot = simulateOnly ? toTestTradeSimulationSnapshot(tenantSnapshot) : tenantSnapshot;
    if (!result.reopened) {
      res.status(409).json({ ...result, snapshot: responseSnapshot });
      return;
    }

    res.json({ ...result, snapshot: responseSnapshot });
  } catch (error) {
    res.status(500).json({
      error: "Failed to reopen last closed trade",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/remove-closed", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  const parsed = z
    .object({
      id: z.string().trim().min(1).optional(),
      symbol: z.string().trim().min(1).optional()
    })
    .refine((value) => Boolean(value.id || value.symbol), {
      message: "Provide id or symbol"
    })
    .safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  try {
    const mode = resolveTradeMode(req);
    const tenantId = resolveEffectiveTenantId(req);
    const simulateOnly = mode === "test";
    const result = await forceRemoveClosedTrade(parsed.data, { simulateOnly, tenantId });
    const latestSnapshot = await refreshTradeSimulation();
    await syncLatestTradeSimulation(latestSnapshot);
    const tenantSnapshot = await refreshTradeSimulation({ tenantId });
    const responseSnapshot = simulateOnly ? toTestTradeSimulationSnapshot(tenantSnapshot) : tenantSnapshot;
    if (!result.removed) {
      res.status(404).json({ ...result, snapshot: responseSnapshot });
      return;
    }

    res.json({ ...result, snapshot: responseSnapshot });
  } catch (error) {
    res.status(500).json({
      error: "Failed to remove closed trade",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/reset", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  try {
    const mode = resolveTradeMode(req);
    const tenantId = resolveEffectiveTenantId(req);
    const simulateOnly = mode === "test";
    await forceResetTradingRuntime({ simulateOnly, tenantId });
    const latestSnapshot = await refreshTradeSimulation();
    await syncLatestTradeSimulation(latestSnapshot);
    const tenantSnapshot = await refreshTradeSimulation({ tenantId });
    const responseSnapshot = simulateOnly ? toTestTradeSimulationSnapshot(tenantSnapshot) : tenantSnapshot;
    res.json({
      reset: true,
      ...responseSnapshot
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to reset trading runtime",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/clear-cooldown", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  try {
    const tenantId = resolveEffectiveTenantId(req);
    const snapshot = await forceClearCooldown({ tenantId });
    const latestSnapshot = await refreshTradeSimulation();
    await syncLatestTradeSimulation(latestSnapshot);
    res.json({
      cleared: true,
      ...snapshot
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to clear cooldown",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/evaluate-now", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  const latest = getLatestServiceState();
  if (!latest) {
    res.status(503).json({
      error: "Scanner service is starting",
      details: "No scan cycle completed yet"
    });
    return;
  }

  try {
    const tenantId = resolveEffectiveTenantId(req);
    const mode = resolveTradeMode(req);
    const runtimeMode = mode === "test" ? "SIM" : "LIVE";
    const beforeSnapshot = await refreshTradeSimulation({ tenantId });
    const beforeActive = mode === "test"
      ? toTestTradeSimulationSnapshot(beforeSnapshot)?.stats?.activeTrades ?? 0
      : beforeSnapshot.stats.activeTrades;

    await processTradeSimulation(latest.results, { tenantId, runtimeMode });
    const latestSnapshot = await refreshTradeSimulation();
    await syncLatestTradeSimulation(latestSnapshot);
    const tenantSnapshot = await refreshTradeSimulation({ tenantId });
    const afterActive = mode === "test"
      ? toTestTradeSimulationSnapshot(tenantSnapshot)?.stats?.activeTrades ?? 0
      : tenantSnapshot.stats.activeTrades;

    res.json({
      evaluated: true,
      beforeActive,
      afterActive,
      openedNow: Math.max(0, afterActive - beforeActive),
      snapshot: tenantSnapshot
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to evaluate entries",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/open-manual", requireJWTAuth, async (req, res) => {
  const parsed = z
    .object({
      symbol: z.string().trim().min(1),
      direction: z.enum(["LONG", "SHORT"]),
      signalType: z.string().trim().min(1).optional(),
      entryPrice: z.number().positive().optional()
    })
    .safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  try {
    const mode = resolveTradeMode(req);
    const tenantId = resolveEffectiveTenantId(req);
    const simulateOnly = mode === "test";

    console.log("[/api/trades/open-manual]", {
      symbol: parsed.data.symbol,
      direction: parsed.data.direction,
      mode,
      tenantId,
      simulateOnly,
      organizationId: (req as any).organizationId,
      userId: (req as any).userId
    });

    // Live trading requires manualTradeControls feature; test mode does not
    if (!simulateOnly && !isFeatureEnabled("manualTradeControls")) {
      res.status(403).json({
        error: "Feature manualTradeControls is unavailable for this plan",
        feature: "manualTradeControls",
        access: getAppAccessState()
      });
      return;
    }
    const result = await forceOpenManualTrade(parsed.data, { simulateOnly, tenantId });
    const latestSnapshot = await refreshTradeSimulation();
    await syncLatestTradeSimulation(latestSnapshot);
    const tenantSnapshot = await refreshTradeSimulation({ tenantId });
    const responseSnapshot = simulateOnly ? toTestTradeSimulationSnapshot(tenantSnapshot) : tenantSnapshot;
    if (!result.opened) {
      res.status(409).json({ ...result, snapshot: responseSnapshot });
      return;
    }

    res.json({ ...result, snapshot: responseSnapshot });
  } catch (error) {
    res.status(500).json({
      error: "Failed to open manual trade",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/simulate-pre-pump", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  const parsed = z
    .object({
      maxTokens: z.number().int().min(1).max(25).optional()
    })
    .safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  const latest = getLatestServiceState();
  if (!latest) {
    res.status(503).json({
      error: "Scanner service is starting",
      details: "No scan cycle completed yet"
    });
    return;
  }

  try {
    const result = await forceSimulatePrePumpWatchTrades(latest.results, {
      maxTokens: parsed.data.maxTokens
    });
    await syncLatestTradeSimulation(result.snapshot);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to simulate pre-pump candidates",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/detect-pre-pump", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  const parsed = z
    .object({
      maxTokens: z.number().int().min(1).max(50).optional()
    })
    .safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  const latest = getLatestServiceState();
  if (!latest) {
    res.status(503).json({
      error: "Scanner service is starting",
      details: "No scan cycle completed yet"
    });
    return;
  }

  try {
    const result = await detectPrePumpWatchCandidates(latest.results, {
      maxTokens: parsed.data.maxTokens
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to detect pre-pump candidates",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/pre-pump-calibration", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  const parsed = z
    .object({
      applySuggestions: z.boolean().optional().default(false),
      interval: z.enum(["M15", "H1", "H4", "H12", "D1"]).optional(),
      lookaheadBars: z.number().int().min(3).max(120).optional(),
      minFutureReturnPct: z.number().min(20).max(800).optional(),
      minCandlesPerSymbol: z.number().int().min(80).max(5000).optional(),
      maxSymbols: z.number().int().min(10).max(5000).optional(),
      topPercentileCut: z.number().min(50).max(99.5).optional(),
      includeTextReport: z.boolean().optional().default(true)
    })
    .safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  try {
    const options: Partial<PrePumpAnalysisOptions> = {
      interval: parsed.data.interval,
      lookaheadBars: parsed.data.lookaheadBars,
      minFutureReturnPct: parsed.data.minFutureReturnPct,
      minCandlesPerSymbol: parsed.data.minCandlesPerSymbol,
      maxSymbols: parsed.data.maxSymbols,
      topPercentileCut: parsed.data.topPercentileCut
    };

    const report = await analyzePrePumpPatterns(options);
    const suggestions = report.suggestedRuntimeSettings;
    const updatePayload = suggestions.map((item) => ({ key: item.key, value: item.value }));

    let applied = false;
    if (parsed.data.applySuggestions && updatePayload.length > 0) {
      await updateRuntimeSettings(updatePayload);
      applied = true;
    }

    res.json({
      success: true,
      analyzedAt: new Date().toISOString(),
      appliedSuggestions: applied,
      appliedCount: applied ? updatePayload.length : 0,
      appliedKeys: applied ? updatePayload.map((item) => item.key) : [],
      options: report.options,
      dataset: report.dataset,
      features: report.features,
      composite: report.composite,
      topExamples: report.topExamples,
      suggestedRuntimeSettings: suggestions,
      textReport: parsed.data.includeTextReport ? formatPrePumpAnalysisReport(report) : undefined
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to calibrate pre-pump settings",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// ─── Pre-pump candidate scanner (deterministic, daily) ─────────────────────────

const prePumpScanCacheByAsset: Record<"CRYPTO" | "STOCK", PrePumpScanResult | null> = {
  CRYPTO: null,
  STOCK: null
};
const prePumpScanInFlightByAsset: Record<"CRYPTO" | "STOCK", Promise<PrePumpScanResult> | null> = {
  CRYPTO: null,
  STOCK: null
};

async function computePrePumpScan(topN: number, assetClass: "CRYPTO" | "STOCK" = "CRYPTO"): Promise<PrePumpScanResult> {
  if (prePumpScanInFlightByAsset[assetClass]) {
    return prePumpScanInFlightByAsset[assetClass] as Promise<PrePumpScanResult>;
  }
  prePumpScanInFlightByAsset[assetClass] = runPrePumpScan({ topN, assetClass })
    .then((result) => {
      prePumpScanCacheByAsset[assetClass] = result;
      return result;
    })
    .finally(() => {
      prePumpScanInFlightByAsset[assetClass] = null;
    });
  return prePumpScanInFlightByAsset[assetClass] as Promise<PrePumpScanResult>;
}

/**
 * Milliseconds from `from` until the next scheduled run. Runs once per UTC day,
 * `offsetMinutes` after the 00:00 UTC daily candle close (default 15 min later,
 * giving the daily bar time to finalize/backfill before scanning).
 */
function msUntilNextDailyRun(from: Date, offsetMinutes: number): number {
  const next = new Date(from);
  next.setUTCHours(0, offsetMinutes, 0, 0);
  if (next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - from.getTime();
}

async function runDailyPrePumpScanAndNotify(): Promise<void> {
  console.log("[pre-pump] Running scheduled daily pre-pump scan...");
  const result = await computePrePumpScan(50);
  console.log(
    `[pre-pump] Scan complete: ${result.candidates.length} candidates from ${result.scanned} tokens`
  );
  const message = formatPrePumpScanTelegram(result);
  await sendTelegramMessage(message);
  console.log("[pre-pump] Telegram pre-pump report sent");
}

function startPrePumpDailyScheduler(): void {
  const enabled = String(process.env.PRE_PUMP_SCAN_ENABLED ?? "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log("[pre-pump] Daily scheduler disabled via PRE_PUMP_SCAN_ENABLED=false");
    return;
  }
  const offsetMinutes = Math.max(0, Math.trunc(Number(process.env.PRE_PUMP_SCAN_OFFSET_MIN ?? 15)) || 15);

  const schedule = (): void => {
    const delay = msUntilNextDailyRun(new Date(), offsetMinutes);
    const runAt = new Date(Date.now() + delay).toISOString();
    console.log(`[pre-pump] Next daily scan scheduled for ${runAt} (in ${Math.round(delay / 60000)} min)`);
    setTimeout(() => {
      void runDailyPrePumpScanAndNotify()
        .catch((error) => {
          console.error("[pre-pump] Daily scan/notify failed:", error instanceof Error ? error.message : error);
        })
        .finally(() => schedule());
    }, delay);
  };

  schedule();
}

app.get("/api/pre-pump/candidates", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  const refresh = String(req.query.refresh ?? "").toLowerCase() === "true";
  const topN = Math.min(100, Math.max(1, Math.trunc(Number(req.query.topN ?? 50)) || 50));
  const assetClassRaw = String(req.query.assetClass ?? "CRYPTO").trim().toUpperCase();
  const assetClass = assetClassRaw === "STOCK" ? "STOCK" : "CRYPTO";

  try {
    const cached = prePumpScanCacheByAsset[assetClass];
    if (!refresh && cached) {
      res.json({ cached: true, result: cached });
      return;
    }
    const result = await computePrePumpScan(topN, assetClass);
    res.json({ cached: false, result });
  } catch (error) {
    res.status(500).json({
      error: "Failed to scan pre-pump candidates",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/state", requireJWTAuth, (_req, res) => {
  const state = getLatestServiceState();
  if (!state) {
    res.status(503).json({
      error: "Scanner service is starting",
      details: "No scan cycle completed yet"
    });
    return;
  }

  const mode = resolveTradeMode(_req);
  const tenantId = resolveTenantId(_req);
  res.json(toStateForMode(state, mode === "test" ? "test" : "live", tenantId));
});

app.post("/api/telegram/test", requireJWTAuth, requireFeature("telegramAlerts"), async (req, res) => {
  const parsed = z
    .object({
      message: z.string().trim().min(1).optional()
    })
    .safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  try {
    const message = parsed.data.message ?? "Test alert from Strata 🔔";
    await sendTelegramMessage(message);
    res.json({ sent: true, message });
  } catch (error) {
    res.status(500).json({
      error: "Failed to send test message",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/strategy/config", requireJWTAuth, async (_req, res) => {
  try {
    const config = await getStrategyConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({
      error: "Failed to get strategy config",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/strategy/mode", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  const parsed = z
    .object({
      mode: z.enum(["DAY_TRADING", "SWING_TRADING"])
    })
    .safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  try {
    const config = await setTradingMode(parsed.data.mode);
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({
      error: "Failed to set trading mode",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.put("/api/strategy/config", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  const parsed = z
    .object({
      tradingMode: z.enum(["DAY_TRADING", "SWING_TRADING"]).optional(),
      enableFibonacci: z.boolean().optional(),
      enableCipherB: z.boolean().optional(),
      enableVWAP: z.boolean().optional(),
      enableEMA: z.boolean().optional(),
      enableStructure: z.boolean().optional(),
      enableOrderFlow: z.boolean().optional(),
      enableATR: z.boolean().optional(),
      enableRSI: z.boolean().optional(),
      fiboTargetLevels: z.array(z.number()).optional(),
      cipherBSensitivity: z.number().min(0).max(1).optional(),
      dayTradingMaxHoldTime: z.number().int().min(60).optional(),
      swingTradingMaxHoldTime: z.number().int().min(1440).optional(),
      dayTradingTpPct: z.number().min(0.1).optional(),
      swingTradingTpPct: z.number().min(0.1).optional(),
      dayTradingSlPct: z.number().min(0.1).optional(),
      swingTradingSlPct: z.number().min(0.1).optional()
    })
    .safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  try {
    const config = await updateStrategyConfig(parsed.data as any);
    await invalidateCache();
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({
      error: "Failed to update strategy config",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/runtime-settings", requireJWTAuth, requireFeature("manualTradeControls"), async (_req, res) => {
  try {
    const settings = await listRuntimeSettings();
    res.json({
      requiredKeys: REQUIRED_RUNTIME_SETTING_KEYS,
      settings
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to list runtime settings",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.put("/api/runtime-settings", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  const parsed = z
    .object({
      settings: z.array(
        z.object({
          key: z.string().min(1),
          value: z.string().min(1)
        })
      ).min(1)
    })
    .safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }

  try {
    const settings = await updateRuntimeSettings(parsed.data.settings);
    res.json({
      success: true,
      requiredKeys: REQUIRED_RUNTIME_SETTING_KEYS,
      settings
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to update runtime settings",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/runtime-settings/audit", requireJWTAuth, requireFeature("manualTradeControls"), async (req, res) => {
  const targetStakeRaw = Number(req.query["targetStakeUsd"] ?? 7);
  const targetStakeUsd = Number.isFinite(targetStakeRaw) && targetStakeRaw > 0 ? targetStakeRaw : 7;

  try {
    const audit = await getRuntimeSettingsAudit(targetStakeUsd);
    res.json(audit);
  } catch (error) {
    res.status(500).json({
      error: "Failed to audit runtime settings",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * Get market candles for a symbol
 * Supports both crypto and stock symbols
 * Query params: symbol, assetType (CRYPTO|STOCK), interval (1m|5m|15m|1h|4h|12h|1d), limit (default 100)
 */
app.get("/api/candles", requireJWTAuth, async (req, res) => {
  const symbol = String(req.query["symbol"] ?? "").trim().toUpperCase();
  const assetTypeRaw = String(req.query["assetType"] ?? "CRYPTO").trim().toUpperCase();
  const intervalRaw = String(req.query["interval"] ?? "1h").trim().toLowerCase();
  const limitRaw = Number(req.query["limit"] ?? 100);

  if (!symbol) {
    res.status(400).json({ error: "symbol query param required" });
    return;
  }

  const assetType = (assetTypeRaw === "STOCK" ? "STOCK" : "CRYPTO") as "CRYPTO" | "STOCK";
  const liveIntervals = new Set(["1m", "5m"]);
  const intervalMsMap: Record<string, number> = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "12h": 43_200_000,
    "1d": 86_400_000,
  };
  const intervalMap: Record<string, "M15" | "H1" | "H4" | "H12" | "D1"> = {
    "15m": "M15",
    "1h": "H1",
    "4h": "H4",
    "12h": "H12",
    "1d": "D1"
  };
  const limit = Math.min(500, Math.max(1, Math.trunc(limitRaw) || 100));

  try {
    if (liveIntervals.has(intervalRaw)) {
      const endTime = Date.now();
      const intervalMs = intervalMsMap[intervalRaw] ?? 300_000;
      const startTime = endTime - (intervalMs * Math.max(limit + 20, 120));
      const candles = assetType === "STOCK"
        ? await fetchStockCandles(symbol, intervalRaw as "1m" | "5m", startTime, endTime)
        : await fetchRecentCandles(symbol, intervalRaw as "1m" | "5m", limit);

      const normalizedCandles = assetType === "STOCK"
        ? candles.slice(-limit)
        : candles;

      res.json({
        symbol,
        assetType,
        interval: intervalRaw,
        count: normalizedCandles.length,
        candles: normalizedCandles.map((candle) => ({
          timestamp: candle.timestamp,
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
          volume: Number(candle.volume),
        })),
      });
      return;
    }

    const interval = intervalMap[intervalRaw] || "H1";
    const prisma = backfillPrismaClient();
    const candles = await prisma.marketCandle.findMany({
      where: {
        symbol: symbol,
        assetType: assetType,
        interval: interval
      },
      orderBy: { timestamp: "desc" },
      take: limit
    });

    res.json({
      symbol,
      assetType,
      interval: intervalRaw,
      count: candles.length,
      candles: candles.reverse().map((c) => ({
        timestamp: c.timestamp,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume)
      }))
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch candles",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

function closeWsClients(serverInstance: WebSocketServer): void {
  for (const client of serverInstance.clients) {
    try {
      client.terminate();
    } catch {
      // Best-effort shutdown path.
    }
  }
}

async function closeWsServer(serverInstance: WebSocketServer): Promise<void> {
  closeWsClients(serverInstance);
  await new Promise<void>((resolve) => {
    serverInstance.close(() => resolve());
  });
}

async function shutdownApi(signal: string): Promise<void> {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;

  console.log(`[shutdown] Received ${signal}; stopping API services...`);

  const forceExitTimer = setTimeout(() => {
    console.error("[shutdown] Forced exit after timeout");
    process.exit(1);
  }, 5_000);
  forceExitTimer.unref();

  stopTelegramCommandListener();
  stopScanService();

  await Promise.allSettled([
    closeWsServer(wsServer),
    closeWsServer(bitunixAccountWsServer),
    closeWsServer(dryRunWsServer),
    closeWsServer(stockPricesWsServer),
    closeWsServer(saasDashboardWsServer),
    closeCoinbaseWebSocket(),
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    })
  ]);

  if (_backfillPrisma) {
    try {
      await _backfillPrisma.$disconnect();
    } catch (error) {
      console.warn("[shutdown] Failed to disconnect backfill prisma client", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    _backfillPrisma = null;
  }

  clearTimeout(forceExitTimer);
  console.log("[shutdown] API server stopped");
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdownApi("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdownApi("SIGTERM");
});

server.listen(port, () => {
  console.log(`RSI API listening on http://localhost:${port}`);
  console.log(`State WebSocket listening on ws://localhost:${port}/ws/state`);
  console.log(`Stock Prices WebSocket listening on ws://localhost:${port}/ws/prices/stocks`);
  console.log(`SaaS Dashboard WebSocket listening on ws://localhost:${port}/ws/saas-dashboard`);
  console.log(`Simulation State Backend: ${getSimulationStorageBackend()}`);
  const access = getAppAccessState();

  void ensureLatestServiceState().catch((error) => {
    console.error("Failed to initialize service state", error);
  });

  // Warm the pre-pump caches in the background so the first page load is instant
  // instead of triggering a cold full scan synchronously.
  void computePrePumpScan(50, "CRYPTO").catch((error) => {
    console.error("[pre-pump] Startup cache warm (CRYPTO) failed:", error instanceof Error ? error.message : error);
  });
  void computePrePumpScan(50, "STOCK").catch((error) => {
    console.error("[pre-pump] Startup cache warm (STOCK) failed:", error instanceof Error ? error.message : error);
  });

  if (access.features.telegramAlerts) {
    startTelegramCommandListener(() => getLatestServiceState());
    startPrePumpDailyScheduler();
  } else {
    console.log(`[access] Telegram controls locked for ${access.plan}/${access.status}`);
  }

  if (access.features.backgroundAutomation) {
    void startScanService()
      .then(() => {
        const service = getLatestServiceState();
        const signalMs = service?.service.signalIntervalMs ?? 0;
        const tradeMs = service?.service.tradeIntervalMs ?? 0;
        console.log(`Background scan service started (${signalMs}ms signal scan / ${tradeMs}ms trade monitor)`);
        if (MARKET_DATA_PROVIDER === "BITUNIX") {
          const ws = getBitunixMarketWsStatus();
          console.log(
            `[bitunix-ws] overlay active url=${ws.url} channels=${ws.channels.join(",")} connected=${ws.connected} hitRate=${ws.overlayHitRatePct}% (${ws.overlayHits}/${ws.overlayLookups}) fresh=${ws.freshSymbols}`
          );
        }
      })
      .catch((error) => {
        console.error("Failed to start background scan service", error);
        process.exit(1);
      });
  } else {
    console.log(`[access] Background automation locked for ${access.plan}/${access.status}`);
  }

  // Initialize Coinbase WebSocket for real-time spot prices (if using Coinbase market data provider)
  // No default subscriptions: only authenticated users with active trades will subscribe to symbols.
  if (MARKET_DATA_PROVIDER === "COINBASE") {
    const defaultProductIds: string[] = [];

    const coinbaseWsClient = getCoinbaseWebSocketClient();
    const subscribeActiveTradeSymbols = (): void => {
      const state = getLatestServiceState();
      const activeTrades = state?.tradeSimulation?.activeTrades;
      if (!Array.isArray(activeTrades) || activeTrades.length === 0) {
        return;
      }

      const productIds = Array.from(
        new Set(
          activeTrades
            .map((trade) => toCoinbaseProductIdFromToken(trade?.token))
            .filter((id) => id.length > 0)
        )
      );

      if (productIds.length > 0) {
        coinbaseWsClient.addProductSubscriptions(productIds);
      }
    };

    let lastCoinbaseWsBroadcastAt = 0;
    coinbaseWsClient.onMessage((msg) => {
      if (msg.type !== "ticker") {
        return;
      }

      const now = Date.now();
      if (now - lastCoinbaseWsBroadcastAt < 1000) {
        return;
      }
      lastCoinbaseWsBroadcastAt = now;

      // Push websocket-only state updates so simulation currentPrice reflects live Coinbase ticks.
      broadcastStateToWsClients(getLatestServiceState());
    });

    void initializeCoinbaseWebSocket(defaultProductIds)
      .then(() => {
        console.log("[coinbase-ws] Connected to Coinbase WebSocket (no default symbols; subscriptions driven by authenticated user trades)");
      })
      .catch((error) => {
        console.warn("[coinbase-ws] Failed to initialize WebSocket:", error instanceof Error ? error.message : error);
      });

    setInterval(() => {
      subscribeActiveTradeSymbols();
    }, 5000);
  }

  // Refresh live account data every 3 seconds for real-time updates
  const LIVE_ACCOUNT_REFRESH_MS = 3000;
  
  // Sync immediately on startup
  void syncLiveAccountData().catch((error) => {
    console.warn("[server] Initial live account sync failed:", error instanceof Error ? error.message : error);
  });
  
  setInterval(() => {
    void syncLiveAccountData().catch((error) => {
      console.warn("[server] Live account sync failed:", error instanceof Error ? error.message : error);
    });
  }, LIVE_ACCOUNT_REFRESH_MS);

  // Keep websocket-only simulation clients fresh even between scan cycles.
  setInterval(() => {
    broadcastStateToWsClients(getLatestServiceState());
  }, 1000);
});
