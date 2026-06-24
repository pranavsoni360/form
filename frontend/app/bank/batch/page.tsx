'use client';

import { useState, useEffect, useCallback } from 'react';
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

function StatusBadge({ status }: { status: string }) {
  const s = (status || '').toLowerCase();
  let cls = 'px-2 py-0.5 rounded text-xs font-medium ';
  if (s === 'completed')       cls += 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-400';
  else if (s === 'running' || s === 'in_progress' || s === 'calling')
                               cls += 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-400';
  else if (s === 'failed')     cls += 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-400';
  else if (s === 'paused' || s === 'scheduled')
                               cls += 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-400';
  else                         cls += 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400';
  return <span className={cls}>{status || 'pending'}</span>;
}

export default function BatchPage() {
  const router = useRouter();

  const [token, setToken]   = useState('');
  const [bankId, setBankId] = useState('');
  const [batches, setBatches]         = useState<any[]>([]);
  const [batchStatus, setBatchStatus] = useState<any>(null);
  const [loading, setLoading]         = useState(true);
  const [uploading, setUploading]     = useState(false);
  const [language, setLanguage]       = useState('hindi');
  const [gender, setGender]           = useState('male');
  const [agentType, setAgentType]     = useState('loan_enquiry');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [phoneOptions, setPhoneOptions]   = useState<{ id: string; phone: string; provider: string }[]>([]);
  const [starting, setStarting]   = useState(false);
  const [stopping, setStopping]   = useState(false);
  const [retrying, setRetrying]   = useState(false);
  const [cleaning, setCleaning]   = useState(false);
  const [resuming, setResuming]   = useState(false);
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);
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
    fetch(`${API_URL}/api/ops/phone-pools`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        const opts: { id: string; phone: string; provider: string }[] = [];
        for (const pool of data.pools ?? []) {
          for (const n of pool.numbers ?? []) {
            if (!n.phone_number || n.status !== 'active') continue;
            opts.push({
              id: n.id, phone: n.phone_number,
              provider: n.phone_number.startsWith('+1') ? 'Twilio US' : n.phone_number.startsWith('+91') ? 'Viva India' : 'Other',
            });
          }
        }
        setPhoneOptions(opts.sort((a, b) => a.phone.localeCompare(b.phone)));
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
      const res  = await fetch(`${API_URL}/api/agent/batch-status`, { headers: { Authorization: `Bearer ${tok}` }, credentials: 'include' });
      setBatchStatus(await res.json());
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

  const refresh = useCallback(() => { fetchBatches(); fetchStatus(); }, [fetchBatches, fetchStatus]);

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

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const params = new URLSearchParams({
        language, gender, agent_type: agentType,
        ...(bankId        ? { bank_id: bankId }                : {}),
        ...(phoneNumberId ? { phone_number_id: phoneNumberId } : {}),
      });
      const res = await fetch(`${API_URL}/api/agent/upload-excel?${params}`, {
        method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` }, credentials: 'include',
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || `Upload failed (${res.status})`); }
      const data = await res.json();
      notify(`Uploaded ${data.inserted_count ?? '?'} records`);
      refresh();
    } catch (err: any) { notify(err.message || 'Upload failed', false); }
    finally { setUploading(false); }
  };

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
    try {
      const qs = phoneNumberId ? `?phone_number_id=${encodeURIComponent(phoneNumberId)}` : '';
      const data = await apiPost(`/api/agent/batch-call${qs}`);
      notify(data.message || 'Batch started'); refresh();
    } catch (err: any) { notify(err.message, false); }
    finally { setStarting(false); }
  };

  const emergencyStop = async () => {
    if (!confirm('EMERGENCY STOP: This will terminate ALL active calls immediately.')) return;
    setStopping(true);
    try { await apiPost('/api/agent/emergency-stop'); notify('Emergency stop sent'); refresh(); }
    catch (err: any) { notify(err.message, false); }
    finally { setStopping(false); }
  };

  const retryFailed = async () => {
    setRetrying(true);
    try { const d = await apiPost('/api/agent/batch-retry'); notify(d.message || 'Retrying failed calls'); refresh(); }
    catch (err: any) { notify(err.message, false); }
    finally { setRetrying(false); }
  };

  const cleanupStuck = async () => {
    setCleaning(true);
    try { const d = await apiPost('/api/agent/stale-cleanup'); notify(d.message || 'Stuck calls cleaned'); refresh(); }
    catch (err: any) { notify(err.message, false); }
    finally { setCleaning(false); }
  };

  const resumeCalling = async () => {
    setResuming(true);
    try { const d = await apiPost('/api/agent/resume-calling'); notify(d.message || 'Batch resumed'); refresh(); }
    catch (err: any) { notify(err.message, false); }
    finally { setResuming(false); }
  };

  const toggleBatch = (batchId: string) => {
    if (expandedBatch === batchId) { setExpandedBatch(null); return; }
    setExpandedBatch(batchId);
    if (!batchCalls[batchId]) fetchBatchCalls(batchId);
  };

  const statItems = [
    { label: 'Active Calls', value: batchStatus?.active_calls ?? 0, color: 'text-blue-600 dark:text-blue-400' },
    { label: 'Completed',    value: batchStatus?.completed    ?? 0, color: 'text-emerald-600 dark:text-emerald-400' },
    { label: 'Pending',      value: batchStatus?.pending      ?? 0, color: 'text-gray-700 dark:text-gray-300' },
    { label: 'Failed',       value: batchStatus?.failed       ?? 0, color: 'text-red-600 dark:text-red-400' },
  ];

  const selectCls = "w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-slate-400 dark:focus:ring-slate-500 transition";

  const btnCls = "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">

      {/* Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/bank/dashboard')}
              className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">Batch Calling</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">Upload Excel, trigger calls, monitor progress</p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">

        {/* Inline notification */}
        {notice && (
          <div className={`flex items-center gap-2.5 rounded-lg px-4 py-3 text-sm border ${
            notice.ok
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-400'
              : 'bg-red-50 border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400'
          }`}>
            {notice.ok
              ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
              : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
            {notice.msg}
          </div>
        )}

        {/* Live Status */}
        {batchStatus && (
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
            <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-4">Live Status</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {statItems.map(({ label, value, color }) => (
                <div key={label} className="rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-4 py-3">
                  <p className={`text-2xl font-bold ${color}`}>{value}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{label}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Voice Config & Upload */}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
          <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-4">Voice Config & Upload</p>
          <div className="flex flex-wrap gap-4 items-end">
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Language</label>
              <select value={language} onChange={e => setLanguage(e.target.value)} className={selectCls}>
                <option value="hindi">Hindi</option>
                <option value="marathi">Marathi</option>
                <option value="english">English</option>
              </select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Voice</label>
              <select value={gender} onChange={e => setGender(e.target.value)} className={selectCls}>
                <option value="male">Male (Rajesh)</option>
                <option value="female">Female (Diya)</option>
              </select>
            </div>
            <div className="flex-1 min-w-[180px]">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Agent Type</label>
              <select value={agentType} onChange={e => setAgentType(e.target.value)} className={selectCls}>
                <option value="loan_enquiry">Loan Enquiry — Pusad Urban</option>
                <option value="account_opening">Account Opening — Union Bank</option>
              </select>
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">From Number (Caller ID)</label>
              <select value={phoneNumberId} onChange={e => setPhoneNumberId(e.target.value)} className={selectCls}>
                <option value="">Auto — pool picks least-loaded</option>
                {phoneOptions.map(p => (
                  <option key={p.id} value={p.id}>{p.phone} · {p.provider}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-600 mt-3">
            Voice + language are baked into every row at upload time. Existing batches keep their original config.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Upload */}
          <label className={`${btnCls} cursor-pointer`}>
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading ? 'Uploading…' : 'Upload Excel'}
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleUpload} disabled={uploading} />
          </label>

          {[
            { label: 'Start Batch',   icon: <Play className="w-4 h-4" />,      busy: starting, onClick: triggerBatch  },
            { label: 'Resume',        icon: <Play className="w-4 h-4" />,      busy: resuming, onClick: resumeCalling },
            { label: 'Retry Failed',  icon: <RotateCcw className="w-4 h-4" />, busy: retrying, onClick: retryFailed   },
            { label: 'Cleanup Stuck', icon: <Wrench className="w-4 h-4" />,    busy: cleaning, onClick: cleanupStuck  },
            { label: 'Refresh',       icon: <RefreshCw className="w-4 h-4" />, busy: false,    onClick: refresh       },
          ].map(({ label, icon, busy, onClick }) => (
            <button key={label} onClick={onClick} disabled={busy} className={btnCls}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
              {label}
            </button>
          ))}

          <button
            onClick={emergencyStop}
            disabled={stopping}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition disabled:opacity-50 ml-auto">
            {stopping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
            Emergency Stop
          </button>
        </div>

        {/* Upload History */}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Upload History</h2>
            <span className="ml-auto text-xs text-gray-400 dark:text-gray-600">Click a row to view calls</span>
          </div>

          {loading ? (
            <div className="py-12 flex justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-gray-300 dark:text-gray-600" />
            </div>
          ) : batches.length === 0 ? (
            <div className="py-12 text-center">
              <FileSpreadsheet className="w-8 h-8 mx-auto mb-2 text-gray-300 dark:text-gray-700" />
              <p className="text-sm text-gray-400">No batches uploaded yet</p>
            </div>
          ) : (
            <div>
              {batches.map((batch: any, i: number) => {
                const bId    = batch.batch_id || batch.id;
                const isOpen = expandedBatch === bId;
                const calls  = batchCalls[bId] || [];
                const isBusy = loadingCalls === bId;

                return (
                  <div key={batch.id || bId} className={i < batches.length - 1 ? 'border-b border-gray-100 dark:border-gray-800' : ''}>
                    <button
                      onClick={() => toggleBatch(bId)}
                      className="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                          {batch.filename || batch.file_name || 'Unknown file'}
                        </p>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                          {batch.total_records ?? batch.count ?? 0} records · {formatDateTime(batch.uploaded_at || batch.created_at || '')}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                        <StatusBadge status={batch.status || 'pending'} />
                        {isOpen
                          ? <ChevronUp className="w-4 h-4 text-gray-400" />
                          : <ChevronDown className="w-4 h-4 text-gray-400" />}
                      </div>
                    </button>

                    {isOpen && (
                      <div className="border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/30">
                        {isBusy ? (
                          <div className="py-8 flex justify-center">
                            <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                          </div>
                        ) : calls.length === 0 ? (
                          <p className="py-6 text-center text-sm text-gray-400">No calls in this batch</p>
                        ) : (
                          <div>
                            <div className="grid grid-cols-[2fr_1.5fr_1fr_0.5fr_0.5fr_0.5fr] gap-2 px-5 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400 border-b border-gray-100 dark:border-gray-800">
                              <span>Name</span><span>Phone</span><span>Status</span>
                              <span>Duration</span><span>Interested</span><span>Form</span>
                            </div>
                            <div className="max-h-72 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800">
                              {calls.map((call: any) => (
                                <div key={call.id} className="grid grid-cols-[2fr_1.5fr_1fr_0.5fr_0.5fr_0.5fr] gap-2 px-5 py-2.5 items-center">
                                  <span className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                                    <User className="w-3 h-3 flex-shrink-0 text-gray-400" />
                                    {call.customer_name || '—'}
                                  </span>
                                  <span className="flex items-center gap-1.5 font-mono text-xs text-gray-500 truncate">
                                    <Phone className="w-3 h-3 flex-shrink-0 text-gray-400" />
                                    {call.phone || '—'}
                                  </span>
                                  <span><StatusBadge status={call.status || ''} /></span>
                                  <span className="flex items-center gap-1 text-xs text-gray-500">
                                    <Clock className="w-3 h-3" />
                                    {call.call_duration ? `${call.call_duration}s` : '—'}
                                  </span>
                                  <span className={`text-xs font-medium ${
                                    call.interested === true  ? 'text-emerald-600 dark:text-emerald-400' :
                                    call.interested === false ? 'text-red-500 dark:text-red-400' : 'text-gray-400'
                                  }`}>
                                    {call.interested === true ? 'Yes' : call.interested === false ? 'No' : '—'}
                                  </span>
                                  <span className={`text-xs font-medium ${call.form_sent ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400'}`}>
                                    {call.form_sent ? 'Sent' : '—'}
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
