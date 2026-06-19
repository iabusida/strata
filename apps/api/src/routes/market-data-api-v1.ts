import { Router } from "express";
import { AssetType, CandleInterval, OptionSide, PrismaClient, TradingStyle } from "@prisma/client";
import {
  apiKeyAuthMiddleware,
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/auth.js";
import multiAssetMarketData from "../services/multi-asset-market-data.js";
import {
  ingestFuturesCandles,
  ingestOptionsCandles,
} from "../services/derivatives-ingestion.js";
import {
  getStyleRefreshSchedulerStatus,
  refreshAllStylePolicies,
  refreshStyleMarketData,
  startStyleRefreshScheduler,
  stopStyleRefreshScheduler,
} from "../services/style-market-refresh.js";

const prisma = new PrismaClient();
const router = Router();

router.use(apiKeyAuthMiddleware);
router.use(requireAuth);

function normalizeCandleInterval(value: string): CandleInterval {
  const v = value.toUpperCase();
  if (v === "M15") return CandleInterval.M15;
  if (v === "H4") return CandleInterval.H4;
  if (v === "H12") return CandleInterval.H12;
  if (v === "D1") return CandleInterval.D1;
  return CandleInterval.H1;
}

router.put("/style-policy/:userId/:style", async (req: AuthenticatedRequest, res) => {
  try {
    const userIdRaw = req.params.userId;
    const userId = Array.isArray(userIdRaw) ? userIdRaw[0] : userIdRaw;
    const styleRaw = req.params.style;
    const style = Array.isArray(styleRaw) ? styleRaw[0] : styleRaw;
    const tradingStyle = String(style).toUpperCase() as TradingStyle;

    const allowedAssetTypes = Array.isArray(req.body?.allowedAssetTypes)
      ? req.body.allowedAssetTypes.map((it: string) => String(it).toUpperCase())
      : [AssetType.CRYPTO];

    const allowedIntervals = Array.isArray(req.body?.allowedIntervals)
      ? req.body.allowedIntervals.map((it: string) => normalizeCandleInterval(it))
      : [CandleInterval.H1];

    const record = await prisma.styleMarketPolicy.upsert({
      where: {
        userId_tradingStyle: {
          userId,
          tradingStyle,
        },
      },
      update: {
        allowedAssetTypes: allowedAssetTypes as AssetType[],
        allowedIntervals,
        refreshSeconds: Number(req.body?.refreshSeconds ?? 60),
        maxUniverseSize: Number(req.body?.maxUniverseSize ?? 50),
        includeExtendedHours: Boolean(req.body?.includeExtendedHours ?? false),
      },
      create: {
        userId,
        tradingStyle,
        allowedAssetTypes: allowedAssetTypes as AssetType[],
        allowedIntervals,
        refreshSeconds: Number(req.body?.refreshSeconds ?? 60),
        maxUniverseSize: Number(req.body?.maxUniverseSize ?? 50),
        includeExtendedHours: Boolean(req.body?.includeExtendedHours ?? false),
      },
    });

    return res.json(record);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: "Failed to upsert style policy", details });
  }
});

router.get("/style-universe/:userId/:style", async (req: AuthenticatedRequest, res) => {
  try {
    const userIdRaw = req.params.userId;
    const userId = Array.isArray(userIdRaw) ? userIdRaw[0] : userIdRaw;
    const styleRaw = req.params.style;
    const style = Array.isArray(styleRaw) ? styleRaw[0] : styleRaw;
    const tradingStyle = String(style).toUpperCase() as TradingStyle;

    const config = await prisma.userConfiguration.findUnique({
      where: {
        userId_tradingStyle: {
          userId,
          tradingStyle,
        },
      },
    });

    if (!config) {
      return res.status(404).json({ error: "User style configuration not found" });
    }

    const policy = await prisma.styleMarketPolicy.findUnique({
      where: {
        userId_tradingStyle: {
          userId,
          tradingStyle,
        },
      },
    });

    const allowedAssetTypes = policy?.allowedAssetTypes ?? [AssetType.CRYPTO];
    const allowedIntervals = policy?.allowedIntervals ?? [CandleInterval.H1];
    const interval = allowedIntervals[0] ?? CandleInterval.H1;
    const maxUniverse = policy?.maxUniverseSize ?? 50;
    const symbols = (config.symbolUniverse ?? []).slice(0, maxUniverse);

    const snapshots = await Promise.all(
      symbols.flatMap((symbol) =>
        allowedAssetTypes.map(async (assetType) => {
          const latest = await multiAssetMarketData.getLatestCandle(symbol, assetType, interval);
          const latestSafe = latest
            ? {
                timestamp: latest.timestamp,
                open: latest.open,
                high: latest.high,
                low: latest.low,
                close: latest.close,
                volume: latest.volume,
              }
            : null;
          return {
            symbol,
            assetType,
            interval,
            latest: latestSafe,
          };
        })
      )
    );

    return res.json({
      userId,
      tradingStyle,
      policy: policy ?? null,
      symbolCount: symbols.length,
      snapshots,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: "Failed to fetch style universe", details });
  }
});

