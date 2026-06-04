import "./env.js";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { getAppAccessState, getEffectiveScanLimit, getFeatureLock, type AccessFeature } from "./app-access.js";
import { saveLicense, invalidateLicenseCache, getLicenseFilePath } from "./license-store.js";
import { fetchPerpContexts, scanRsi, searchTokens } from "./market-data-service.js";
import { MARKET_DATA_PROVIDER } from "./market-data-service.js";
import {
  attachBitunixPositionTpSlDebug,
  fetchBitunixAccountSnapshot,
  fetchBitunixClosedTradeHistory,
  fetchLatestOhlc,
  getBitunixMarketWsStatus,
  getBitunixPrivateAuthStatus,
  placeBitunixLimitOrder
} from "./bitunix-service.js";
import {
  forceClearCooldown,
  forceCloseOpenTradesBySymbol,
  forceOpenManualTrade,
  detectPrePumpWatchCandidates,
  forceSimulatePrePumpWatchTrades,
  forceRemoveClosedTrade,
  forceResetTradingRuntime,
  forceReopenLastClosedTrade,
  processTradeSimulation,
  refreshTradeSimulation,
  getTradeRejectionLog,
  clearTradeRejections,
  getTradeEngineProfile
} from "./trade-engine.js";
import { getTokenLeverageProfile } from "./trade-engine.js";
import {
  ensureLatestServiceState,
  getLatestServiceState,
  setLatestServiceState,
  startScanService,
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
import { sendTelegramMessage, startTelegramCommandListener } from "./telegram-service.js";
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
import {
  clearDryRunExecutionPlans,
  listDryRunExecutionPlans,
  subscribeDryRunExecutionPlans
} from "./dry-run-execution.js";
import { listExchangeTradeHistory, upsertExchangeTradeHistory } from "./exchange-trade-history-prisma.js";
import { formatTokenDisplay } from "./token-metadata.js";

const app = express();
const server = createServer(app);
const wsServer = new WebSocketServer({ noServer: true });
const bitunixAccountWsServer = new WebSocketServer({ noServer: true });
const dryRunWsServer = new WebSocketServer({ noServer: true });
const port = Number(process.env.PORT ?? 8787);
const defaultScanLimitTokensRaw = Number(process.env.SCAN_LIMIT_TOKENS ?? 25);
const DEFAULT_SCAN_LIMIT_TOKENS = Number.isFinite(defaultScanLimitTokensRaw)
  ? Math.max(1, Math.min(200, Math.trunc(defaultScanLimitTokensRaw)))
  : 15;
const bitunixAccountWsPollMsRaw = Number(process.env.BITUNIX_ACCOUNT_WS_POLL_MS ?? 2000);
const BITUNIX_ACCOUNT_WS_POLL_MS = Number.isFinite(bitunixAccountWsPollMsRaw)
  ? Math.max(750, Math.min(30_000, Math.trunc(bitunixAccountWsPollMsRaw)))
  : 2000;

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url ?? "/", `http://localhost:${port}`);

  if (requestUrl.pathname === "/ws/state") {
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

wsServer.on("connection", (socket) => {
  const state = getLatestServiceState();
  if (state) {
    socket.send(JSON.stringify(state));
  }
});

subscribeStateUpdates((state) => {
  const payload = JSON.stringify(state);
  for (const client of wsServer.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
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

app.use(cors());
app.use(express.json());

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
  res.json({ ok: true, service: "ciphora-api", now: new Date().toISOString(), access: getAppAccessState() });
});

app.get("/api/access", (_req, res) => {
  res.json(getAppAccessState());
});

app.get("/api/bitunix/account", async (req, res) => {
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

app.post("/api/bitunix/history/sync", requireFeature("manualTradeControls"), async (req, res) => {
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

app.get("/api/bitunix/history", requireFeature("manualTradeControls"), async (req, res) => {
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
app.post("/api/bitunix/test/limit-order", requireFeature("manualTradeControls"), async (req, res) => {
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

app.post("/api/bitunix/position/attach-tpsl", async (req, res) => {
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

    const tradeSimulation = await processTradeSimulation(scan.results);
    const perpContexts = await fetchPerpContexts(results.map((row) => row.symbol));

    const filteredOutNoSignal = parsed.data.onlySignals ? unfilteredCounts.noSignal : 0;
    const resultsWithLeverage = results.map((row) => {
      const leverage = perpContexts.get(row.symbol)?.maxLeverage;
      return {
        ...row,
        maxLeverage: typeof leverage === "number" && Number.isFinite(leverage) && leverage > 0 ? leverage : undefined
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
      await setLatestServiceState(response);
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

app.get("/api/trades", async (_req, res) => {
  try {
    const tradeSimulation = await refreshTradeSimulation();
    res.json(tradeSimulation);
  } catch (error) {
    res.status(500).json({
      error: "Failed to refresh trade simulation",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/trades/rejections", (req, res) => {
  const limitRaw = Number(req.query["limit"] ?? 50);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 200) : 50;
  const symbolFilter = typeof req.query["symbol"] === "string" ? req.query["symbol"].trim().toUpperCase() : null;
  let log = getTradeRejectionLog();
  if (symbolFilter) {
    log = log.filter((entry) => entry.symbol.toUpperCase() === symbolFilter);
  }
  res.json({ count: log.length, rejections: log.slice(0, limit) });
});

app.post("/api/trades/rejections/clear", requireFeature("manualTradeControls"), (_req, res) => {
  clearTradeRejections();
  res.json({ cleared: true });
});

app.get("/api/execution/dry-run", requireFeature("manualTradeControls"), (req, res) => {
  const limitRaw = Number(req.query["limit"] ?? 50);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 500) : 50;
  const plans = listDryRunExecutionPlans(limit);
  res.json({
    count: plans.length,
    plans
  });
});

app.post("/api/execution/dry-run/clear", requireFeature("manualTradeControls"), (_req, res) => {
  const cleared = clearDryRunExecutionPlans();
  res.json(cleared);
});

app.get("/api/backfill/status", async (req, res) => {
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

app.post("/api/trades/close-symbol", requireFeature("manualTradeControls"), async (req, res) => {
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
    const result = await forceCloseOpenTradesBySymbol(parsed.data.symbol);
    await syncLatestTradeSimulation(result.snapshot);
    res.json({
      symbol: parsed.data.symbol,
      closedCount: result.closedCount,
      ...result.snapshot
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to close open trades for symbol",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/reopen-last", requireFeature("manualTradeControls"), async (req, res) => {
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
    const result = await forceReopenLastClosedTrade(parsed.data.symbol);
    await syncLatestTradeSimulation(result.snapshot);
    if (!result.reopened) {
      res.status(409).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to reopen last closed trade",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/remove-closed", requireFeature("manualTradeControls"), async (req, res) => {
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
    const result = await forceRemoveClosedTrade(parsed.data);
    await syncLatestTradeSimulation(result.snapshot);
    if (!result.removed) {
      res.status(404).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to remove closed trade",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/reset", requireFeature("manualTradeControls"), async (_req, res) => {
  try {
    const snapshot = await forceResetTradingRuntime();
    await syncLatestTradeSimulation(snapshot);
    res.json({
      reset: true,
      ...snapshot
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to reset trading runtime",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/clear-cooldown", requireFeature("manualTradeControls"), async (_req, res) => {
  try {
    const snapshot = await forceClearCooldown();
    await syncLatestTradeSimulation(snapshot);
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

app.post("/api/trades/evaluate-now", requireFeature("manualTradeControls"), async (_req, res) => {
  const latest = getLatestServiceState();
  if (!latest) {
    res.status(503).json({
      error: "Scanner service is starting",
      details: "No scan cycle completed yet"
    });
    return;
  }

  try {
    const beforeActive = latest.tradeSimulation.stats.activeTrades;
    const snapshot = await processTradeSimulation(latest.results);
    await syncLatestTradeSimulation(snapshot);
    const afterActive = snapshot.stats.activeTrades;

    res.json({
      evaluated: true,
      beforeActive,
      afterActive,
      openedNow: Math.max(0, afterActive - beforeActive),
      snapshot
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to evaluate entries",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/open-manual", requireFeature("manualTradeControls"), async (req, res) => {
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
    const result = await forceOpenManualTrade(parsed.data);
    await syncLatestTradeSimulation(result.snapshot);
    if (!result.opened) {
      res.status(409).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to open manual trade",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/trades/simulate-pre-pump", requireFeature("manualTradeControls"), async (req, res) => {
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

app.post("/api/trades/detect-pre-pump", requireFeature("manualTradeControls"), async (req, res) => {
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

app.get("/api/state", (_req, res) => {
  const state = getLatestServiceState();
  if (!state) {
    res.status(503).json({
      error: "Scanner service is starting",
      details: "No scan cycle completed yet"
    });
    return;
  }

  res.json(state);
});

app.post("/api/telegram/test", requireFeature("telegramAlerts"), async (req, res) => {
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
    const message = parsed.data.message ?? "Test alert from Ciphora 🔔";
    await sendTelegramMessage(message);
    res.json({ sent: true, message });
  } catch (error) {
    res.status(500).json({
      error: "Failed to send test message",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/strategy/config", async (_req, res) => {
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

app.post("/api/strategy/mode", requireFeature("manualTradeControls"), async (req, res) => {
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

app.put("/api/strategy/config", requireFeature("manualTradeControls"), async (req, res) => {
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

app.get("/api/runtime-settings", requireFeature("manualTradeControls"), async (_req, res) => {
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

app.put("/api/runtime-settings", requireFeature("manualTradeControls"), async (req, res) => {
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

server.listen(port, () => {
  console.log(`RSI API listening on http://localhost:${port}`);
  console.log(`State WebSocket listening on ws://localhost:${port}/ws/state`);
  console.log(`Simulation State Backend: ${getSimulationStorageBackend()}`);
  const access = getAppAccessState();

  void ensureLatestServiceState().catch((error) => {
    console.error("Failed to initialize service state", error);
  });

  if (access.features.telegramAlerts) {
    startTelegramCommandListener(() => getLatestServiceState());
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
});
