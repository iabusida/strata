"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";

export function useJwtToken() {
  const { data: session } = useSession();
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.user) {
      setToken(null);
      setLoading(false);
      return;
    }

    async function fetchToken() {
      try {
        const res = await fetch("/api/auth/token");
        if (!res.ok) {
          throw new Error("Failed to fetch token");
        }
        const data = await res.json();
        setToken(data.token);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setToken(null);
      } finally {
        setLoading(false);
      }
    }

    fetchToken();
  }, [session?.user]);

  return { token, loading, error };
}
