"use client";

import { useAuth } from "../contexts/auth-context";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

function isAuthDisabled(): boolean {
  const raw = String(process.env.NEXT_PUBLIC_AUTH_DISABLED ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return process.env.NODE_ENV !== "production";
}

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const authDisabled = isAuthDisabled();

  useEffect(() => {
    if (!authDisabled && !isLoading && !user) {
      router.push("/login");
    }
  }, [authDisabled, user, isLoading, router]);

  if (authDisabled) {
    return <>{children}</>;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-[--muted]">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return <>{children}</>;
}
