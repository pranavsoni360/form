'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getBankApplications, STATUS_LABELS, STATUS_COLORS, SUGGESTION_COLORS, formatCurrency, formatDate } from '@/lib/api';
import { LogOut, FileText, CheckCircle2, XCircle, Clock, ChevronRight, ClipboardCheck, Building2, Filter, Phone, Upload, AlertTriangle, Search } from 'lucide-react';
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

// palette
const P = {
  bg: '#f8fafc', card: '#ffffff', accent: '#d9eafd',
  border: '#bcccdc', muted: '#9aa6b2', text: '#1e293b', sub: '#475569', hov: '#f0f6ff',
};

const OFFICER_FILTERS = ['all', 'submitted', 'system_reviewed', 'officer_approved', 'officer_rejected'];
const SUPERVISOR_FILTERS = ['all', 'officer_approved', 'documents_submitted', 'approved', 'supervisor_rejected'];

export default function BankDashboardPage() {
  const router = useRouter();
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
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
    setFetchError('');
    try {
      const statusFilter = filter === 'all' ? undefined : filter;
      const data = await getBankApplications(token, statusFilter);
      setApplications(data.applications || []);
    } catch (error: any) {
      const msg = error.message || '';
      if (msg.includes('401') || msg.includes('Invalid') || msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('token')) {
        authLogout('bank');
        router.push('/bank/login');
      } else {
        setFetchError(msg || 'Failed to load applications');
      }
    } finally { setLoading(false); }
  };

  const handleLogout = () => {
    authLogout('bank');
    router.push('/bank/login');
  };

  const filters = user?.role === 'bank_supervisor' ? SUPERVISOR_FILTERS : OFFICER_FILTERS;

  const visibleApps = search.trim()
    ? applications.filter(a => {
        const q = search.trim().toLowerCase();
        return (a.customer_name || '').toLowerCase().includes(q)
          || (a.phone || '').includes(q)
          || (a.loan_id || '').toLowerCase().includes(q);
      })
    : applications;

  const stats = {
    total:    applications.length,
    pending:  applications.filter(a => ['submitted', 'system_reviewed'].includes(a.status)).length,
    approved: applications.filter(a => ['officer_approved', 'approved'].includes(a.status)).length,
    rejected: applications.filter(a => a.status.includes('rejected')).length,
  };

  const statItems = [
    { label: 'Total',    value: stats.total,    icon: FileText,      tint: P.accent },
    { label: 'Pending',  value: stats.pending,  icon: Clock,         tint: '#fffbeb' },
    { label: 'Approved', value: stats.approved, icon: CheckCircle2,  tint: '#ecfdf5' },
    { label: 'Rejected', value: stats.rejected, icon: XCircle,       tint: '#fef2f2' },
  ];

  return (
    <div className="min-h-screen" style={{ background: P.bg }}>

      {/* Header */}
      <div style={{ background: P.card, borderBottom: `1px solid ${P.border}`, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: P.accent, border: `1px solid ${P.border}` }}>
                <Building2 className="w-5 h-5" style={{ color: '#1e3a5f' }} />
              </div>
              <div>
                <h1 className="text-xl font-bold" style={{ color: P.text }}>
                  {user?.bank_name || 'Bank'} Portal
                </h1>
                <p className="text-xs" style={{ color: P.muted }}>
                  {user?.full_name || user?.name} · {user?.role === 'bank_supervisor' ? 'Supervisor' : 'Officer'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {[
                { label: 'Calls', icon: <Phone className="w-4 h-4" />, path: '/bank/calls' },
                { label: 'Batch', icon: <Upload className="w-4 h-4" />, path: '/bank/batch' },
              ].map(({ label, icon, path }) => (
                <button key={label} onClick={() => router.push(path)}
                  className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm transition"
                  style={{ color: P.sub }}
                  onMouseEnter={e => (e.currentTarget.style.background = P.hov)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  {icon} <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
              <ThemeToggle />
              <button onClick={handleLogout}
                className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm transition"
                style={{ color: '#dc2626' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#fef2f2')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <LogOut className="w-4 h-4" /> <span className="hidden sm:inline">Logout</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          {statItems.map(({ label, value, icon: Icon, tint }) => (
            <div key={label} className="rounded-xl p-4" style={{ background: tint, border: `1px solid ${P.border}` }}>
              <div className="flex items-center gap-2 mb-1">
                <Icon className="w-4 h-4" style={{ color: P.sub }} />
                <span className="text-xs font-medium" style={{ color: P.sub }}>{label}</span>
              </div>
              <p className="text-2xl font-bold" style={{ color: P.text }}>{value}</p>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="rounded-xl p-3 mb-4" style={{ background: P.card, border: `1px solid ${P.border}` }}>
          <div className="flex items-center gap-2 overflow-x-auto">
            <Filter className="w-4 h-4 flex-shrink-0" style={{ color: P.muted }} />
            {filters.map(status => (
              <button key={status} onClick={() => setFilter(status)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition"
                style={filter === status
                  ? { background: P.accent, color: '#1e3a5f', border: `1px solid ${P.border}` }
                  : { background: P.bg, color: P.sub, border: `1px solid ${P.border}` }}
                onMouseEnter={e => { if (filter !== status) (e.currentTarget.style.background = P.hov); }}
                onMouseLeave={e => { if (filter !== status) (e.currentTarget.style.background = P.bg); }}>
                {STATUS_LABELS[status] || 'All'}
              </button>
            ))}
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: P.muted }} />
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, phone, or loan ID…"
            className="w-full rounded-lg py-2 pl-10 pr-3 text-sm outline-none"
            style={{ border: `1px solid ${P.border}`, background: P.card, color: P.text }}
          />
        </div>

        {/* View all link */}
        <div className="flex justify-end -mt-2 mb-2">
          <button onClick={() => router.push('/bank/applications')}
            className="text-xs font-medium transition"
            style={{ color: '#1e3a5f' }}
            onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
            onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>
            View all applications →
          </button>
        </div>

        {/* Table */}
        {loading ? (
          <div className="rounded-xl p-12 text-center" style={{ background: P.card, border: `1px solid ${P.border}` }}>
            <div className="animate-spin rounded-full h-8 w-8 mx-auto mb-3"
              style={{ border: `2px solid ${P.border}`, borderTopColor: '#1e3a5f' }} />
            <p className="text-sm" style={{ color: P.muted }}>Loading...</p>
          </div>
        ) : fetchError ? (
          <div className="rounded-xl p-12 text-center" style={{ background: P.card, border: `1px solid ${P.border}` }}>
            <AlertTriangle className="w-10 h-10 mx-auto mb-2" style={{ color: '#f87171' }} />
            <p className="text-sm font-medium mb-1" style={{ color: '#dc2626' }}>Failed to load applications</p>
            <p className="text-xs mb-4" style={{ color: P.muted }}>{fetchError}</p>
            <button onClick={fetchApplications}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white transition"
              style={{ background: '#1e3a5f' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#1e4a7a')}
              onMouseLeave={e => (e.currentTarget.style.background = '#1e3a5f')}>
              Retry
            </button>
          </div>
        ) : visibleApps.length === 0 ? (
          <div className="rounded-xl p-12 text-center" style={{ background: P.card, border: `1px solid ${P.border}` }}>
            <FileText className="w-10 h-10 mx-auto mb-2" style={{ color: P.border }} />
            <p className="text-sm" style={{ color: P.muted }}>
              {search ? `No results for "${search}"` : 'No applications found'}
            </p>
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden" style={{ background: P.card, border: `1px solid ${P.border}` }}>
            <table className="min-w-full">
              <thead>
                <tr style={{ background: P.bg, borderBottom: `1px solid ${P.border}` }}>
                  {['Customer','Loan ID','Type','Amount','Status','Interested','Form','Suggestion','KYC','Date',''].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide"
                      style={{ color: P.muted }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleApps.map((app, i) => (
                  <tr key={app.id} onClick={() => router.push(`/bank/applications/${app.id}`)}
                    className="cursor-pointer transition"
                    style={{ borderBottom: i < visibleApps.length - 1 ? `1px solid ${P.bg}` : 'none' }}
                    onMouseEnter={e => (e.currentTarget.style.background = P.hov)}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium" style={{ color: P.text }}>{app.customer_name}</div>
                      <div className="text-xs" style={{ color: P.muted }}>{app.phone}</div>
                    </td>
                    <td className="px-4 py-3 text-sm" style={{ color: P.sub }}>{app.loan_id}</td>
                    <td className="px-4 py-3 text-sm" style={{ color: P.sub }}>
                      {app.consumer_loan_type === 'consumer_durable' ? 'Consumer Durable' : app.consumer_loan_type === 'personal' ? 'Personal' : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium" style={{ color: P.text }}>
                      {app.loan_amount_requested ? formatCurrency(app.loan_amount_requested) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_COLORS[app.status] || ''}`}>
                        {STATUS_LABELS[app.status] || app.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {app.interested === true
                        ? <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-100 text-emerald-700">Yes</span>
                        : app.interested === false
                        ? <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700">No</span>
                        : <span className="text-xs" style={{ color: P.muted }}>—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {app.form_status === 'completed'
                        ? <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-100 text-emerald-700">Submitted</span>
                        : app.form_status === 'in_progress'
                        ? <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700">In Progress</span>
                        : app.form_status === 'pending'
                        ? <span className="px-2 py-0.5 text-xs font-medium rounded-full" style={{ background: P.accent, color: '#1e3a5f' }}>Pending</span>
                        : <span className="text-xs" style={{ color: P.muted }}>—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {app.system_suggestion ? (
                        <div className="flex items-center gap-1">
                          <ClipboardCheck className="w-3.5 h-3.5" style={{ color: P.muted }} />
                          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${SUGGESTION_COLORS[app.system_suggestion] || ''}`}>
                            {app.system_suggestion.charAt(0).toUpperCase() + app.system_suggestion.slice(1)}
                          </span>
                        </div>
                      ) : <span className="text-xs" style={{ color: P.muted }}>—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {app.pan_verified && <span title="PAN Verified"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /></span>}
                        {app.aadhaar_verified && <span title="Aadhaar Verified"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /></span>}
                        {!app.pan_verified && !app.aadhaar_verified && <span className="text-xs" style={{ color: P.muted }}>—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: P.muted }}>
                      {formatDate(app.submitted_at || app.created_at || '')}
                    </td>
                    <td className="px-4 py-3">
                      <ChevronRight className="w-4 h-4" style={{ color: P.muted }} />
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
