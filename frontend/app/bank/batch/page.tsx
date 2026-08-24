'use client';

// Bank batch calling — Finix design migration (Job 2).
//
// This is the most behaviour-dense screen in /bank/*: it streams, polls, uploads
// in two steps, and fires six mutating actions. ALL of that logic is copied
// verbatim; only presentation moved.
//
// NO FEATURE LOSS — the acceptance checklist:
//  - Auth gate + bank_id capture from the cached user.
//  - Phone-pool load from /api/ops/phone-pools with the TRUNK_PROVIDERS map, the
//    active-only filter, phone sort, and the per-bank localStorage default
//    (`bank_default_phone_<bankId>`) including writing it on first load.
//  - dateQS() shared by BOTH the uploads and batch-status fetches so they scope
//    together, and the date range re-fetches both.
//  - useEventStream('batches', …) SSE + the 500ms debounced status refetch when
//    live batches change.
//  - Auto-poll every 5s WHILE active_calls > 0 or pending > 0, and the
//    window-focus refetch. Both are how a hung batch becomes visible.
//  - "Updated Ns ago" ticker.
//  - Two-step upload: preview (commit=false) -> BatchPreviewModal -> confirm
//    (commit=true, same File re-sent). Cancel clears both.
//  - uploadParams() carries language/gender/agent_type/bank_id/phone_number_id.
//  - All six actions with their window.confirm() guards where they had them
//    (Start Batch and Emergency Stop), their per-action busy flags, and their
//    notify() messages: triggerBatch, emergencyStop, retryFailed (which REQUIRES
//    an expanded batch and says so), cleanupStuck, resumeCalling, refresh.
//  - Both blocked-reason banners — emergency_stop (with inline Resume) and
//    outside_calling_hours (with the calling window) — plus batchStatus.message.
//  - Six live counters.
//  - Expandable batch rows that lazy-load their calls once and cache them, with
//    the per-row loading state and the scrollable call list.
//  - Transient notice banner (4s auto-dismiss).

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL, formatDateTime } from '@/lib/api';
import { getAccessToken, getCurrentUser } from '@/lib/auth';
import DateRangeFilter, { DateRangeValue, DEFAULT_RANGE } from '@/components/DateRangeFilter';
import { useEventStream } from '@/lib/realtime/useEventStream';
import { batchesReducer, initialBatchesState, type BatchesState } from '@/lib/realtime/reducers';
import { BatchPreviewModal, type BatchReport } from '@/components/shared/BatchPreviewModal';
import { BankUserShell } from '../_shell/BankUserShell';
import {
  Toolbar,
  PeriodChip,
  Breadcrumb,
  PageTitle,
  Button,
  Card,
  CardHeader,
  CardBody,
  MetricCard,
  Field,
  Select,
  Dropzone,
  LiveDot,
  BatchStatusPill,
  FormDeliveryMark,
  InterestPill,
  LoadingState,
  EmptyState,
} from '@/components/finix';

