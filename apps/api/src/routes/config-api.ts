import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  apiKeyAuthMiddleware,
  requireAuth,
  generateApiKey,
  hashApiKey,
  type AuthenticatedRequest,
} from "../middleware/auth.js";
import { invalidatePlatformConfigCache } from "../config/platform-config.js";

const prisma = new PrismaClient();
const router = Router();

// Apply auth to all config routes
router.use(apiKeyAuthMiddleware);
router.use(requireAuth);

/**
 * Platform Configuration Management (admin only)
 */

router.get("/platform", async (req: AuthenticatedRequest, res) => {
  try {
    const config = await prisma.platformConfiguration.findFirst();

    if (!config) {
      return res.status(404).json({ error: "Platform config not found" });
    }

    res.json({
      id: config.id,
      exchangeCredentials: config.exchangeCredentials,
      backfillPolicy: config.backfillPolicy,
      indicatorDefaults: config.indicatorDefaults,
      alertChannels: config.alertChannels,
      riskDefaults: config.riskDefaults,
      updatedAt: config.updatedAt,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch platform config" });
  }
});

router.put("/platform", async (req: AuthenticatedRequest, res) => {
  try {
    const {
      exchangeCredentials,
      backfillPolicy,
      indicatorDefaults,
      alertChannels,
      riskDefaults,
    } = req.body;

    let config = await prisma.platformConfiguration.findFirst();

    if (!config) {
      config = await prisma.platformConfiguration.create({
        data: {
          exchangeCredentials: exchangeCredentials || {},
          backfillPolicy: backfillPolicy || {},
          indicatorDefaults: indicatorDefaults || {},
          alertChannels: alertChannels || {},
          riskDefaults: riskDefaults || {},
        },
      });
    } else {
      config = await prisma.platformConfiguration.update({
        where: { id: config.id },
        data: {
          ...(exchangeCredentials && {
            exchangeCredentials,
          }),
          ...(backfillPolicy && {
            backfillPolicy,
          }),
          ...(indicatorDefaults && {
            indicatorDefaults,
          }),
          ...(alertChannels && {
            alertChannels,
          }),
          ...(riskDefaults && {
            riskDefaults,
          }),
        },
      });
    }

    invalidatePlatformConfigCache();

    res.json({
      id: config.id,
      exchangeCredentials: config.exchangeCredentials,
      backfillPolicy: config.backfillPolicy,
      indicatorDefaults: config.indicatorDefaults,
      alertChannels: config.alertChannels,
      riskDefaults: config.riskDefaults,
      updatedAt: config.updatedAt,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to update platform config" });
  }
});

/**
 * User Configuration Management
 */

router.get("/user/:userId", async (req: AuthenticatedRequest, res) => {
  try {
    const { userId: userIdParam } = req.params;
    const userId = Array.isArray(userIdParam) ? userIdParam[0] : userIdParam;
    const { tradingStyle } = req.query;

    const query: any = { userId };
    if (tradingStyle) {
      query.tradingStyle = Array.isArray(tradingStyle) ? tradingStyle[0] : tradingStyle;
    }

    const configs = tradingStyle
      ? await prisma.userConfiguration.findUnique({
          where: {
            userId_tradingStyle: {
              userId,
              tradingStyle: (Array.isArray(tradingStyle) ? tradingStyle[0] : tradingStyle) as any,
            },
          },
        })
      : await prisma.userConfiguration.findMany({ where: query });

    res.json(configs);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user config" });
  }
});

router.post("/user/:userId", async (req: AuthenticatedRequest, res) => {
  try {
    const { userId: userIdParam } = req.params;
    const userId = Array.isArray(userIdParam) ? userIdParam[0] : userIdParam;
    const {
      tradingStyle,
      symbolUniverse,
      riskPerTrade,
      maxConcurrentTrades,
      dayTradeSettings,
      swingSettings,
      longTermSettings,
      spotSettings,
    } = req.body as any;

    // Check if config exists for this style
    const existing = await prisma.userConfiguration.findUnique({
      where: {
        userId_tradingStyle: {
          userId,
          tradingStyle: tradingStyle as any,
        },
      },
    });

    const config = existing
      ? await prisma.userConfiguration.update({
          where: {
            userId_tradingStyle: {
              userId,
              tradingStyle: tradingStyle as any,
            },
          },
          data: {
            ...(symbolUniverse !== undefined && { symbolUniverse }),
            ...(riskPerTrade !== undefined && { riskPerTrade }),
            ...(maxConcurrentTrades !== undefined && {
              maxConcurrentTrades,
            }),
            ...(dayTradeSettings !== undefined && { dayTradeSettings }),
            ...(swingSettings !== undefined && { swingSettings }),
            ...(longTermSettings !== undefined && { longTermSettings }),
            ...(spotSettings !== undefined && { spotSettings }),
          },
        })
      : await prisma.userConfiguration.create({
          data: {
            userId,
            tradingStyle: tradingStyle as any,
            symbolUniverse,
            riskPerTrade,
            maxConcurrentTrades,
            dayTradeSettings,
            swingSettings,
            longTermSettings,
            spotSettings,
          },
        });

    res.json(config);
  } catch (error) {
    res.status(500).json({ error: "Failed to save user config" });
  }
});

/**
 * API Key Management
 */

router.post(
  "/organization/:organizationId/keys",
  async (req: AuthenticatedRequest, res) => {
    try {
      const { organizationId } = req.params;
      const { name } = req.body;

      if (req.organizationId !== organizationId) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const rawKey = generateApiKey();
      const keyHash = hashApiKey(rawKey);

      const apiKey = await prisma.apiKey.create({
        data: {
          organizationId,
          name,
          keyHash,
        },
      });

      res.json({
        id: apiKey.id,
        name: apiKey.name,
        key: rawKey, // Only return once
        createdAt: apiKey.createdAt,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to create API key" });
    }
  }
);

router.get(
  "/organization/:organizationId/keys",
  async (req: AuthenticatedRequest, res) => {
    try {
      const { organizationId } = req.params;

      if (req.organizationId !== organizationId) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const keys = await prisma.apiKey.findMany({
        where: { organizationId },
        select: {
          id: true,
          name: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
        },
      });

      res.json(keys);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch API keys" });
    }
  }
);

router.delete(
  "/organization/:organizationId/keys/:keyId",
  async (req: AuthenticatedRequest, res) => {
    try {
      const { organizationId, keyId } = req.params;

      if (req.organizationId !== organizationId) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const keyIdStr = Array.isArray(keyId) ? keyId[0] : keyId;

      await prisma.apiKey.update({
        where: { id: keyIdStr },
        data: { revokedAt: new Date() },
      });

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to revoke API key" });
    }
  }
);

export default router;
