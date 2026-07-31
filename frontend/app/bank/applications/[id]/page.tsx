'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { API_URL, getApplicationDetail, officerApprove, officerReject, supervisorApprove, supervisorReject, initiateDisbursement, cancelApplication, STATUS_LABELS, STATUS_COLORS, SUGGESTION_COLORS, formatCurrency, formatDate, formatDateTime, maskPAN, maskAadhaar } from '@/lib/api';
import { ArrowLeft, User, Briefcase, FileText, ClipboardCheck, CheckCircle2, XCircle, Eye, Shield, Loader2, Banknote, LayoutDashboard, Ban } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import { getAccessToken, getCurrentUser } from '@/lib/auth';
import { AssignVendorPanel } from '@/components/bank/AssignVendorPanel';
import { LRSScorePanel } from '@/components/bank/LRSScorePanel';

interface TimelineEvent {
  id: string;
  from_status: string;
  to_status: string;
  changed_by_type: string;
  notes?: string;
  created_at: string;
}

type TabId = 'overview' | 'personal' | 'employment' | 'loan' | 'kyc' | 'notes';

const TAB_DEFS: { id: TabId; label: string; Icon: any }[] = [
  { id: 'overview',    label: 'Overview',    Icon: LayoutDashboard },
  { id: 'personal',   label: 'Personal',    Icon: User },
  { id: 'employment', label: 'Employment',  Icon: Briefcase },
  { id: 'loan',       label: 'Loan',        Icon: Banknote },
  { id: 'kyc',        label: 'KYC & Docs',  Icon: Shield },
  { id: 'notes',      label: 'Notes',       Icon: FileText },
];

