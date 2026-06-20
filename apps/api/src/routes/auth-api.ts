import { Router, Request, Response } from "express";
import { prisma } from "../prisma-client.js";
import { generateJWT, hashPassword, verifyPassword } from "../middleware/auth.js";

const router = Router();

interface SignupRequest {
  email: string;
  password: string;
  name?: string;
}

interface LoginRequest {
  email: string;
  password: string;
}

interface AuthResponse {
  userId: string;
  email: string;
  name: string | null;
  token: string;
}

// Signup: Create new user and organization
router.post("/signup", async (req: Request<{}, {}, SignupRequest>, res: Response) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(409).json({ error: "User already exists" });
    }

    // Create organization for new user
    const org = await prisma.organization.create({
      data: {
        name: name || email.split("@")[0],
        slug: `${email.split("@")[0]}-${Date.now()}`
      }
    });

    // Create user with hashed password
    const passwordHash = hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email,
        name: name || null,
        passwordHash,
        organizationId: org.id,
        role: "admin" // First user is admin
      }
    });

    // Create default simulation profile
    await prisma.userSimulationProfile.create({
      data: {
        userId: user.id,
        initialBalanceUsd: 10000,
        riskPerTradePct: 1.5,
        leverage: 5,
        maxOpenTrades: 8
      }
    });

    // Generate JWT token
    const token = generateJWT(user.id, org.id);

    const response: AuthResponse = {
      userId: user.id,
      email: user.email,
      name: user.name,
      token
    };

    res.status(201).json(response);
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Signup failed" });
  }
});

// Login: Authenticate user and return JWT
router.post("/login", async (req: Request<{}, {}, LoginRequest>, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { email },
      include: { organization: true }
    });

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Verify password
    if (!verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Generate JWT token
    const token = generateJWT(user.id, user.organizationId);

    const response: AuthResponse = {
      userId: user.id,
      email: user.email,
      name: user.name,
      token
    };

    res.json(response);
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

export default router;
