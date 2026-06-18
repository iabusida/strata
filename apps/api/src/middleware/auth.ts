import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { Request, Response, NextFunction } from "express";

const prisma = new PrismaClient();

export interface AuthenticatedRequest extends Request {
  organizationId?: string;
  userId?: string;
  apiKeyId?: string;
}

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): string {
  return `hype_${crypto.randomBytes(24).toString("hex")}`;
}

export async function apiKeyAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization" });
  }

  const keyRaw = authHeader.slice(7);
  const keyHash = hashApiKey(keyRaw);

  try {
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: { organization: true },
    });

    if (!apiKey || apiKey.revokedAt) {
      return res.status(401).json({ error: "Invalid or revoked API key" });
    }

    // Update lastUsedAt
    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    });

    req.organizationId = apiKey.organizationId;
    req.apiKeyId = apiKey.id;
    next();
  } catch (error) {
    return res.status(500).json({ error: "Auth error" });
  }
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.organizationId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}
