'use client';

// Bank officer/supervisor dashboard — Finix design migration (Job 2).
//
// NO FEATURE LOSS. Preserved 1:1 from the legacy page:
//  - Auth gate: token+user from localStorage, redirect to /bank/login if absent.
//  - TWO fetches: allApplications (period only, drives the stat cards) and the
//    filtered set (drives the table). Stats must stay accurate regardless of the
//    active status filter, so they are never computed from the filtered rows.
//  - The 401/expired-token branch logs out and redirects; other errors surface
//    an inline error state with Retry.
//  - Role-dependent filter list (OFFICER_FILTERS vs SUPERVISOR_FILTERS).
//  - Client-side search over name / phone / loan ID.
//  - Date range filter scoping BOTH the stat cards and the table.
//  - 5 stat cards, each clickable and each setting the same filter as before.
//  - All 11 table columns: customer(+phone), loan ID, type, requested, status,
//    interested, form, suggestion, KYC, date, row chevron -> detail route.
//  - "View all applications" link to /bank/applications.
//  - Header destinations (Calls / Batch / Scorecard) + logout + theme toggle are
//    now provided by BankUserShell's sidebar and ThemePill.

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getBankApplications, formatCurrency, formatDate } from '@/lib/api';
import { STATUS_LABELS } from '@/lib/utils/statusConfig';
import DateRangeFilter, { DateRangeValue, DEFAULT_RANGE } from '@/components/DateRangeFilter';
import { getAccessToken, getCurrentUser, logout as authLogout } from '@/lib/auth';
import { BankUserShell } from '../_shell/BankUserShell';
import {
  Toolbar,
  PeriodChip,
  Breadcrumb,
  PageTitle,
  FilterPills,
  Button,
  Card,
  CardHeader,
  MetricCard,
  Table,
  TwoLine,
  AppStatusPill,
  SuggestionPill,
  InterestPill,
  FormStatusPill,
  KycMarks,
  LoadingState,
  EmptyState,
  ErrorState,
  type Column,
} from '@/components/finix';

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

const loanTypeLabel = (t?: string) =>
  t === 'consumer_durable' ? 'Consumer durable' : t === 'personal' ? 'Personal' : '—';

