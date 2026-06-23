"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

function isAuthDisabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const raw = String(process.env.NEXT_PUBLIC_AUTH_DISABLED ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return true;
}

interface User {
  userId: string;
  email: string;
  name: string | null;
  organizationId: string | null;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  setAuthState: (auth: { token: string; userId: string; email: string; name?: string | null; organizationId?: string | null }) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function decodeJwtOrganizationId(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) {
      return null;
    }
    const payloadBase64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadBase64.padEnd(Math.ceil(payloadBase64.length / 4) * 4, "=");
    const payloadJson = atob(padded);
    const payload = JSON.parse(payloadJson) as { organizationId?: unknown };
    return typeof payload.organizationId === "string" && payload.organizationId.trim().length > 0
      ? payload.organizationId.trim()
      : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const setAuthState = (auth: { token: string; userId: string; email: string; name?: string | null; organizationId?: string | null }) => {
    const organizationId = auth.organizationId ?? decodeJwtOrganizationId(auth.token);
    localStorage.setItem("authToken", auth.token);
    localStorage.setItem("userId", auth.userId);
    localStorage.setItem("userEmail", auth.email);
    localStorage.setItem("userName", auth.name ?? "");
    if (organizationId) {
      localStorage.setItem("organizationId", organizationId);
    } else {
      localStorage.removeItem("organizationId");
    }

    setToken(auth.token);
    setUser({
      userId: auth.userId,
      email: auth.email,
      name: auth.name ?? null,
      organizationId,
    });
  };

  // Restore auth state from localStorage on mount
  useEffect(() => {
    if (isAuthDisabled()) {
      setToken("dev-auth-bypass-token");
      setUser({
        userId: "dev-user",
        email: "dev@local",
        name: "Dev User",
        organizationId: "dev-org",
      });
      setIsLoading(false);
      return;
    }

    const storedToken = localStorage.getItem("authToken");
    const storedUserId = localStorage.getItem("userId");
    const storedEmail = localStorage.getItem("userEmail");
    const storedName = localStorage.getItem("userName");
    const storedOrganizationId = localStorage.getItem("organizationId");

    if (storedToken && storedUserId) {
      const organizationId = storedOrganizationId || decodeJwtOrganizationId(storedToken);
      setToken(storedToken);
      setUser({
        userId: storedUserId,
        email: storedEmail || "",
        name: storedName || null,
        organizationId,
      });
    }

    setIsLoading(false);
  }, []);

  const logout = () => {
    localStorage.removeItem("authToken");
    localStorage.removeItem("userId");
    localStorage.removeItem("userEmail");
    localStorage.removeItem("userName");
    localStorage.removeItem("organizationId");
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, isLoading, setAuthState, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
