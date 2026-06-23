import { Router, Request, Response } from "express";
import { prisma } from "../prisma-client.js";
import {
  apiKeyAuthMiddleware,
  combinedAuthMiddleware,
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/auth.js";
import {
  openPosition,
  placeOrder,
  getUserPositions,
  getPosition,
  updatePosition,
  closePosition,
  getUserOrders,
  getOrder,
  updateOrderStatus,
  cancelOrder,
} from "../services/position-manager.js";

const positionsApiV1Router = Router();

// Apply combined auth (JWT or API key) to all position routes
positionsApiV1Router.use(combinedAuthMiddleware);
positionsApiV1Router.use(requireAuth);

// ============ POSITIONS ============

/**
 * POST /api/v1/positions
 * Open a new position
 */
positionsApiV1Router.post("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId, symbol, assetType, side, quantity, entryPrice, brokerAccount, stopLoss, takeProfit, notes } = req.body;

    if (!userId || !symbol || !assetType || !side || !quantity || entryPrice === undefined) {
      return res.status(400).json({
        error: "Missing required fields: userId, symbol, assetType, side, quantity, entryPrice",
      });
    }

    const position = await openPosition({
      userId,
      symbol,
      assetType,
      side,
      quantity: parseFloat(quantity),
      entryPrice: parseFloat(entryPrice),
      brokerAccount,
      stopLoss: stopLoss ? parseFloat(stopLoss) : undefined,
      takeProfit: takeProfit ? parseFloat(takeProfit) : undefined,
      notes,
    });

    res.status(201).json({
      success: true,
      position,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/v1/positions/:userId
 * List all positions for a user
 */
positionsApiV1Router.get("/:userId", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    
    // If authenticated with JWT, validate userId matches
    if (req.userId && req.userId !== userId) {
      return res.status(403).json({ error: "Cannot access positions for other users" });
    }

    const positions = await getUserPositions(userId);

    res.json({
      success: true,
      count: positions.length,
      positions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/v1/positions/:userId/:positionId
 * Get single position details
 */
positionsApiV1Router.get("/:userId/:positionId", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const positionId = Array.isArray(req.params.positionId) ? req.params.positionId[0] : req.params.positionId;
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    const position = await getPosition(positionId);

    if (!position || position.userId !== userId) {
      return res.status(404).json({ error: "Position not found" });
    }

    res.json({
      success: true,
      position,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

/**
 * PATCH /api/v1/positions/:positionId
 * Update position (SL/TP or current price for PnL)
 */
positionsApiV1Router.patch("/:positionId", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const positionId = Array.isArray(req.params.positionId) ? req.params.positionId[0] : req.params.positionId;
    const { stopLoss, takeProfit, currentPrice, notes } = req.body;

    const position = await updatePosition(positionId, {
      stopLoss: stopLoss ? parseFloat(stopLoss) : undefined,
      takeProfit: takeProfit ? parseFloat(takeProfit) : undefined,
      currentPrice: currentPrice ? parseFloat(currentPrice) : undefined,
      notes,
    });

    res.json({
      success: true,
      position,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/v1/positions/:positionId/close
 * Close an open position
 */
positionsApiV1Router.post("/:positionId/close", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const positionId = Array.isArray(req.params.positionId) ? req.params.positionId[0] : req.params.positionId;
    const { closePrice, reason } = req.body;

    if (closePrice === undefined) {
      return res.status(400).json({ error: "closePrice is required" });
    }

    const position = await closePosition(positionId, parseFloat(closePrice), reason);

    res.json({
      success: true,
      position,
      message: "Position closed successfully",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

// ============ ORDERS ============

/**
 * POST /api/v1/orders
 * Place an order
 */
positionsApiV1Router.post("/orders", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId, symbol, assetType, side, type, quantity, price, broker, brokerAccount, positionId } =
      req.body;

    if (!userId || !symbol || !assetType || !side || !type || !quantity || !broker) {
      return res.status(400).json({
        error: "Missing required fields: userId, symbol, assetType, side, type, quantity, broker",
      });
    }

    const order = await placeOrder({
      userId,
      symbol,
      assetType,
      side,
      type,
      quantity: parseFloat(quantity),
      price: price ? parseFloat(price) : undefined,
      broker,
      brokerAccount,
      positionId,
    });

    res.status(201).json({
      success: true,
      order,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/v1/orders/:userId
 * List orders for a user
 */
positionsApiV1Router.get("/orders/:userId", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    const orders = await getUserOrders(userId);

    res.json({
      success: true,
      count: orders.length,
      orders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/v1/orders/:orderId
 * Get single order
 */
positionsApiV1Router.get("/orders/details/:orderId", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orderId = Array.isArray(req.params.orderId) ? req.params.orderId[0] : req.params.orderId;
    const order = await getOrder(orderId);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json({
      success: true,
      order,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

/**
 * PATCH /api/v1/orders/:orderId/status
 * Update order status (used when broker confirms fills)
 */
positionsApiV1Router.patch(
  "/orders/:orderId/status",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const orderId = Array.isArray(req.params.orderId) ? req.params.orderId[0] : req.params.orderId;
      const { status, filledQuantity, filledPrice } = req.body;

      if (!status) {
        return res.status(400).json({ error: "status is required" });
      }

      const order = await updateOrderStatus(
        orderId,
        status,
        filledQuantity ? parseFloat(filledQuantity) : undefined,
        filledPrice ? parseFloat(filledPrice) : undefined
      );

      res.json({
        success: true,
        order,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  }
);

/**
 * POST /api/v1/orders/:orderId/cancel
 * Cancel an order
 */
positionsApiV1Router.post("/:orderId/cancel", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orderId = Array.isArray(req.params.orderId) ? req.params.orderId[0] : req.params.orderId;
    const { reason } = req.body;

    const order = await cancelOrder(orderId, reason);

    res.json({
      success: true,
      order,
      message: "Order cancelled successfully",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

export default positionsApiV1Router;
