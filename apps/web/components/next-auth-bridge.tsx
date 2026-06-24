"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useAuth } from "../contexts/auth-context";

/**
 * Syncs a NextAuth session into the legacy AuthContext so that components
 * using useAuth() (e.g. Dashboard WebSocket tenantId) see the signed-in user
 * regardless of whether they authenticated via OAuth or credentials.
 */
export function NextAuthBridge() {
  const { data: session, status } = useSession();
  const { setAuthState, logout, user } = useAuth();

  useEffect(() => {
    if (status !== "authenticated" || !session?.user) return;

    const s = session.user as {
      email?: string | null;
      name?: string | null;
      userId?: string;
      organizationId?: string;
      jwtToken?: string;
    };

    if (!s.jwtToken || !s.userId) return;

    // Only call setAuthState if data differs from current state to avoid loops.
    if (user?.userId === s.userId && user?.organizationId === s.organizationId) return;

    setAuthState({
      token: s.jwtToken,
      userId: s.userId,
      email: s.email ?? "",
      name: s.name ?? null,
      organizationId: s.organizationId ?? null,
    });
  }, [status, session, user?.userId, user?.organizationId, setAuthState]);

  // When NextAuth signs out, clear legacy auth too.
  useEffect(() => {
    if (status === "unauthenticated") {
      logout();
    }
  }, [status, logout]);

  return null;
}
