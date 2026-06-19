import crypto from "crypto";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { Request, Response, NextFunction } from "express";

const prisma = new PrismaClient();

function isAuthDisabled(): boolean {
  const raw = String(process.env.AUTH_DISABLED ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return process.env.NODE_ENV !== "production";
}

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
  if (isAuthDisabled()) {
    return next();
  }

  if (!req.organizationId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

// JWT Auth Functions
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-key-change-in-prod";
const JWT_EXPIRY = "7d";

export function generateJWT(userId: string, organizationId: string): string {
  return jwt.sign(
    { userId, organizationId },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

export function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

export async function jwtAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization" });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      organizationId: string;
    };
    req.userId = decoded.userId;
    req.organizationId = decoded.organizationId;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export async function optionalJwtAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      organizationId: string;
    };
    req.userId = decoded.userId;
    req.organizationId = decoded.organizationId;
  } catch (error) {
    // Invalid token, but don't block - just skip auth
  }
  
  next();
}

export async function requireJWTAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  if (isAuthDisabled()) {
    return next();
  }

  if (!req.userId) {
    return res.status(401).json({ error: "User authentication required" });
  }
  next();
}
