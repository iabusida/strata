import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthenticatedRequest, requireJWTAuth } from "../middleware/auth.js";

const router = Router();
const prisma = new PrismaClient();

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
