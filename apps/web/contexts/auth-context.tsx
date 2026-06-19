"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

function isAuthDisabled(): boolean {
  const raw = String(process.env.NEXT_PUBLIC_AUTH_DISABLED ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return process.env.NODE_ENV !== "production";
}

interface User {
  userId: string;
  email: string;
  name: string | null;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore auth state from localStorage on mount
  useEffect(() => {
    if (isAuthDisabled()) {
      setToken("dev-auth-bypass-token");
      setUser({
        userId: "dev-user",
        email: "dev@local",
        name: "Dev User",
      });
      setIsLoading(false);
      return;
    }

    const storedToken = localStorage.getItem("authToken");
    const storedUserId = localStorage.getItem("userId");
    const storedEmail = localStorage.getItem("userEmail");
    const storedName = localStorage.getItem("userName");

    if (storedToken && storedUserId) {
      setToken(storedToken);
      setUser({
        userId: storedUserId,
        email: storedEmail || "",
        name: storedName || null,
      });
    }

    setIsLoading(false);
  }, []);

  const logout = () => {
    localStorage.removeItem("authToken");
    localStorage.removeItem("userId");
    localStorage.removeItem("userEmail");
    localStorage.removeItem("userName");
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, isLoading, logout }}>
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
