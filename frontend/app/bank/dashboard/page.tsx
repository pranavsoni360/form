'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getBankApplications, STATUS_LABELS, STATUS_COLORS, SUGGESTION_COLORS, formatCurrency, formatDate } from '@/lib/api';
import { LogOut, FileText, CheckCircle2, XCircle, Clock, ChevronRight, ClipboardCheck, Building2, Filter, Phone, Upload } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import { getAccessToken, getCurrentUser, logout as authLogout } from '@/lib/auth';

interface Application {
  id: string;
  customer_name: string;
  phone: string;
  loan_id: string;
  loan_amount?: number;
  loan_type?: string;
  status: string;
  submitted_at?: string;
  created_at?: string;
  system_suggestion?: string;
  system_suggestion_reason?: string;
  system_score?: number;
  pan_verified?: boolean;
  aadhaar_verified?: boolean;
}

const OFFICER_FILTERS = ['all', 'submitted', 'system_reviewed', 'officer_approved', 'officer_rejected'];
const SUPERVISOR_FILTERS = ['all', 'officer_approved', 'documents_submitted', 'approved', 'supervisor_rejected'];

export default function BankDashboardPage() {
  const router = useRouter();
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [user, setUser] = useState<any>(null);
  const [token, setToken] = useState('');

  useEffect(() => {
    const t = getAccessToken('bank');
    const u = getCurrentUser('bank');
    if (!t || !u) { router.push('/bank/login'); return; }
    setToken(t);
    setUser(u);
  }, []);

  useEffect(() => {
    if (!token) return;
    fetchApplications();
  }, [token, filter]);

  const fetchApplications = async () => {
    setLoading(true);
    try {
      const statusFilter = filter === 'all' ? undefined : filter;
      const data = await getBankApplications(token, statusFilter);
      setApplications(data.applications || []);
    } catch (error: any) {
      if (error.message?.includes('401') || error.message?.includes('Invalid')) {
        router.push('/bank/login');
      }
    } finally { setLoading(false); }
  };

  const handleLogout = () => {
    authLogout('bank');
    router.push('/bank/login');
  };

  const filters = user?.role === 'bank_supervisor' ? SUPERVISOR_FILTERS : OFFICER_FILTERS;

  const stats = {
    total: applications.length,
    pending: applications.filter(a => ['submitted', 'system_reviewed'].includes(a.status)).length,
    approved: applications.filter(a => ['officer_approved', 'approved'].includes(a.status)).length,
    rejected: applications.filter(a => a.status.includes('rejected')).length,
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">
      {/* Header */}
      <div className="bg-white dark:bg-dark-card shadow dark:shadow-gray-900/50 transition-colors">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex items-center justify-center">
                <Building2 className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                  {user?.bank_name || 'Bank'} Portal
                </h1>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {user?.full_name || user?.name} · {user?.role === 'bank_supervisor' ? 'Supervisor' : 'Officer'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <button onClick={() => router.push('/bank/calls')} className="flex items-center gap-1 px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition">
                <Phone className="w-4 h-4" /> <span className="hidden sm:inline">Calls</span>
              </button>
              <button onClick={() => router.push('/bank/batch')} className="flex items-center gap-1 px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition">
                <Upload className="w-4 h-4" /> <span className="hidden sm:inline">Batch</span>
              </button>
              <ThemeToggle />
              <button onClick={handleLogout} className="flex items-center gap-1 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition">
                <LogOut className="w-4 h-4" /> <span className="hidden sm:inline">Logout</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
        {/* Stats Row */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          {[
            { label: 'Total', value: stats.total, icon: FileText, color: 'text-blue-500' },
            { label: 'Pending', value: stats.pending, icon: Clock, color: 'text-yellow-500' },
            { label: 'Approved', value: stats.approved, icon: CheckCircle2, color: 'text-green-500' },
            { label: 'Rejected', value: stats.rejected, icon: XCircle, color: 'text-red-500' },
          ].map(s => (
            <div key={s.label} className="bg-white dark:bg-dark-card rounded-xl p-4 shadow-sm dark:shadow-gray-900/30">
              <div className="flex items-center gap-2 mb-1">
                <s.icon className={`w-4 h-4 ${s.color}`} />
                <span className="text-xs text-gray-500 dark:text-gray-400">{s.label}</span>
              </div>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{s.value}</p>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm dark:shadow-gray-900/30 p-3 mb-4">
          <div className="flex items-center gap-2 overflow-x-auto">
            <Filter className="w-4 h-4 text-gray-400 flex-shrink-0" />
            {filters.map((status) => (
              <button key={status} onClick={() => setFilter(status)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                  filter === status
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-dark-section text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}>
                {STATUS_LABELS[status] || 'All'}
              </button>
            ))}
          </div>
        </div>

        {/* Applications Table */}
        {loading ? (
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm p-12 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-3" />
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading...</p>
          </div>
        ) : applications.length === 0 ? (
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm p-12 text-center">
            <FileText className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
            <p className="text-sm text-gray-500 dark:text-gray-400">No applications found</p>
          </div>
        ) : (
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm dark:shadow-gray-900/30 overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700/50">
              <thead className="bg-gray-50 dark:bg-dark-section">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Customer</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Loan ID</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Amount</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Suggestion</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">KYC</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Date</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {applications.map((app) => (
                  <tr key={app.id} onClick={() => router.push(`/bank/applications/${app.id}`)}
                    className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition">
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-gray-900 dark:text-white">{app.customer_name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{app.phone}</div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{app.loan_id}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{app.loan_type || '—'}</td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">
                      {app.loan_amount ? formatCurrency(app.loan_amount) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_COLORS[app.status] || ''}`}>
                        {STATUS_LABELS[app.status] || app.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {app.system_suggestion ? (
                        <div className="flex items-center gap-1">
                          <ClipboardCheck className="w-3.5 h-3.5 text-purple-500" />
                          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${SUGGESTION_COLORS[app.system_suggestion] || ''}`}>
                            {app.system_suggestion.charAt(0).toUpperCase() + app.system_suggestion.slice(1)}
                          </span>
                        </div>
                      ) : <span className="text-xs text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {app.pan_verified && <span title="PAN Verified"><CheckCircle2 className="w-3.5 h-3.5 text-green-500" /></span>}
                        {app.aadhaar_verified && <span title="Aadhaar Verified"><CheckCircle2 className="w-3.5 h-3.5 text-green-500" /></span>}
                        {!app.pan_verified && !app.aadhaar_verified && <span className="text-xs text-gray-400">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                      {formatDate(app.submitted_at || app.created_at || '')}
                    </td>
                    <td className="px-4 py-3">
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
