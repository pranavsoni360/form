'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileText, CheckCircle2, XCircle, Clock,
  ChevronRight, ClipboardCheck, Filter,
  RefreshCw,
} from 'lucide-react';

import { getBankApplications } from '@/lib/api/bank';
import { getAccessToken, getCurrentUser } from '@/lib/auth';
import { formatCurrency, formatDate } from '@/lib/utils/formatters';
import { getStatusLabel } from '@/lib/utils/statusConfig';

import DataCard          from '@/components/ui/DataCard';
import StatusChip        from '@/components/ui/StatusChip';
import EmptyState        from '@/components/ui/EmptyState';
import { SkeletonTable } from '@/components/ui/skeleton';

interface Application {
  id:                        string;
  customer_name:             string;
  phone:                     string;
  loan_id:                   string;
  loan_amount?:              number;
  loan_type?:                string;
  status:                    string;
  submitted_at?:             string;
  created_at?:               string;
  system_suggestion?:        string;
  system_suggestion_reason?: string;
  system_score?:             number;
  pan_verified?:             boolean;
  aadhaar_verified?:         boolean;
}

const OFFICER_FILTERS    = ['all', 'submitted', 'system_reviewed', 'officer_approved', 'officer_rejected'];
const SUPERVISOR_FILTERS = ['all', 'officer_approved', 'documents_submitted', 'approved', 'supervisor_rejected'];