export default function BatchPage() {
  const router = useRouter();

  const [token, setToken]   = useState('');
  const [bankId, setBankId] = useState('');
  const [batches, setBatches]         = useState<any[]>([]);
  const [batchStatus, setBatchStatus] = useState<any>(null);
  const [loading, setLoading]         = useState(true);
  const [uploading, setUploading]     = useState(false);
  const [preview, setPreview]         = useState<BatchReport | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [confirming, setConfirming]   = useState(false);
  const [language, setLanguage]       = useState('hindi');
  const [gender, setGender]           = useState('male');
  const [agentType, setAgentType]     = useState('loan_enquiry');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [phoneOptions, setPhoneOptions]   = useState<{ id: string; phone: string; provider: string; trunkId: string }[]>([]);
  const [phoneDropdownOpen, setPhoneDropdownOpen] = useState(false);
  const phoneDropdownRef = useRef<HTMLDivElement>(null);
  const [starting, setStarting]   = useState(false);
  const [stopping, setStopping]   = useState(false);
  const [retrying, setRetrying]   = useState(false);
  const [cleaning, setCleaning]   = useState(false);
  const [resuming, setResuming]   = useState(false);
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secondsAgo, setSecondsAgo]   = useState(0);
  const [refreshing, setRefreshing]       = useState(false);
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null);
  const [batchCalls, setBatchCalls]       = useState<Record<string, any[]>>({});
  const [loadingCalls, setLoadingCalls]   = useState<string | null>(null);
  const [dateRange, setDateRange]         = useState<DateRangeValue>(DEFAULT_RANGE);

  // Build the ?date_from&date_to query suffix from the active range (empty when
  // "All"), shared by the uploads + batch-status fetches so both scope together.
  const dateQS = useCallback(() => {
    const p = new URLSearchParams();
    if (dateRange.from) p.set('date_from', dateRange.from);
    if (dateRange.to) p.set('date_to', dateRange.to);
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [dateRange.from, dateRange.to]);

  const liveBatches = useEventStream<BatchesState>('batches', batchesReducer, initialBatchesState);

  const notify = useCallback((msg: string, ok = true) => {
    setNotice({ msg, ok });
    setTimeout(() => setNotice(null), 4000);
  }, []);

  useEffect(() => {
    const t = getAccessToken('bank');
    const u = getCurrentUser('bank') as any;
    if (!t || !u) { router.push('/bank/login'); return; }
    setToken(t);
    setBankId(u.bank_id || '');

    const TRUNK_PROVIDERS: Record<string, string> = {
      'ST_pTYcg7Az9q8R': 'Vobiz',
      'ST_7AXVHfHRbCwP': 'Viva India',
    };
    const providerFromTrunk = (trunkId: string, phone: string) => {
      if (trunkId && TRUNK_PROVIDERS[trunkId]) return TRUNK_PROVIDERS[trunkId];
      if (phone.startsWith('+1')) return 'Twilio US';
      return '';
    };

    const savedDefault = localStorage.getItem(`bank_default_phone_${u.bank_id || 'default'}`);
    fetch(`${API_URL}/api/ops/phone-pools`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        const opts: { id: string; phone: string; provider: string; trunkId: string }[] = [];
        for (const pool of data.pools ?? []) {
          for (const n of pool.numbers ?? []) {
            if (!n.phone_number || n.status !== 'active') continue;
            opts.push({ id: n.id, phone: n.phone_number, trunkId: n.livekit_trunk_id || '',
              provider: providerFromTrunk(n.livekit_trunk_id || '', n.phone_number) });
          }
        }
        const sorted = opts.sort((a, b) => a.phone.localeCompare(b.phone));
        setPhoneOptions(sorted);
        if (savedDefault && sorted.some(o => o.id === savedDefault)) setPhoneNumberId(savedDefault);
        else if (sorted.length > 0) {
          setPhoneNumberId(sorted[0].id);
          localStorage.setItem(`bank_default_phone_${u.bank_id || 'default'}`, sorted[0].id);
        }
      }).catch(() => {});
  }, []);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const fetchBatches = useCallback(async (tok = token) => {
    if (!tok) return;
    setLoading(true);
    try {
      const res  = await fetch(`${API_URL}/api/agent/uploads${dateQS()}`, { headers: { Authorization: `Bearer ${tok}` }, credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBatches(data.uploads || []);
      setLoadError(null);
    } catch (e) {
      // Without this the list said 'No batches uploaded yet' to a bank that
      // has hundreds.
      setLoadError(e instanceof Error ? e.message : 'Could not load batches');
    } finally { setLoading(false); }
  }, [token, dateQS]);

  const fetchStatus = useCallback(async (tok = token) => {
    if (!tok) return;
    try {
      const res = await fetch(`${API_URL}/api/agent/batch-status${dateQS()}`, { headers: { Authorization: `Bearer ${tok}` }, credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setBatchStatus(await res.json());
      setLastUpdated(new Date());
      setStatusError(null);
    } catch (e) {
      // The whole live-status card is gated on `batchStatus`, so a swallowed
      // failure took the six counters, the emergency-stop banner and the
      // outside-calling-hours banner off screen with no message - an operator
      // could not tell a hung batch from a failed poll.
      setStatusError(e instanceof Error ? e.message : 'Could not load batch status');
    }
  }, [token, dateQS]);

  const fetchBatchCalls = async (batchId: string) => {
    setLoadingCalls(batchId);
    try {
      const res  = await fetch(`${API_URL}/api/agent/upload/${batchId}`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' });
      const data = await res.json();
      setBatchCalls(prev => ({ ...prev, [batchId]: data.calls || [] }));
    } catch { notify('Failed to load call details', false); }
    finally { setLoadingCalls(null); }
  };

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.all([fetchBatches(), fetchStatus()]); }
    finally { setRefreshing(false); }
  }, [fetchBatches, fetchStatus]);

  useEffect(() => { if (token) { fetchBatches(token); fetchStatus(token); } }, [token, dateRange.from, dateRange.to]);
  useEffect(() => {
    if (!token || Object.keys(liveBatches.byId).length === 0) return;
    const t = setTimeout(() => fetchStatus(token), 500);
    return () => clearTimeout(t);
  }, [token, liveBatches.byId]);
  useEffect(() => {
    if (!token) return;
    const onFocus = () => fetchStatus(token);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [token]);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (phoneDropdownRef.current && !phoneDropdownRef.current.contains(e.target as Node))
        setPhoneDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Auto-poll every 5s while calls are active or pending
  useEffect(() => {
    if (!token) return;
    const isLiveNow = (batchStatus?.active_calls ?? 0) > 0 || (batchStatus?.pending ?? 0) > 0;
    if (!isLiveNow) return;
    const id = setInterval(() => fetchStatus(token), 5000);
    return () => clearInterval(id);
  }, [token, batchStatus?.active_calls, batchStatus?.pending, fetchStatus]);

  // Tick "X seconds ago" counter
  useEffect(() => {
    if (!lastUpdated) return;
    const id = setInterval(() => setSecondsAgo(Math.floor((Date.now() - lastUpdated.getTime()) / 1000)), 1000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  const uploadParams = (commit: boolean) => new URLSearchParams({
    language, gender, agent_type: agentType, commit: String(commit),
    ...(bankId        ? { bank_id: bankId }                : {}),
    ...(phoneNumberId ? { phone_number_id: phoneNumberId } : {}),
  });

  // Step 1 — preview: parse + preprocess the file WITHOUT queuing any calls.
  // Dropzone hands us the File directly (the legacy version read it off the
  // input event); the request and the two-step flow are otherwise identical.
  const handleUpload = async (file: File) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_URL}/api/agent/upload-excel?${uploadParams(false)}`, {
        method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` }, credentials: 'include',
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || `Upload failed (${res.status})`); }
      const report: BatchReport = await res.json();
      setPendingFile(file);
      setPreview(report);
    } catch (err: any) { notify(err.message || 'Upload failed', false); }
    finally { setUploading(false); }
  };

  // Step 2 — confirm: re-send the same file with commit=true to queue + call.
  const confirmUpload = async () => {
    if (!pendingFile) return;
    setConfirming(true);
    try {
      const fd = new FormData();
      fd.append('file', pendingFile);
      const res = await fetch(`${API_URL}/api/agent/upload-excel?${uploadParams(true)}`, {
        method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` }, credentials: 'include',
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || `Upload failed (${res.status})`); }
      const data = await res.json();
      notify(data.message || `Queued ${data.inserted_count ?? '?'} records`);
      setPreview(null);
      setPendingFile(null);
      refresh();
    } catch (err: any) { notify(err.message || 'Upload failed', false); }
    finally { setConfirming(false); }
  };

  const cancelPreview = () => { setPreview(null); setPendingFile(null); };

  const apiPost = async (path: string) => {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, credentials: 'include',
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || `Request failed (${res.status})`); }
    return res.json();
  };

  const triggerBatch = async () => {
    if (!confirm('Start batch calling? This will initiate calls to all pending customers.')) return;
    setStarting(true);
    try { const d = await apiPost(`/api/agent/batch-call${phoneNumberId ? `?phone_number_id=${encodeURIComponent(phoneNumberId)}` : ''}`); notify(d.message || 'Batch started'); refresh(); }
    catch (err: any) { notify(err.message, false); } finally { setStarting(false); }
  };
  const emergencyStop = async () => {
    if (!confirm('EMERGENCY STOP: This will terminate ALL active calls immediately.')) return;
    setStopping(true);
    try { await apiPost('/api/agent/emergency-stop'); notify('Emergency stop sent'); refresh(); }
    catch (err: any) { notify(err.message, false); } finally { setStopping(false); }
  };
  const retryFailed   = async () => {
    // Retry only the batch the operator has opened, so failed calls in the
    // right batch are re-dialed (the endpoint otherwise guesses the most-recent
    // completed batch). expandedBatch holds that batch's id.
    if (!expandedBatch) { notify('Open the batch you want to retry (tap its row), then click Retry failed', false); return; }
    setRetrying(true);
    try { notify((await apiPost(`/api/agent/batch-retry?batch_id=${encodeURIComponent(expandedBatch)}`)).message || 'Retrying'); refresh(); }
    catch (e: any) { notify(e.message, false); } finally { setRetrying(false); }
  };
  const cleanupStuck  = async () => { setCleaning(true);  try { notify((await apiPost('/api/agent/stale-cleanup')).message  || 'Cleaned'); refresh(); }  catch (e: any) { notify(e.message, false); } finally { setCleaning(false); } };
  const resumeCalling = async () => { setResuming(true);  try { notify((await apiPost('/api/agent/resume-calling')).message || 'Resumed'); refresh(); }  catch (e: any) { notify(e.message, false); } finally { setResuming(false); } };

  const toggleBatch = (batchId: string) => {
    if (expandedBatch === batchId) { setExpandedBatch(null); return; }
    setExpandedBatch(batchId);
    if (!batchCalls[batchId]) fetchBatchCalls(batchId);
  };

  const isLive = (batchStatus?.active_calls ?? 0) > 0 || (batchStatus?.pending ?? 0) > 0;

  const statItems = [
    { label: 'Active now',   value: batchStatus?.active_calls ?? 0 },
    { label: 'Pending',      value: batchStatus?.pending      ?? 0 },
    { label: 'Completed',    value: batchStatus?.completed    ?? 0 },
    { label: 'Not answered', value: batchStatus?.not_answered ?? 0 },
    { label: 'Failed',       value: batchStatus?.failed       ?? 0 },
    { label: 'Total',        value: batchStatus?.total        ?? 0 },
  ];

  const selectedPhoneLabel = phoneNumberId
    ? (() => { const o = phoneOptions.find(p => p.id === phoneNumberId); return o ? `${o.phone}${o.provider ? ` · ${o.provider}` : ''}` : phoneNumberId; })()
    : 'Auto — pool picks least-loaded';

  const periodLabel = dateRange.from && dateRange.to ? `${dateRange.from} – ${dateRange.to}` : 'All dates';

  return (
    <BankUserShell>
      <BatchPreviewModal report={preview} confirming={confirming} onConfirm={confirmUpload} onCancel={cancelPreview} />

      <Toolbar
        left={<><PeriodChip>{periodLabel}</PeriodChip><Breadcrumb>batch calling</Breadcrumb></>}
        right={
          <>
            <Button variant="quiet" disabled={refreshing} onClick={refresh}>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button variant="primary" disabled={starting} onClick={triggerBatch}>
              {starting ? 'Starting…' : 'Start batch'}
            </Button>
          </>
        }
      />
      <PageTitle title="Batch calling" subtitle="Upload a sheet, trigger calls, monitor progress" />

      {/* Transient notice — 4s auto-dismiss */}
      {notice && (
        <div
          className="rounded-[10px] px-4 py-2.5 text-[13px]"
          style={{
            background: notice.ok ? 'var(--fx-green-tint)' : 'var(--fx-red-tint)',
            color: notice.ok ? 'var(--fx-green)' : 'var(--fx-red)',
          }}
          role="status"
        >
          {notice.msg}
        </div>
      )}

      {/* ── LIVE STATUS ─────────────────────────────────────────────────── */}
      {statusError && (
        <div className="rounded-[12px] border px-3 py-2 text-[13px]"
          style={{ borderColor: "var(--fx-red)", color: "var(--fx-red)", background: "var(--fx-red-tint)" }}>
          {statusError} — live counters are stale. Do not read this as ‘no calls running’.
        </div>
      )}
      {loadError && (
        <div className="rounded-[12px] border px-3 py-2 text-[13px]"
          style={{ borderColor: "var(--fx-red)", color: "var(--fx-red)", background: "var(--fx-red-tint)" }}>
          {loadError} — the batch list could not be loaded.
        </div>
      )}
      {batchStatus && (
        <Card>
          <CardHeader
            title={isLive ? 'Calling — live' : (batchStatus?.pending === 0 && batchStatus?.active_calls === 0 ? 'Idle' : 'Live status')}
            qualifier={lastUpdated ? `updated ${secondsAgo}s ago` : undefined}
            right={<LiveDot state={isLive ? 'open' : 'closed'} />}
          />
          <CardBody className="space-y-3">
            {/* Why isn't a running batch dialing? Make the silent hang visible. */}
            {batchStatus?.blocked_reason === 'emergency_stop' && (
              <div
                className="flex flex-wrap items-center gap-3 rounded-[10px] px-4 py-3 text-[13px]"
                style={{ background: 'var(--fx-red-tint)', color: 'var(--fx-red)' }}
              >
                <span>
                  <b>Emergency stop is active</b> — {batchStatus.pending} pending call{batchStatus.pending === 1 ? '' : 's'} won&apos;t dial until you resume.
                </span>
                <span className="ml-auto">
                  <Button variant="danger" disabled={resuming} onClick={resumeCalling}>
                    {resuming ? 'Resuming…' : 'Resume calling'}
                  </Button>
                </span>
              </div>
            )}
            {batchStatus?.blocked_reason === 'outside_calling_hours' && (
              <div
                className="flex flex-wrap items-center gap-3 rounded-[10px] px-4 py-3 text-[13px]"
                style={{ background: 'var(--fx-amber-tint)', color: 'var(--fx-amber)' }}
              >
                <span>
                  <b>Outside calling hours</b> ({batchStatus.calling_window}) — {batchStatus.pending} pending call{batchStatus.pending === 1 ? '' : 's'} will dial automatically during the window.
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {statItems.map(s => (
                <MetricCard key={s.label} label={s.label} value={s.value} />
              ))}
            </div>

            {batchStatus?.message && (
              <p className="text-[11px] text-fx-text3">{batchStatus.message}</p>
            )}
          </CardBody>
        </Card>
      )}

      {/* ── VOICE CONFIG + UPLOAD ───────────────────────────────────────── */}
      <Card>
        <CardHeader title="Voice config & upload" />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Language" htmlFor="b-lang">
              <Select id="b-lang" value={language} onChange={e => setLanguage(e.target.value)}>
                <option value="hindi">Hindi</option>
                <option value="marathi">Marathi</option>
                <option value="english">English</option>
              </Select>
            </Field>
            <Field label="Voice" htmlFor="b-voice">
              <Select id="b-voice" value={gender} onChange={e => setGender(e.target.value)}>
                <option value="male">Male (Rajesh)</option>
                <option value="female">Female (Diya)</option>
              </Select>
            </Field>
            <Field label="Agent type" htmlFor="b-agent">
              <Select id="b-agent" value={agentType} onChange={e => setAgentType(e.target.value)}>
                <option value="loan_enquiry">Loan enquiry — Pusad Urban</option>
                <option value="account_opening">Account opening — Union Bank</option>
              </Select>
            </Field>

            {/* Custom dropdown, not a <Select>: rows carry a phone + provider +
                "default" badge, which a native option cannot render. */}
            <div className="relative" ref={phoneDropdownRef}>
              <Field label="From number (caller ID)">
                <button
                  type="button"
                  onClick={() => setPhoneDropdownOpen(v => !v)}
                  className="fx-tap flex h-[30px] w-full items-center justify-between gap-2 rounded-[10px] bg-fx-surface2 px-3 text-left text-[13px] text-fx-text"
                >
                  <span className="truncate">{selectedPhoneLabel}</span>
                  <span className="fx-mono shrink-0 text-[10px] text-fx-text3">
                    {phoneDropdownOpen ? '▲' : '▼'}
                  </span>
                </button>
              </Field>
              {phoneDropdownOpen && (
                <div
                  className="fx-menu absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-[12px]"
                  style={{
                    background: 'var(--fx-surface)',
                    boxShadow: 'var(--fx-elevation), inset 0 0 0 1px var(--fx-border)',
                    // fx-menu defaults to top-right origin (built for the row ⋯
                    // popover); this dropdown spans the field, so it opens down.
                    transformOrigin: 'top center',
                  }}
                >
                  {[{ id: '', phone: 'Auto', provider: 'pool picks least-loaded', trunkId: '' }, ...phoneOptions].map((p, i) => {
                    const isSelected = phoneNumberId === p.id;
                    const isDefault  = p.id !== '' && localStorage.getItem(`bank_default_phone_${bankId || 'default'}`) === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setPhoneNumberId(p.id);
                          if (p.id) localStorage.setItem(`bank_default_phone_${bankId || 'default'}`, p.id);
                          setPhoneDropdownOpen(false);
                        }}
                        className={`fx-tap flex w-full items-center gap-2.5 px-3 py-2.5 text-left ${i > 0 ? 'border-t border-fx-border' : ''}`}
                        style={isSelected ? { background: 'var(--fx-accent-tint)' } : undefined}
                      >
                        <span
                          className="grid h-[13px] w-[13px] shrink-0 place-items-center rounded-full"
                          style={{ boxShadow: `inset 0 0 0 1.5px ${isSelected ? 'var(--fx-accent)' : 'var(--fx-border-strong)'}` }}
                        >
                          {isSelected && (
                            <span className="h-[5px] w-[5px] rounded-full" style={{ background: 'var(--fx-accent)' }} />
                          )}
                        </span>
                        <span className="min-w-0 flex-1 leading-tight">
                          <span className="fx-mono block truncate text-[12px] text-fx-text">{p.phone}</span>
                          {p.provider && <span className="block truncate text-[11px] text-fx-text3">{p.provider}</span>}
                        </span>
                        {isDefault && (
                          <span
                            className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]"
                            style={{ background: 'var(--fx-green-tint)', color: 'var(--fx-green)' }}
                          >
                            default
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <Dropzone
            onFile={handleUpload}
            accept=".xlsx,.xls,.csv"
            busy={uploading}
            label="Drop a sheet here or click to browse"
            hint="Excel or CSV — you'll see a preview before any call is queued"
          />

          <p className="text-[11px] text-fx-text3">
            Voice + language are baked into every row at upload time. Existing batches keep their original config.
          </p>
        </CardBody>
      </Card>

      {/* ── SECONDARY ACTIONS ───────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="quiet" disabled={resuming} onClick={resumeCalling}>
          {resuming ? 'Resuming…' : 'Resume'}
        </Button>
        <Button variant="quiet" disabled={retrying} onClick={retryFailed}>
          {retrying ? 'Retrying…' : 'Retry failed'}
        </Button>
        <Button variant="quiet" disabled={cleaning} onClick={cleanupStuck}>
          {cleaning ? 'Cleaning…' : 'Cleanup stuck'}
        </Button>
        <span className="ml-auto">
          <Button variant="danger" disabled={stopping} onClick={emergencyStop}>
            {stopping ? 'Stopping…' : 'Emergency stop'}
          </Button>
        </span>
      </div>

      {/* Date range — scopes BOTH the status counters and the upload history */}
      <DateRangeFilter value={dateRange} onChange={setDateRange} />

      {/* ── UPLOAD HISTORY ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Upload history"
          qualifier={batches.length ? `${batches.length} batches · click a row to view calls` : undefined}
        />
        {loading ? (
          <LoadingState label="Loading batches…" rows={5} />
        ) : batches.length === 0 ? (
          <EmptyState title="No batches uploaded yet" description="Upload a sheet above to queue your first batch." />
        ) : (
          <div>
            {batches.map((batch: any, i: number) => {
              const bId    = batch.batch_id || batch.id;
              const isOpen = expandedBatch === bId;
              const calls  = batchCalls[bId] || [];
              const isBusy = loadingCalls === bId;
              return (
                <div key={batch.id || bId} className={i < batches.length - 1 ? 'border-b border-fx-border' : ''}>
                  <button
                    type="button"
                    onClick={() => toggleBatch(bId)}
                    className="fx-tap flex w-full items-center justify-between gap-4 px-[14px] py-3 text-left hover:bg-fx-surface"
                  >
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="truncate text-[13px] text-fx-text">
                        {batch.filename || batch.file_name || 'Unknown file'}
                      </div>
                      <div className="fx-mono mt-0.5 text-[11px] text-fx-text3">
                        {batch.total_records ?? batch.count ?? 0} records · {formatDateTime(batch.uploaded_at || batch.created_at || '')}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <BatchStatusPill status={batch.status || 'pending'} />
                      <span className="fx-mono text-[10px] text-fx-text3">{isOpen ? '▲' : '▼'}</span>
                    </div>
                  </button>

                  {isOpen && (
                    <div className="border-t border-fx-border" style={{ background: 'var(--fx-bg)' }}>
                      {isBusy ? (
                        <LoadingState label="Loading calls…" rows={3} />
                      ) : calls.length === 0 ? (
                        <EmptyState title="No calls in this batch" />
                      ) : (
                        <div>
                          <div className="grid grid-cols-[2fr_1.5fr_1fr_0.6fr_0.6fr_0.6fr] gap-2 border-b border-fx-border px-[14px] py-2 text-[11px] text-fx-text3">
                            <span>Name</span><span>Phone</span><span>Status</span><span>Duration</span><span>Interested</span><span>Form</span>
                          </div>
                          <div className="max-h-72 overflow-y-auto">
                            {calls.map((call: any) => (
                              <div
                                key={call.id}
                                className="grid grid-cols-[2fr_1.5fr_1fr_0.6fr_0.6fr_0.6fr] items-center gap-2 border-b border-fx-border px-[14px] py-2.5 last:border-0"
                              >
                                <span className="truncate text-[13px] text-fx-text">{call.customer_name || '—'}</span>
                                <span className="fx-mono truncate text-[12px] text-fx-text2">{call.phone || '—'}</span>
                                <span><BatchStatusPill status={call.status || ''} /></span>
                                <span className="fx-mono text-[12px] text-fx-text2">
                                  {call.call_duration ? `${call.call_duration}s` : '—'}
                                </span>
                                {/* In-flight statuses show a dash rather than a
                                    verdict — same condition as the legacy page. */}
                                <span className="text-[12px]">
                                  {['Calling', 'Pending', 'Connecting'].includes(call.status || '')
                                    ? <span className="text-fx-text3">—</span>
                                    : <InterestPill interested={call.interested} />}
                                </span>
                                <span><FormDeliveryMark call={call} /></span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </BankUserShell>
  );
}
