'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getAdminStats, getAdminApplications, seedMockData, getBanks, STATUS_LABELS, STATUS_COLORS, formatCurrency, formatDate } from '@/lib/api';
import { LogOut, Loader2, Building2, Users, FileText, TrendingUp, ChevronRight, Plus, Database, BarChart3 } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import { getAccessToken, getCurrentUser, logout as authLogout } from '@/lib/auth';

export default function AdminDashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<any>(null);
  const [banks, setBanks] = useState<any[]>([]);
  const [recentApps, setRecentApps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [token, setToken] = useState('');

  useEffect(() => {
    const t = getAccessToken('admin');
    if (!t) { router.push('/admin/login'); return; }
    setToken(t);
  }, []);

  useEffect(() => {
    if (token) fetchAll();
  }, [token]);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [statsData, banksData, appsData] = await Promise.all([
        getAdminStats(token),
        getBanks(token),
        getAdminApplications(token),
      ]);
      setStats(statsData);
      setBanks(banksData.banks || []);
      setRecentApps((appsData.applications || []).slice(0, 10));
    } catch (err: any) {
      if (err.message?.includes('401')) router.push('/admin/login');
    } finally { setLoading(false); }
  };

  const handleSeed = async () => {
    if (!confirm('This will create mock banks, users, and applications. Continue?')) return;
    setSeeding(true);
    try {
      await seedMockData(token);
      await fetchAll();
    } catch (err: any) {
      alert(err.message || 'Seeding failed');
    } finally { setSeeding(false); }
  };

  const handleLogout = () => {
    authLogout('admin');
    router.push('/admin/login');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">
      <div className="bg-white dark:bg-dark-card shadow dark:shadow-gray-900/50 transition-colors">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Admin Dashboard</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">Loan Application Management System</p>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={handleSeed} disabled={seeding}
                className="flex items-center gap-1 px-3 py-2 text-sm bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded-lg hover:bg-purple-200 dark:hover:bg-purple-900/50 transition disabled:opacity-50">
                <Database className="w-4 h-4" /> {seeding ? 'Seeding...' : 'Seed Mock Data'}
              </button>
              <ThemeToggle />
              <button onClick={handleLogout} className="flex items-center gap-1 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition">
                <LogOut className="w-4 h-4" /> Logout
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {[
              { label: 'Total Applications', value: stats.total_applications || 0, icon: FileText, color: 'text-blue-500' },
              { label: 'Banks', value: stats.total_banks || 0, icon: Building2, color: 'text-indigo-500' },
              { label: 'Bank Users', value: stats.total_bank_users || 0, icon: Users, color: 'text-purple-500' },
              { label: 'Approval Rate', value: stats.approval_rate ? `${stats.approval_rate}%` : '--', icon: TrendingUp, color: 'text-green-500' },
              { label: 'Pending Review', value: stats.per_status?.submitted || 0, icon: BarChart3, color: 'text-yellow-500' },
            ].map(s => (
              <div key={s.label} className="bg-white dark:bg-dark-card rounded-xl p-4 shadow-sm dark:shadow-gray-900/30 transition-colors">
                <s.icon className={`w-5 h-5 ${s.color} mb-2`} />
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{s.value}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{s.label}</p>
              </div>
            ))}
          </div>
        )}

        <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm dark:shadow-gray-900/30 transition-colors">
          <div className="flex items-center justify-between p-5 border-b border-gray-100 dark:border-gray-700/50">
            <div className="flex items-center gap-2">
              <Building2 className="w-5 h-5 text-blue-600" />
              <h2 className="font-semibold text-gray-900 dark:text-white">Banks</h2>
              <span className="px-2 py-0.5 text-xs bg-gray-100 dark:bg-dark-section text-gray-600 dark:text-gray-400 rounded-full">{banks.length}</span>
            </div>
            <button onClick={() => router.push('/admin/banks')}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
              <Plus className="w-4 h-4" /> Manage Banks
            </button>
          </div>
          {banks.length > 0 ? (
            <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {banks.map((bank: any) => (
                <div key={bank.id} onClick={() => router.push(`/admin/banks/${bank.id}`)}
                  className="flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{bank.name}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{bank.code} · {bank.contact_email || 'No email'}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 text-xs rounded-full ${bank.status === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'}`}>
                      {bank.status}
                    </span>
                    <ChevronRight className="w-4 h-4 text-gray-400" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center">
              <Building2 className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
              <p className="text-sm text-gray-500 dark:text-gray-400">No banks yet. Seed mock data or create one.</p>
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm dark:shadow-gray-900/30 transition-colors">
          <div className="flex items-center justify-between p-5 border-b border-gray-100 dark:border-gray-700/50">
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-blue-600" />
              <h2 className="font-semibold text-gray-900 dark:text-white">Recent Applications</h2>
            </div>
          </div>
          {recentApps.length > 0 ? (
            <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {recentApps.map((app: any) => (
                <div key={app.id} onClick={() => router.push(`/admin/applications/${app.id}`)}
                  className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{app.customer_name}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{app.loan_id} · {app.loan_type} · {formatDate(app.created_at)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {app.loan_amount && <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{formatCurrency(app.loan_amount)}</span>}
                    <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_COLORS[app.status] || ''}`}>
                      {STATUS_LABELS[app.status] || app.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center">
              <FileText className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
              <p className="text-sm text-gray-500 dark:text-gray-400">No applications yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
