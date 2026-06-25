'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL } from '@/lib/api';
import { Loader2, X, ChevronRight, FileText, Edit3, CheckCircle, Clock, AlertCircle, TrendingUp, Phone } from 'lucide-react';

// ── Status configuration ────────────────────────────────────────────────────
const STATUS: Record<string, { label: string; color: string; light: string; dot: string; step: number; msg: string }> = {
  draft:               { label: 'In Progress',     color: '#2563EB', light: '#EFF6FF', dot: '#93C5FD', step: 1, msg: 'Complete your application to get started' },
  submitted:           { label: 'Under Review',    color: '#D97706', light: '#FFFBEB', dot: '#FCD34D', step: 2, msg: 'We\'ll review within 24–48 hours' },
  system_reviewed:     { label: 'Being Reviewed',  color: '#7C3AED', light: '#F5F3FF', dot: '#C4B5FD', step: 3, msg: 'Our team is reviewing your details' },
  officer_approved:    { label: 'Officer Approved',color: '#059669', light: '#F0FDF4', dot: '#6EE7B7', step: 4, msg: 'Approved by officer — awaiting final sign-off' },
  officer_rejected:    { label: 'Not Approved',    color: '#DC2626', light: '#FEF2F2', dot: '#FCA5A5', step: -1, msg: 'Please visit your branch for assistance' },
  documents_submitted: { label: 'Docs Verified',   color: '#059669', light: '#F0FDF4', dot: '#6EE7B7', step: 4, msg: 'Documents verified — moving to approval' },
  approved:            { label: 'Approved',         color: '#059669', light: '#F0FDF4', dot: '#6EE7B7', step: 5, msg: 'Congratulations! Loan approved' },
  supervisor_rejected: { label: 'Not Approved',    color: '#DC2626', light: '#FEF2F2', dot: '#FCA5A5', step: -1, msg: 'Contact your bank branch for next steps' },
  vendor_assigned:     { label: 'Processing',      color: '#D97706', light: '#FFFBEB', dot: '#FCD34D', step: 6, msg: 'NBFC partner is processing disbursement' },
  vendor_rejected:     { label: 'NBFC Declined',   color: '#DC2626', light: '#FEF2F2', dot: '#FCA5A5', step: -1, msg: 'Contact your bank for alternate options' },
  disbursed:           { label: 'Disbursed',        color: '#059669', light: '#F0FDF4', dot: '#6EE7B7', step: 7, msg: 'Loan credited to your account' },
};

const STEPS = ['Filling', 'Submitted', 'Review', 'Approved', 'NBFC', 'Done'];
const STEP_MAP = [1, 2, 3, 5, 6, 7];

