import { Router } from "express";
import { CandleInterval, TradingStyle, AssetType } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import {
  apiKeyAuthMiddleware,
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/auth.js";
import multiAssetMarketData from "../services/multi-asset-market-data.js";

const prisma = new PrismaClient();
const router = Router();

// Apply auth to all signal routes
router.use(apiKeyAuthMiddleware);
router.use(requireAuth);

/**
 * Response contract for signals - explicit state semantics
 */
interface SignalResponse {
  symbol: string;
  assetType: AssetType;
  tradingStyle: TradingStyle;
  timestamp: Date;
  state: "READY" | "CAUTION" | "BLOCKED" | "UNRESOLVED";
  signals: {
    type: string;
    direction?: string;
    confidence: number;
    reason: string;
  }[];
  candles: {
    timestamp: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
  metadata: {
    regime?: string;
    volatility?: number;
    lastUpdated: Date;
  };
}

/**
 * Get latest signals for a symbol (asset + style aware)
 */
router.get("/latest", async (req: AuthenticatedRequest, res) => {
  try {
    const {
      symbol,
      assetType = AssetType.CRYPTO,
      tradingStyle = TradingStyle.SWING,
      interval = CandleInterval.H1,
      limit = 50,
    } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: "symbol required" });
    }

    // Fetch candles
    const candles = await multiAssetMarketData.getCandles({
      symbol: symbol as string,
      assetType: assetType as AssetType,
      interval: interval as CandleInterval,
      limit: parseInt(limit as string) || 50,
    });

    if (candles.length === 0) {
      return res.status(404).json({
        error: `No candle data for ${symbol}`,
        state: "UNRESOLVED",
      });
    }

    // Stub: compute signals
    // In production, call your existing signal engine with style context
    const signalState = "UNRESOLVED"; // TODO: integrate signal engine
    const signals: SignalResponse["signals"] = [];

    const response: SignalResponse = {
      symbol: symbol as string,
      assetType: assetType as AssetType,
      tradingStyle: tradingStyle as TradingStyle,
      timestamp: new Date(),
      state: signalState as any,
      signals,
      candles: candles.map((c: any) => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
      metadata: {
        lastUpdated: new Date(),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching signals:", error);
    res.status(500).json({ error: "Failed to fetch signals" });
  }
});

/**
 * Get signal history
 */
router.get("/history", async (req: AuthenticatedRequest, res) => {
  try {
    const {
      symbol,
      assetType = AssetType.CRYPTO,
      tradingStyle = TradingStyle.SWING,
      interval = CandleInterval.D1,
      days = 30,
    } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: "symbol required" });
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days as string));

    const candles = await prisma.marketCandle.findMany({
      where: {
        symbol: symbol as string,
        assetType: assetType as AssetType,
        interval: interval as CandleInterval,
        timestamp: { gte: startDate },
      },
      orderBy: { timestamp: "asc" },
      take: 500,
    });

    res.json({
      symbol,
      assetType,
      tradingStyle,
      interval,
      periodDays: parseInt(days as string),
      totalCandles: candles.length,
      candles: candles.map((c: any) => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    });
  } catch (error) {
    console.error("Error fetching signal history:", error);
    res.status(500).json({ error: "Failed to fetch signal history" });
  }
});

/**
 * Get risk/position sizing
 */
router.post("/risk/score", async (req: AuthenticatedRequest, res) => {
  try {
    const { symbol, assetType, tradingStyle, accountSize } = req.body;

    if (!symbol || !accountSize) {
      return res
        .status(400)
        .json({ error: "symbol and accountSize required" });
    }

    // Fetch user config for this style
    const userConfig = await prisma.userConfiguration.findMany({
      where: {
        tradingStyle: tradingStyle || TradingStyle.SWING,
      },
      take: 1,
    });

    const riskPerTrade =
      userConfig[0]?.riskPerTrade || 2.0; // default 2%
    const riskAmount = (accountSize * riskPerTrade) / 100;

    res.json({
      symbol,
      assetType: assetType || AssetType.CRYPTO,
      tradingStyle: tradingStyle || TradingStyle.SWING,
      accountSize,
      riskPercentage: riskPerTrade,
      riskAmount,
      positionSizeUsd: riskAmount * 10, // rough estimate
      recommended: {
        maxConcurrentTrades: 3,
        maxDrawdown: 5,
      },
    });
  } catch (error) {
    console.error("Error computing risk score:", error);
    res.status(500).json({ error: "Failed to compute risk score" });
  }
});

/**
 * Get market context
 */
router.get("/market/context", async (req: AuthenticatedRequest, res) => {
  try {
    const { assetType = AssetType.CRYPTO } = req.query;

    const symbols = await multiAssetMarketData.getSymbolsByAssetType(
      assetType as AssetType
    );

    res.json({
      assetType,
      symbolCount: symbols.length,
      symbols: symbols.slice(0, 20), // Top 20
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("Error fetching market context:", error);
    res.status(500).json({ error: "Failed to fetch market context" });
  }
});

export default router;
