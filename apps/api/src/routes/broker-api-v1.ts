import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  apiKeyAuthMiddleware,
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/auth.js";
import {
  SchwabConnector,
  ingestSchwabCandles,
  storeSchwabTokens,
} from "../services/schwab-connector.js";

const prisma = new PrismaClient();
const router = Router();

router.use(apiKeyAuthMiddleware);
router.use(requireAuth);

function hasRealSchwabConfig(credentials: unknown): boolean {
  const creds = credentials as
    | {
        schwab?: {
          clientId?: string;
          clientSecret?: string;
          redirectUri?: string;
        };
      }
    | undefined;

  const clientId = creds?.schwab?.clientId ?? "";
  const clientSecret = creds?.schwab?.clientSecret ?? "";
  const redirectUri = creds?.schwab?.redirectUri ?? "";

  if (!clientId || !clientSecret || !redirectUri) return false;
  if (clientId.startsWith("YOUR_")) return false;
  if (clientSecret.startsWith("YOUR_")) return false;
  return true;
}

router.get("/schwab/oauth-url", async (_req: AuthenticatedRequest, res) => {
  try {
    const platform = await prisma.platformConfiguration.findFirst();
    if (!platform || !hasRealSchwabConfig(platform.exchangeCredentials)) {
      return res.status(503).json({
        error: "Schwab is not configured",
        code: "SCHWAB_CONFIG_MISSING",
        action: "Set real Schwab credentials in PlatformConfiguration.exchangeCredentials.schwab",
      });
    }

    const connector = new SchwabConnector();
    const url = await connector.getOAuthUrl();
    return res.json({ provider: "schwab", oauthUrl: url });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: "Failed to build Schwab OAuth URL", details });
  }
});

router.post("/schwab/oauth/callback", async (req: AuthenticatedRequest, res) => {
  try {
    const code = String(req.body?.code ?? "").trim();
    if (!code) {
      return res.status(400).json({ error: "OAuth code is required" });
    }

    const connector = new SchwabConnector();
    const tokens = await connector.exchangeCodeForToken(code);
    await storeSchwabTokens(req.organizationId ?? "", tokens);

    return res.json({
      provider: "schwab",
      linked: true,
      expiresInSeconds: tokens.expires_in,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(502).json({ error: "Failed to exchange Schwab OAuth code", details });
  }
});

router.get("/schwab/accounts", async (_req: AuthenticatedRequest, res) => {
  try {
    const connector = new SchwabConnector();
    const accounts = await connector.getAccounts();
    return res.json({ provider: "schwab", accounts });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(502).json({ error: "Failed to fetch Schwab accounts", details });
  }
});

router.get("/schwab/candles", async (req: AuthenticatedRequest, res) => {
  try {
    const symbol = String(req.query.symbol ?? "").trim().toUpperCase();
    if (!symbol) {
      return res.status(400).json({ error: "symbol query is required" });
    }

    const periodType = String(req.query.periodType ?? "day");
    const period = Number(req.query.period ?? 10);
    const frequencyType = String(req.query.frequencyType ?? "minute");
    const frequency = Number(req.query.frequency ?? 30);

    const connector = new SchwabConnector();
    const candles = await connector.getCandles(
      symbol,
      periodType,
      Number.isFinite(period) ? period : 10,
      frequencyType,
      Number.isFinite(frequency) ? frequency : 30
    );

    return res.json({ provider: "schwab", symbol, candles });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(502).json({ error: "Failed to fetch Schwab candles", details });
  }
});

router.post("/schwab/ingest/candles", async (req: AuthenticatedRequest, res) => {
  try {
    const symbol = String(req.body?.symbol ?? "").trim().toUpperCase();
    if (!symbol) {
      return res.status(400).json({ error: "symbol is required" });
    }

    const periodType = String(req.body?.periodType ?? "day");
    const period = Number(req.body?.period ?? 10);
    const frequencyType = String(req.body?.frequencyType ?? "minute");
    const frequency = Number(req.body?.frequency ?? 30);

    const result = await ingestSchwabCandles({
      symbol,
      periodType,
      period: Number.isFinite(period) ? period : 10,
      frequencyType,
      frequency: Number.isFinite(frequency) ? frequency : 30,
    });

    return res.json({
      provider: "schwab",
      symbol,
      assetType: "STOCK",
      insertedCandles: result.insertedCandles,
      interval: result.interval,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return res.status(502).json({ error: "Failed to ingest Schwab candles", details });
  }
});

export default router;
