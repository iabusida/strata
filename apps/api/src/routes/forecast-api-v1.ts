import express from "express";
import {
  buildMomentumForecast,
  DEFAULT_FORECAST_INTERVAL,
  SUPPORTED_FORECAST_INTERVALS
} from "../forecast-engine.js";

const router = express.Router();

/**
 * GET /api/v1/forecast/:symbol/:interval?
 * Momentum forecast from stored market candles (no prediction market dependency).
 */
router.get(["/:symbol", "/:symbol/:interval"], async (req, res) => {
  try {
    const symbolParam = Array.isArray(req.params.symbol) ? req.params.symbol[0] : req.params.symbol;
    if (!symbolParam) {
      return res.status(400).json({ error: "Symbol is required" });
    }

    const intervalParam = String(req.params.interval ?? req.query.interval ?? DEFAULT_FORECAST_INTERVAL);
    const assetTypeParam = String(req.query.assetType ?? "CRYPTO");
    const forecast = await buildMomentumForecast({
      symbol: symbolParam,
      intervalRequested: intervalParam,
      assetType: assetTypeParam
    });

    return res.json({
      ...forecast,
      supportedIntervals: SUPPORTED_FORECAST_INTERVALS
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    const status = /Insufficient/.test(details) ? 404 : 500;

    return res.status(status).json({
      error: "Failed to generate momentum forecast",
      details,
      supportedIntervals: SUPPORTED_FORECAST_INTERVALS
    });
  }
});

export default router;
