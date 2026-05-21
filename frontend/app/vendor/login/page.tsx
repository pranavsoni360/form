"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Banknote, Loader2, Lock, User } from "lucide-react";

import { vendorLogin } from "@/lib/api/vendor";
import { setAccessToken, setCurrentUser } from "@/lib/auth";

// useSearchParams forces client-side bail-out — Next.js requires a Suspense
// boundary so the rest of the route group can still pre-render.
export default function VendorLoginPage() {
  return (
    <React.Suspense fallback={<div className="min-h-screen grid place-items-center text-slate-500">Loading…</div>}>
      <VendorLoginForm />
    </React.Suspense>
  );
}

function VendorLoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get("redirect") || "/vendor/dashboard";

  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const resp = await vendorLogin(username, password);
      setAccessToken("vendor", resp.token);
      setCurrentUser("vendor", resp.user);
      router.replace(redirectTo);
    } catch (err: any) {
      setError(err?.message || "Login failed — please check your credentials");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 via-slate-50 to-teal-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950 grid place-items-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-xl dark:border-gray-800 dark:bg-gray-900">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-emerald-600 text-white shadow-lg">
            <Banknote className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-gray-100">
            Vendor Portal
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-gray-400">
            NBFC partner disbursement workflow
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-gray-300">
              Username
            </label>
            <div className="relative">
              <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                required
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="vendor username"
                className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-10 pr-3 text-sm outline-none ring-emerald-500 focus:ring-2 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-gray-300">
              Password
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-10 pr-3 text-sm outline-none ring-emerald-500 focus:ring-2 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Sign in
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-500 dark:text-gray-500">
          Need access? Contact your bank's admin to create your account.
        </p>
      </div>
    </div>
  );
}
