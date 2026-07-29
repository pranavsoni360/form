'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getBankApplications, STATUS_LABELS, STATUS_COLORS, SUGGESTION_COLORS, formatCurrency, formatDate } from '@/lib/api';
import { LogOut, FileText, CheckCircle2, XCircle, Clock, ChevronRight, ClipboardCheck, Building2, Filter, Phone, Upload, AlertTriangle, Search, PenLine, SlidersHorizontal } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import { getAccessToken, getCurrentUser, logout as authLogout } from '@/lib/auth';

interface Application {
  id: string;
  customer_name: string;
  phone: string;
  loan_id: string;
  loan_amount_requested?: number;
  consumer_loan_type?: string;
  status: string;
  submitted_at?: string;
  created_at?: string;
  system_suggestion?: string;
  system_suggestion_reason?: string;
  system_score?: number;
  pan_verified?: boolean;
  aadhaar_verified?: boolean;
  interested?: boolean | null;
  form_status?: string | null;
}

const OFFICER_FILTERS    = ['all', 'draft', 'submitted', 'system_reviewed', 'officer_approved', 'officer_rejected'];
const SUPERVISOR_FILTERS = ['all', 'draft', 'officer_approved', 'documents_submitted', 'approved', 'supervisor_rejected'];

export default function BankDashboardPage() {
  const router = useRouter();
  const [applications, setApplications] = useState<Application[]>([]);
  const [allApplications, setAllApplications] = useState<Application[]>([]);
  const [loading, setLoading]     = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [filter, setFilter]       = useState('all');
  const [search, setSearch]       = useState('');
  const [user, setUser]           = useState<any>(null);
  const [token, setToken]         = useState('');

  useEffect(() => {
    const t = getAccessToken('bank');
    const u = getCurrentUser('bank');
    if (!t || !u) { router.push('/bank/login'); return; }
    setToken(t); setUser(u);
  }, []);

  // Always fetch ALL apps for stat cards (independent of filter)
  useEffect(() => {
    if (!token) return;
    getBankApplications(token, undefined)
      .then(d => setAllApplications(d.applications || []))
      .catch(() => {});
  }, [token]);

  // Fetch filtered apps for the table
  useEffect(() => { if (token) fetchApplications(); }, [token, filter]);

  const fetchApplications = async () => {
    setLoading(true); setFetchError('');
    try {
      const data = await getBankApplications(token, filter === 'all' ? undefined : filter);
      setApplications(data.applications || []);
      // Keep allApplications in sync when viewing all
      if (filter === 'all') setAllApplications(data.applications || []);
    } catch (error: any) {
      const msg = error.message || '';
      if (msg.includes('401') || msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('token')) {
        authLogout('bank'); router.push('/bank/login');
      } else { setFetchError(msg || 'Failed to load applications'); }
    } finally { setLoading(false); }
  };

  const handleLogout = () => { authLogout('bank'); router.push('/bank/login'); };

  const filters = user?.role === 'bank_supervisor' ? SUPERVISOR_FILTERS : OFFICER_FILTERS;

  const visibleApps = search.trim()
    ? applications.filter(a => {
        const q = search.trim().toLowerCase();
        return (a.customer_name || '').toLowerCase().includes(q) || (a.phone || '').includes(q) || (a.loan_id || '').toLowerCase().includes(q);
      })
    : applications;

  // Stats always computed from ALL applications so counts stay accurate regardless of active filter
  const stats = {
    total:    allApplications.length,
    draft:    allApplications.filter(a => a.status === 'draft').length,
    pending:  allApplications.filter(a => ['submitted', 'system_reviewed'].includes(a.status)).length,
    approved: allApplications.filter(a => ['officer_approved', 'approved'].includes(a.status)).length,
    rejected: allApplications.filter(a => a.status.includes('rejected')).length,
  };

  const statItems = [
    { label: 'Total',    value: stats.total,    icon: FileText,     accent: 'border-l-blue-500 bg-blue-50 dark:bg-blue-950/30',     onClick: () => setFilter('all') },
    { label: 'Draft',    value: stats.draft,    icon: PenLine,      accent: 'border-l-gray-400 bg-gray-50 dark:bg-gray-900/40',     onClick: () => setFilter('draft') },
    { label: 'Pending',  value: stats.pending,  icon: Clock,        accent: 'border-l-amber-500 bg-amber-50 dark:bg-amber-950/30',   onClick: () => setFilter('submitted') },
    { label: 'Approved', value: stats.approved, icon: CheckCircle2, accent: 'border-l-emerald-500 bg-emerald-50 dark:bg-emerald-950/30', onClick: () => setFilter('officer_approved') },
    { label: 'Rejected', value: stats.rejected, icon: XCircle,      accent: 'border-l-red-500 bg-red-50 dark:bg-red-950/30',        onClick: () => setFilter('officer_rejected') },
  ];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 relative">

      {/* Ambient background glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden -z-10">
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[90rem] h-[36rem] rounded-full bg-blue-400/[0.04] dark:bg-blue-400/[0.06] blur-3xl" />
      </div>

      {/* Header */}
      <div className="sticky top-0 z-30 bg-white/90 dark:bg-slate-950/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-blue-600 shadow-sm shadow-blue-600/30">
                <Building2 className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
                  {user?.bank_name || 'Bank'} Portal
                </h1>
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  {user?.full_name || user?.name} · {user?.role === 'bank_supervisor' ? 'Supervisor' : 'Officer'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {[
                { label: 'Calls',      icon: <Phone className="w-4 h-4" />,            path: '/bank/calls' },
                { label: 'Batch',      icon: <Upload className="w-4 h-4" />,           path: '/bank/batch' },
                { label: 'Scorecard',  icon: <SlidersHorizontal className="w-4 h-4" />, path: '/bank/scorecard' },
              ].map(({ label, icon, path }) => (
                <button key={label} onClick={() => router.push(path)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition">
                  {icon} <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
              <ThemeToggle />
              <button onClick={handleLogout}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition">
                <LogOut className="w-4 h-4" /> <span className="hidden sm:inline">Logout</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8 space-y-5">

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          {statItems.map(({ label, value, icon: Icon, accent, onClick }) => (
            <button key={label} onClick={onClick}
              className={`rounded-xl p-4 border-l-4 border border-slate-200 dark:border-slate-800 shadow-sm text-left transition hover:shadow-md hover:scale-[1.02] ${accent}`}>
              <div className="flex items-center gap-2 mb-2">
                <Icon className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</span>
              </div>
              <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{value}</p>
            </button>
          ))}
        </div>

        {/* Search + Filters */}
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input type="search" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search name, phone, loan ID…"
                className="w-full pl-9 pr-3 py-1.5 rounded-lg text-sm border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition" />
            </div>
            <div className="flex items-center gap-2 overflow-x-auto">
              <Filter className="w-4 h-4 text-slate-400 flex-shrink-0" />
              {filters.map(status => (
                <button key={status} onClick={() => setFilter(status)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                    filter === status
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}>
                  {STATUS_LABELS[status] || 'All'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* View all link */}
        <div className="flex justify-end -mt-3">
          <button onClick={() => router.push('/bank/applications')}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline transition">
            View all applications →
          </button>
        </div>

        {/* Table */}
        {loading ? (
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-12 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 dark:border-slate-700 border-t-blue-600 mx-auto mb-3" />
            <p className="text-sm text-slate-400">Loading applications…</p>
          </div>
        ) : fetchError ? (
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-12 text-center">
            <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-2" />
            <p className="text-sm font-medium text-red-600 dark:text-red-400 mb-1">Failed to load applications</p>
            <p className="text-xs text-slate-400 mb-4">{fetchError}</p>
            <button onClick={fetchApplications}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-b from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 shadow-sm transition">
              Retry
            </button>
          </div>
        ) : visibleApps.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-12 text-center">
            <FileText className="w-10 h-10 text-slate-200 dark:text-slate-700 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No applications found</p>
          </div>
        ) : (
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
                <tr>
                  {['Customer','Loan ID','Type','Requested','Status','Interested','Form','Suggestion','KYC','Date',''].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {visibleApps.map(app => (
                  <tr key={app.id} onClick={() => router.push(`/bank/applications/${app.id}`)}
                    className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 transition">
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{app.customer_name}</div>
                      <div className="text-xs text-slate-400 dark:text-slate-500">{app.phone}</div>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">{app.loan_id}</td>
                    <td className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
                      {app.consumer_loan_type === 'consumer_durable' ? 'Consumer Durable' : app.consumer_loan_type === 'personal' ? 'Personal' : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-slate-900 dark:text-slate-100">
                      {app.loan_amount_requested ? formatCurrency(app.loan_amount_requested) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_COLORS[app.status] || 'bg-slate-100 text-slate-600'}`}>
                        {STATUS_LABELS[app.status] || app.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {app.interested === true
                        ? <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Yes</span>
                        : app.interested === false
                        ? <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">No</span>
                        : <span className="text-xs text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {app.form_status === 'completed'
                        ? <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Submitted</span>
                        : app.form_status === 'in_progress'
                        ? <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">In Progress</span>
                        : app.form_status === 'pending'
                        ? <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">Pending</span>
                        : <span className="text-xs text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {app.system_suggestion ? (
                        <div className="flex items-center gap-1">
                          <ClipboardCheck className="w-3.5 h-3.5 text-slate-400" />
                          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${SUGGESTION_COLORS[app.system_suggestion] || ''}`}>
                            {app.system_suggestion.charAt(0).toUpperCase() + app.system_suggestion.slice(1)}
                          </span>
                        </div>
                      ) : <span className="text-xs text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {app.pan_verified     && <span title="PAN Verified"><CheckCircle2    className="w-3.5 h-3.5 text-emerald-500" /></span>}
                        {app.aadhaar_verified && <span title="Aadhaar Verified"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /></span>}
                        {!app.pan_verified && !app.aadhaar_verified && <span className="text-xs text-slate-400">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400 dark:text-slate-500">
                      {formatDate(app.submitted_at || app.created_at || '')}
                    </td>
                    <td className="px-4 py-3">
                      <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600" />
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
