'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { API_URL, getApplicationDetail, officerApprove, officerReject, supervisorApprove, supervisorReject, initiateDisbursement, STATUS_LABELS, STATUS_COLORS, SUGGESTION_COLORS, formatCurrency, formatDate, formatDateTime, maskPAN, maskAadhaar } from '@/lib/api';
import { ArrowLeft, User, Briefcase, FileText, ClipboardCheck, CheckCircle2, XCircle, Clock, AlertTriangle, Eye, CreditCard, Shield, Upload, Loader2, ChevronDown, ChevronUp, Banknote } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import { getAccessToken, getCurrentUser, logout as authLogout } from '@/lib/auth';

interface TimelineEvent {
  id: string;
  from_status: string;
  to_status: string;
  changed_by_type: string;
  notes?: string;
  created_at: string;
}

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
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({ personal: true, employment: true, kyc: true, documents: true, ai: true });

  useEffect(() => {
    const t = getAccessToken('bank');
    const u = getCurrentUser('bank');
    if (!t || !u) { router.push('/bank/login'); return; }
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
    } catch (err: any) {
      alert(err.message || 'Action failed');
    } finally { setActionLoading(false); }
  };

  const toggleSection = (key: string) => {
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
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

  const Section = ({ title, icon: Icon, sectionKey, children }: { title: string; icon: any; sectionKey: string; children: React.ReactNode }) => (
    <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm dark:shadow-gray-900/30 overflow-hidden transition-colors">
      <button onClick={() => toggleSection(sectionKey)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition">
        <div className="flex items-center gap-3">
          <Icon className="w-5 h-5 text-blue-600" />
          <span className="font-semibold text-gray-900 dark:text-white">{title}</span>
        </div>
        {expandedSections[sectionKey] ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
      </button>
      {expandedSections[sectionKey] && <div className="px-5 pb-5 border-t border-gray-100 dark:border-gray-700/50 pt-4">{children}</div>}
    </div>
  );

  const Field = ({ label, value }: { label: string; value: any }) => (
    <div className="py-2">
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-sm font-medium text-gray-900 dark:text-gray-100 mt-0.5">{value || '—'}</dd>
    </div>
  );

  const DocItem = ({ label, url }: { label: string; url?: string }) => (
    <div className="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-dark-section rounded-lg">
      <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
      {url ? (
        <a href={`${API_URL}${url}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-blue-600 dark:text-blue-400 text-xs hover:underline">
          <Eye className="w-3.5 h-3.5" /> View
        </a>
      ) : (
        <span className="text-xs text-gray-400">Not uploaded</span>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">
      {/* Header */}
      <div className="bg-white dark:bg-dark-card shadow dark:shadow-gray-900/50 sticky top-0 z-20 transition-colors">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/bank/dashboard')} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition">
              <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-300" />
            </button>
            <div>
              <h1 className="text-lg font-bold text-gray-900 dark:text-white">{app.customer_name}</h1>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">{app.loan_id}</span>
                <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_COLORS[app.status] || ''}`}>
                  {STATUS_LABELS[app.status] || app.status}
                </span>
              </div>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        {/* AI Suggestion Card */}
        {app.system_suggestion && (
          <div className={`rounded-xl p-5 border ${
            app.system_suggestion === 'approve' ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800/30' :
            app.system_suggestion === 'deny' ? 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800/30' :
            'bg-yellow-50 dark:bg-yellow-900/10 border-yellow-200 dark:border-yellow-800/30'
          }`}>
            <div className="flex items-start gap-3">
              <ClipboardCheck className="w-6 h-6 text-purple-500 mt-0.5" />
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">System Recommendation</span>
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${SUGGESTION_COLORS[app.system_suggestion] || ''}`}>
                    {app.system_suggestion.charAt(0).toUpperCase() + app.system_suggestion.slice(1)}
                  </span>
                  {app.system_score && <span className="text-xs text-gray-500 dark:text-gray-400">Score: {app.system_score}/100</span>}
                </div>
                <p className="text-sm text-gray-700 dark:text-gray-300">{app.system_suggestion_reason || 'No detailed reason provided'}</p>
              </div>
            </div>
          </div>
        )}

        {/* Personal Details */}
        <Section title="Personal Details" icon={User} sectionKey="personal">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1">
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
        </Section>

        {/* Employment & Financial */}
        <Section title="Employment & Financial" icon={Briefcase} sectionKey="employment">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1">
            <Field label="Employment Type" value={app.employment_type} />
            <Field label="Employer" value={app.employer_name} />
            <Field label="Designation" value={app.designation} />
            <Field label="Experience" value={app.total_work_experience ? `${app.total_work_experience} years` : null} />
            <Field label="Monthly Gross Income" value={app.monthly_gross_income ? formatCurrency(app.monthly_gross_income) : null} />
            <Field label="Monthly Deductions" value={app.monthly_deductions ? formatCurrency(app.monthly_deductions) : null} />
            <Field label="Existing EMIs" value={app.monthly_emi_existing ? formatCurrency(app.monthly_emi_existing) : null} />
            <Field label="Net Income" value={app.monthly_net_income ? formatCurrency(app.monthly_net_income) : null} />
          </div>
        </Section>

        {/* Loan Details */}
        <Section title="Loan Details" icon={Banknote} sectionKey="loan">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1">
            <Field label="Loan Type" value={app.loan_type} />
            <Field label="Requested Amount" value={app.loan_amount_requested ? formatCurrency(app.loan_amount_requested) : (app.loan_amount ? formatCurrency(app.loan_amount) : null)} />
            <Field label="Purpose" value={app.purpose_of_loan} />
            <Field label="Tenure" value={app.repayment_period_years ? `${app.repayment_period_years} years` : null} />
            <Field label="Scheme" value={app.scheme} />
          </div>
        </Section>

        {/* KYC Verification */}
        <Section title="KYC Verification" icon={Shield} sectionKey="kyc">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className={`p-4 rounded-lg border ${app.pan_verified ? 'border-green-200 dark:border-green-800/30 bg-green-50 dark:bg-green-900/10' : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-dark-section'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">PAN Card</span>
                {app.pan_verified ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-gray-400" />}
              </div>
              <p className="text-sm text-gray-900 dark:text-gray-100">{app.pan_number ? maskPAN(app.pan_number) : 'Not provided'}</p>
              {app.pan_verification_timestamp && <p className="text-xs text-gray-400 mt-1">Verified: {formatDateTime(app.pan_verification_timestamp)}</p>}
            </div>
            <div className={`p-4 rounded-lg border ${app.aadhaar_verified ? 'border-green-200 dark:border-green-800/30 bg-green-50 dark:bg-green-900/10' : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-dark-section'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Aadhaar</span>
                {app.aadhaar_verified ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-gray-400" />}
              </div>
              <p className="text-sm text-gray-900 dark:text-gray-100">{app.aadhaar_last4 ? maskAadhaar(app.aadhaar_last4) : 'Not provided'}</p>
              {app.aadhaar_verification_timestamp && <p className="text-xs text-gray-400 mt-1">Verified: {formatDateTime(app.aadhaar_verification_timestamp)}</p>}
            </div>
          </div>
        </Section>

        {/* Documents */}
        <Section title="Documents" icon={Upload} sectionKey="documents">
          <div className="space-y-2">
            <DocItem label="PAN Card" url={app.pan_card_url} />
            <DocItem label="Aadhaar Front" url={app.aadhaar_front_url} />
            <DocItem label="Aadhaar Back" url={app.aadhaar_back_url} />
            <DocItem label="Photo" url={app.photo_url} />
            <DocItem label="Income Proof" url={app.income_proof_url} />
            <DocItem label="Bank Statement" url={app.bank_statement_url} />
          </div>
        </Section>

        {/* Status Timeline */}
        <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm dark:shadow-gray-900/30 p-5 transition-colors">
          <div className="flex items-center gap-3 mb-4">
            <Clock className="w-5 h-5 text-blue-600" />
            <span className="font-semibold text-gray-900 dark:text-white">Status Timeline</span>
          </div>
          {timeline.length > 0 ? (
            <div className="space-y-3">
              {timeline.map((event, i) => (
                <div key={event.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className="w-2.5 h-2.5 rounded-full bg-blue-500 mt-1.5" />
                    {i < timeline.length - 1 && <div className="w-0.5 flex-1 bg-gray-200 dark:bg-gray-700 mt-1" />}
                  </div>
                  <div className="pb-4">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_COLORS[event.to_status] || ''}`}>
                        {STATUS_LABELS[event.to_status] || event.to_status}
                      </span>
                      <span className="text-xs text-gray-400">{formatDateTime(event.created_at)}</span>
                    </div>
                    {event.notes && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{event.notes}</p>}
                    <p className="text-xs text-gray-400 mt-0.5">by {event.changed_by_type}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400">No status history available</p>
          )}
        </div>

        {/* Action Panel */}
        {(canOfficerAct || canSupervisorAct || canDisburse) && (
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm dark:shadow-gray-900/30 p-5 transition-colors">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">Actions</h3>
            <div className="space-y-3">
              <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Add notes (optional)..."
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 dark:bg-dark-input dark:text-gray-100 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" rows={2} />

              {showReject && (
                <input value={rejectionReason} onChange={e => setRejectionReason(e.target.value)} placeholder="Rejection reason (required)..."
                  className="w-full px-4 py-3 border border-red-300 dark:border-red-700 dark:bg-dark-input dark:text-gray-100 rounded-lg text-sm focus:ring-2 focus:ring-red-500 outline-none" />
              )}

              <div className="flex flex-wrap gap-2">
                {canOfficerAct && (
                  <>
                    <button onClick={() => handleAction(() => officerApprove(token, appId, notes))} disabled={actionLoading}
                      className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-1">
                      {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve
                    </button>
                    <button onClick={() => { if (showReject && rejectionReason) handleAction(() => officerReject(token, appId, notes, rejectionReason)); else setShowReject(true); }} disabled={actionLoading}
                      className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-1">
                      {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />} {showReject ? 'Confirm Reject' : 'Reject'}
                    </button>
                  </>
                )}

                {canSupervisorAct && (
                  <>
                    <button onClick={() => handleAction(() => supervisorApprove(token, appId, notes))} disabled={actionLoading}
                      className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1">
                      <CheckCircle2 className="w-4 h-4" /> Final Approve
                    </button>
                    <button onClick={() => { if (showReject && rejectionReason) handleAction(() => supervisorReject(token, appId, notes, rejectionReason)); else setShowReject(true); }} disabled={actionLoading}
                      className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-1">
                      <XCircle className="w-4 h-4" /> {showReject ? 'Confirm Reject' : 'Reject'}
                    </button>
                  </>
                )}
                {canDisburse && (
                  <button onClick={() => handleAction(() => initiateDisbursement(token, appId, notes))} disabled={actionLoading}
                    className="px-4 py-2 bg-cyan-600 text-white text-sm font-medium rounded-lg hover:bg-cyan-700 disabled:opacity-50 flex items-center gap-1">
                    <Banknote className="w-4 h-4" /> Approve & Disburse
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
