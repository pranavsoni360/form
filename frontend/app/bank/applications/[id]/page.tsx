'use client';

// Bank application detail + decision screen — Finix design migration (Job 2).
//
// HIGHEST-RISK SCREEN IN THE MIGRATION: this is where money decisions happen.
// Every permission predicate, handler and two-step confirmation below is copied
// VERBATIM from the legacy page. Only presentation changed.
//
// NO FEATURE LOSS — the acceptance checklist for this screen:
//  - Auth gate (token+user, redirect to /bank/login) and the 401 branch in
//    fetchDetail.
//  - The FIVE permission predicates, unchanged and still derived from role +
//    status: canOfficerAct, canSupervisorAct, canDisburse, canCancel, canAct.
//  - All six tabs (overview / personal / employment / loan / kyc / notes) and
//    their per-tab "n of m filled" counts, computed by the same `filled()` over
//    the same field lists.
//  - Two-step reject: first click reveals the reason input, second click submits
//    ONLY if a reason is present. Same for cancel (reason optional there).
//  - officerApprove / officerReject / supervisorApprove / supervisorReject /
//    initiateDisbursement / cancelApplication all still called with the same
//    args, still through handleAction (which refetches and clears the inputs).
//  - Notes textarea feeds every approve/reject call.
//  - The supervisor-only "Approve" is still suppressed when canDisburse, so the
//    two never render together.
//  - Conditional sections: guarantor block, consumer-durable product/dealer
//    block, the 7th document row for consumer_durable, and the supervisor-only
//    AssignVendorPanel.
//  - LRSScorePanel with canRescore={isOfficer}; document links to API_URL+url
//    with target=_blank rel=noopener; masked PAN/Aadhaar; verification
//    timestamps.
//  - Loading and not-found states.
//  - Bottom padding reserved when the action bar shows, so the last row is never
//    hidden behind it.
//
// DEFERRED, deliberately: LRSScorePanel and AssignVendorPanel keep their own
// legacy styling for now. They are self-contained and carry mutation logic
// (rescore, assign, withdraw); restyling their internals is separate work. They
// are wrapped in Finix cards so the page frame is consistent.

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  API_URL, getApplicationDetail, officerApprove, officerReject, supervisorApprove,
  supervisorReject, initiateDisbursement, cancelApplication, STATUS_LABELS,
  formatCurrency, formatDate, formatDateTime, maskPAN, maskAadhaar,
} from '@/lib/api';
import { getAccessToken, getCurrentUser } from '@/lib/auth';
import { AssignVendorPanel } from '@/components/bank/AssignVendorPanel';
import { LRSScorePanel } from '@/components/bank/LRSScorePanel';
import { BankStatementPanel } from '@/components/bank/BankStatementPanel';
import { BankUserShell } from '../../_shell/BankUserShell';
import {
  Toolbar,
  Breadcrumb,
  PageTitle,
  Button,
  Card,
  CardHeader,
  CardBody,
  Pill,
  Tabs,
  DecisionBar,
  DataField,
  DataGrid,
  Input,
  Textarea,
  Progress,
  AppStatusPill,
  SuggestionPill,
  LoadingState,
  EmptyState,
  type TabDef,
} from '@/components/finix';

interface TimelineEvent {
  id: string;
  from_status: string;
  to_status: string;
  changed_by_type: string;
  notes?: string;
  created_at: string;
}

type TabId = 'overview' | 'personal' | 'employment' | 'loan' | 'kyc' | 'notes';

