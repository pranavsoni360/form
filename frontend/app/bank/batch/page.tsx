'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL, formatDateTime } from '@/lib/api';
import { getAccessToken, getCurrentUser } from '@/lib/auth';
import {
  ArrowLeft, Upload, Play, Square, RefreshCw, FileSpreadsheet,
  Loader2, AlertTriangle, CheckCircle2, RotateCcw, Wrench,
  ChevronDown, ChevronUp, Phone, User, Clock,
} from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import { useEventStream } from '@/lib/realtime/useEventStream';
import { batchesReducer, initialBatchesState, type BatchesState } from '@/lib/realtime/reducers';
import { BatchPreviewModal, type BatchReport } from '@/components/shared/BatchPreviewModal';

function StatusBadge({ status }: { status: string }) {
  const s = (status || '').toLowerCase();
  let cls = 'px-2 py-0.5 rounded text-xs font-medium ';
  if      (s === 'completed')                                      cls += 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300';
  else if (s === 'running' || s === 'in_progress' || s === 'calling') cls += 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
  else if (s === 'failed')                                         cls += 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
  else if (s === 'paused' || s === 'scheduled')                    cls += 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
  else                                                             cls += 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400';
  return <span className={cls}>{status || 'pending'}</span>;
}

// Multi-state WhatsApp form-link status. Reads the explicit form_status column
// (written from the real AiSensy accept/fail) and falls back to the legacy
// boolean for old rows. "Sent" = AiSensy accepted (queued), "Failed" = rejected.
const FORM_STATUS_VIEW: Record<string, { label: string; cls: string }> = {
  sent:      { label: 'Sent',      cls: 'text-emerald-600 dark:text-emerald-400' },
  delivered: { label: 'Delivered', cls: 'text-emerald-600 dark:text-emerald-400' },
  sending:   { label: 'Sending',   cls: 'text-blue-500 dark:text-blue-400' },
  pending:   { label: 'Pending',   cls: 'text-amber-500 dark:text-amber-400' },
  failed:    { label: 'Failed',    cls: 'text-red-500 dark:text-red-400' },
  not_sent:  { label: '—',         cls: 'text-slate-400' },
};
function formStatusView(call: any) {
  const s = (call?.form_status as string) || (call?.form_sent ? 'sent' : 'not_sent');
  return FORM_STATUS_VIEW[s] || FORM_STATUS_VIEW.not_sent;
}

const selectCls = "w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition";

