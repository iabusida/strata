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

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function calculateRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateSma(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  const slice = closes.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

function resolveStyleInterval(style: TradingStyle): CandleInterval {
  if (style === TradingStyle.DAY_TRADING) return CandleInterval.M15;
  if (style === TradingStyle.LONG_TERM) return CandleInterval.D1;
  if (style === TradingStyle.SPOT_SHORT) return CandleInterval.H1;
  return CandleInterval.H1;
}

function buildSignalState(
  tradingStyle: TradingStyle,
  closes: number[],
  highs: number[],
  lows: number[]
): Pick<SignalResponse, "state" | "signals" | "metadata"> {
  if (closes.length < 30) {
    return {
      state: "UNRESOLVED",
      signals: [
        {
          type: "INSUFFICIENT_DATA",
          confidence: 0,
          reason: "Need at least 30 candles for reliable signal evaluation",
        },
      ],
      metadata: { lastUpdated: new Date() },
    };
  }

  const latest = closes[closes.length - 1];
  const prev = closes[closes.length - 2] ?? latest;
  const rsi14 = calculateRsi(closes, 14);
  const sma20 = calculateSma(closes, 20);
  const sma50 = calculateSma(closes, 50);
  const momentumPct = prev > 0 ? ((latest - prev) / prev) * 100 : 0;
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow = Math.min(...lows.slice(-20));
  const rangePct = latest > 0 ? ((recentHigh - recentLow) / latest) * 100 : 0;

  const trendUp = latest > sma20 && sma20 >= sma50;
  const trendDown = latest < sma20 && sma20 <= sma50;
  const nearLow = recentLow > 0 ? ((latest - recentLow) / recentLow) * 100 <= 2.5 : false;

  if (tradingStyle === TradingStyle.LONG_TERM) {
    if (trendUp && rsi14 >= 52 && rsi14 <= 72) {
      return {
        state: "READY",
        signals: [
          {
            type: "LONG_TERM_TREND_CONFIRM",
            direction: "LONG",
            confidence: Math.min(95, Math.round(60 + (rsi14 - 50) * 1.1)),
            reason: `Trend up with RSI ${rsi14.toFixed(1)} and price above SMA20/SMA50`,
          },
        ],
        metadata: {
          regime: "trend_up",
          volatility: Number(rangePct.toFixed(3)),
          lastUpdated: new Date(),
        },
      };
    }

    return {
      state: trendDown ? "BLOCKED" : "CAUTION",
      signals: [
        {
          type: trendDown ? "LONG_TERM_DOWNTREND" : "LONG_TERM_SETUP_FORMING",
          confidence: Math.max(20, Math.round(50 - Math.abs(60 - rsi14))),
          reason: trendDown
            ? `Price below SMA trend stack (RSI ${rsi14.toFixed(1)})`
            : `Waiting for trend + RSI alignment (RSI ${rsi14.toFixed(1)})`,
        },
      ],
      metadata: {
        regime: trendDown ? "trend_down" : "transition",
        volatility: Number(rangePct.toFixed(3)),
        lastUpdated: new Date(),
      },
    };
  }

  if (tradingStyle === TradingStyle.SPOT_SHORT) {
    if (nearLow && rsi14 <= 38 && momentumPct >= -0.6) {
      return {
        state: "READY",
        signals: [
          {
            type: "SPOT_SHORT_MEAN_REVERSION",
            direction: "LONG",
            confidence: Math.min(92, Math.round(55 + Math.max(0, 40 - rsi14))),
            reason: `Near 20-bar support with RSI ${rsi14.toFixed(1)} (short-term rebound setup)`,
          },
        ],
        metadata: {
          regime: "mean_reversion",
          volatility: Number(rangePct.toFixed(3)),
          lastUpdated: new Date(),
        },
      };
    }

    return {
      state: "CAUTION",
      signals: [
        {
          type: "SPOT_SHORT_WAIT",
          confidence: Math.max(15, Math.round(45 - Math.abs(35 - rsi14))),
          reason: `No high-quality short-term support bounce (RSI ${rsi14.toFixed(1)})`,
        },
      ],
      metadata: {
        regime: "range",
        volatility: Number(rangePct.toFixed(3)),
        lastUpdated: new Date(),
      },
    };
  }

  if (tradingStyle === TradingStyle.DAY_TRADING) {
    if (latest > sma20 && rsi14 >= 52 && rsi14 <= 75 && momentumPct > 0) {
      return {
        state: "READY",
        signals: [
          {
            type: "INTRADAY_MOMENTUM",
            direction: "LONG",
            confidence: Math.min(90, Math.round(58 + Math.max(0, momentumPct * 12))),
            reason: `Intraday momentum with RSI ${rsi14.toFixed(1)} and price above SMA20`,
          },
        ],
        metadata: {
          regime: "intraday_trend",
          volatility: Number(rangePct.toFixed(3)),
          lastUpdated: new Date(),
        },
      };
    }

    return {
      state: trendDown ? "BLOCKED" : "CAUTION",
      signals: [
        {
          type: trendDown ? "INTRADAY_TREND_CONFLICT" : "INTRADAY_SETUP_FORMING",
          confidence: Math.max(15, Math.round(50 - Math.abs(60 - rsi14))),
          reason: trendDown
            ? `Intraday trend down, avoid new longs (RSI ${rsi14.toFixed(1)})`
            : `Momentum not fully aligned yet (RSI ${rsi14.toFixed(1)})`,
        },
      ],
      metadata: {
        regime: trendDown ? "intraday_down" : "intraday_transition",
        volatility: Number(rangePct.toFixed(3)),
        lastUpdated: new Date(),
      },
    };
  }

  // SWING default
  if (latest > sma20 && rsi14 >= 50 && rsi14 <= 68 && momentumPct >= -0.2) {
    return {
      state: "READY",
      signals: [
        {
          type: "SWING_TREND_CONTINUATION",
          direction: "LONG",
          confidence: Math.min(92, Math.round(62 + Math.max(0, (rsi14 - 50) * 0.9))),
          reason: `Swing setup aligned: RSI ${rsi14.toFixed(1)}, close above SMA20`,
        },
      ],
      metadata: {
        regime: "swing_up",
        volatility: Number(rangePct.toFixed(3)),
        lastUpdated: new Date(),
      },
    };
  }

  return {
    state: trendDown ? "BLOCKED" : "CAUTION",
    signals: [
      {
        type: trendDown ? "SWING_DOWNTREND_FILTER" : "SWING_WAIT_CONFIRMATION",
        confidence: Math.max(20, Math.round(48 - Math.abs(58 - rsi14))),
        reason: trendDown
          ? `Swing trend filter blocking entries (RSI ${rsi14.toFixed(1)})`
          : `Awaiting better swing alignment (RSI ${rsi14.toFixed(1)})`,
      },
    ],
    metadata: {
      regime: trendDown ? "swing_down" : "swing_transition",
      volatility: Number(rangePct.toFixed(3)),
      lastUpdated: new Date(),
    },
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
      limit = 50,
    } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: "symbol required" });
    }

    const style = tradingStyle as TradingStyle;
    const resolvedInterval = resolveStyleInterval(style);

    // Fetch candles
    const candles = await multiAssetMarketData.getCandles({
      symbol: symbol as string,
      assetType: assetType as AssetType,
      interval: resolvedInterval,
      limit: parseInt(limit as string) || 50,
    });

    if (candles.length === 0) {
      return res.status(404).json({
        error: `No candle data for ${symbol}`,
        state: "UNRESOLVED",
      });
    }

    const closes = candles.map((c) => asNumber(c.close));
    const highs = candles.map((c) => asNumber(c.high));
    const lows = candles.map((c) => asNumber(c.low));
    const evaluated = buildSignalState(style, closes, highs, lows);

    const response: SignalResponse = {
      symbol: symbol as string,
      assetType: assetType as AssetType,
      tradingStyle: style,
      timestamp: new Date(),
      state: evaluated.state,
      signals: evaluated.signals,
      candles: candles.map((c: any) => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
      metadata: evaluated.metadata,
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
    const { symbol, assetType, tradingStyle, accountSize, userId } = req.body;

    if (!symbol || !accountSize) {
      return res
        .status(400)
        .json({ error: "symbol and accountSize required" });
    }

    const style = (tradingStyle || TradingStyle.SWING) as TradingStyle;

    const users = await prisma.user.findMany({
      where: { organizationId: req.organizationId },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      select: { id: true },
      take: 20,
    });

    const scopedUserId = userId ?? users[0]?.id;
    const userConfig = scopedUserId
      ? await prisma.userConfiguration.findUnique({
          where: {
            userId_tradingStyle: {
              userId: scopedUserId,
              tradingStyle: style,
            },
          },
        })
      : null;

    const riskPerTrade = userConfig?.riskPerTrade ?? 2.0;
    const maxConcurrentTrades = userConfig?.maxConcurrentTrades ?? 3;
    const riskAmount = (accountSize * riskPerTrade) / 100;
    const stopDistancePct = 2;
    const positionSizeUsd = stopDistancePct > 0 ? riskAmount / (stopDistancePct / 100) : 0;

    res.json({
      symbol,
      assetType: assetType || AssetType.CRYPTO,
      tradingStyle: style,
      userId: scopedUserId ?? null,
      accountSize,
      riskPercentage: riskPerTrade,
      riskAmount,
      positionSizeUsd: Number(positionSizeUsd.toFixed(2)),
      recommended: {
        maxConcurrentTrades,
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