const TAB_DEFS: { id: TabId; label: string; glyph: string }[] = [
  { id: 'overview',   label: 'Overview',   glyph: '▤' },
  { id: 'personal',   label: 'Personal',   glyph: '◍' },
  { id: 'employment', label: 'Employment', glyph: '◫' },
  { id: 'loan',       label: 'Loan',       glyph: '₹' },
  { id: 'kyc',        label: 'KYC & docs', glyph: '◈' },
  { id: 'notes',      label: 'Notes',      glyph: '✎' },
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

  useEffect(() => {
    const t = getAccessToken('bank');
    const u = getCurrentUser('bank');
    if (!t || !u) { router.push('/bank/login'); return; }
    setToken(t);
    setUser(u);
  }, []);

  useEffect(() => { if (token) fetchDetail(); }, [token]);

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
      <BankUserShell>
        <Card><LoadingState label="Loading application…" rows={8} /></Card>
      </BankUserShell>
    );
  }

  if (!app) {
    return (
      <BankUserShell>
        <Card>
          <EmptyState
            title="Application not found"
            description="It may have been withdrawn, or you may not have access to it."
            action={<Button variant="quiet" onClick={() => router.push('/bank/dashboard')}>Back to my queue</Button>}
          />
        </Card>
      </BankUserShell>
    );
  }

  // ── Permission predicates — COPIED VERBATIM. Do not reinterpret. ──────────
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

  const tabs: TabDef<TabId>[] = TAB_DEFS.map(t => ({
    id: t.id, label: t.label, glyph: t.glyph, count: tabCounts[t.id],
  }));

  const kycVerified = [app.pan_verified, app.aadhaar_verified].filter(Boolean).length;
  const kycPending  = kycVerified < 2;

  const requestedAmount = app.loan_amount_requested
    ? formatCurrency(app.loan_amount_requested)
    : app.loan_amount ? formatCurrency(app.loan_amount) : '—';

  const statsFacts = [
    { label: 'Requested', value: requestedAmount, large: true },
    { label: 'Product',   value: app.consumer_loan_type === 'consumer_durable' ? 'Consumer durable' : app.consumer_loan_type === 'personal_loan' ? 'Personal loan' : '—' },
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

  const docs: { label: string; url?: string }[] = [
    { label: 'PAN card', url: app.pan_card_url },
    { label: 'Aadhaar front', url: app.aadhaar_front_url },
    { label: 'Aadhaar back', url: app.aadhaar_back_url },
    { label: 'Photo', url: app.photo_url },
    { label: 'Income proof', url: app.income_proof_url },
    { label: 'Bank statement', url: app.bank_statement_url },
    // 7th row only for consumer durable — same condition as the legacy page.
    ...(app.consumer_loan_type === 'consumer_durable' ? [{ label: 'Dealer quotation', url: app.quotation_url }] : []),
  ];
  const docsUploaded = docs.filter(d => d.url).length;

  const DocRow = ({ label, url }: { label: string; url?: string }) => (
    <div className="flex items-center gap-3 border-b border-fx-border px-3.5 py-2.5 last:border-0">
      <span className="fx-mono text-[12px] text-fx-text3" aria-hidden>▤</span>
      <span className="min-w-0 flex-1 text-[13px] text-fx-text2">{label}</span>
      {url ? (
        <a
          href={`${API_URL}${url}`}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[12px] transition-colors hover:underline"
          style={{ color: 'var(--fx-accent)' }}
        >
          View ↗
        </a>
      ) : (
        <span className="shrink-0 text-[11px] text-fx-text3">Not uploaded</span>
      )}
    </div>
  );

  const IdentityRow = ({
    label, verified, masked, timestamp,
  }: { label: string; verified?: boolean; masked?: string | null; timestamp?: string }) => (
    <div className="flex items-center gap-3 border-b border-fx-border p-3.5 last:border-0">
      <span
        className="fx-mono grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[8px] text-[12px]"
        style={{
          background: verified ? 'var(--fx-green-tint)' : 'var(--fx-amber-tint)',
          color: verified ? 'var(--fx-green)' : 'var(--fx-amber)',
        }}
        aria-hidden
      >
        {verified ? '✓' : '!'}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-[13px] text-fx-text">{label}</div>
        <div className="fx-mono text-[11px] text-fx-text3">{masked || 'Not provided'}</div>
        {timestamp && <div className="text-[10px] text-fx-text3">Verified {formatDateTime(timestamp)}</div>}
      </div>
    </div>
  );

  return (
    <BankUserShell>
      {/* Space for the fixed decision bar so the last row is never hidden. */}
      <div style={{ paddingBottom: canAct ? 72 : 0 }} className="space-y-4">
        <Toolbar
          left={<Breadcrumb>applications / {app.loan_id}</Breadcrumb>}
          right={
            <Button variant="quiet" onClick={() => router.push('/bank/dashboard')}>
              ← My queue
            </Button>
          }
        />

        <div className="flex flex-wrap items-start gap-3">
          <span
            className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] text-[14px] font-medium"
            style={{ background: 'var(--fx-accent-tint)', color: 'var(--fx-accent)' }}
          >
            {(app.customer_name || 'U')[0].toUpperCase()}
          </span>
          <div className="min-w-0">
            <PageTitle title={app.customer_name} subtitle={<span className="fx-mono">{app.loan_id}</span>} />
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <AppStatusPill status={app.status} />
            {kycPending
              ? <Pill tone="amber">KYC pending</Pill>
              : <Pill tone="green">KYC verified</Pill>}
          </div>
        </div>

        {/* Facts strip */}
        <Card>
          <DataGrid min={150}>
            {statsFacts.map((f) => (
              <div key={f.label} className="flex min-w-0 flex-col gap-1 p-3.5">
                <span className="text-[10px] uppercase tracking-[0.12em] text-fx-text3">{f.label}</span>
                <span
                  className={f.large ? 'text-[20px] font-medium leading-none' : 'text-[13px]'}
                  style={{ color: f.warn ? 'var(--fx-amber)' : 'var(--fx-text)' }}
                >
                  {f.value}
                </span>
              </div>
            ))}
          </DataGrid>
        </Card>

        <Tabs tabs={tabs} value={activeTab} onChange={setActiveTab} />

        {/* ── OVERVIEW ─────────────────────────────────────────────────── */}
        {activeTab === 'overview' && (
          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Credit assessment"
                right={<Button variant="quiet" onClick={fetchDetail}>Re-run</Button>}
              />
              {app.system_suggestion ? (
                <CardBody className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] text-fx-text">System recommendation</span>
                    <SuggestionPill suggestion={app.system_suggestion} />
                    {app.system_score != null && (
                      <span className="fx-mono text-[11px] text-fx-text3">Score {app.system_score}/100</span>
                    )}
                  </div>
                  <p className="text-[12px] leading-relaxed text-fx-text2">
                    {app.system_suggestion_reason || 'No detailed reason provided'}
                  </p>
                </CardBody>
              ) : (
                <CardBody>
                  <div className="text-[13px] text-fx-text2">No assessment yet</div>
                  <div className="mt-1 text-[11px] text-fx-text3">Needs income proof and KYC on file.</div>
                </CardBody>
              )}
              {token && (
                <div className="border-t border-fx-border">
                  {/* Legacy-styled panel, deliberately not restyled yet — it owns
                      the rescore mutation. */}
                  <LRSScorePanel token={token} applicationId={appId} canRescore={isOfficer} />
                </div>
              )}
            </Card>

            <div className="space-y-3">
              <Card>
                <CardHeader title="File completeness" />
                <CardBody className="space-y-3">
                  {progressItems.map(p => (
                    <Progress
                      key={p.label}
                      value={p.total ? p.have / p.total : 0}
                      label={`${p.label} · ${p.have} of ${p.total}`}
                      tone={p.have === 0 ? 'amber' : 'accent'}
                      showPct={false}
                    />
                  ))}
                </CardBody>
              </Card>

              {/* Bank statement analysis — the real source for the cash-flow
                  pillar, which is otherwise scored on mock data. */}
              <BankStatementPanel applicationId={appId} />

              <Card>
                <CardHeader title="Status timeline" qualifier={`${timeline.length} events`} />
                {timeline.length > 0 ? (
                  <CardBody className="space-y-0">
                    {timeline.map((event, i) => (
                      <div key={event.id} className="grid gap-3" style={{ gridTemplateColumns: '10px 1fr' }}>
                        <div className="flex flex-col items-center">
                          <span
                            className="mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full"
                            style={{ background: 'var(--fx-accent)' }}
                          />
                          {i < timeline.length - 1 && <span className="min-h-3 w-px flex-1 bg-fx-border" />}
                        </div>
                        <div className="min-w-0 pb-3.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <AppStatusPill status={event.to_status} />
                            <span className="fx-mono text-[10px] text-fx-text3">{formatDateTime(event.created_at)}</span>
                          </div>
                          {event.notes && <div className="mt-1 text-[12px] text-fx-text2">{event.notes}</div>}
                          <div className="mt-0.5 text-[10px] text-fx-text3">by {event.changed_by_type}</div>
                        </div>
                      </div>
                    ))}
                  </CardBody>
                ) : (
                  <EmptyState title="No status history" description="Nothing has changed on this application yet." />
                )}
              </Card>
            </div>
          </div>
        )}

        {/* ── PERSONAL ─────────────────────────────────────────────────── */}
        {activeTab === 'personal' && (
          <Card>
            <CardHeader title="Personal details" qualifier={`${filled(personalFields)} of 9 filled`} />
            <DataGrid>
              <DataField label="Full name" value={app.customer_name} />
              <DataField label="Phone" value={app.phone} />
              <DataField label="Email" value={app.email} />
              <DataField label="Date of birth" value={app.date_of_birth} />
              <DataField label="Gender" value={app.gender} />
              <DataField label="Marital status" value={app.marital_status} />
              <DataField label="Current address" value={app.current_address} />
              <DataField label="Permanent address" value={app.same_as_current ? 'Same as current' : app.permanent_address} />
              <DataField label="Qualification" value={app.qualification_label || app.qualification} />
            </DataGrid>
          </Card>
        )}

        {/* ── EMPLOYMENT ───────────────────────────────────────────────── */}
        {activeTab === 'employment' && (
          <div className="space-y-3">
            <Card>
              <CardHeader title="Employment & financial" qualifier={`${filled(employmentFields)} of 8 filled`} />
              <DataGrid>
                <DataField label="Employment type" value={app.employment_type_label || app.employment_type} />
                <DataField label="Employer" value={app.employer_name} />
                <DataField label="Designation" value={app.designation} />
                <DataField label="Experience" value={app.total_work_experience ? `${app.total_work_experience} years` : null} />
                <DataField label="Monthly gross income" value={app.monthly_gross_income ? formatCurrency(app.monthly_gross_income) : null} />
                <DataField label="Monthly deductions" value={app.monthly_deductions ? formatCurrency(app.monthly_deductions) : null} />
                <DataField label="Existing EMIs" value={app.monthly_emi_existing ? formatCurrency(app.monthly_emi_existing) : null} />
                <DataField label="Net income" value={app.monthly_net_income ? formatCurrency(app.monthly_net_income) : null} />
              </DataGrid>
            </Card>

            {/* Same condition as legacy: only when any guarantor field exists. */}
            {(app.guarantor_name || app.guarantor_phone || app.guarantor_consent) && (
              <Card>
                <CardHeader title="Guarantor details" />
                <DataGrid>
                  <DataField label="Guarantor name" value={app.guarantor_name} />
                  <DataField label="Guarantor phone" value={app.guarantor_phone} />
                  <DataField
                    label="Consent"
                    value={
                      app.guarantor_consent === 'yes' ? 'Yes' :
                      app.guarantor_consent === 'no' ? 'No' :
                      app.guarantor_consent === 'no_answer' ? 'No answer' :
                      app.guarantor_consent === 'pending' ? 'Pending' : null
                    }
                  />
                </DataGrid>
              </Card>
            )}
          </div>
        )}

        {/* ── LOAN ─────────────────────────────────────────────────────── */}
        {activeTab === 'loan' && (
          <div className="space-y-3">
            <Card>
              <CardHeader title="Loan details" qualifier={`${filled(loanFields)} of 5 filled`} />
              <DataGrid>
                <DataField label="Loan type" value={app.consumer_loan_type === 'consumer_durable' ? 'Consumer durable' : 'Personal loan'} />
                <DataField label="Requested amount" value={requestedAmount === '—' ? null : requestedAmount} />
                <DataField label="Purpose" value={app.purpose_of_loan_label || app.purpose_of_loan} />
                <DataField label="Tenure" value={app.repayment_period_years ? `${app.repayment_period_years} years` : null} />
                <DataField label="Scheme" value={app.scheme} />
              </DataGrid>
            </Card>

            {app.consumer_loan_type === 'consumer_durable' && (
              <Card>
                <CardHeader title="Product & dealer details" />
                <DataGrid>
                  <DataField label="Product name" value={app.product_name} />
                  <DataField label="Brand" value={app.brand} />
                  <DataField label="Model number" value={app.model_number} />
                  <DataField label="Quotation amount" value={app.quotation_amount ? formatCurrency(app.quotation_amount) : null} />
                  <DataField label="Dealer name" value={app.dealer_name} />
                  <DataField label="Dealer address" value={app.dealer_address} />
                </DataGrid>
              </Card>
            )}
          </div>
        )}

        {/* ── KYC & DOCS ───────────────────────────────────────────────── */}
        {activeTab === 'kyc' && (
          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Identity documents"
                right={kycPending
                  ? <Pill tone="amber">{kycVerified} of 2 verified</Pill>
                  : <Pill tone="green">{kycVerified} of 2 verified</Pill>}
              />
              <IdentityRow
                label="PAN card"
                verified={app.pan_verified}
                masked={app.pan_number ? maskPAN(app.pan_number) : null}
                timestamp={app.pan_verification_timestamp}
              />
              <IdentityRow
                label="Aadhaar"
                verified={app.aadhaar_verified}
                masked={app.aadhaar_last4 ? maskAadhaar(app.aadhaar_last4) : null}
                timestamp={app.aadhaar_verification_timestamp}
              />
            </Card>

            <Card>
              <CardHeader title="Documents" qualifier={`${docsUploaded} of ${docs.length} uploaded`} />
              {docs.map(d => <DocRow key={d.label} label={d.label} url={d.url} />)}
            </Card>
          </div>
        )}

        {/* ── NOTES ────────────────────────────────────────────────────── */}
        {activeTab === 'notes' && (
          <Card className="max-w-2xl">
            <CardHeader title="Officer notes" />
            <CardBody className="space-y-2">
              <Textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Add a note for the file…"
                rows={5}
              />
              <span className="text-[11px] text-fx-text3">
                Notes are included with any approval or rejection action.
              </span>
            </CardBody>
          </Card>
        )}

        {isSupervisor && (
          <Card>
            <CardHeader title="Vendor assignment" />
            {/* Legacy-styled panel, deliberately not restyled yet — it owns the
                assign/withdraw mutations. */}
            <AssignVendorPanel token={token} applicationId={appId} applicationStatus={app.status} />
          </Card>
        )}
      </div>

      {/* ── FIXED DECISION BAR ─────────────────────────────────────────── */}
      {canAct && (
        <DecisionBar
          title="Awaiting your decision"
          detail={`${kycPending ? 'KYC incomplete · ' : ''}${STATUS_LABELS[app.status] || app.status}`}
        >
          {/* Two-step reject: the input only appears after the first click, and
              submit requires a reason — same as legacy. */}
          {showReject && (
            <Input
              value={rejectionReason}
              onChange={e => setRejectionReason(e.target.value)}
              placeholder="Rejection reason…"
              invalid
              className="w-[200px]"
            />
          )}
          {showCancel && (
            <Input
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
              placeholder="Cancellation reason (optional)…"
              className="w-[220px]"
            />
          )}

          {canOfficerAct && (
            <>
              <Button
                variant="quiet"
                disabled={actionLoading}
                onClick={() => {
                  if (showReject && rejectionReason) handleAction(() => officerReject(token, appId, notes, rejectionReason));
                  else setShowReject(s => !s);
                }}
              >
                {showReject ? 'Confirm reject' : 'Reject'}
              </Button>
              <Button
                variant="primary"
                disabled={actionLoading}
                onClick={() => handleAction(() => officerApprove(token, appId, notes))}
              >
                {actionLoading ? 'Working…' : 'Approve'}
              </Button>
            </>
          )}

          {canSupervisorAct && (
            <>
              <Button
                variant="quiet"
                disabled={actionLoading}
                onClick={() => {
                  if (showReject && rejectionReason) handleAction(() => supervisorReject(token, appId, notes, rejectionReason));
                  else setShowReject(s => !s);
                }}
              >
                {showReject ? 'Confirm reject' : 'Reject'}
              </Button>
              {/* Suppressed when canDisburse so the two never render together. */}
              {!canDisburse && (
                <Button
                  variant="primary"
                  disabled={actionLoading}
                  onClick={() => handleAction(() => supervisorApprove(token, appId, notes))}
                >
                  {actionLoading ? 'Working…' : 'Approve'}
                </Button>
              )}
            </>
          )}

          {canDisburse && (
            <Button
              variant="primary"
              disabled={actionLoading}
              onClick={() => handleAction(() => initiateDisbursement(token, appId, notes))}
            >
              {actionLoading ? 'Working…' : 'Approve & disburse'}
            </Button>
          )}

          {canCancel && (
            <Button
              variant="danger"
              disabled={actionLoading}
              onClick={() => {
                if (showCancel) handleAction(() => cancelApplication(token, appId, cancelReason));
                else setShowCancel(s => !s);
              }}
            >
              {showCancel ? 'Confirm cancel' : 'Cancel'}
            </Button>
          )}
        </DecisionBar>
      )}
    </BankUserShell>
  );
}
