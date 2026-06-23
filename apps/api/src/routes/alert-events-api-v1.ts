import { Router } from "express";
import {
  apiKeyAuthMiddleware,
  combinedAuthMiddleware,
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/auth.js";
import {
  createAlertEvent,
  getUserAlertEvents,
  getSymbolAlertHistory,
  getAlertEventsBySignalState,
  getAlertEventsSummary,
  deleteOldAlertEvents,
} from "../services/alert-event-manager.js";

const alertEventsApiV1Router = Router();

// Apply combined auth (JWT or API key) to all alert event routes
alertEventsApiV1Router.use(combinedAuthMiddleware);
alertEventsApiV1Router.use(requireAuth);

/**
 * POST /api/v1/alerts/events
 * Create a new alert event (log signal state)
 */
alertEventsApiV1Router.post("/events", async (req: AuthenticatedRequest, res) => {
  try {
    const {
      userId,
      symbol,
      assetType,
      tradingStyle,
      interval,
      signalState,
      signalType,
      recommendation,
      metrics,
      priceContext,
    } = req.body;

    if (
      !userId ||
      !symbol ||
      !assetType ||
      !tradingStyle ||
      !interval ||
      !signalState
    ) {
      return res.status(400).json({
        error: "Missing required fields: userId, symbol, assetType, tradingStyle, interval, signalState",
      });
    }

    const alertEvent = await createAlertEvent({
      userId,
      symbol,
      assetType,
      tradingStyle,
      interval,
      signalState,
      signalType,
      recommendation,
      metrics,
      priceContext,
    });

    res.status(201).json({
      success: true,
      alertEvent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/v1/alerts/user/:userId
 * Get all alert events for a user
 */
alertEventsApiV1Router.get("/user/:userId", async (req: AuthenticatedRequest, res) => {
  try {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    
    // If authenticated with JWT, validate userId matches
    if (req.userId && req.userId !== userId) {
      return res.status(403).json({ error: "Cannot access alerts for other users" });
    }

    const limit = req.query.limit ? parseInt(String(req.query.limit)) : 100;
    const offset = req.query.offset ? parseInt(String(req.query.offset)) : 0;

    const result = await getUserAlertEvents(userId, limit, offset);

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/v1/alerts/symbol/:symbol/:assetType/:tradingStyle
 * Get alert history for a specific symbol/style combination
 */
alertEventsApiV1Router.get(
  "/symbol/:symbol/:assetType/:tradingStyle",
  async (req: AuthenticatedRequest, res) => {
    try {
      const symbol = Array.isArray(req.params.symbol)
        ? req.params.symbol[0]
        : req.params.symbol;
      const assetType = Array.isArray(req.params.assetType)
        ? req.params.assetType[0]
        : req.params.assetType;
      const tradingStyle = Array.isArray(req.params.tradingStyle)
        ? req.params.tradingStyle[0]
        : req.params.tradingStyle;
      const limit = req.query.limit ? parseInt(String(req.query.limit)) : 50;

      const events = await getSymbolAlertHistory(
        symbol,
        assetType as any,
        tradingStyle as any,
        limit
      );

      res.json({
        success: true,
        symbol,
        assetType,
        tradingStyle,
        count: events.length,
        events,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  }
);

/**
 * GET /api/v1/alerts/state/:userId/:signalState
 * Get alerts by signal state
 */
alertEventsApiV1Router.get(
  "/state/:userId/:signalState",
  async (req: AuthenticatedRequest, res) => {
    try {
      const userId = Array.isArray(req.params.userId)
        ? req.params.userId[0]
        : req.params.userId;
      const signalState = Array.isArray(req.params.signalState)
        ? req.params.signalState[0]
        : req.params.signalState;
      const limit = req.query.limit ? parseInt(String(req.query.limit)) : 100;

      const events = await getAlertEventsBySignalState(
        userId,
        signalState as any,
        limit
      );

      res.json({
        success: true,
        userId,
        signalState,
        count: events.length,
        events,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  }
);

/**
 * GET /api/v1/alerts/summary/:userId
 * Get alert summary (counts by state/style/symbol) for past N days
 */
alertEventsApiV1Router.get(
  "/summary/:userId",
  async (req: AuthenticatedRequest, res) => {
    try {
      const userId = Array.isArray(req.params.userId)
        ? req.params.userId[0]
        : req.params.userId;
      
      // If authenticated with JWT, validate userId matches
      if (req.userId && req.userId !== userId) {
        return res.status(403).json({ error: "Cannot access summary for other users" });
      }

      const daysBack = req.query.daysBack
        ? parseInt(String(req.query.daysBack))
        : 7;

      const summary = await getAlertEventsSummary(userId, daysBack);

      res.json({
        success: true,
        userId,
        daysBack,
        summary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  }
);

/**
 * POST /api/v1/alerts/cleanup
 * Delete alert events older than N days (admin only)
 */
alertEventsApiV1Router.post(
  "/cleanup",
  async (req: AuthenticatedRequest, res) => {
    try {
      const daysOld = req.body.daysOld || 30;

      const result = await deleteOldAlertEvents(daysOld);

      res.json({
        success: true,
        message: `Deleted ${result.count} alert events older than ${daysOld} days`,
        deletedCount: result.count,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  }
);

export default alertEventsApiV1Router;
