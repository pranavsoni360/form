'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, ChevronRight, Banknote, Clock, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

import { getVendorStats, getVendorApplications } from '@/lib/api/vendor';
import { getAccessToken, getCurrentUser } from '@/lib/auth';
import { formatCurrency, formatDate } from '@/lib/utils/formatters';

import DataCard   from '@/components/ui/DataCard';
import StatusChip from '@/components/ui/StatusChip';
import EmptyState from '@/components/ui/EmptyState';
import { SkeletonCard } from '@/components/ui/skeleton';

export default function VendorDashboardPage() {
  const router = useRouter();

  const [stats, setStats]     = useState<any>(null);
  const [recent, setRecent]   = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser]       = useState<any>(null);
  const [token, setToken]     = useState('');

  useEffect(() => {
    const t = getAccessToken('vendor');
    const u = getCurrentUser('vendor');
    if (!t || !u) { router.replace('/vendor/login'); return; }
    setToken(t); setUser(u);
  }, []);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const [statsData, appsData] = await Promise.all([
          getVendorStats(token),
          getVendorApplications(token),
        ]);
        setStats(statsData);
        setRecent((appsData.applications || []).slice(0, 8));
      } catch (err: any) {
        if (err.message?.includes('401')) router.replace('/vendor/login');
      } finally { setLoading(false); }
    })();
  }, [token]);

  if (loading) return (
    <div className="flex items-center justify-center h-96">
      <Loader2 className="w-8 h-8 animate-spin" style={{ color: '#059669' }} />
    </div>
  );

  return (
    <div className="space-y-6 animate-fade-in">

      {/* Heading */}
      <div>
        <h2 className="text-2xl font-bold"
          style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
          Dashboard
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Welcome back{user?.full_name ? `, ${user.full_name}` : ''}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <DataCard title="Assigned"  value={stats?.total_assigned  || 0}
          icon={<FileText className="w-5 h-5" />} accent="blue" />
        <DataCard title="Pending"   value={stats?.total_pending   || 0}
          icon={<Clock className="w-5 h-5" />} accent="orange" />
        <DataCard title="Disbursed" value={stats?.total_disbursed || 0}
          icon={<CheckCircle2 className="w-5 h-5" />} accent="green" />
        <DataCard title="Rejected"  value={stats?.total_rejected  || 0}
          icon={<XCircle className="w-5 h-5" />} accent="red" />
      </div>

      {/* Recent applications */}
      <div className="rounded-2xl overflow-hidden"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
        <div className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center"
              style={{ background: 'rgba(5,150,105,0.1)' }}>
              <FileText className="w-3.5 h-3.5" style={{ color: '#059669' }} />
            </div>
            <h3 className="font-semibold text-sm"
              style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
              Recent applications
            </h3>
          </div>
          <button onClick={() => router.push('/vendor/applications')}
            className="text-xs font-medium transition-colors"
            style={{ color: '#059669' }}>
            View all →
          </button>
        </div>

        {recent.length > 0 ? (
          <div>
            {recent.map((app: any, i) => (
              <div key={app.id}
                onClick={() => router.push(`/vendor/applications/${app.id}`)}
                className="flex items-center justify-between px-5 py-3.5 cursor-pointer transition-colors"
                style={{ borderBottom: i < recent.length - 1 ? '1px solid var(--border)' : 'none' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-subtle)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                    style={{ background: 'rgba(5,150,105,0.08)', color: '#059669' }}>
                    {app.customer_name?.charAt(0) || '?'}
                  </div>
                  <div>
                    <p className="text-sm font-semibold"
                      style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                      {app.customer_name}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      <span style={{ fontFamily: 'JetBrains Mono' }}>{app.loan_id}</span>
                      {' · '}{formatDate(app.created_at)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  {app.loan_amount && (
                    <span className="text-sm font-semibold hidden sm:block"
                      style={{ color: 'var(--text-secondary)', fontFamily: 'Plus Jakarta Sans' }}>
                      {formatCurrency(app.loan_amount)}
                    </span>
                  )}
                  <StatusChip status={app.status} size="sm" />
                  <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No applications yet"
            description="Applications assigned to you will appear here."
            icon={<FileText className="w-10 h-10" />}
          />
        )}
      </div>
    </div>
  );
}