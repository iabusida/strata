import { Router, Response } from "express";
import { RiskLevel, TradingProfileStyle } from "@prisma/client";
import { AuthenticatedRequest, requireJWTAuth } from "../middleware/auth.js";
import { prisma } from "../prisma-client.js";

const router = Router();

function normalizeTradingProfileStyle(value: string): TradingProfileStyle {
  switch (value) {
    case "scalp":
      return TradingProfileStyle.SCALP;
    case "day":
      return TradingProfileStyle.DAY;
    case "long_term":
      return TradingProfileStyle.LONG_TERM;
    default:
      return TradingProfileStyle.SWING;
  }
}

function normalizeRiskLevel(value: string): RiskLevel {
  switch (value) {
    case "low":
      return RiskLevel.LOW;
    case "high":
      return RiskLevel.HIGH;
    default:
      return RiskLevel.MEDIUM;
  }
}

function serializeTradingProfile(profile: {
  id: string;
  userId: string;
  style: TradingProfileStyle;
  riskLevel: RiskLevel;
  minConfidence: number;
}) {
  return {
    id: profile.id,
    userId: profile.userId,
    style: profile.style.toLowerCase(),
    riskLevel: profile.riskLevel.toLowerCase(),
    minConfidence: profile.minConfidence,
  };
}

router.get(
  "/trading-profile",
  requireJWTAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { userId } = req;

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      const profile = await prisma.userTradingProfile.upsert({
        where: { userId },
        update: {},
        create: {
          userId,
          style: TradingProfileStyle.SWING,
          riskLevel: RiskLevel.MEDIUM,
          minConfidence: 60,
        },
      });

      return res.json(serializeTradingProfile(profile));
    } catch (error) {
      console.error("Get trading profile error:", error);
      return res.status(500).json({ error: "Failed to fetch trading profile" });
    }
  },
);

router.put(
  "/trading-profile",
  requireJWTAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { userId } = req;
      const { style, riskLevel, minConfidence } = req.body as {
        style?: string;
        riskLevel?: string;
        minConfidence?: number;
      };

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      const profile = await prisma.userTradingProfile.upsert({
        where: { userId },
        update: {
          style: style ? normalizeTradingProfileStyle(style) : undefined,
          riskLevel: riskLevel ? normalizeRiskLevel(riskLevel) : undefined,
          minConfidence: typeof minConfidence === "number"
            ? Math.max(0, Math.min(100, Math.round(minConfidence)))
            : undefined,
        },
        create: {
          userId,
          style: normalizeTradingProfileStyle(style ?? "swing"),
          riskLevel: normalizeRiskLevel(riskLevel ?? "medium"),
          minConfidence: typeof minConfidence === "number"
            ? Math.max(0, Math.min(100, Math.round(minConfidence)))
            : 60,
        },
      });

      return res.json(serializeTradingProfile(profile));
    } catch (error) {
      console.error("Update trading profile error:", error);
      return res.status(500).json({ error: "Failed to update trading profile" });
    }
  },
);

// Get user simulation profile
router.get(
  "/simulation",
  requireJWTAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { userId } = req;

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      const profile = await prisma.userSimulationProfile.findUnique({
        where: { userId }
      });

      if (!profile) {
        // Create default if doesn't exist
        const newProfile = await prisma.userSimulationProfile.create({
          data: {
            userId,
            initialBalanceUsd: 10000,
            riskPerTradePct: 1.5,
            leverage: 5,
            maxOpenTrades: 8
          }
        });
        return res.json(newProfile);
      }

      res.json(profile);
    } catch (error) {
      console.error("Get simulation profile error:", error);
      res.status(500).json({ error: "Failed to fetch profile" });
    }
  }
);

// Update user simulation profile
router.put(
  "/simulation",
  requireJWTAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { userId } = req;
      const { initialBalanceUsd, riskPerTradePct, leverage, maxOpenTrades } = req.body;

      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      const profile = await prisma.userSimulationProfile.upsert({
        where: { userId },
        update: {
          initialBalanceUsd: initialBalanceUsd || undefined,
          riskPerTradePct: riskPerTradePct || undefined,
          leverage: leverage || undefined,
          maxOpenTrades: maxOpenTrades || undefined
        },
        create: {
          userId,
          initialBalanceUsd: initialBalanceUsd || 10000,
          riskPerTradePct: riskPerTradePct || 1.5,
          leverage: leverage || 5,
          maxOpenTrades: maxOpenTrades || 8
        }
      });

      res.json(profile);
    } catch (error) {
      console.error("Update simulation profile error:", error);
      res.status(500).json({ error: "Failed to update profile" });
    }
  }
);

export default router;