router.post("/ingest/futures", async (req: AuthenticatedRequest, res) => {
  try {
    const symbol = String(req.body?.symbol ?? "").trim().toUpperCase();
    const underlyingSymbol = String(req.body?.underlyingSymbol ?? "").trim().toUpperCase();
    const venue = String(req.body?.venue ?? "").trim() || "finnhub";
    const interval = normalizeCandleInterval(String(req.body?.interval ?? "H1"));
    const candles = Array.isArray(req.body?.candles) ? req.body.candles : [];

    if (!symbol || !underlyingSymbol || candles.length === 0) {
      return res.status(400).json({
        error: "symbol, underlyingSymbol, and candles[] are required",
      });
    }

    const result = await ingestFuturesCandles({
      symbol,
      underlyingSymbol,
      venue,
      interval,
      contractSize: Number(req.body?.contractSize ?? 1),
      tickSize: Number(req.body?.tickSize ?? 0.01),
      metadata: req.body?.metadata ?? {},
      candles: candles.map((row: any) => ({
        timestamp: new Date(row.timestamp),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      })),
    });

    return res.json({
      assetType: AssetType.FUTURE,
      symbol,
      interval,
      insertedCandles: result.insertedCandles,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: "Failed to ingest futures candles", details });
  }
});

router.post("/ingest/options", async (req: AuthenticatedRequest, res) => {
  try {
    const symbol = String(req.body?.symbol ?? "").trim().toUpperCase();
    const underlyingSymbol = String(req.body?.underlyingSymbol ?? "").trim().toUpperCase();
    const venue = String(req.body?.venue ?? "").trim() || "finnhub";
    const interval = normalizeCandleInterval(String(req.body?.interval ?? "H1"));
    const candles = Array.isArray(req.body?.candles) ? req.body.candles : [];
    const optionSide = String(req.body?.optionSide ?? "CALL").toUpperCase() as OptionSide;

    if (!symbol || !underlyingSymbol || candles.length === 0) {
      return res.status(400).json({
        error: "symbol, underlyingSymbol, and candles[] are required",
      });
    }

    const result = await ingestOptionsCandles({
      symbol,
      underlyingSymbol,
      venue,
      interval,
      optionSide,
      strike: Number(req.body?.strike ?? 0),
      expiration: req.body?.expiration ? new Date(req.body.expiration) : undefined,
      contractSize: Number(req.body?.contractSize ?? 100),
      tickSize: Number(req.body?.tickSize ?? 0.01),
      metadata: req.body?.metadata ?? {},
      candles: candles.map((row: any) => ({
        timestamp: new Date(row.timestamp),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      })),
    });

    return res.json({
      assetType: AssetType.OPTION,
      symbol,
      interval,
      insertedCandles: result.insertedCandles,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: "Failed to ingest options candles", details });
  }
});

router.post("/style-refresh/run/:userId/:style", async (req: AuthenticatedRequest, res) => {
  try {
    const userIdRaw = req.params.userId;
    const userId = Array.isArray(userIdRaw) ? userIdRaw[0] : userIdRaw;
    const styleRaw = req.params.style;
    const style = Array.isArray(styleRaw) ? styleRaw[0] : styleRaw;
    const tradingStyle = String(style).toUpperCase() as TradingStyle;

    const summary = await refreshStyleMarketData(userId, tradingStyle);
    return res.json(summary);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: "Failed to refresh style market data", details });
  }
});

router.post("/style-refresh/all", async (_req: AuthenticatedRequest, res) => {
  try {
    const summaries = await refreshAllStylePolicies();
    return res.json({
      policyCount: summaries.length,
      summaries,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: "Failed to refresh all style policies", details });
  }
});

router.post("/style-refresh/scheduler/start", async (req: AuthenticatedRequest, res) => {
  try {
    const intervalSeconds = Number(req.body?.intervalSeconds ?? 60);
    const state = startStyleRefreshScheduler(intervalSeconds);
    return res.json(state);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: "Failed to start style refresh scheduler", details });
  }
});

router.post("/style-refresh/scheduler/stop", async (_req: AuthenticatedRequest, res) => {
  try {
    const state = stopStyleRefreshScheduler();
    return res.json(state);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: "Failed to stop style refresh scheduler", details });
  }
});

router.get("/style-refresh/scheduler/status", async (_req: AuthenticatedRequest, res) => {
  try {
    const state = getStyleRefreshSchedulerStatus();
    return res.json(state);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: "Failed to fetch style refresh scheduler status", details });
  }
});

export default router;
