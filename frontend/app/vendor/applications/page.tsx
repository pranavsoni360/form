'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, ChevronRight, Filter } from 'lucide-react';

import { getVendorApplications } from '@/lib/api/vendor';
import { getAccessToken } from '@/lib/auth';
import { formatCurrency, formatDate } from '@/lib/utils/formatters';
import { getStatusLabel } from '@/lib/utils/statusConfig';

import StatusChip        from '@/components/ui/StatusChip';
import EmptyState        from '@/components/ui/EmptyState';
import { SkeletonTable } from '@/components/ui/skeleton';

const FILTERS = ['all', 'approved', 'disbursed', 'rejected'];

export default function VendorApplicationsPage() {
  const router = useRouter();

  const [applications, setApplications] = useState<any[]>([]);
  const [loading, setLoading]           = useState(true);
  const [filter, setFilter]             = useState('all');
  const [token, setToken]               = useState('');

  useEffect(() => {
    const t = getAccessToken('vendor');
    if (!t) { router.replace('/vendor/login'); return; }
    setToken(t);
  }, []);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    const status = filter === 'all' ? undefined : filter;
    getVendorApplications(token, status)
      .then(data => setApplications(data.applications || []))
      .catch(err => { if (err.message?.includes('401')) router.replace('/vendor/login'); })
      .finally(() => setLoading(false));
  }, [token, filter]);

  return (
    <div className="space-y-6 animate-fade-in">

      {/* Heading */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold"
            style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
            Applications
          </h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            {applications.length} application{applications.length !== 1 ? 's' : ''} assigned to you
          </p>
        </div>
        <div className="px-3 py-1.5 rounded-xl text-xs font-semibold"
          style={{ background: 'rgba(5,150,105,0.08)', color: '#059669', border: '1px solid rgba(5,150,105,0.2)' }}>
          {applications.length} total
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-2xl p-4"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2 overflow-x-auto">
          <Filter className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
          {FILTERS.map(s => (
            <button key={s} onClick={() => setFilter(s)}
              className="px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all duration-150 flex-shrink-0"
              style={filter === s
                ? { background: '#059669', color: '#fff' }
                : { background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
              {s === 'all' ? 'All' : getStatusLabel(s)}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <SkeletonTable rows={5} />
      ) : applications.length === 0 ? (
        <div className="rounded-2xl"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <EmptyState title="No applications found"
            description="No applications match the selected filter."
            icon={<FileText className="w-10 h-10" />} />
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
          {/* Header */}
          <div className="grid grid-cols-12 px-5 py-3 text-xs font-semibold uppercase tracking-wider"
            style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', letterSpacing: '0.07em' }}>
            <div className="col-span-4">Customer</div>
            <div className="col-span-3">Loan ID</div>
            <div className="col-span-2">Amount</div>
            <div className="col-span-2">Status</div>
            <div className="col-span-1">Date</div>
          </div>
          {applications.map((app: any, i) => (
            <div key={app.id}
              onClick={() => router.push(`/vendor/applications/${app.id}`)}
              className="grid grid-cols-12 px-5 py-4 cursor-pointer transition-colors items-center"
              style={{ borderBottom: i < applications.length - 1 ? '1px solid var(--border)' : 'none' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-subtle)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <div className="col-span-4 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                  style={{ background: 'rgba(5,150,105,0.08)', color: '#059669' }}>
                  {app.customer_name?.charAt(0) || '?'}
                </div>
                <div>
                  <p className="text-sm font-semibold"
                    style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                    {app.customer_name}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{app.phone}</p>
                </div>
              </div>
              <div className="col-span-3">
                <span className="text-xs font-medium px-2 py-1 rounded-lg"
                  style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono' }}>
                  {app.loan_id}
                </span>
              </div>
              <div className="col-span-2">
                <span className="text-sm font-semibold"
                  style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                  {app.loan_amount ? formatCurrency(app.loan_amount) : '—'}
                </span>
              </div>
              <div className="col-span-2">
                <StatusChip status={app.status} size="sm" />
              </div>
              <div className="col-span-1 flex items-center justify-between">
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {formatDate(app.submitted_at || app.created_at || '')}
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