export default function ApplicationDetailPage() {
  const router = useRouter();
  const params = useParams();
  const appId = params.id as string;

  const [app, setApp] = useState<any>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [token, setToken] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [notes, setNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showCancel, setShowCancel] = useState(false);

  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [grown, setGrown] = useState(false);

  useEffect(() => {
    const t = getAccessToken('bank');
    const u = getCurrentUser('bank');
    if (!t || !u) { router.push('/bank/login'); return; }
    setToken(t);
    setUser(u);
  }, []);

  useEffect(() => { if (token) fetchDetail(); }, [token]);

  useEffect(() => {
    const timer = setTimeout(() => setGrown(true), 120);
    return () => clearTimeout(timer);
  }, []);

  const fetchDetail = async () => {
    setLoading(true);
    try {
      const data = await getApplicationDetail(token, appId);
      setApp(data.application);
      setTimeline(data.timeline || []);
    } catch (err: any) {
      if (err.message?.includes('401')) router.push('/bank/login');
    } finally { setLoading(false); }
  };

  const handleAction = async (action: () => Promise<any>) => {
    setActionLoading(true);
    try {
      await action();
      await fetchDetail();
      setNotes('');
      setRejectionReason('');
      setShowReject(false);
      setCancelReason('');
      setShowCancel(false);
    } catch (err: any) {
      alert(err.message || 'Action failed');
    } finally { setActionLoading(false); }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  if (!app) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400">Application not found</p>
      </div>
    );
  }

  const isOfficer = user?.role === 'bank_officer' || user?.role === 'bank_supervisor';
  const isSupervisor = user?.role === 'bank_supervisor';
  const canOfficerAct = isOfficer && ['submitted', 'system_reviewed'].includes(app.status);
  const canSupervisorAct = isSupervisor && ['officer_approved', 'documents_submitted'].includes(app.status);
  const canDisburse = isSupervisor && app.status === 'officer_approved';
  const canCancel = isOfficer && !app.disbursed_at && !['cancelled', 'withdrawn'].includes(app.status);
  const canAct = canOfficerAct || canSupervisorAct || canDisburse || canCancel;

  const filled = (arr: any[]) => arr.filter(v => v != null && v !== '' && v !== false).length;
  const personalFields  = [app.customer_name, app.phone, app.email, app.date_of_birth, app.gender, app.marital_status, app.current_address, app.permanent_address, app.qualification];
  const employmentFields = [app.employment_type, app.employer_name, app.designation, app.total_work_experience, app.monthly_gross_income, app.monthly_deductions, app.monthly_emi_existing, app.monthly_net_income];
  const loanFields      = [app.consumer_loan_type, app.loan_amount_requested || app.loan_amount, app.purpose_of_loan, app.repayment_period_years, app.scheme];
  const kycFields       = [app.pan_verified || null, app.aadhaar_verified || null, app.pan_card_url, app.aadhaar_front_url, app.aadhaar_back_url, app.photo_url, app.income_proof_url, app.bank_statement_url, app.quotation_url];

  const tabCounts: Record<TabId, string> = {
    overview: '',
    personal:   `${filled(personalFields)}/9`,
    employment: `${filled(employmentFields)}/8`,
    loan:       `${filled(loanFields)}/5`,
    kyc:        `${filled(kycFields)}/9`,
    notes: '',
  };

  const Field = ({ label, value }: { label: string; value: any }) => (
    <div className="bg-white dark:bg-gray-900 p-4 flex flex-col gap-1.5 min-w-0">
      <span className="text-[9px] font-semibold tracking-[0.16em] uppercase text-gray-400 dark:text-gray-500">{label}</span>
      <span className={`text-sm leading-snug break-words ${value ? 'font-semibold text-gray-900 dark:text-gray-100' : 'font-medium text-gray-400 dark:text-gray-600'}`}>{value || '—'}</span>
    </div>
  );

  const DocItem = ({ label, url }: { label: string; url?: string }) => (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
      <span className="w-7 h-7 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center flex-shrink-0">
        <FileText className="w-3.5 h-3.5 text-gray-400" />
      </span>
      <span className="text-sm flex-1 min-w-0 text-gray-700 dark:text-gray-300">{label}</span>
      {url ? (
        <a href={`${API_URL}${url}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-blue-500 dark:text-blue-400 text-xs hover:underline flex-shrink-0">
          <Eye className="w-3.5 h-3.5" /> View
        </a>
      ) : (
        <span className="text-xs text-gray-400 flex-shrink-0">Not uploaded</span>
      )}
    </div>
  );

  const kycVerified = [app.pan_verified, app.aadhaar_verified].filter(Boolean).length;
  const kycPending  = kycVerified < 2;
  const statsFacts = [
    { label: 'Requested', value: app.loan_amount_requested ? formatCurrency(app.loan_amount_requested) : app.loan_amount ? formatCurrency(app.loan_amount) : '—', large: true },
    { label: 'Product',   value: app.consumer_loan_type === 'consumer_durable' ? 'Consumer Durable' : app.consumer_loan_type === 'personal_loan' ? 'Personal Loan' : '—' },
    { label: 'Created',   value: app.created_at ? formatDate(app.created_at) : '—' },
    { label: 'KYC',       value: `${kycVerified} of 2 verified`, warn: kycPending },
    { label: 'Officer',   value: app.assigned_to_name || app.officer_name || '—' },
  ];

  const progressItems = [
    { label: 'Personal details', have: filled(personalFields), total: 9 },
    { label: 'Employment',       have: filled(employmentFields), total: 8 },
    { label: 'Loan details',     have: filled(loanFields), total: 5 },
    { label: 'KYC & documents',  have: filled(kycFields), total: 9 },
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors" style={{ paddingBottom: canAct ? 72 : 0 }}>

      {/* ── HEADER ─────────────────────────────────────────────── */}
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 sticky top-0 z-20">

        {/* Top row */}
        <div className="px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3.5 min-w-0" style={{ flex: '1 1 320px' }}>
            <button
              onClick={() => router.push('/bank/dashboard')}
              className="w-8 h-8 flex-shrink-0 border border-gray-200 dark:border-gray-700 rounded-lg flex items-center justify-center text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <span
              className="w-10 h-10 flex-shrink-0 rounded-xl flex items-center justify-center text-sm font-semibold"
              style={{ background: 'rgba(125,159,209,0.14)', border: '1px solid rgba(125,159,209,0.3)', color: '#7d9fd1' }}
            >
              {(app.customer_name || 'U')[0].toUpperCase()}
            </span>
            <span className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[19px] font-semibold tracking-tight leading-tight text-gray-900 dark:text-gray-100 truncate">{app.customer_name}</span>
              <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 font-mono tracking-tight break-all">{app.loan_id}</span>
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[9.5px] font-semibold tracking-widest uppercase px-2.5 py-1.5 rounded-full border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 whitespace-nowrap">
              {STATUS_LABELS[app.status] || app.status}
            </span>
            {kycPending ? (
              <span className="text-[9.5px] font-semibold tracking-widest uppercase px-2.5 py-1.5 rounded-full bg-amber-400 text-gray-900 whitespace-nowrap">KYC pending</span>
            ) : (
              <span className="text-[9.5px] font-semibold tracking-widest uppercase px-2.5 py-1.5 rounded-full text-white whitespace-nowrap" style={{ background: '#7d9fd1' }}>KYC verified</span>
            )}
            <ThemeToggle />
          </div>
        </div>

        {/* Stats bar */}
        <div
          className="grid border-t border-gray-100 dark:border-gray-800"
          style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '1px', background: 'transparent' }}
        >
          {statsFacts.map((f, i) => (
            <div
              key={i}
              className={`flex flex-col gap-1.5 px-5 py-3.5 min-w-0 border-r border-gray-100 dark:border-gray-800 ${i === 0 ? 'bg-blue-500/5 dark:bg-blue-400/5' : 'bg-white dark:bg-gray-900'}`}
            >
              <span className="text-[9px] font-semibold tracking-[0.16em] uppercase text-gray-400 dark:text-gray-500">{f.label}</span>
              <span
                className={`font-semibold tracking-tight leading-tight ${f.warn ? 'text-amber-500' : 'text-gray-900 dark:text-gray-100'}`}
                style={{ fontSize: f.large ? '20px' : '13px' }}
              >
                {f.value}
              </span>
            </div>
          ))}
        </div>

        {/* Tab bar */}
        <div className="flex items-stretch flex-wrap border-t border-gray-100 dark:border-gray-800 px-2 overflow-x-auto">
          {TAB_DEFS.map(t => {
            const active = activeTab === t.id;
            const count  = tabCounts[t.id];
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className="relative flex items-center gap-2 px-4 py-3.5 bg-transparent border-0 text-[10.5px] font-semibold tracking-widest uppercase whitespace-nowrap cursor-pointer transition-colors"
                style={{ color: active ? undefined : '#8ea9a3' }}
              >
                <t.Icon className="w-3.5 h-3.5 flex-shrink-0" />
                {t.label}
                {count && (
                  <span
                    className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full tabular-nums"
                    style={{
                      background: active ? 'rgba(125,159,209,0.14)' : 'rgba(100,116,139,0.1)',
                      color: active ? '#7d9fd1' : '#8ea9a3',
                    }}
                  >
                    {count}
                  </span>
                )}
                <span
                  className="absolute left-3 right-3 bottom-0 h-0.5 rounded-full transition-transform origin-left duration-300"
                  style={{ background: '#7d9fd1', transform: `scaleX(${active ? 1 : 0})` }}
                />
              </button>
            );
          })}
        </div>
      </header>

      {/* ── MAIN CONTENT ───────────────────────────────────────── */}
      <main className="px-6 py-6 max-w-6xl mx-auto">

        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,300px),1fr))' }}>

            {/* Credit assessment + LRS */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-gray-100 dark:border-gray-800 flex-wrap gap-y-2">
                <span className="text-[11px] font-semibold tracking-widest uppercase text-gray-600 dark:text-gray-300">Credit assessment</span>
                <button
                  onClick={fetchDetail}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[9.5px] font-semibold tracking-widest uppercase text-white cursor-pointer transition-colors"
                  style={{ background: '#7d9fd1' }}
                >
                  Re-run
                </button>
              </div>
              {app.system_suggestion ? (
                <div className="p-4 flex items-start gap-3">
                  <ClipboardCheck className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">System Recommendation</span>
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${SUGGESTION_COLORS[app.system_suggestion] || ''}`}>
                        {app.system_suggestion.charAt(0).toUpperCase() + app.system_suggestion.slice(1)}
                      </span>
                      {app.system_score && <span className="text-xs text-gray-400">Score: {app.system_score}/100</span>}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{app.system_suggestion_reason || 'No detailed reason provided'}</p>
                  </div>
                </div>
              ) : (
                <div className="p-5 flex items-center gap-3">
                  <span className="w-9 h-9 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center flex-shrink-0">
                    <ClipboardCheck className="w-4 h-4 text-gray-400" />
                  </span>
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">No assessment yet</span>
                    <span className="text-xs text-gray-400 leading-snug">Needs income proof and KYC on file.</span>
                  </span>
                </div>
              )}
              {token && (
                <div className="border-t border-gray-100 dark:border-gray-800">
                  <LRSScorePanel token={token} applicationId={appId} canRescore={isOfficer} />
                </div>
              )}
            </div>

            {/* File completeness */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
              <div className="px-4 py-3.5 border-b border-gray-100 dark:border-gray-800">
                <span className="text-[11px] font-semibold tracking-widest uppercase text-gray-600 dark:text-gray-300">File completeness</span>
              </div>
              <div className="p-4 flex flex-col gap-4">
                {progressItems.map(p => (
                  <span key={p.label} className="flex flex-col gap-1.5">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[10px] font-semibold tracking-widest uppercase text-gray-400 dark:text-gray-500">{p.label}</span>
                      <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 tabular-nums">{p.have} / {p.total}</span>
                    </span>
                    <span className="block h-2 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-800">
                      <span
                        className="block h-2 rounded-full transition-all duration-700"
                        style={{
                          width: grown ? `${Math.round(p.have / p.total * 100)}%` : '0%',
                          background: p.have === 0 ? '#d9b174' : '#7d9fd1',
                        }}
                      />
                    </span>
                  </span>
                ))}
              </div>
            </div>

            {/* Status timeline */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
              <div className="px-4 py-3.5 border-b border-gray-100 dark:border-gray-800">
                <span className="text-[11px] font-semibold tracking-widest uppercase text-gray-600 dark:text-gray-300">Status timeline</span>
              </div>
              <div className="p-4">
                {timeline.length > 0 ? timeline.map((event, i) => (
                  <div key={event.id} className="grid gap-3" style={{ gridTemplateColumns: '20px 1fr' }}>
                    <span className="flex flex-col items-center">
                      <span className="w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0" style={{ background: '#7d9fd1', boxShadow: '0 0 0 1px #7d9fd1' }} />
                      {i < timeline.length - 1 && <span className="w-px flex-1 bg-gray-200 dark:bg-gray-700 min-h-3 mt-1" />}
                    </span>
                    <span className="flex flex-col gap-1 pb-3.5 min-w-0">
                      <span className="flex items-center gap-2 flex-wrap">
                        <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_COLORS[event.to_status] || ''}`}>
                          {STATUS_LABELS[event.to_status] || event.to_status}
                        </span>
                        <span className="text-[10px] text-gray-400 tabular-nums">{formatDateTime(event.created_at)}</span>
                      </span>
                      {event.notes && <span className="text-xs text-gray-500 dark:text-gray-400">{event.notes}</span>}
                      <span className="text-[10px] text-gray-400">by {event.changed_by_type}</span>
                    </span>
                  </div>
                )) : (
                  <p className="text-sm text-gray-400">No status history available</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* PERSONAL TAB */}
        {activeTab === 'personal' && (
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
              <span className="text-[11px] font-semibold tracking-widest uppercase text-gray-600 dark:text-gray-300">Personal details</span>
              <span className="text-[9.5px] font-semibold tracking-widest uppercase px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">{filled(personalFields)} of 9 filled</span>
            </div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,210px),1fr))', gap: '1px', background: '#e5e7eb' }}>
              <Field label="Full Name" value={app.customer_name} />
              <Field label="Phone" value={app.phone} />
              <Field label="Email" value={app.email} />
              <Field label="Date of Birth" value={app.date_of_birth} />
              <Field label="Gender" value={app.gender} />
              <Field label="Marital Status" value={app.marital_status} />
              <Field label="Current Address" value={app.current_address} />
              <Field label="Permanent Address" value={app.same_as_current ? 'Same as current' : app.permanent_address} />
              <Field label="Qualification" value={app.qualification} />
            </div>
          </div>
        )}

        {/* EMPLOYMENT TAB */}
        {activeTab === 'employment' && (
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
                <span className="text-[11px] font-semibold tracking-widest uppercase text-gray-600 dark:text-gray-300">Employment & Financial</span>
                <span className="text-[9.5px] font-semibold tracking-widest uppercase px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">{filled(employmentFields)} of 8 filled</span>
              </div>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,210px),1fr))', gap: '1px', background: '#e5e7eb' }}>
                <Field label="Employment Type" value={app.employment_type} />
                <Field label="Employer" value={app.employer_name} />
                <Field label="Designation" value={app.designation} />
                <Field label="Experience" value={app.total_work_experience ? `${app.total_work_experience} years` : null} />
                <Field label="Monthly Gross Income" value={app.monthly_gross_income ? formatCurrency(app.monthly_gross_income) : null} />
                <Field label="Monthly Deductions" value={app.monthly_deductions ? formatCurrency(app.monthly_deductions) : null} />
                <Field label="Existing EMIs" value={app.monthly_emi_existing ? formatCurrency(app.monthly_emi_existing) : null} />
                <Field label="Net Income" value={app.monthly_net_income ? formatCurrency(app.monthly_net_income) : null} />
              </div>
            </div>

            {(app.guarantor_name || app.guarantor_phone || app.guarantor_consent) && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
                <div className="px-4 py-3.5 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
                  <span className="text-[10px] font-semibold tracking-widest uppercase text-orange-500">Guarantor details</span>
                </div>
                <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,210px),1fr))', gap: '1px', background: '#e5e7eb' }}>
                  <Field label="Guarantor Name" value={app.guarantor_name} />
                  <Field label="Guarantor Phone" value={app.guarantor_phone} />
                  <Field label="Consent" value={
                    app.guarantor_consent === 'yes' ? 'Yes' :
                    app.guarantor_consent === 'no' ? 'No' :
                    app.guarantor_consent === 'no_answer' ? 'No answer' :
                    app.guarantor_consent === 'pending' ? 'Pending' : null
                  } />
                </div>
              </div>
            )}
          </div>
        )}

        {/* LOAN TAB */}
        {activeTab === 'loan' && (
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
                <span className="text-[11px] font-semibold tracking-widest uppercase text-gray-600 dark:text-gray-300">Loan details</span>
                <span className="text-[9.5px] font-semibold tracking-widest uppercase px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">{filled(loanFields)} of 5 filled</span>
              </div>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,210px),1fr))', gap: '1px', background: '#e5e7eb' }}>
                <Field label="Loan Type" value={app.consumer_loan_type === 'consumer_durable' ? 'Consumer Durable' : 'Personal Loan'} />
                <Field label="Requested Amount" value={app.loan_amount_requested ? formatCurrency(app.loan_amount_requested) : app.loan_amount ? formatCurrency(app.loan_amount) : null} />
                <Field label="Purpose" value={app.purpose_of_loan} />
                <Field label="Tenure" value={app.repayment_period_years ? `${app.repayment_period_years} years` : null} />
                <Field label="Scheme" value={app.scheme} />
              </div>
            </div>

            {app.consumer_loan_type === 'consumer_durable' && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
                <div className="px-4 py-3.5 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
                  <span className="text-[10px] font-semibold tracking-widest uppercase text-orange-500">Product & dealer details</span>
                </div>
                <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,210px),1fr))', gap: '1px', background: '#e5e7eb' }}>
                  <Field label="Product Name" value={app.product_name} />
                  <Field label="Brand" value={app.brand} />
                  <Field label="Model Number" value={app.model_number} />
                  <Field label="Quotation Amount" value={app.quotation_amount ? formatCurrency(app.quotation_amount) : null} />
                  <Field label="Dealer Name" value={app.dealer_name} />
                  <Field label="Dealer Address" value={app.dealer_address} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* KYC & DOCS TAB */}
        {activeTab === 'kyc' && (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,340px),1fr))' }}>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-gray-100 dark:border-gray-800 flex-wrap gap-y-2">
                <span className="text-[11px] font-semibold tracking-widest uppercase text-gray-600 dark:text-gray-300">Identity documents</span>
                <span className={`text-[9.5px] font-semibold tracking-widest uppercase px-2.5 py-1 rounded-full ${!kycPending ? 'text-white' : 'bg-amber-400 text-gray-900'}`} style={!kycPending ? { background: '#7d9fd1', color: '#fff' } : {}}>
                  {kycVerified} of 2 verified
                </span>
              </div>
              <div className="p-4 border-b border-gray-100 dark:border-gray-800">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${app.pan_verified ? 'bg-green-100 dark:bg-green-900/20' : 'bg-amber-100 dark:bg-amber-900/20'}`}>
                    {app.pan_verified ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-amber-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">PAN Card</div>
                    <div className="text-xs text-gray-400">{app.pan_number ? maskPAN(app.pan_number) : 'Not provided'}</div>
                    {app.pan_verification_timestamp && <div className="text-[10px] text-gray-400 mt-0.5">Verified: {formatDateTime(app.pan_verification_timestamp)}</div>}
                  </div>
                </div>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${app.aadhaar_verified ? 'bg-green-100 dark:bg-green-900/20' : 'bg-amber-100 dark:bg-amber-900/20'}`}>
                    {app.aadhaar_verified ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-amber-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">Aadhaar</div>
                    <div className="text-xs text-gray-400">{app.aadhaar_last4 ? maskAadhaar(app.aadhaar_last4) : 'Not provided'}</div>
                    {app.aadhaar_verification_timestamp && <div className="text-[10px] text-gray-400 mt-0.5">Verified: {formatDateTime(app.aadhaar_verification_timestamp)}</div>}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-gray-100 dark:border-gray-800">
                <span className="text-[11px] font-semibold tracking-widest uppercase text-gray-600 dark:text-gray-300">Documents</span>
                <span className="text-[9.5px] font-semibold tracking-widest uppercase text-gray-400">
                  {[app.pan_card_url, app.aadhaar_front_url, app.aadhaar_back_url, app.photo_url, app.income_proof_url, app.bank_statement_url, app.quotation_url].filter(Boolean).length} of {app.consumer_loan_type === 'consumer_durable' ? 7 : 6} uploaded
                </span>
              </div>
              <DocItem label="PAN Card" url={app.pan_card_url} />
              <DocItem label="Aadhaar Front" url={app.aadhaar_front_url} />
              <DocItem label="Aadhaar Back" url={app.aadhaar_back_url} />
              <DocItem label="Photo" url={app.photo_url} />
              <DocItem label="Income Proof" url={app.income_proof_url} />
              <DocItem label="Bank Statement" url={app.bank_statement_url} />
              {app.consumer_loan_type === 'consumer_durable' && <DocItem label="Dealer Quotation" url={app.quotation_url} />}
            </div>
          </div>
        )}

        {/* NOTES TAB */}
        {activeTab === 'notes' && (
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden max-w-2xl">
            <div className="px-4 py-3.5 border-b border-gray-100 dark:border-gray-800" style={{ boxShadow: 'inset 3px 0 0 #7d9fd1' }}>
              <span className="text-[11px] font-semibold tracking-widest uppercase text-gray-600 dark:text-gray-300">Officer notes</span>
            </div>
            <div className="p-4 flex flex-col gap-3">
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Add a note for the file…"
                rows={5}
                className="w-full resize-y px-3.5 py-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-900 dark:text-gray-100 text-sm font-medium leading-relaxed outline-none focus:border-blue-400 transition-colors"
              />
              <span className="text-xs text-gray-400">Notes are included with any approval or rejection action.</span>
            </div>
          </div>
        )}

        {isSupervisor && (
          <div className="mt-4">
            <AssignVendorPanel token={token} applicationId={appId} applicationStatus={app.status} />
          </div>
        )}
      </main>

      {/* ── FIXED BOTTOM ACTION BAR ────────────────────────────── */}
      {canAct && (
        <div className="fixed left-0 right-0 bottom-0 z-30 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 px-6 py-3.5 flex items-center justify-between gap-4 flex-wrap">
          <span className="flex items-center gap-3 min-w-0">
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: '#d9b174' }} />
            <span className="flex flex-col gap-0.5 min-w-0">
              <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 tracking-tight">Awaiting your decision</span>
              <span className="text-[11px] text-gray-400">
                {kycPending ? 'KYC incomplete · ' : ''}{STATUS_LABELS[app.status] || app.status}
              </span>
            </span>
          </span>

          <span className="flex items-center gap-2 flex-wrap">
            {showReject && (
              <input
                value={rejectionReason}
                onChange={e => setRejectionReason(e.target.value)}
                placeholder="Rejection reason…"
                className="px-3 py-2 border border-red-300 dark:border-red-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg text-xs outline-none focus:ring-1 focus:ring-red-400"
                style={{ minWidth: 180 }}
              />
            )}

            {showCancel && (
              <input
                value={cancelReason}
                onChange={e => setCancelReason(e.target.value)}
                placeholder="Cancellation reason (optional)…"
                className="px-3 py-2 border border-slate-300 dark:border-slate-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg text-xs outline-none focus:ring-1 focus:ring-slate-400"
                style={{ minWidth: 200 }}
              />
            )}

            {canOfficerAct && (
              <>
                <button
                  onClick={() => { if (showReject && rejectionReason) handleAction(() => officerReject(token, appId, notes, rejectionReason)); else setShowReject(s => !s); }}
                  disabled={actionLoading}
                  className="flex items-center gap-2 px-4 py-2.5 bg-transparent border border-gray-200 dark:border-gray-700 rounded-lg text-[10px] font-semibold tracking-widest uppercase text-gray-500 dark:text-gray-400 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
                >
                  {showReject ? 'Confirm Reject' : 'Reject'}
                </button>
                <button
                  onClick={() => handleAction(() => officerApprove(token, appId, notes))}
                  disabled={actionLoading}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[10px] font-semibold tracking-widest uppercase text-white cursor-pointer disabled:opacity-50 transition-colors"
                  style={{ background: '#7d9fd1' }}
                >
                  {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  Approve
                </button>
              </>
            )}

            {canSupervisorAct && (
              <>
                <button
                  onClick={() => { if (showReject && rejectionReason) handleAction(() => supervisorReject(token, appId, notes, rejectionReason)); else setShowReject(s => !s); }}
                  disabled={actionLoading}
                  className="flex items-center gap-2 px-4 py-2.5 bg-transparent border border-gray-200 dark:border-gray-700 rounded-lg text-[10px] font-semibold tracking-widest uppercase text-gray-500 dark:text-gray-400 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  {showReject ? 'Confirm Reject' : 'Reject'}
                </button>
                {!canDisburse && (
                  <button
                    onClick={() => handleAction(() => supervisorApprove(token, appId, notes))}
                    disabled={actionLoading}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-[10px] font-semibold tracking-widest uppercase text-white cursor-pointer disabled:opacity-50 transition-colors"
                    style={{ background: '#7d9fd1' }}
                  >
                    {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                    Approve
                  </button>
                )}
              </>
            )}

            {canDisburse && (
              <button
                onClick={() => handleAction(() => initiateDisbursement(token, appId, notes))}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2.5 bg-cyan-600 rounded-lg text-[10px] font-semibold tracking-widest uppercase text-white cursor-pointer hover:bg-cyan-700 disabled:opacity-50 transition-colors"
              >
                <Banknote className="w-3.5 h-3.5" />
                Approve & Disburse
              </button>
            )}

            {canCancel && (
              <button
                onClick={() => { if (showCancel) handleAction(() => cancelApplication(token, appId, cancelReason)); else setShowCancel(s => !s); }}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2.5 bg-slate-700 rounded-lg text-[10px] font-semibold tracking-widest uppercase text-white cursor-pointer hover:bg-slate-800 disabled:opacity-50 transition-colors"
              >
                {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
                {showCancel ? 'Confirm Cancel' : 'Cancel'}
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