export default function BankDashboardPage() {
  const router = useRouter();

  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [filter, setFilter]             = useState('all');
  const [user, setUser]                 = useState<any>(null);
  const [token, setToken]               = useState('');
  const [lastUpdated, setLastUpdated]   = useState<Date | null>(null);
  const intervalRef                     = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const t = getAccessToken('bank');
    const u = getCurrentUser('bank');
    if (!t || !u) { router.replace('/bank/login'); return; }
    setToken(t);
    setUser(u);
  }, []);

  const fetchApplications = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const statusFilter = filter === 'all' ? undefined : filter;
      const data = await getBankApplications(token, statusFilter);
      setApplications(data.applications || []);
      setLastUpdated(new Date());
    } catch (err: any) {
      if (err.message?.includes('401')) router.replace('/bank/login');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, filter]);

  useEffect(() => {
    if (token) fetchApplications(false);
  }, [token, filter]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!token) return;
    intervalRef.current = setInterval(() => fetchApplications(true), 30000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [token, fetchApplications]);

  const isSupervisor = user?.role === 'bank_supervisor';
  const accent       = isSupervisor ? '#7C3AED' : '#2563EB';
  const filters      = isSupervisor ? SUPERVISOR_FILTERS : OFFICER_FILTERS;

  const stats = {
    total:    applications.length,
    pending:  applications.filter(a => ['submitted', 'system_reviewed'].includes(a.status)).length,
    approved: applications.filter(a => ['officer_approved', 'approved'].includes(a.status)).length,
    rejected: applications.filter(a => a.status.includes('rejected')).length,
  };

  const lastUpdatedLabel = lastUpdated
    ? `${lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
    : null;

  return (
    <div className="space-y-6 animate-fade-in">

      {/* Page heading */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold"
            style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
            {user?.bank_name || 'Bank'} Dashboard
          </h2>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {isSupervisor ? 'Supervisor view' : 'Officer view'} · {applications.length} applications
            </p>
            {lastUpdatedLabel && (
              <>
                <span style={{ color: 'var(--border-strong)' }}>·</span>
                <span className="text-xs flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                  {refreshing
                    ? <RefreshCw className="w-3 h-3 animate-spin" />
                    : <RefreshCw className="w-3 h-3" />}
                  {refreshing ? 'Refreshing...' : `Updated ${lastUpdatedLabel}`}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="px-3 py-1.5 rounded-xl text-xs font-semibold"
            style={{ background: `${accent}12`, color: accent, border: `1px solid ${accent}25` }}>
            {isSupervisor ? 'Supervisor' : 'Officer'}
          </div>
          <button
            onClick={() => fetchApplications(false)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--border)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-subtle)'}>
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <DataCard title="Total applications" value={stats.total}
          icon={<FileText className="w-5 h-5" />} accent="blue" />
        <DataCard title="Pending review" value={stats.pending}
          icon={<Clock className="w-5 h-5" />} accent="orange" />
        <DataCard title="Approved" value={stats.approved}
          icon={<CheckCircle2 className="w-5 h-5" />} accent="green" />
        <DataCard title="Rejected" value={stats.rejected}
          icon={<XCircle className="w-5 h-5" />} accent="red" />
      </div>

      {/* Table card */}
      <div className="rounded-2xl overflow-hidden"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>

        {/* Filters */}
        <div className="px-5 py-4 flex items-center gap-2 overflow-x-auto"
          style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
          <Filter className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
          {filters.map(status => (
            <button
              key={status}
              onClick={() => setFilter(status)}
              className="px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all flex-shrink-0"
              style={filter === status
                ? { background: accent, color: '#fff' }
                : { background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              {status === 'all' ? 'All' : getStatusLabel(status)}
            </button>
          ))}
        </div>

        {/* Table */}
        {loading ? (
          <SkeletonTable rows={6} />
        ) : applications.length === 0 ? (
          <EmptyState
            title="No applications found"
            description="No applications match the selected filter."
            icon={<FileText className="w-10 h-10" />}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Customer', 'Loan ID', 'Amount', 'Status', 'AI', 'KYC', 'Date', ''].map(h => (
                    <th key={h} className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {applications.map((row, i) => (
                  <tr
                    key={row.id}
                    onClick={() => router.push(`/bank/applications/${row.id}`)}
                    className="cursor-pointer transition-colors"
                    style={{ borderBottom: i < applications.length - 1 ? '1px solid var(--border)' : 'none' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>

                    {/* Customer */}
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                          style={{ background: `${accent}12`, color: accent }}>
                          {row.customer_name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        <div>
                          <p className="text-sm font-semibold"
                            style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                            {row.customer_name}
                          </p>
                          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{row.phone}</p>
                        </div>
                      </div>
                    </td>

                    {/* Loan ID */}
                    <td className="px-5 py-4">
                      <span className="text-xs font-medium px-2 py-1 rounded-lg"
                        style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono' }}>
                        {row.loan_id}
                      </span>
                    </td>

                    {/* Amount */}
                    <td className="px-5 py-4">
                      <span className="text-sm font-semibold"
                        style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                        {row.loan_amount ? formatCurrency(row.loan_amount) : '—'}
                      </span>
                    </td>

                    {/* Status */}
                    <td className="px-5 py-4">
                      <StatusChip status={row.status} size="sm" />
                    </td>

                    {/* AI */}
                    <td className="px-5 py-4">
                      {row.system_suggestion ? (
                        <div className="flex items-center gap-1.5">
                          <ClipboardCheck className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#7C3AED' }} />
                          <StatusChip status={row.system_suggestion} type="suggestion" size="sm" />
                        </div>
                      ) : <span className="text-xs" style={{ color: 'var(--text-muted)' }}>—</span>}
                    </td>

                    {/* KYC */}
                    <td className="px-5 py-4">
                      <div className="flex gap-1 items-center">
                        {row.pan_verified && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(5,150,105,0.1)', color: '#059669' }}>PAN</span>
                        )}
                        {row.aadhaar_verified && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(5,150,105,0.1)', color: '#059669' }}>ADH</span>
                        )}
                        {!row.pan_verified && !row.aadhaar_verified && (
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </div>
                    </td>

                    {/* Date */}
                    <td className="px-5 py-4">
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {formatDate(row.submitted_at || row.created_at || '')}
                      </span>
                    </td>

                    {/* Arrow */}
                    <td className="px-5 py-4">
                      <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
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
