'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileText, ChevronRight, Filter, Search,
  RefreshCw, CheckCircle2, Download,
} from 'lucide-react';

import { getBankApplications } from '@/lib/api/bank';
import { getAccessToken, getCurrentUser } from '@/lib/auth';
import { formatCurrency, formatDate } from '@/lib/utils/formatters';
import { getStatusLabel } from '@/lib/utils/statusConfig';

import StatusChip        from '@/components/ui/StatusChip';
import EmptyState        from '@/components/ui/EmptyState';
import { SkeletonTable } from '@/components/ui/skeleton';

interface Application {
  id:                 string;
  customer_name:      string;
  phone:              string;
  loan_id:            string;
  loan_amount?:       number;
  loan_type?:         string;
  status:             string;
  submitted_at?:      string;
  created_at?:        string;
  system_suggestion?: string;
  system_score?:      number;
  pan_verified?:      boolean;
  aadhaar_verified?:  boolean;
}

const OFFICER_FILTERS    = ['all', 'submitted', 'system_reviewed', 'officer_approved', 'officer_rejected'];
const SUPERVISOR_FILTERS = ['all', 'officer_approved', 'documents_submitted', 'approved', 'supervisor_rejected'];

const ROLE_ACCENT: Record<string, string> = {
  bank_supervisor: '#7C3AED',
  bank_officer:    '#2563EB',
};

