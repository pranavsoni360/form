'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { adminLogin } from '@/lib/api';
import { setAccessToken, setCurrentUser } from '@/lib/auth';
import { Shield, Loader2 } from 'lucide-react';

/**
 * Admin login.
 *
 * Post-login redirect logic:
 *   1. If a `?redirect=` query param is present AND it points to a same-origin
 *      path under /ops, /admin, or /bank — go there.
 *   2. Otherwise default to /ops (the new VirtualVaani dashboard — operator's
 *      primary destination).
 *
 * Why a redirect param: /ops/layout.tsx (auth gate) bounces unauthenticated
 * users here with the original path attached. After login they end up exactly
 * where they meant to go — no manual URL re-typing.
 */
export default function AdminLoginPage() {
  // Wrap in Suspense because useSearchParams() requires it under Next.js 14
  // App Router's static rendering rules.
  return (
    <Suspense>
      <AdminLoginInner />
    </Suspense>
  );
}

function AdminLoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /** Allow-list of post-login destinations to defeat open-redirect abuse. */
  const safeRedirect = (raw: string | null): string => {
    if (!raw) return '/admin/dashboard';
    // Must start with / (relative path), must not be // (protocol-relative),
    // must point to a known section of the app.
    if (!raw.startsWith('/') || raw.startsWith('//')) return '/admin/dashboard';
    if (raw.startsWith('/admin/')) return raw;
    return '/admin/dashboard';
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await adminLogin(email, password);
      setAccessToken('admin', response.token);
      setCurrentUser('admin', response.user);
      router.push(safeRedirect(searchParams.get('redirect')));
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-700 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full">
        <div className="text-center mb-8">
          <div className="mb-4"><Shield className="w-14 h-14 text-blue-600 mx-auto" /></div>
          <h1 className="text-3xl font-bold text-gray-900">Admin Login</h1>
          <p className="text-gray-600 mt-2">
            VirtualVaani · Loan Operations
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Email Address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              placeholder="admin@bank.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3 rounded-lg font-semibold hover:from-blue-700 hover:to-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <p className="text-xs text-gray-500">
            Authorized personnel only
          </p>
        </div>
      </div>
    </div>
  );
}
