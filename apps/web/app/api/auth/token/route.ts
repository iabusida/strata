import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth-config";
import jwt from "jsonwebtoken";

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return Response.json(
      { error: "Not authenticated" },
      { status: 401 }
    );
  }

  try {
    const user = session.user as any;
    const jwtSecret = process.env.JWT_SECRET || "dev-secret-key-change-in-prod";
    
    // Generate JWT token for WebSocket use
    const token = jwt.sign(
      {
        userId: user.userId,
        organizationId: user.organizationId,
      },
      jwtSecret,
      { expiresIn: "7d" }
    );

    return Response.json({ token });
  } catch (error) {
    console.error("Token generation error:", error);
    return Response.json(
      { error: "Failed to generate token" },
      { status: 500 }
    );
  }
}