export default function BankApplicationsPage() {
  const router = useRouter();

  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [filter, setFilter]             = useState('all');
  const [search, setSearch]             = useState('');
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

  // Fetch on filter change
  useEffect(() => {
    if (token) fetchApplications(false);
  }, [token, filter]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!token) return;
    intervalRef.current = setInterval(() => fetchApplications(true), 30000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [token, fetchApplications]);

  // Export CSV
  const exportCSV = () => {
    const rows = filtered.map(a => [
      a.customer_name, a.phone, a.loan_id,
      a.loan_amount || '', a.status,
      a.system_suggestion || '',
      a.pan_verified ? 'Yes' : 'No',
      a.aadhaar_verified ? 'Yes' : 'No',
      a.submitted_at || a.created_at || '',
    ]);
    const header = ['Name', 'Phone', 'Loan ID', 'Amount', 'Status', 'AI Suggestion', 'PAN', 'Aadhaar', 'Date'];
    const csv = [header, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `applications-${filter}-${Date.now()}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const isSupervisor = user?.role === 'bank_supervisor';
  const filters      = isSupervisor ? SUPERVISOR_FILTERS : OFFICER_FILTERS;
  const accent       = ROLE_ACCENT[user?.role] || '#2563EB';

  const filtered = applications.filter(a => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      a.customer_name?.toLowerCase().includes(q) ||
      a.phone?.includes(q) ||
      a.loan_id?.toLowerCase().includes(q)
    );
  });

  const lastUpdatedLabel = lastUpdated
    ? `Updated ${lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
    : null;

  return (
    <div className="space-y-6 animate-fade-in">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold"
            style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
            Applications
          </h2>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {isSupervisor ? 'Supervisor view' : 'Officer view'} · {filtered.length} applications
            </p>
            {lastUpdatedLabel && (
              <>
                <span style={{ color: 'var(--border-strong)' }}>·</span>
                <span className="text-xs flex items-center gap-1"
                  style={{ color: 'var(--text-muted)' }}>
                  {refreshing
                    ? <RefreshCw className="w-3 h-3 animate-spin" />
                    : <RefreshCw className="w-3 h-3" />}
                  {lastUpdatedLabel}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="px-3 py-1.5 rounded-xl text-xs font-semibold"
            style={{
              background: `${accent}12`,
              color: accent,
              border: `1px solid ${accent}25`,
            }}>
            {isSupervisor ? 'Supervisor' : 'Officer'}
          </div>
          <button
            onClick={exportCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--border)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-subtle)'}>
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
          <button
            onClick={() => fetchApplications(false)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--border)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-subtle)'}>
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {/* Search + Filters */}
      <div className="rounded-2xl p-4 space-y-3"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
            style={{ color: 'var(--text-muted)' }} />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, phone, or loan ID..."
            className="w-full pl-9 pr-4 py-2.5 rounded-xl text-sm outline-none transition-all"
            style={{
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
            }}
            onFocus={e => e.target.style.borderColor = '#1A1A2E'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'}
          />
        </div>
        {/* Filter pills */}
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
          <Filter className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
          {filters.map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className="px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all flex-shrink-0"
              style={filter === s
                ? { background: accent, color: '#fff' }
                : { background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
              {s === 'all' ? 'All' : getStatusLabel(s)}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <SkeletonTable rows={8} />
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <EmptyState
            title={search ? 'No results found' : 'No applications found'}
            description={search
              ? `No applications match "${search}". Try a different search.`
              : 'No applications match the selected filter.'}
            icon={<FileText className="w-10 h-10" />}
          />
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>

          {/* Table header */}
          <div className="grid grid-cols-12 px-5 py-3 text-xs font-semibold uppercase tracking-wider"
            style={{
              background: 'var(--bg-subtle)',
              borderBottom: '1px solid var(--border)',
              color: 'var(--text-muted)',
              letterSpacing: '0.07em',
            }}>
            <div className="col-span-4">Customer</div>
            <div className="col-span-2">Loan ID</div>
            <div className="col-span-2">Amount</div>
            <div className="col-span-1">Status</div>
            <div className="col-span-1">AI</div>
            <div className="col-span-1">KYC</div>
            <div className="col-span-1">Date</div>
          </div>

          {/* Rows */}
          {filtered.map((row, i) => (
            <div
              key={row.id}
              onClick={() => router.push(`/bank/applications/${row.id}`)}
              className="grid grid-cols-12 px-5 py-4 cursor-pointer transition-colors items-center"
              style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>

              {/* Customer */}
              <div className="col-span-4 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                  style={{ background: `${accent}12`, color: accent, fontFamily: 'Plus Jakarta Sans' }}>
                  {row.customer_name?.charAt(0)?.toUpperCase() || '?'}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate"
                    style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                    {row.customer_name}
                  </p>
                  <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                    {row.phone}
                  </p>
                </div>
              </div>

              {/* Loan ID */}
              <div className="col-span-2">
                <span className="text-xs font-medium px-2 py-1 rounded-lg"
                  style={{
                    background: 'var(--bg-subtle)',
                    color: 'var(--text-secondary)',
                    fontFamily: 'JetBrains Mono',
                  }}>
                  {row.loan_id}
                </span>
              </div>

              {/* Amount */}
              <div className="col-span-2">
                <span className="text-sm font-semibold"
                  style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                  {row.loan_amount ? formatCurrency(row.loan_amount) : '—'}
                </span>
              </div>

              {/* Status */}
              <div className="col-span-1">
                <StatusChip status={row.status} size="sm" />
              </div>

              {/* AI suggestion */}
              <div className="col-span-1">
                {row.system_suggestion
                  ? <StatusChip status={row.system_suggestion} type="suggestion" size="sm" />
                  : <span className="text-xs" style={{ color: 'var(--text-muted)' }}>—</span>}
              </div>

              {/* KYC */}
              <div className="col-span-1">
                <div className="flex gap-1 flex-wrap">
                  {row.pan_verified && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(5,150,105,0.1)', color: '#059669' }}>
                      PAN
                    </span>
                  )}
                  {row.aadhaar_verified && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(5,150,105,0.1)', color: '#059669' }}>
                      ADH
                    </span>
                  )}
                  {!row.pan_verified && !row.aadhaar_verified && (
                    <CheckCircle2 className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)', opacity: 0.3 }} />
                  )}
                </div>
              </div>

              {/* Date + arrow */}
              <div className="col-span-1 flex items-center justify-between gap-1">
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {formatDate(row.submitted_at || row.created_at || '')}
                </span>
                <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
