"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import Link from "next/link";

interface SignupFormData {
  email: string;
  password: string;
  name: string;
}

export default function SignupPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [formData, setFormData] = useState<SignupFormData>({
    email: "",
    password: "",
    name: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  // Redirect if already logged in
  useEffect(() => {
    if (status === "authenticated" && session?.user?.email) {
      router.push("/markets/crypto");
    }
  }, [status, session, router]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (formData.password.length < 8) {
        throw new Error("Password must be at least 8 characters");
      }

      const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8787";
      const response = await fetch(`${API_BASE}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Signup failed");
      }

      // Use credentials provider to sign in with the new account
      const result = await signIn("credentials", {
        email: formData.email,
        password: formData.password,
        redirect: true,
        callbackUrl: "/markets/crypto",
      });

      if (!result?.ok) {
        throw new Error("Failed to sign in after signup");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed");
      setLoading(false);
    }
  };

  const handleGoogleSignUp = async () => {
    setGoogleLoading(true);
    try {
      await signIn("google", { redirect: true, callbackUrl: "/markets/crypto" });
    } catch (err) {
      setError(`Google sign up failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      setGoogleLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[--bg] to-[--panel]">
      <div className="w-full max-w-md bg-[--panel] rounded-lg border border-[--line] p-8 shadow-lg">
        <h1 className="text-3xl font-bold text-[--text] mb-2">Create Account</h1>
        <p className="text-[--muted] mb-8">Join Strata to access signal intelligence for crypto and stocks</p>

        {error && (
          <div className="mb-6 p-4 bg-red-900/20 border border-red-600/30 rounded text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Google Sign-Up Button */}
        <button
          onClick={handleGoogleSignUp}
          disabled={googleLoading}
          className="w-full py-2 bg-white text-gray-800 font-semibold rounded hover:bg-gray-100 disabled:opacity-50 transition flex items-center justify-center gap-2 mb-6"
        >
          {googleLoading ? (
            "Signing up..."
          ) : (
            <>
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Sign up with Google
            </>
          )}
        </button>

        {/* Divider */}
        <div className="relative mb-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-[--line]"></div>
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 bg-[--panel] text-[--muted]">Or sign up with email</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-[--text] mb-2">
              Full Name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              value={formData.name}
              onChange={handleChange}
              placeholder="John Doe"
              className="w-full px-4 py-2 bg-[--bg] border border-[--line] rounded text-[--text] placeholder-[--muted] focus:outline-none focus:border-[--hot]"
            />
          </div>

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
            <p className="text-xs text-[--muted] mt-1">At least 8 characters</p>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-[--hot] text-white font-semibold rounded hover:opacity-90 disabled:opacity-50 transition mt-6"
          >
            {loading ? "Creating account..." : "Create Account"}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-[--muted]">
          Already have an account?{" "}
          <Link href="/login" className="text-[--hot] hover:underline">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
