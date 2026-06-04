'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Banknote } from 'lucide-react';

import { getVendorSettlements } from '@/lib/api/vendor';
import { getAccessToken } from '@/lib/auth';
import { formatCurrency, formatDate } from '@/lib/utils/formatters';

import EmptyState        from '@/components/ui/EmptyState';
import { SkeletonTable } from '@/components/ui/skeleton';

export default function VendorSettlementsPage() {
  const router = useRouter();

  const [settlements, setSettlements] = useState<any[]>([]);
  const [loading, setLoading]         = useState(true);
  const [token, setToken]             = useState('');

  useEffect(() => {
    const t = getAccessToken('vendor');
    if (!t) { router.replace('/vendor/login'); return; }
    setToken(t);
  }, []);

  useEffect(() => {
    if (!token) return;
    getVendorSettlements(token)
      .then(data => setSettlements(data.settlements || []))
      .catch(err => { if (err.message?.includes('401')) router.replace('/vendor/login'); })
      .finally(() => setLoading(false));
  }, [token]);

  const statusBadge = (status: string) => {
    const isComplete = status === 'completed';
    return (
      <span className="text-xs font-semibold px-2.5 py-1 rounded-full"
        style={{
          background: isComplete ? 'rgba(5,150,105,0.1)' : 'rgba(217,119,6,0.1)',
          color:      isComplete ? '#059669'              : '#D97706',
        }}>
        {status}
      </span>
    );
  };

  return (
    <div className="space-y-6 animate-fade-in">

      {/* Heading */}
      <div>
        <h2 className="text-2xl font-bold"
          style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
          Settlements
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          {settlements.length} settlement{settlements.length !== 1 ? 's' : ''}
        </p>
      </div>

      {loading ? (
        <SkeletonTable rows={5} />
      ) : settlements.length === 0 ? (
        <div className="rounded-2xl"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <EmptyState
            title="No settlements yet"
            description="Completed disbursements will appear here."
            icon={<Banknote className="w-10 h-10" />}
          />
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>

          {/* Header */}
          <div className="grid grid-cols-12 px-5 py-3 text-xs font-semibold uppercase tracking-wider"
            style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', letterSpacing: '0.07em' }}>
            <div className="col-span-3">Loan ID</div>
            <div className="col-span-4">Customer</div>
            <div className="col-span-2">Amount</div>
            <div className="col-span-2">Date</div>
            <div className="col-span-1">Status</div>
          </div>

          {settlements.map((s: any, i) => (
            <div key={s.id || i}
              className="grid grid-cols-12 px-5 py-4 transition-colors items-center"
              style={{ borderBottom: i < settlements.length - 1 ? '1px solid var(--border)' : 'none' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-subtle)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>

              <div className="col-span-3">
                <span className="text-xs font-medium px-2 py-1 rounded-lg"
                  style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono' }}>
                  {s.loan_id}
                </span>
              </div>

              <div className="col-span-4">
                <p className="text-sm font-semibold"
                  style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                  {s.customer_name}
                </p>
              </div>

              <div className="col-span-2">
                <span className="text-sm font-semibold"
                  style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                  {s.amount ? formatCurrency(s.amount) : '—'}
                </span>
              </div>

              <div className="col-span-2">
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {formatDate(s.settlement_date || s.created_at)}
                </span>
              </div>

              <div className="col-span-1">
                {statusBadge(s.status || 'pending')}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}