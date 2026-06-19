"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787";

interface LoginFormData {
  email: string;
  password: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [formData, setFormData] = useState<LoginFormData>({ email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Redirect if already logged in
  useEffect(() => {
    const token = localStorage.getItem("authToken");
    if (token) {
      router.push("/markets/crypto");
    }
  }, [router]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Login failed");
      }

      const { token, userId, email, name } = await response.json();

      // Store token and user info in localStorage
      localStorage.setItem("authToken", token);
      localStorage.setItem("userId", userId);
      localStorage.setItem("userEmail", email);
      localStorage.setItem("userName", name || "");

      // Redirect to dashboard
      router.push("/markets/crypto");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[--bg] to-[--panel]">
      <div className="w-full max-w-md bg-[--panel] rounded-lg border border-[--line] p-8 shadow-lg">
        <h1 className="text-3xl font-bold text-[--text] mb-2">Welcome Back</h1>
        <p className="text-[--muted] mb-8">Sign in to your Hype Trading account</p>

        {error && (
          <div className="mb-6 p-4 bg-red-900/20 border border-red-600/30 rounded text-red-400 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-[--text] mb-2">
              Email Address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              value={formData.email}
              onChange={handleChange}
              placeholder="you@example.com"
              className="w-full px-4 py-2 bg-[--bg] border border-[--line] rounded text-[--text] placeholder-[--muted] focus:outline-none focus:border-[--hot]"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-[--text] mb-2">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              value={formData.password}
              onChange={handleChange}
              placeholder="••••••••"
              className="w-full px-4 py-2 bg-[--bg] border border-[--line] rounded text-[--text] placeholder-[--muted] focus:outline-none focus:border-[--hot]"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-[--hot] text-white font-semibold rounded hover:opacity-90 disabled:opacity-50 transition mt-6"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-[--muted]">
          Don't have an account?{" "}
          <Link href="/signup" className="text-[--hot] hover:underline">
            Sign up
          </Link>
        </div>
      </div>
    </div>
  );
}