export default function BankDashboardPage() {
  const router = useRouter();
  const [applications, setApplications] = useState<Application[]>([]);
  const [allApplications, setAllApplications] = useState<Application[]>([]);
  const [loading, setLoading]     = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [filter, setFilter]       = useState('all');
  const [search, setSearch]       = useState('');
  const [dateRange, setDateRange] = useState<DateRangeValue>(DEFAULT_RANGE);
  const [user, setUser]           = useState<any>(null);
  const [token, setToken]         = useState('');

  useEffect(() => {
    const t = getAccessToken('bank');
    const u = getCurrentUser('bank');
    if (!t || !u) { router.push('/bank/login'); return; }
    setToken(t); setUser(u);
  }, []);

  // Always fetch ALL apps (for the selected period) for stat cards, independent
  // of the status filter.
  useEffect(() => {
    if (!token) return;
    getBankApplications(token, undefined, dateRange.from || undefined, dateRange.to || undefined)
      .then(d => setAllApplications(d.applications || []))
      .catch(() => {});
  }, [token, dateRange.from, dateRange.to]);

  // Fetch filtered apps for the table
  useEffect(() => { if (token) fetchApplications(); }, [token, filter, dateRange.from, dateRange.to]);

  const fetchApplications = async () => {
    setLoading(true); setFetchError('');
    try {
      const data = await getBankApplications(
        token,
        filter === 'all' ? undefined : filter,
        dateRange.from || undefined,
        dateRange.to || undefined,
      );
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

  // Each card sets the same filter it did in the legacy header row; `match`
  // marks which card is the active filter so the selection is visible.
  const statItems = [
    { label: 'Total',    value: stats.total,    filter: 'all' },
    { label: 'Draft',    value: stats.draft,    filter: 'draft' },
    { label: 'Pending',  value: stats.pending,  filter: 'submitted' },
    { label: 'Approved', value: stats.approved, filter: 'officer_approved' },
    { label: 'Rejected', value: stats.rejected, filter: 'officer_rejected' },
  ];

  const cols: Column<Application>[] = [
    {
      key: 'customer', header: 'Customer',
      render: (a) => <TwoLine primary={a.customer_name} secondary={<span className="fx-mono">{a.phone}</span>} />,
    },
    { key: 'loan_id', header: 'Loan ID', render: (a) => <span className="fx-mono text-fx-text2">{a.loan_id}</span> },
    { key: 'type', header: 'Type', render: (a) => <span className="text-fx-text2">{loanTypeLabel(a.consumer_loan_type)}</span> },
    {
      key: 'requested', header: 'Requested', align: 'right',
      render: (a) => (a.loan_amount_requested ? formatCurrency(a.loan_amount_requested) : '—'),
    },
    { key: 'status', header: 'Status', render: (a) => <AppStatusPill status={a.status} /> },
    { key: 'interested', header: 'Interested', render: (a) => <InterestPill interested={a.interested} /> },
    { key: 'form', header: 'Form', render: (a) => <FormStatusPill status={a.form_status} /> },
    { key: 'suggestion', header: 'Suggestion', render: (a) => <SuggestionPill suggestion={a.system_suggestion} /> },
    {
      key: 'kyc', header: 'KYC',
      render: (a) => <KycMarks panVerified={a.pan_verified} aadhaarVerified={a.aadhaar_verified} />,
    },
    {
      key: 'date', header: 'Date', align: 'right',
      render: (a) => <span className="text-fx-text2">{formatDate(a.submitted_at || a.created_at || '')}</span>,
    },
    {
      key: 'chevron', header: '', align: 'right', width: 40,
      render: () => <span className="fx-mono text-fx-text3">›</span>,
    },
  ];

  const periodLabel = dateRange.from && dateRange.to ? `${dateRange.from} – ${dateRange.to}` : 'All dates';

  return (
    <BankUserShell>
      <Toolbar
        left={<><PeriodChip>{periodLabel}</PeriodChip><Breadcrumb>my queue</Breadcrumb></>}
        right={
          <Button variant="quiet" onClick={() => router.push('/bank/applications')}>
            View all applications →
          </Button>
        }
      />
      <PageTitle
        title="My queue"
        subtitle={`${user?.bank_name || 'Bank'} · ${user?.full_name || user?.name || ''}`}
      />

      {/* Stat cards — clickable status filters, computed from ALL apps in period */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {statItems.map((s) => (
          <MetricCard
            key={s.label}
            label={s.label}
            value={s.value}
            onClick={() => setFilter(s.filter)}
            active={filter === s.filter}
          />
        ))}
      </div>

      {/* Date range — scopes the stat cards AND the applications table */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, phone, loan ID…"
          className="w-full rounded-[10px] bg-fx-surface2 px-3 py-2 text-[13px] text-fx-text outline-none placeholder:text-fx-text3 focus:shadow-[inset_0_0_0_1px_var(--fx-accent)] sm:max-w-xs"
        />
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
      </div>

      <Card>
        <CardHeader
          title="Applications"
          qualifier={`${visibleApps.length} shown`}
          right={
            <FilterPills
              options={filters.map((f) => ({ key: f, label: STATUS_LABELS[f] || 'All' }))}
              value={filter}
              onChange={setFilter}
            />
          }
        />
        {loading ? (
          <LoadingState label="Loading applications…" rows={8} />
        ) : fetchError ? (
          <ErrorState
            title="Failed to load applications"
            detail={fetchError}
            onRetry={fetchApplications}
          />
        ) : visibleApps.length === 0 ? (
          <EmptyState
            title="No applications found"
            description="No applications match the current filter, search and date range."
          />
        ) : (
          <Table
            columns={cols}
            rows={visibleApps}
            rowKey={(a) => a.id}
            onRowClick={(a) => router.push(`/bank/applications/${a.id}`)}
          />
        )}
      </Card>
    </BankUserShell>
  );
}
