import express from "express";
import * as kalshi from "../kalshi-service.js";
import * as kalshiSignal from "../kalshi-signal-analyzer.js";
import * as kalshiAlertScheduler from "../kalshi-alert-scheduler.js";

export const router = express.Router();

/**
 * GET /api/v1/kalshi/alert-scheduler
 * Get Kalshi hourly BTC alert scheduler status
 */
router.get("/alert-scheduler", async (req, res) => {
  try {
    const status = kalshiAlertScheduler.getKalshiAlertSchedulerStatus();
    res.json({
      timestamp: new Date().toISOString(),
      scheduler: status,
    });
  } catch (error) {
    console.error("[Kalshi Alert Scheduler Route] Error:", error);
    res.status(500).json({
      error: "Failed to get scheduler status",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /api/v1/kalshi/send-alert
 * Manually send a Kalshi BTC alert to Telegram (testing/manual trigger)
 */
router.post("/send-alert", async (req, res) => {
  try {
    await kalshiAlertScheduler.sendKalshiBtcAlert();
    res.json({
      timestamp: new Date().toISOString(),
      status: "success",
      message: "Kalshi BTC alert sent to Telegram",
    });
  } catch (error) {
    console.error("[Kalshi Send Alert Route] Error:", error);
    res.status(500).json({
      error: "Failed to send alert",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/v1/kalshi/signal
 * Generate a BTC trading signal based on Kalshi market sentiment
 */
router.get("/signal", async (req, res) => {
  try {
    const symbol = (req.query.symbol as string) || "BTC";
    const signal = await kalshiSignal.generateKalshiSignal(symbol);

    res.json(signal);
  } catch (error) {
    console.error("[Kalshi Signal Route] Error:", error);
    res.status(500).json({
      error: "Failed to generate signal",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/v1/kalshi/sentiment
 * Analyze Kalshi market sentiment for a given symbol
 */
router.get("/sentiment", async (req, res) => {
  try {
    const symbol = (req.query.symbol as string) || "BTC";
    const sentiment = await kalshiSignal.analyzeKalshiSentiment(symbol);

    res.json(sentiment);
  } catch (error) {
    console.error("[Kalshi Sentiment Route] Error:", error);
    res.status(500).json({
      error: "Failed to analyze sentiment",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/v1/kalshi/status
 * Check Kalshi exchange status
 */
router.get("/status", async (req, res) => {
  try {
    const status = await kalshi.fetchExchangeStatus();

    if (!status) {
      return res.status(503).json({
        error: "Unable to reach Kalshi API",
      });
    }

    res.json({
      timestamp: new Date().toISOString(),
      ...status,
    });
  } catch (error) {
    console.error("[Kalshi Status Route] Error:", error);
    res.status(500).json({
      error: "Failed to fetch exchange status",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/v1/kalshi/debug
 * Debug endpoint to see raw Kalshi API responses
 */
router.get("/debug", async (req, res) => {
  try {
    const baseUrl = "https://external-api.kalshi.com/trade-api/v2";
    const endpoints = [
      "/exchange/status",
      "/markets?limit=2",
      "/markets?status=open&limit=2",
    ];

    const results: Record<string, unknown> = {};

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          headers: { "Accept": "application/json" },
        });
        const data = await response.json().catch(() => ({ error: "Invalid JSON" }));
        results[endpoint] = {
          status: response.status,
          ok: response.ok,
          data: typeof data === "object" ? Object.keys(data) : data,
          sample: typeof data === "object" && Array.isArray(data.markets) ? data.markets[0] : null,
        };
      } catch (error) {
        results[endpoint] = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    res.json({
      timestamp: new Date().toISOString(),
      baseUrl,
      results,
    });
  } catch (error) {
    res.status(500).json({
      error: "Debug failed",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/v1/kalshi/all-markets
 * List all available markets on Kalshi
 */
router.get("/all-markets", async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const markets = await kalshi.fetchAllMarkets(limit);

    res.json({
      timestamp: new Date().toISOString(),
      count: markets.length,
      markets: markets.map((m) => ({
        ticker: m.ticker,
        title: m.title,
        yes_sub_title: m.yes_sub_title,
        no_sub_title: m.no_sub_title,
        yes_bid_dollars: m.yes_bid_dollars,
        yes_ask_dollars: m.yes_ask_dollars,
        no_bid_dollars: m.no_bid_dollars,
        no_ask_dollars: m.no_ask_dollars,
        status: m.status,
        expiration_time: m.expiration_time,
        volume_24h_fp: m.volume_24h_fp,
      })),
    });
  } catch (error) {
    console.error("[Kalshi All Markets Route] Error:", error);
    res.status(500).json({
      error: "Failed to fetch all markets",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/v1/kalshi/btc-hourly
 * Fetch BTC hourly price prediction probabilities from Kalshi
 */
router.get("/btc-hourly", async (req, res) => {
  try {
    const hours = req.query.hours ? parseInt(req.query.hours as string, 10) : 24;
    const probabilities = await kalshi.fetchBtcPriceProbabilities(hours);

    if (probabilities.length === 0) {
      return res.status(404).json({
        error: "No hourly BTC markets found on Kalshi",
      });
    }

    res.json({
      timestamp: new Date().toISOString(),
      count: probabilities.length,
      data: probabilities,
    });
  } catch (error) {
    console.error("[Kalshi API Route] Error:", error);
    res.status(500).json({
      error: "Failed to fetch Kalshi probabilities",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/v1/kalshi/markets
 * List all available hourly BTC prediction markets
 */
router.get("/markets", async (req, res) => {
  try {
    const markets = await kalshi.fetchBtcHourlyMarkets();

    res.json({
      timestamp: new Date().toISOString(),
      count: markets.length,
      markets: markets.map((m) => ({
        ticker: m.ticker,
        title: m.title,
        yes_sub_title: m.yes_sub_title,
        no_sub_title: m.no_sub_title,
        yes_bid_dollars: m.yes_bid_dollars,
        yes_ask_dollars: m.yes_ask_dollars,
        status: m.status,
        expiration_time: m.expiration_time,
      })),
    });
  } catch (error) {
    console.error("[Kalshi Markets Route] Error:", error);
    res.status(500).json({
      error: "Failed to fetch Kalshi markets",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/v1/kalshi/search
 * Search for prediction markets by keyword
 */
router.get("/search", async (req, res) => {
  try {
    const keyword = req.query.q as string;
    if (!keyword) {
      return res.status(400).json({
        error: "Missing required query parameter: q",
      });
    }

    const markets = await kalshi.searchMarkets(keyword);

    res.json({
      timestamp: new Date().toISOString(),
      query: keyword,
      count: markets.length,
      markets: markets.map((m) => ({
        ticker: m.ticker,
        title: m.title,
        yes_sub_title: m.yes_sub_title,
        yes_bid_dollars: m.yes_bid_dollars,
        yes_ask_dollars: m.yes_ask_dollars,
        status: m.status,
        expiration_time: m.expiration_time,
      })),
    });
  } catch (error) {
    console.error("[Kalshi Search Route] Error:", error);
    res.status(500).json({
      error: "Failed to search markets",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/v1/kalshi/market/:ticker
 * Get details for a specific market
 */
router.get("/market/:ticker", async (req, res) => {
  try {
    const { ticker } = req.params;
    const market = await kalshi.fetchMarketDetails(ticker);

    if (!market) {
      return res.status(404).json({ error: "Market not found" });
    }

    res.json({
      timestamp: new Date().toISOString(),
      market: {
        ticker: market.ticker,
        title: market.title,
        yes_sub_title: market.yes_sub_title,
        no_sub_title: market.no_sub_title,
        yes_bid_dollars: market.yes_bid_dollars,
        yes_ask_dollars: market.yes_ask_dollars,
        no_bid_dollars: market.no_bid_dollars,
        no_ask_dollars: market.no_ask_dollars,
        status: market.status,
        market_type: market.market_type,
        event_ticker: market.event_ticker,
        expiration_time: market.expiration_time,
        created_time: market.created_time,
      },
    });
  } catch (error) {
    console.error("[Kalshi Market Details Route] Error:", error);
    res.status(500).json({
      error: "Failed to fetch market details",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/v1/kalshi/forecast/:symbol/:interval?
 * Deprecated: use /api/v1/forecast/:symbol/:interval?
 */
router.get(["/forecast/:symbol", "/forecast/:symbol/:interval"], async (_req, res) => {
  return res.status(410).json({
    error: "Deprecated endpoint",
    message: "Use /api/v1/forecast/:symbol/:interval? for candle-based momentum forecasts."
  });
});

/**
 * GET /api/v1/kalshi/predict/:symbol
 * Deprecated endpoint retained to avoid accidental betting-style usage.
 */
router.get("/predict/:symbol", async (_req, res) => {
  return res.status(410).json({
    error: "Deprecated endpoint",
    message: "Use /api/v1/forecast/:symbol/:interval? for momentum forecast output."
  });
});
