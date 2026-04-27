'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { bankLogin } from '@/lib/api';
import { setAccessToken, setCurrentUser } from '@/lib/auth';
import { Building2, Loader2, User, Lock } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';

export default function BankLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await bankLogin(username, password);
      setAccessToken('bank', response.token);
      setCurrentUser('bank', response.user);
      router.push('/bank/dashboard');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-gray-950 dark:to-gray-900 flex items-center justify-center p-4 transition-colors">
      <div className="bg-white dark:bg-dark-card rounded-2xl shadow-2xl dark:shadow-gray-950/50 p-8 max-w-md w-full transition-colors">
        <div className="flex justify-end mb-2"><ThemeToggle /></div>
        <div className="text-center mb-8">
          <div className="mb-4">
            <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-2xl flex items-center justify-center mx-auto">
              <Building2 className="w-8 h-8 text-blue-600" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Bank Portal</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-2 text-sm">Loan Application Management System</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Username</label>
            <div className="relative">
              <User className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required
                className="w-full pl-10 pr-4 py-3 border border-gray-300 dark:border-gray-600 dark:bg-dark-input dark:text-gray-100 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-colors"
                placeholder="Enter username" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Password</label>
            <div className="relative">
              <Lock className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
                className="w-full pl-10 pr-4 py-3 border border-gray-300 dark:border-gray-600 dark:bg-dark-input dark:text-gray-100 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-colors"
                placeholder="Enter password" />
            </div>
          </div>
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 rounded-lg">
              <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
            </div>
          )}
          <button type="submit" disabled={loading}
            className="w-full bg-gradient-to-r from-blue-600 to-blue-700 text-white py-3 rounded-lg font-semibold hover:from-blue-700 hover:to-blue-800 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
            {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Logging in...</> : 'Login'}
          </button>
        </form>
        <div className="mt-6 text-center">
          <p className="text-xs text-gray-400 dark:text-gray-500">Contact your administrator for access</p>
        </div>
      </div>
    </div>
  );
}
