'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  ArrowLeft, User, Briefcase, FileText,
  ClipboardCheck, CheckCircle2, XCircle,
  Clock, Eye, Shield, Upload, Loader2,
  ChevronDown, ChevronUp, Banknote,
} from 'lucide-react';

import {
  getApplicationDetail,
  officerApprove, officerReject,
  supervisorApprove, supervisorReject,
  initiateDisbursement,
} from '@/lib/api/bank';
import { getAccessToken, getCurrentUser } from '@/lib/auth';
import { API_URL } from '@/lib/api/index';
import { formatCurrency, formatDate, formatDateTime, maskPAN, maskAadhaar } from '@/lib/utils/formatters';
import { getStatusColor, getStatusLabel, getSuggestionColor } from '@/lib/utils/statusConfig';

import StatusChip from '@/components/ui/StatusChip';
import { Button } from '@/components/ui/button';
import Input      from '@/components/ui/Input';

// ── Types ─────────────────────────────────────────────────

interface TimelineEvent {
  id:              string;
  from_status:     string;
  to_status:       string;
  actor_type:      string;
  actor_id?:       string;
  notes?:          string;
  created_at:      string;
}

// ── Sub-components ────────────────────────────────────────

function Section({
  title, icon: Icon, sectionKey, expanded, onToggle, children,
}: {
  title:     string;
  icon:      any;
  sectionKey: string;
  expanded:  boolean;
  onToggle:  (key: string) => void;
  children:  React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <button
        onClick={() => onToggle(sectionKey)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition"
      >
        <div className="flex items-center gap-3">
          <Icon className="w-5 h-5 text-blue-600" />
          <span className="font-semibold text-gray-900 dark:text-white text-sm">{title}</span>
        </div>
        {expanded
          ? <ChevronUp className="w-4 h-4 text-gray-400" />
          : <ChevronDown className="w-4 h-4 text-gray-400" />}
      </button>
      {expanded && (
        <div className="px-5 pb-5 border-t border-gray-100 dark:border-gray-800 pt-4">
          {children}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: any }) {
  return (
    <div className="py-2">
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-sm font-medium text-gray-900 dark:text-gray-100 mt-0.5">
        {value || '—'}
      </dd>
    </div>
  );
}

function DocItem({ label, url }: { label: string; url?: string }) {
  const fullUrl = url ? (API_URL + url) : null;
  return (
    <div className="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-800 rounded-xl">
      <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
      {fullUrl ? (
        <a
          href={fullUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-blue-600 dark:text-blue-400 text-xs hover:underline"
        >
          <Eye className="w-3.5 h-3.5" /> View
        </a>
      ) : (
        <span className="text-xs text-gray-400">Not uploaded</span>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────

export default function ApplicationDetailPage() {
  const router = useRouter();
  const params = useParams();
  const appId  = params.id as string;

  const [app, setApp]               = useState<any>(null);
  const [timeline, setTimeline]     = useState<TimelineEvent[]>([]);
  const [loading, setLoading]       = useState(true);
  const [user, setUser]             = useState<any>(null);
  const [token, setToken]           = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [notes, setNotes]           = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [expanded, setExpanded]     = useState<Record<string, boolean>>({
    personal: true, employment: true, loan: true,
    kyc: true, documents: true,
  });

  useEffect(() => {
    const t = getAccessToken('bank');
    const u = getCurrentUser('bank');
    if (!t || !u) { router.replace('/bank/login'); return; }
    setToken(t);
    setUser(u);
  }, []);

  useEffect(() => {
    if (token) fetchDetail();
  }, [token]);

  const fetchDetail = async () => {
    setLoading(true);
    try {
      const data = await getApplicationDetail(token, appId);
      setApp(data.application);
      setTimeline(data.timeline || []);
    } catch (err: any) {
      if (err.message?.includes('401')) router.replace('/bank/login');
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (action: () => Promise<any>) => {
    setActionLoading(true);
    try {
      await action();
    } catch (err: any) {
      alert(err.message || 'Action failed');
      setActionLoading(false);
      return;
    }
    // Refresh separately - don't show error if this fails
    try {
      await fetchDetail();
    } catch {
      // Silently ignore refresh errors - action already succeeded
    }
    setNotes('');
    setRejectionReason('');
    setShowReject(false);
    setActionLoading(false);
  };

  const toggleSection = (key: string) =>
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  // ── Loading / not found ──────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex items-center justify-center h-96">
        <p className="text-gray-400">Application not found.</p>
      </div>
    );
  }

  // ── Permissions ──────────────────────────────────────
  const isSupervisor    = user?.role === 'bank_supervisor';
  const canOfficerAct   = ['submitted', 'system_reviewed'].includes(app.status);
  const canSupervisorAct = isSupervisor && ['officer_approved', 'documents_submitted'].includes(app.status);
  const canDisburse     = isSupervisor && app.status === 'approved';

  return (
    <div className="space-y-4 max-w-4xl mx-auto">

      {/* Back + title */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition"
        >
          <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-300" />
        </button>
        <div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">
            {app.customer_name}
          </h2>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-gray-400 font-mono">{app.loan_id}</span>
            <StatusChip status={app.status} size="sm" />
          </div>
        </div>
      </div>

      {/* AI Suggestion */}
      {app.system_suggestion && (
        <div className={`rounded-2xl p-5 border ${
          app.system_suggestion === 'approve'
            ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800/30'
            : app.system_suggestion === 'deny'
            ? 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800/30'
            : 'bg-yellow-50 dark:bg-yellow-900/10 border-yellow-200 dark:border-yellow-800/30'
        }`}>
          <div className="flex items-start gap-3">
            <ClipboardCheck className="w-5 h-5 text-purple-500 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-sm font-semibold text-gray-900 dark:text-white">
                  System Recommendation
                </span>
                <StatusChip status={app.system_suggestion} type="suggestion" size="sm" />
                {app.system_score && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    Score: {app.system_score}/100
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-700 dark:text-gray-300">
                {app.system_suggestion_reason || 'No detailed reason provided'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Personal Details */}
      <Section title="Personal details" icon={User} sectionKey="personal" expanded={expanded.personal} onToggle={toggleSection}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6">
          <Field label="Full name"        value={app.customer_name} />
          <Field label="Phone"            value={app.phone} />
          <Field label="Email"            value={app.email} />
          <Field label="Date of birth"    value={app.date_of_birth} />
          <Field label="Gender"           value={app.gender} />
          <Field label="Marital status"   value={app.marital_status} />
          <Field label="Current address"  value={app.current_address} />
          <Field label="Permanent address" value={app.same_as_current ? 'Same as current' : app.permanent_address} />
          <Field label="Qualification"    value={app.qualification} />
        </div>
      </Section>

      {/* Employment & Financial */}
      <Section title="Employment & financial" icon={Briefcase} sectionKey="employment" expanded={expanded.employment} onToggle={toggleSection}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6">
          <Field label="Employment type"      value={app.employment_type} />
          <Field label="Employer"             value={app.employer_name} />
          <Field label="Designation"          value={app.designation} />
          <Field label="Experience"           value={app.total_work_experience ? `${app.total_work_experience} years` : null} />
          <Field label="Monthly gross income" value={app.monthly_gross_income ? formatCurrency(app.monthly_gross_income) : null} />
          <Field label="Monthly deductions"   value={app.monthly_deductions ? formatCurrency(app.monthly_deductions) : null} />
          <Field label="Existing EMIs"        value={app.monthly_emi_existing ? formatCurrency(app.monthly_emi_existing) : null} />
          <Field label="Net income"           value={app.monthly_net_income ? formatCurrency(app.monthly_net_income) : null} />
        </div>
      </Section>

      {/* Loan Details */}
      <Section title="Loan details" icon={Banknote} sectionKey="loan" expanded={expanded.loan} onToggle={toggleSection}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6">
          <Field label="Loan type"         value={app.loan_type} />
          <Field label="Requested amount"  value={app.loan_amount_requested ? formatCurrency(app.loan_amount_requested) : app.loan_amount ? formatCurrency(app.loan_amount) : null} />
          <Field label="Purpose"           value={app.purpose_of_loan} />
          <Field label="Tenure"            value={app.repayment_period_years ? `${app.repayment_period_years} years` : null} />
          <Field label="Scheme"            value={app.scheme} />
        </div>
      </Section>

      {/* KYC */}
      <Section title="KYC verification" icon={Shield} sectionKey="kyc" expanded={expanded.kyc} onToggle={toggleSection}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            {
              label:     'PAN card',
              verified:  app.pan_verified,
              value:     app.pan_number ? maskPAN(app.pan_number) : 'Not provided',
              timestamp: app.pan_verification_timestamp,
            },
            {
              label:     'Aadhaar',
              verified:  app.aadhaar_verified,
              value:     app.aadhaar_last4 ? maskAadhaar(app.aadhaar_last4) : 'Not provided',
              timestamp: app.aadhaar_verification_timestamp,
            },
          ].map(item => (
            <div key={item.label} className={`p-4 rounded-xl border ${
              item.verified
                ? 'border-green-200 dark:border-green-800/30 bg-green-50 dark:bg-green-900/10'
                : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800'
            }`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {item.label}
                </span>
                {item.verified
                  ? <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  : <XCircle className="w-4 h-4 text-gray-400" />}
              </div>
              <p className="text-sm text-gray-900 dark:text-gray-100">{item.value}</p>
              {item.timestamp && (
                <p className="text-xs text-gray-400 mt-1">
                  Verified: {formatDateTime(item.timestamp)}
                </p>
              )}
            </div>
          ))}
        </div>
      </Section>

      {/* Documents */}
      <Section title="Documents" icon={Upload} sectionKey="documents" expanded={expanded.documents} onToggle={toggleSection}>
        <div className="space-y-2">
          <DocItem label="PAN card"       url={app.pan_card_url} />
          <DocItem label="Aadhaar front"  url={app.aadhaar_front_url} />
          <DocItem label="Aadhaar back"   url={app.aadhaar_back_url} />
          <DocItem label="Photo"          url={app.photo_url} />
          <DocItem label="Income proof"   url={app.income_proof_url} />
          <DocItem label="Bank statement" url={app.bank_statement_url} />
        </div>
      </Section>

      {/* Timeline */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
        <div className="flex items-center gap-3 mb-4">
          <Clock className="w-5 h-5 text-blue-600" />
          <span className="font-semibold text-gray-900 dark:text-white text-sm">
            Status timeline
          </span>
        </div>
        {timeline.length > 0 ? (
          <div className="space-y-3">
            {timeline.map((event, i) => (
              <div key={event.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <div className="w-2.5 h-2.5 rounded-full bg-blue-500 mt-1.5 flex-shrink-0" />
                  {i < timeline.length - 1 && (
                    <div className="w-0.5 flex-1 bg-gray-200 dark:bg-gray-700 mt-1" />
                  )}
                </div>
                <div className="pb-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusChip status={event.to_status} size="sm" />
                    <span className="text-xs text-gray-400">
                      {formatDateTime(event.created_at)}
                    </span>
                  </div>
                  {event.notes && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {event.notes}
                    </p>
                  )}
                  <p className="text-xs text-gray-400 mt-0.5">by {event.actor_type}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-400">No status history available.</p>
        )}
      </div>

      {/* Action Panel */}
      {(canOfficerAct || canSupervisorAct || canDisburse) && (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-5">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-4 text-sm">
            Actions
          </h3>
          <div className="space-y-3">
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add notes (optional)..."
              rows={2}
              className="w-full px-4 py-3 rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 outline-none transition resize-none"
            />

            {showReject && (
              <input
                value={rejectionReason}
                onChange={e => setRejectionReason(e.target.value)}
                placeholder="Rejection reason (required)..."
                className="w-full px-4 py-3 rounded-xl border border-red-300 dark:border-red-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:ring-2 focus:ring-red-500 outline-none transition"
              />
            )}

            <div className="flex flex-wrap gap-2">
              {canOfficerAct && !isSupervisor && (
                <>
                  <Button
                    variant="default"
                    disabled={actionLoading}
                    onClick={() => handleAction(() => officerApprove(token, appId, notes))}
                  >
                    <CheckCircle2 className="w-4 h-4" /> Approve
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={actionLoading}
                    onClick={() => {
                      if (showReject && rejectionReason) {
                        handleAction(() => officerReject(token, appId, notes, rejectionReason));
                      } else {
                        setShowReject(true);
                      }
                    }}
                  >
                    <XCircle className="w-4 h-4" />
                    {showReject ? 'Confirm reject' : 'Reject'}
                  </Button>
                </>
              )}

              {canSupervisorAct && (
                <>
                  <Button
                    variant="default"
                    disabled={actionLoading}
                    onClick={() => handleAction(() => supervisorApprove(token, appId, notes))}
                  >
                    <CheckCircle2 className="w-4 h-4" /> Final approve
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={actionLoading}
                    onClick={() => {
                      if (showReject && rejectionReason) {
                        handleAction(() => supervisorReject(token, appId, notes, rejectionReason));
                      } else {
                        setShowReject(true);
                      }
                    }}
                  >
                    <XCircle className="w-4 h-4" />
                    {showReject ? 'Confirm reject' : 'Reject'}
                  </Button>
                </>
              )}

              {canDisburse && (
                <Button
                  disabled={actionLoading}
                  className="bg-cyan-600 hover:bg-cyan-700"
                  onClick={() => handleAction(() => initiateDisbursement(token, appId, notes))}
                >
                  <Banknote className="w-4 h-4" /> Approve & disburse
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}