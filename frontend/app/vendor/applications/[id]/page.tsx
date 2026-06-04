'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  ArrowLeft, User, Banknote, FileText,
  CheckCircle2, XCircle, Eye,
  Shield, Upload, Loader2,
  ChevronDown, ChevronUp,
} from 'lucide-react';

import { getVendorApplicationDetail, vendorDisburse, vendorReject } from '@/lib/api/vendor';
import { getAccessToken } from '@/lib/auth';
import { API_URL } from '@/lib/api/index';
import { formatCurrency, formatDateTime, maskPAN, maskAadhaar } from '@/lib/utils/formatters';

import StatusChip from '@/components/ui/StatusChip';

function Section({
  title, icon: Icon, sectionKey, expanded, onToggle, children, accent = '#059669',
}: {
  title: string; icon: any; sectionKey: string;
  expanded: boolean; onToggle: (k: string) => void;
  children: React.ReactNode; accent?: string;
}) {
  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
      <button onClick={() => onToggle(sectionKey)}
        className="w-full flex items-center justify-between px-5 py-4 transition-colors"
        style={{ borderBottom: expanded ? '1px solid var(--border)' : 'none' }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-subtle)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: `${accent}15`, color: accent }}>
            <Icon className="w-3.5 h-3.5" />
          </div>
          <span className="font-semibold text-sm"
            style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
            {title}
          </span>
        </div>
        {expanded
          ? <ChevronUp className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
          : <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />}
      </button>
      {expanded && <div className="px-5 py-5">{children}</div>}
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: any; mono?: boolean }) {
  return (
    <div className="py-2">
      <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="text-sm font-medium mt-0.5"
        style={{ color: 'var(--text-primary)', fontFamily: mono ? 'JetBrains Mono' : 'inherit' }}>
        {value || '—'}
      </dd>
    </div>
  );
}

function DocItem({ label, url }: { label: string; url?: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 px-4 rounded-xl"
      style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2">
        <FileText className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      </div>
      {url ? (
        <a href={`${API_URL}${url}`} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs font-medium"
          style={{ color: '#059669' }}>
          <Eye className="w-3.5 h-3.5" /> View
        </a>
      ) : (
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Not uploaded</span>
      )}
    </div>
  );
}

