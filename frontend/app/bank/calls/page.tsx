'use client';

// Bank Call Logs — Finix design migration (Job 2, screen 1).
//
// NO FEATURE LOSS. Everything the old page did is preserved 1:1; only the
// presentation moved to the Finix shell + primitives. Reused VERBATIM from the
// old page: the GET /api/agent/calls fetch (page_size=200 + date range), the
// FAILED/PENDING/COMPLETED status buckets + matchesFilter (which keep this page
// reconciled with the batch dashboard — see backend/agent/batch.py), the 8
// filter tabs + live counts, the interest-cell logic, name/phone search, and
// the loading/empty states. Added per the design: the Form ✆ column + legend.

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { BankUserShell } from '../_shell/BankUserShell';
import {
  Toolbar,
  PeriodChip,
  Breadcrumb,
  PageTitle,
  FilterPills,
  Card,
  CardHeader,
  Table,
  TwoLine,
  CallStatusPill,
  CallLegend,
  FormSentMark,
  LoadingState,
  EmptyState,
  formatDuration,
  type Column,
} from '@/components/finix';
import DateRangeFilter, { DateRangeValue, DEFAULT_RANGE } from '@/components/DateRangeFilter';

interface Call {
  _id: string;
  customer_name: string;
  phone: string;
  status: string;
  call_duration?: number;
  language?: string;
  loan_type?: string;
  loan_amount?: number;
  created_at?: string;
  ended_at?: string;
  interested?: boolean;
  form_sent?: boolean;
}

// ── Status buckets — COPIED VERBATIM from the old page. These MUST match the
// batch dashboard's buckets (backend/agent/batch.py batch_status) so the two
// pages always reconcile. Do not reinterpret.
//   pending   = Pending + Calling + Scheduled + Called - Callback Requested
//   completed = Called + Called - Interested + Called - Not Interested
//   failed    = Failed + Invalid Phone + Call Not Connected
//   not_answered = Not Answered
const FAILED_STATUSES    = ['Failed', 'Invalid Phone', 'Call Not Connected'];
const PENDING_STATUSES   = ['Pending', 'Calling', 'Scheduled', 'Called - Callback Requested'];
const COMPLETED_STATUSES = ['Called', 'Called - Interested', 'Called - Not Interested'];

const matchesFilter = (status: string, key: string) => {
  switch (key) {
    case 'Failed':    return FAILED_STATUSES.includes(status);
    case 'Pending':   return PENDING_STATUSES.includes(status);
    case 'Completed': return COMPLETED_STATUSES.includes(status);
    default:          return status === key;
  }
};

const FILTERS: { key: string; label: string }[] = [
  { key: 'all',                     label: 'All' },
  { key: 'Completed',               label: 'Completed' },
  { key: 'Called - Interested',     label: 'Interested' },
  { key: 'Called - Not Interested', label: 'Not interested' },
  { key: 'Not Answered',            label: 'Not answered' },
  { key: 'Wrong Contact',           label: 'Wrong contact' },
  { key: 'Failed',                  label: 'Failed' },
  { key: 'Pending',                 label: 'Pending' },
];

export default function CallsPage() {
  const router = useRouter();
  const [allCalls, setAllCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateRange, setDateRange] = useState<DateRangeValue>(DEFAULT_RANGE);
  const [token, setToken] = useState('');

  useEffect(() => {
    const t = getAccessToken('bank');
    if (!t) { router.push('/bank/login'); return; }
    setToken(t);
  }, []);

  // Re-fetch whenever the token or the selected date range changes.
  useEffect(() => { if (token) fetchCalls(); }, [token, dateRange.from, dateRange.to]);

  const fetchCalls = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page_size: '200' });
      if (dateRange.from) params.set('date_from', dateRange.from);
      if (dateRange.to) params.set('date_to', dateRange.to);
      const res = await fetch(`${API_URL}/api/agent/calls?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }, credentials: 'include',
      });
      const data = await res.json();
      setAllCalls(data.calls || []);
    } catch { } finally { setLoading(false); }
  };

  const filtered = allCalls.filter(c => {
    const matchesStatus = statusFilter === 'all' || matchesFilter(c.status, statusFilter);
    if (!matchesStatus) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return c.customer_name?.toLowerCase().includes(q) || c.phone?.includes(q);
  });

  const countFor = (key: string) =>
    key === 'all' ? allCalls.length : allCalls.filter(c => matchesFilter(c.status, key)).length;

  const filterOptions = FILTERS.map(f => ({ key: f.key, label: f.label, count: countFor(f.key) }));

  const cols: Column<Call>[] = [
    {
      key: 'customer',
      header: 'Customer',
      render: (c) => <TwoLine primary={c.customer_name || 'Unknown'} secondary={<span className="fx-mono">{c.phone}</span>} />,
    },
    { key: 'status', header: 'Status', render: (c) => <CallStatusPill status={c.status} /> },
    { key: 'form', header: 'Form', align: 'center', width: 60, render: (c) => <FormSentMark sent={!!c.form_sent} /> },
    {
      key: 'duration', header: 'Duration', align: 'right', width: 110,
      render: (c) => <span className="fx-mono">{c.call_duration ? formatDuration(c.call_duration) : '—'}</span>,
    },
    { key: 'language', header: 'Language', render: (c) => <span className="text-fx-text2">{c.language || '—'}</span> },
    {
      key: 'interest', header: 'Interest',
      render: (c) => {
        // Interest-cell logic — preserved exactly from the old page.
        if (['Calling', 'Pending'].includes(c.status)) return <span className="text-fx-text3">—</span>;
        if (c.interested === true) return <span style={{ color: 'var(--fx-green)' }}>Interested</span>;
        if (c.interested === false) return <span className="text-fx-text2">Not interested</span>;
        return <span className="text-fx-text3">—</span>;
      },
    },
    { key: 'date', header: 'Date', align: 'right', render: (c) => <span className="fx-mono text-fx-text2">{c.created_at || '—'}</span> },
  ];

  return (
    <BankUserShell>
      <Toolbar
        left={<><PeriodChip>{dateRange.from && dateRange.to ? `${dateRange.from} – ${dateRange.to}` : 'All dates'}</PeriodChip><Breadcrumb>call logs</Breadcrumb></>}
      />
      <PageTitle title="Call logs" subtitle={`${filtered.length} of ${allCalls.length} calls`} />

      {/* Search + date range */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or phone…"
          className="w-full rounded-[10px] bg-fx-surface2 px-3 py-2 text-[13px] text-fx-text outline-none placeholder:text-fx-text3 focus:shadow-[inset_0_0_0_1px_var(--fx-accent)] sm:max-w-xs"
        />
        <DateRangeFilter value={dateRange} onChange={setDateRange} finix />
      </div>

      <Card>
        <CardHeader
          title="Calls"
          qualifier={`${filtered.length} shown`}
          right={<FilterPills options={filterOptions} value={statusFilter} onChange={setStatusFilter} />}
        />
        {loading ? (
          <LoadingState label="Loading calls…" rows={8} />
        ) : filtered.length === 0 ? (
          <EmptyState title="No calls found" description="No calls match the current filters and date range." />
        ) : (
          <>
            <Table columns={cols} rows={filtered} rowKey={(c) => c._id} />
            <CallLegend />
          </>
        )}
      </Card>
    </BankUserShell>
  );
}