export default function CustomerDashboard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [app, setApp]   = useState<any>(null);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    const s = sessionStorage.getItem('loan_session');
    if (!s) { router.push('/'); return; }
    fetch(`${API_URL}/api/get-application?session_token=${s}`)
      .then(r => { if (r.status === 401) { router.push('/'); return null; } return r.json(); })
      .then(d => { if (d?.status === 'success') setApp(d.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const s = app ? (STATUS[app.status] || STATUS.draft) : null;
  const isDraft    = app?.status === 'draft';
  const isRejected = app && ['officer_rejected','supervisor_rejected','vendor_rejected'].includes(app.status);
  const isDisbursed = app?.status === 'disbursed';
  const stepIdx = s ? Math.max(0, STEP_MAP.indexOf(s.step)) : 0;
  const pct = isRejected ? 100 : Math.round((stepIdx / (STEPS.length - 1)) * 100);

  const signOut = () => { sessionStorage.removeItem('loan_session'); router.push('/'); };

  // ── Loading ────────────────────────────────────────────────────────────────
  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#EEF2F9' }}>
      <div className="flex flex-col items-center gap-3">
        <div className="w-12 h-12 rounded flex items-center justify-center font-bold text-lg"
          style={{ background: '#0D2650', color: '#fff', fontFamily: 'var(--font-heading)' }}>F</div>
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: '#2563EB' }} />
      </div>
    </div>
  );

  // ── Status Drawer ──────────────────────────────────────────────────────────
  const StatusDrawer = () => !drawer || !app ? null : (
    <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ background: 'rgba(15,23,42,0.6)', backdropFilter: 'blur(6px)' }}
      onClick={e => { if (e.target === e.currentTarget) setDrawer(false); }}>
      <div className="w-full max-w-md bg-white rounded-t-3xl overflow-hidden" style={{ boxShadow: '0 -20px 60px rgba(0,0,0,0.2)', maxHeight: '90vh', overflowY: 'auto' }}>

        {/* Handle */}
        <div className="flex justify-center pt-3"><div className="w-9 h-1 rounded-full" style={{ background: '#E2E8F0' }} /></div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <div>
            <p className="text-xs font-medium" style={{ color: '#94A3B8', fontFamily: 'var(--font-body)', letterSpacing: '0.05em' }}>LOAN APPLICATION</p>
            <p className="text-sm font-semibold mt-0.5" style={{ color: '#0F172A', fontFamily: 'var(--font-mono-loan)' }}>{app.loan_id}</p>
          </div>
          <button onClick={() => setDrawer(false)} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: '#F1F5F9' }}>
            <X className="w-4 h-4" style={{ color: '#64748B' }} />
          </button>
        </div>

        <div className="px-5 pb-6 space-y-5">
          {/* Big status card */}
          <div className="rounded-2xl p-4" style={{ background: s?.light, border: `1px solid ${s?.dot}40` }}>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: s?.color + '20' }}>
                {isDisbursed ? <CheckCircle className="w-5 h-5" style={{ color: s?.color }} /> :
                 isRejected  ? <AlertCircle className="w-5 h-5" style={{ color: s?.color }} /> :
                               <Clock className="w-5 h-5" style={{ color: s?.color }} />}
              </div>
              <div>
                <p className="font-bold" style={{ color: s?.color, fontFamily: 'var(--font-heading)' }}>{s?.label}</p>
                <p className="text-xs" style={{ color: s?.color + 'aa', fontFamily: 'var(--font-body)' }}>{s?.msg}</p>
              </div>
            </div>
            {/* Progress bar */}
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: s?.color + '25' }}>
              <div className="h-full rounded-full transition-all duration-700"
                style={{ width: `${isRejected ? 100 : pct}%`, background: isRejected ? '#DC2626' : s?.color }} />
            </div>
            <div className="flex justify-between mt-1.5">
              <span className="text-[10px]" style={{ color: s?.color + '99', fontFamily: 'var(--font-body)' }}>Applied</span>
              <span className="text-[10px] font-semibold" style={{ color: s?.color, fontFamily: 'var(--font-body)' }}>{pct}% complete</span>
            </div>
          </div>

          {/* Steps */}
          <div>
            <p className="text-xs font-semibold mb-3" style={{ color: '#94A3B8', fontFamily: 'var(--font-body)', letterSpacing: '0.08em' }}>JOURNEY</p>
            <div className="space-y-2">
              {STEPS.map((label, i) => {
                const myStep = STEP_MAP[i];
                const done   = !isRejected && s && s.step >= myStep;
                const active = s && s.step === myStep && !isRejected;
                return (
                  <div key={i} className="flex items-center gap-3 py-1">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold"
                      style={{ background: done ? (active ? s?.color : '#059669') : '#F1F5F9', color: done ? '#fff' : '#94A3B8', fontFamily: 'var(--font-heading)', boxShadow: active ? `0 0 0 3px ${s?.color}30` : 'none' }}>
                      {done && !active ? '✓' : i + 1}
                    </div>
                    <span className="text-sm font-medium" style={{ color: done ? '#0F172A' : '#94A3B8', fontFamily: 'var(--font-body)', fontWeight: active ? 700 : 500 }}>
                      {label}
                      {active && <span className="ml-2 text-xs font-normal" style={{ color: s?.color }}>← You are here</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Details table */}
          <div>
            <p className="text-xs font-semibold mb-3" style={{ color: '#94A3B8', fontFamily: 'var(--font-body)', letterSpacing: '0.08em' }}>DETAILS</p>
            <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid #F1F5F9' }}>
              {[
                { label: 'Applicant',   value: [app.first_name, app.last_name].filter(Boolean).join(' ') || app.customer_name },
                { label: 'Loan Amount', value: app.loan_amount_requested ? `₹${parseFloat(app.loan_amount_requested).toLocaleString('en-IN')}` : '—' },
                { label: 'Purpose',     value: app.purpose_of_loan || '—' },
                { label: 'Submitted',   value: app.submitted_at ? new Date(app.submitted_at).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }) : 'Pending' },
              ].map(({ label, value }, i, arr) => (
                <div key={label} className="flex items-center justify-between px-4 py-3 text-sm"
                  style={{ borderBottom: i < arr.length - 1 ? '1px solid #F8F9FC' : 'none' }}>
                  <span style={{ color: '#94A3B8', fontFamily: 'var(--font-body)' }}>{label}</span>
                  <span className="font-semibold text-right max-w-[55%]" style={{ color: '#0F172A', fontFamily: 'var(--font-body)' }}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          <button onClick={() => setDrawer(false)}
            className="w-full py-3.5 rounded-xl text-sm font-semibold transition hover:opacity-80"
            style={{ background: '#F1F5F9', color: '#64748B', fontFamily: 'var(--font-heading)' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );

  // ── Main page ──────────────────────────────────────────────────────────────
  return (
    <>
      <StatusDrawer />
      <div className="min-h-screen" style={{ background: '#EEF2F9' }}>

        {/* ── TOP SECTION ── */}
        <div className="px-5 pt-6 pb-8 relative overflow-hidden"
          style={{ background: '#0D2650' }}>

          {/* Nav */}
          <div className="flex items-center justify-between mb-8 relative z-10">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded flex items-center justify-center font-bold text-xs"
                style={{ background: '#fff', fontFamily: 'var(--font-heading)', color: '#0D2650' }}>F</div>
              <span className="text-sm font-semibold" style={{ color: '#fff', fontFamily: 'var(--font-heading)' }}>Finix</span>
            </div>
            <button onClick={signOut} className="text-xs px-3 py-1.5 rounded-full transition hover:opacity-80"
              style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.45)', border: '1px solid rgba(255,255,255,0.08)', fontFamily: 'var(--font-body)' }}>
              Sign out
            </button>
          </div>

          {/* Greeting + Loan overview */}
          {app && (
            <div className="relative z-10 max-w-sm mx-auto">
              <p className="text-sm mb-1" style={{ color: 'rgba(255,255,255,0.5)', fontFamily: 'var(--font-body)' }}>
                Welcome back,
              </p>
              <h1 className="text-2xl font-bold text-white mb-5" style={{ fontFamily: 'var(--font-heading)' }}>
                {app.customer_name?.split(' ')[0] || 'there'}
              </h1>

              {/* Loan card */}
              <div className="rounded-2xl p-4" style={{ background: '#0A1F45', border: '1px solid rgba(255,255,255,0.15)' }}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="text-xs mb-1" style={{ color: 'rgba(255,255,255,0.4)', fontFamily: 'var(--font-body)' }}>Loan Application</p>
                    <p className="text-sm font-semibold" style={{ color: 'rgba(255,255,255,0.85)', fontFamily: 'var(--font-mono-loan)' }}>{app.loan_id}</p>
                  </div>
                  {/* Status badge */}
                  <div className="px-2.5 py-1 rounded text-xs font-semibold"
                    style={{ background: '#fff', color: s?.color, border: `1.5px solid ${s?.color}`, fontFamily: 'var(--font-body)' }}>
                    {s?.label}
                  </div>
                </div>

                {/* Progress bar */}
                <div className="h-1.5 rounded-full overflow-hidden mb-1.5" style={{ background: 'rgba(255,255,255,0.1)' }}>
                  <div className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${isRejected ? 100 : pct}%`, background: isRejected ? '#DC2626' : '#60A5FA' }} />
                </div>
                <div className="flex justify-between">
                  <p className="text-[10px]" style={{ color: 'rgba(255,255,255,0.3)', fontFamily: 'var(--font-body)' }}>Applied</p>
                  <p className="text-[10px] font-semibold" style={{ color: 'rgba(255,255,255,0.6)', fontFamily: 'var(--font-body)' }}>Disbursed</p>
                </div>

                {app.loan_amount_requested && (
                  <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                    <p className="text-xs" style={{ color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-body)' }}>Requested Amount</p>
                    <p className="text-xl font-bold text-white mt-0.5" style={{ fontFamily: 'var(--font-heading)' }}>
                      ₹{parseFloat(app.loan_amount_requested).toLocaleString('en-IN')}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── BOTTOM SECTION ── */}
        <div className="px-5 pt-6 pb-10 -mt-3 relative z-10">
          <div className="max-w-sm mx-auto space-y-3">

            {app && (
              <>
                {/* ── Action 1: Check Status ── */}
                <button onClick={() => setDrawer(true)}
                  className="w-full bg-white rounded-2xl p-4 text-left group transition-all hover:shadow-md active:scale-[0.99]"
                  style={{ boxShadow: '0 1px 8px rgba(0,0,0,0.06)', border: '1px solid #EEF2FF' }}>
                  <div className="flex items-center gap-3.5">
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ background: s?.light, border: `1px solid ${s?.dot}60` }}>
                      <TrendingUp className="w-5 h-5" style={{ color: s?.color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm" style={{ color: '#0F172A', fontFamily: 'var(--font-heading)' }}>
                        Check Application Status
                      </p>
                      <p className="text-xs mt-0.5 truncate" style={{ color: '#64748B', fontFamily: 'var(--font-body)' }}>
                        {s?.msg}
                      </p>
                    </div>
                    <ChevronRight className="w-4 h-4 flex-shrink-0 transition-transform group-hover:translate-x-0.5" style={{ color: '#CBD5E1' }} />
                  </div>
                </button>

                {/* ── Action 2: Form ── */}
                <button
                  onClick={() => !isRejected && router.push('/loan-form/application')}
                  className="w-full rounded-2xl p-4 text-left group transition-all hover:shadow-xl active:scale-[0.99]"
                  style={{
                    background: isRejected ? '#F8F9FC' : '#0D2650',
                    boxShadow: isRejected ? 'none' : '0 2px 8px rgba(0,0,0,0.2)',
                    border: isRejected ? '1px solid #E2E8F0' : '1px solid rgba(255,255,255,0.12)',
                    cursor: isRejected ? 'not-allowed' : 'pointer',
                    opacity: isRejected ? 0.6 : 1,
                  }}>
                  <div className="flex items-center gap-3.5">
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ background: isRejected ? '#F1F5F9' : 'rgba(255,255,255,0.15)', border: `1px solid ${isRejected ? '#E2E8F0' : 'rgba(255,255,255,0.15)'}` }}>
                      {isDraft
                        ? <Edit3 className="w-5 h-5" style={{ color: isRejected ? '#94A3B8' : '#fff' }} />
                        : <FileText className="w-5 h-5" style={{ color: isRejected ? '#94A3B8' : '#fff' }} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm" style={{ color: isRejected ? '#64748B' : '#fff', fontFamily: 'var(--font-heading)' }}>
                        {isDraft ? 'Continue Filling Form' : 'View Application'}
                      </p>
                      <p className="text-xs mt-0.5" style={{ color: isRejected ? '#94A3B8' : 'rgba(255,255,255,0.6)', fontFamily: 'var(--font-body)' }}>
                        {isDraft ? `Step ${app.current_step || 1} of 6` : isDisbursed ? 'Loan successfully disbursed' : 'View your submitted form'}
                      </p>
                    </div>
                    {!isRejected && (
                      <ChevronRight className="w-4 h-4 flex-shrink-0 text-white opacity-70 transition-transform group-hover:translate-x-0.5" />
                    )}
                  </div>

                  {/* Step progress for draft */}
                  {isDraft && (
                    <div className="mt-3.5 flex gap-1.5">
                      {[1,2,3,4,5,6].map(n => (
                        <div key={n} className="flex-1 h-1 rounded-full transition-all"
                          style={{ background: n <= (app.current_step || 1) ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.15)' }} />
                      ))}
                    </div>
                  )}
                </button>

                {/* Support */}
                <div className="flex items-center justify-between pt-2 px-1">
                  <a href="tel:18001030408" className="flex items-center gap-2 text-xs group"
                    style={{ color: '#64748B', fontFamily: 'var(--font-body)' }}>
                    <Phone className="w-3.5 h-3.5" />
                    <span>Need help? <span className="font-semibold" style={{ color: '#1A1A2E', fontFamily: 'var(--font-mono-loan)' }}>1800-103-0408</span></span>
                  </a>
                  <button onClick={signOut} className="text-xs" style={{ color: '#94A3B8', fontFamily: 'var(--font-body)' }}>
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