export default function VendorApplicationDetailPage() {
  const router = useRouter();
  const params = useParams();
  const appId  = params.id as string;

  const [app, setApp]               = useState<any>(null);
  const [loading, setLoading]       = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [notes, setNotes]           = useState('');
  const [showReject, setShowReject] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [token, setToken]           = useState('');
  const [expanded, setExpanded]     = useState<Record<string, boolean>>({
    personal: true, loan: true, kyc: true, documents: true,
  });

  useEffect(() => {
    const t = getAccessToken('vendor');
    if (!t) { router.replace('/vendor/login'); return; }
    setToken(t);
  }, []);

  useEffect(() => {
    if (!token) return;
    getVendorApplicationDetail(token, appId)
      .then(data => setApp(data.application))
      .catch(err => { if (err.message?.includes('401')) router.replace('/vendor/login'); })
      .finally(() => setLoading(false));
  }, [token]);

  const handleAction = async (action: () => Promise<any>) => {
    setActionLoading(true);
    try {
      await action();
      const data = await getVendorApplicationDetail(token, appId);
      setApp(data.application);
      setNotes(''); setRejectionReason(''); setShowReject(false);
    } catch (err: any) { alert(err.message || 'Action failed'); }
    finally { setActionLoading(false); }
  };

  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  if (loading) return (
    <div className="flex items-center justify-center h-96">
      <Loader2 className="w-8 h-8 animate-spin" style={{ color: '#059669' }} />
    </div>
  );

  if (!app) return (
    <div className="flex items-center justify-center h-96">
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Application not found.</p>
    </div>
  );

  const canDisburse = app.status === 'approved';

  return (
    <div className="space-y-4 animate-fade-in">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={() => router.back()}
            className="p-2 rounded-xl transition-colors flex-shrink-0"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--border)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-subtle)'}>
            <ArrowLeft className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
          </button>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
              style={{ background: 'rgba(5,150,105,0.08)', color: '#059669', fontFamily: 'Plus Jakarta Sans' }}>
              {app.customer_name?.charAt(0) || '?'}
            </div>
            <div>
              <h2 className="text-xl font-bold"
                style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                {app.customer_name}
              </h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs font-medium"
                  style={{ color: 'var(--text-muted)', fontFamily: 'JetBrains Mono' }}>
                  {app.loan_id}
                </span>
                <StatusChip status={app.status} size="sm" />
              </div>
            </div>
          </div>
        </div>
        {app.loan_amount && (
          <div className="text-right flex-shrink-0">
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Loan amount</p>
            <p className="text-xl font-bold"
              style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
              {formatCurrency(app.loan_amount)}
            </p>
          </div>
        )}
      </div>

      <Section title="Personal details" icon={User} sectionKey="personal"
        expanded={expanded.personal} onToggle={toggle} accent="#2563EB">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6">
          <Field label="Full name"     value={app.customer_name} />
          <Field label="Phone"         value={app.phone} mono />
          <Field label="Email"         value={app.email} />
          <Field label="Date of birth" value={app.date_of_birth} />
          <Field label="Gender"        value={app.gender} />
        </div>
      </Section>

      <Section title="Loan details" icon={Banknote} sectionKey="loan"
        expanded={expanded.loan} onToggle={toggle} accent="#059669">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6">
          <Field label="Requested amount" value={app.loan_amount ? formatCurrency(app.loan_amount) : null} />
          <Field label="Purpose"          value={app.purpose_of_loan} />
          <Field label="Tenure"           value={app.repayment_period_years ? `${app.repayment_period_years} years` : null} />
          <Field label="Net income"       value={app.monthly_net_income ? formatCurrency(app.monthly_net_income) : null} />
        </div>
      </Section>

      <Section title="KYC verification" icon={Shield} sectionKey="kyc"
        expanded={expanded.kyc} onToggle={toggle} accent="#D97706">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            { label: 'PAN card', verified: app.pan_verified, value: app.pan_number ? maskPAN(app.pan_number) : 'Not provided' },
            { label: 'Aadhaar',  verified: app.aadhaar_verified, value: app.aadhaar_last4 ? maskAadhaar(app.aadhaar_last4) : 'Not provided' },
          ].map(item => (
            <div key={item.label} className="rounded-xl p-4"
              style={{
                background: item.verified ? 'rgba(5,150,105,0.06)' : 'var(--bg-subtle)',
                border: `1px solid ${item.verified ? 'rgba(5,150,105,0.2)' : 'var(--border)'}`,
              }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold"
                  style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                  {item.label}
                </span>
                {item.verified
                  ? <CheckCircle2 className="w-4 h-4" style={{ color: '#059669' }} />
                  : <XCircle className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />}
              </div>
              <p className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>{item.value}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Documents" icon={Upload} sectionKey="documents"
        expanded={expanded.documents} onToggle={toggle} accent="#EA580C">
        <div className="space-y-2">
          <DocItem label="PAN card"       url={app.pan_card_url} />
          <DocItem label="Aadhaar"        url={app.aadhaar_front_url} />
          <DocItem label="Photo"          url={app.photo_url} />
          <DocItem label="Income proof"   url={app.income_proof_url} />
          <DocItem label="Bank statement" url={app.bank_statement_url} />
        </div>
      </Section>

      {/* Action panel */}
      {canDisburse && (
        <div className="rounded-2xl p-5"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
          <h3 className="font-semibold text-sm mb-4"
            style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
            Actions
          </h3>
          <div className="space-y-3">
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Add notes (optional)..." rows={2}
              className="w-full px-4 py-3 rounded-xl text-sm outline-none transition resize-none"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              onFocus={e => e.target.style.borderColor = '#059669'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'} />

            {showReject && (
              <input value={rejectionReason} onChange={e => setRejectionReason(e.target.value)}
                placeholder="Rejection reason (required)..."
                className="w-full px-4 py-3 rounded-xl text-sm outline-none transition"
                style={{ background: 'rgba(220,38,38,0.04)', border: '1px solid rgba(220,38,38,0.3)', color: 'var(--text-primary)' }} />
            )}

            <div className="flex gap-2">
              <button disabled={actionLoading}
                onClick={() => handleAction(() => vendorDisburse(token, appId, notes))}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #059669 0%, #047857 100%)' }}>
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Disburse
              </button>
              <button disabled={actionLoading}
                onClick={() => {
                  if (showReject && rejectionReason) {
                    handleAction(() => vendorReject(token, appId, notes, rejectionReason));
                  } else { setShowReject(true); }
                }}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
                style={{
                  background: showReject && rejectionReason ? 'linear-gradient(135deg, #DC2626 0%, #B91C1C 100%)' : 'var(--bg-subtle)',
                  color: showReject && rejectionReason ? '#fff' : 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}>
                <XCircle className="w-4 h-4" />
                {showReject ? 'Confirm reject' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}