const btnSecondary = "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-slate-200 dark:border-slate-700 bg-gradient-to-b from-white to-slate-50 dark:from-slate-700 dark:to-slate-800 text-slate-700 dark:text-slate-200 hover:from-slate-50 hover:to-slate-100 dark:hover:from-slate-600 dark:hover:to-slate-700 shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed";

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

  const fetchBatches = useCallback(async (tok = token) => {
    if (!tok) return;
    setLoading(true);
    try {
      const res  = await fetch(`${API_URL}/api/agent/uploads`, { headers: { Authorization: `Bearer ${tok}` }, credentials: 'include' });
      const data = await res.json();
      setBatches(data.uploads || []);
    } catch { } finally { setLoading(false); }
  }, [token]);

  const fetchStatus = useCallback(async (tok = token) => {
    if (!tok) return;
    try {
      const res = await fetch(`${API_URL}/api/agent/batch-status`, { headers: { Authorization: `Bearer ${tok}` }, credentials: 'include' });
      setBatchStatus(await res.json());
      setLastUpdated(new Date());
    } catch { }
  }, [token]);

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

  useEffect(() => { if (token) { fetchBatches(token); fetchStatus(token); } }, [token]);
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
    const isLive = (batchStatus?.active_calls ?? 0) > 0 || (batchStatus?.pending ?? 0) > 0;
    if (!isLive) return;
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
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
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
    if (!expandedBatch) { notify('Open the batch you want to retry (tap its row), then click Retry Failed', false); return; }
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
    { label: 'Active Now',   value: batchStatus?.active_calls  ?? 0, accent: 'bg-blue-50 dark:bg-blue-950/30 border-l-4 border-l-blue-500' },
    { label: 'Pending',      value: batchStatus?.pending       ?? 0, accent: 'bg-amber-50 dark:bg-amber-950/30 border-l-4 border-l-amber-500' },
    { label: 'Completed',    value: batchStatus?.completed     ?? 0, accent: 'bg-emerald-50 dark:bg-emerald-950/30 border-l-4 border-l-emerald-500' },
    { label: 'Not Answered', value: batchStatus?.not_answered  ?? 0, accent: 'bg-yellow-50 dark:bg-yellow-950/30 border-l-4 border-l-yellow-500' },
    { label: 'Failed',       value: batchStatus?.failed        ?? 0, accent: 'bg-red-50 dark:bg-red-950/30 border-l-4 border-l-red-500' },
    { label: 'Total',        value: batchStatus?.total         ?? 0, accent: 'bg-slate-50 dark:bg-slate-800/50 border-l-4 border-l-slate-400' },
  ];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 relative">

      <BatchPreviewModal report={preview} confirming={confirming} onConfirm={confirmUpload} onCancel={cancelPreview} />

      {/* Ambient background glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden -z-10">
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[80rem] h-[36rem] rounded-full bg-blue-400/[0.04] dark:bg-blue-400/[0.06] blur-3xl" />
      </div>

      {/* Header */}
      <div className="sticky top-0 z-30 bg-white/90 dark:bg-slate-950/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/bank/dashboard')}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">Batch Calling</h1>
              <p className="text-xs text-slate-400 dark:text-slate-500">Upload Excel, trigger calls, monitor progress</p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">

        {/* Notification */}
        {notice && (
          <div className={`flex items-center gap-2.5 rounded-lg px-4 py-3 text-sm border ${notice.ok
            ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
            : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'}`}>
            {notice.ok ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
            {notice.msg}
          </div>
        )}

        {/* Live Status */}
        {batchStatus && (
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                {isLive && (
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                  </span>
                )}
                <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                  {isLive ? 'Calling — live' : batchStatus?.pending === 0 && batchStatus?.active_calls === 0 ? 'Idle' : 'Live Status'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {lastUpdated && (
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    Updated {secondsAgo}s ago
                  </span>
                )}
                <button onClick={refresh} disabled={refreshing}
                  className="text-xs text-blue-500 hover:text-blue-600 font-medium flex items-center gap-1 disabled:opacity-60">
                  <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
                  {refreshing ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {statItems.map(({ label, value, accent }) => (
                <div key={label} className={`rounded-lg px-4 py-3 border border-slate-200 dark:border-slate-800 ${accent}`}>
                  <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{value}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{label}</p>
                </div>
              ))}
            </div>
            {batchStatus?.message && (
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">{batchStatus.message}</p>
            )}
          </div>
        )}

        {/* Voice Config */}
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-5">
          <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-4">Voice Config & Upload</p>
          <div className="flex flex-wrap gap-4 items-end">
            {[
              { label: 'Language', val: language, set: setLanguage, opts: [['hindi','Hindi'],['marathi','Marathi'],['english','English']] },
              { label: 'Voice',    val: gender,   set: setGender,   opts: [['male','Male (Rajesh)'],['female','Female (Diya)']] },
              { label: 'Agent Type', val: agentType, set: setAgentType, opts: [['loan_enquiry','Loan Enquiry — Pusad Urban'],['account_opening','Account Opening — Union Bank']] },
            ].map(({ label, val, set, opts }) => (
              <div key={label} className="flex-1 min-w-[140px]">
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">{label}</label>
                <select value={val} onChange={e => set(e.target.value)} className={selectCls}>
                  {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            ))}

            {/* Phone custom dropdown */}
            <div className="flex-1 min-w-[220px] relative" ref={phoneDropdownRef}>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">From Number (Caller ID)</label>
              <button onClick={() => setPhoneDropdownOpen(v => !v)}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-left transition focus:outline-none focus:ring-2 focus:ring-blue-500/30">
                <span className="truncate text-slate-800 dark:text-slate-200">
                  {phoneNumberId
                    ? (() => { const o = phoneOptions.find(p => p.id === phoneNumberId); return o ? `${o.phone}${o.provider ? ` · ${o.provider}` : ''}` : phoneNumberId; })()
                    : 'Auto — pool picks least-loaded'}
                </span>
                <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 ml-1 text-slate-400 transition-transform ${phoneDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
              {phoneDropdownOpen && (
                <div className="absolute z-50 left-0 right-0 mt-1 rounded-xl overflow-hidden shadow-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700" style={{ top: '100%' }}>
                  {[{ id: '', phone: 'Auto', provider: 'pool picks least-loaded', trunkId: '' }, ...phoneOptions].map((p, i) => {
                    const isSelected = phoneNumberId === p.id;
                    const isDefault  = p.id !== '' && localStorage.getItem(`bank_default_phone_${bankId || 'default'}`) === p.id;
                    return (
                      <button key={p.id} onClick={() => {
                        setPhoneNumberId(p.id);
                        if (p.id) localStorage.setItem(`bank_default_phone_${bankId || 'default'}`, p.id);
                        setPhoneDropdownOpen(false);
                      }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-sm transition ${i > 0 ? 'border-t border-slate-100 dark:border-slate-700/50' : ''} ${isSelected ? 'bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}>
                        <span className={`flex-shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${isSelected ? 'border-blue-600 dark:border-blue-400' : 'border-slate-300 dark:border-slate-600'}`}>
                          {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-blue-600 dark:bg-blue-400 block" />}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="text-xs font-medium text-slate-800 dark:text-slate-200 block">{p.phone}</span>
                          {p.provider && <span className="text-[11px] text-slate-400 dark:text-slate-500">{p.provider}</span>}
                        </span>
                        {isDefault && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 flex-shrink-0">default</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <p className="text-xs text-slate-300 dark:text-slate-600 mt-3">
            Voice + language are baked into every row at upload time. Existing batches keep their original config.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Primary: Upload */}
          <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer bg-gradient-to-b from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 dark:from-blue-600 dark:to-blue-700 dark:hover:from-blue-500 dark:hover:to-blue-600 text-white shadow-sm shadow-blue-500/20 border border-blue-600 dark:border-blue-700 transition">
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading ? 'Uploading…' : 'Upload Excel'}
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleUpload} disabled={uploading} />
          </label>

          {/* Primary: Start Batch */}
          <button onClick={triggerBatch} disabled={starting}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-gradient-to-b from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 dark:from-blue-600 dark:to-blue-700 dark:hover:from-blue-500 dark:hover:to-blue-600 text-white shadow-sm shadow-blue-500/20 border border-blue-600 dark:border-blue-700 transition disabled:opacity-50">
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Start Batch
          </button>

          {/* Secondary actions */}
          {[
            { label: 'Resume',        icon: <Play className="w-4 h-4" />,      busy: resuming, onClick: resumeCalling },
            { label: 'Retry Failed',  icon: <RotateCcw className="w-4 h-4" />, busy: retrying, onClick: retryFailed   },
            { label: 'Cleanup Stuck', icon: <Wrench className="w-4 h-4" />,    busy: cleaning, onClick: cleanupStuck  },
            { label: 'Refresh',       icon: <RefreshCw className="w-4 h-4" />, busy: refreshing, onClick: refresh     },
          ].map(({ label, icon, busy, onClick }) => (
            <button key={label} onClick={onClick} disabled={busy} className={btnSecondary}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
              {label}
            </button>
          ))}

          {/* Danger */}
          <button onClick={emergencyStop} disabled={stopping}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ml-auto border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition disabled:opacity-50">
            {stopping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
            Emergency Stop
          </button>
        </div>

        {/* Upload History */}
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Upload History</h2>
            <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">Click a row to view calls</span>
          </div>

          {loading ? (
            <div className="py-12 flex justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-slate-300 dark:text-slate-600" />
            </div>
          ) : batches.length === 0 ? (
            <div className="py-12 text-center">
              <FileSpreadsheet className="w-8 h-8 mx-auto mb-2 text-slate-200 dark:text-slate-700" />
              <p className="text-sm text-slate-400">No batches uploaded yet</p>
            </div>
          ) : (
            <div>
              {batches.map((batch: any, i: number) => {
                const bId    = batch.batch_id || batch.id;
                const isOpen = expandedBatch === bId;
                const calls  = batchCalls[bId] || [];
                const isBusy = loadingCalls === bId;
                return (
                  <div key={batch.id || bId} className={i < batches.length - 1 ? 'border-b border-slate-100 dark:border-slate-800' : ''}>
                    <button onClick={() => toggleBatch(bId)}
                      className="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 transition">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                          {batch.filename || batch.file_name || 'Unknown file'}
                        </p>
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                          {batch.total_records ?? batch.count ?? 0} records · {formatDateTime(batch.uploaded_at || batch.created_at || '')}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                        <StatusBadge status={batch.status || 'pending'} />
                        {isOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                      </div>
                    </button>

                    {isOpen && (
                      <div className="border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                        {isBusy ? (
                          <div className="py-8 flex justify-center">
                            <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                          </div>
                        ) : calls.length === 0 ? (
                          <p className="py-6 text-center text-sm text-slate-400">No calls in this batch</p>
                        ) : (
                          <div>
                            <div className="grid grid-cols-[2fr_1.5fr_1fr_0.5fr_0.5fr_0.5fr] gap-2 px-5 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800">
                              <span>Name</span><span>Phone</span><span>Status</span><span>Duration</span><span>Interested</span><span>Form</span>
                            </div>
                            <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                              {calls.map((call: any) => (
                                <div key={call.id} className="grid grid-cols-[2fr_1.5fr_1fr_0.5fr_0.5fr_0.5fr] gap-2 px-5 py-2.5 items-center">
                                  <span className="flex items-center gap-1.5 text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
                                    <User className="w-3 h-3 flex-shrink-0 text-slate-400" />{call.customer_name || '—'}
                                  </span>
                                  <span className="flex items-center gap-1.5 font-mono text-xs text-slate-500 dark:text-slate-400 truncate">
                                    <Phone className="w-3 h-3 flex-shrink-0 text-slate-300 dark:text-slate-600" />{call.phone || '—'}
                                  </span>
                                  <span><StatusBadge status={call.status || ''} /></span>
                                  <span className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                                    <Clock className="w-3 h-3" />{call.call_duration ? `${call.call_duration}s` : '—'}
                                  </span>
                                  <span className={`text-xs font-medium ${call.interested === true ? 'text-emerald-600 dark:text-emerald-400' : ['Calling', 'Pending', 'Connecting'].includes(call.status || '') ? 'text-slate-400' : call.interested === false ? 'text-red-500 dark:text-red-400' : 'text-slate-400'}`}>
                                    {call.interested === true ? 'Yes' : ['Calling', 'Pending', 'Connecting'].includes(call.status || '') ? '—' : call.interested === false ? 'No' : '—'}
                                  </span>
                                  <span className={`text-xs font-medium ${formStatusView(call).cls}`}>
                                    {formStatusView(call).label}
                                  </span>
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
        </div>
      </div>
    </div>
  );
}
