import "./env.js";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { scanRsi, searchTokens } from "./hyperliquid-service.js";
import { forceCloseOpenTradesBySymbol, processTradeSimulation, refreshTradeSimulation, updateLiveMarkPrices } from "./trade-engine.js";
import {
  getLatestServiceState,
  setLatestServiceState,
  startScanService,
  subscribeStateUpdates,
  triggerTradeRefresh,
  updateScanResultPrices
} from "./scan-service.js";
import { getSimulationDbPath } from "./simulation-store.js";

const app = express();
const server = createServer(app);
const wsServer = new WebSocketServer({ server, path: "/ws/state" });
const port = Number(process.env.PORT ?? 8787);
const defaultScanLimitTokensRaw = Number(process.env.SCAN_LIMIT_TOKENS ?? 25);
const DEFAULT_SCAN_LIMIT_TOKENS = Number.isFinite(defaultScanLimitTokensRaw)
  ? Math.max(1, Math.min(200, Math.trunc(defaultScanLimitTokensRaw)))
  : 15;
const WS_TRADE_REFRESH_MS = 5_000;
let wsTradeRefreshInterval: NodeJS.Timeout | null = null;

function maybeStopWsTradeRefreshLoop(): void {
  if (wsServer.clients.size > 0 || !wsTradeRefreshInterval) {
    return;
  }

  clearInterval(wsTradeRefreshInterval);
  wsTradeRefreshInterval = null;
}

function ensureWsTradeRefreshLoop(): void {
  if (wsTradeRefreshInterval) {
    return;
  }

  wsTradeRefreshInterval = setInterval(() => {
    if (wsServer.clients.size === 0) {
      maybeStopWsTradeRefreshLoop();
      return;
    }

    void Promise.all([updateScanResultPrices(), updateLiveMarkPrices()]).then(() => triggerTradeRefresh());
  }, WS_TRADE_REFRESH_MS);
}

wsServer.on("connection", (socket) => {
  ensureWsTradeRefreshLoop();

  const state = getLatestServiceState();
  if (state) {
    socket.send(JSON.stringify(state));
  }

  socket.on("close", () => {
    maybeStopWsTradeRefreshLoop();
  });
});

subscribeStateUpdates((state) => {
  const payload = JSON.stringify(state);
  for (const client of wsServer.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
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
    .transform((value) => value === "true")
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "signetix-api", now: new Date().toISOString() });
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
      tokens
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

  try {
    const scan = await scanRsi({
      query: undefined,
      market: parsed.data.market,
      limitTokens: parsed.data.limitTokens
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

    const filteredOutNoSignal = parsed.data.onlySignals ? unfilteredCounts.noSignal : 0;

    console.info("[/api/rsi] Scan completed", {
      market: parsed.data.market,
      query: parsed.data.query ?? "",
      limitTokens: parsed.data.limitTokens,
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
      results,
      tradeSimulation
    };

    setLatestServiceState(response);
    res.json(response);
  } catch (error) {
    console.error("[/api/rsi] Scan failed", {
      market: parsed.data.market,
      query: parsed.data.query ?? "",
      limitTokens: parsed.data.limitTokens,
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

app.post("/api/trades/close-symbol", async (req, res) => {
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

server.listen(port, () => {
  console.log(`RSI API listening on http://localhost:${port}`);
  console.log(`State WebSocket listening on ws://localhost:${port}/ws/state`);
  console.log(`Simulation DB: ${getSimulationDbPath()}`);
  void startScanService()
    .then(() => {
      console.log("Background scan service started (5m signal scan / 1m trade monitor)");
    })
    .catch((error) => {
      console.error("Failed to start background scan service", error);
      process.exit(1);
    });
});
