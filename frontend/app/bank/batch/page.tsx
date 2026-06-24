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

// palette: #f8fafc bg · #d9eafd accent · #bcccdc border · #9aa6b2 muted
const P = {
  bg:      '#f8fafc',
  card:    '#ffffff',
  accent:  '#d9eafd',
  border:  '#bcccdc',
  muted:   '#9aa6b2',
  text:    '#1e293b',
  sub:     '#475569',
  hov:    '#f0f6ff',
};

function StatusBadge({ status }: { status: string }) {
  const s = (status || '').toLowerCase();
  let bg = '#f1f5f9', color = '#64748b', border = '#cbd5e1';
  if (s === 'completed')
    { bg = '#ecfdf5'; color = '#065f46'; border = '#a7f3d0'; }
  else if (s === 'running' || s === 'in_progress' || s === 'calling')
    { bg = P.accent; color = '#1e3a5f'; border = P.border; }
  else if (s === 'failed')
    { bg = '#fef2f2'; color = '#991b1b'; border = '#fecaca'; }
  else if (s === 'paused' || s === 'scheduled')
    { bg = '#fffbeb'; color = '#92400e'; border = '#fde68a'; }
  return (
    <span className="px-2 py-0.5 rounded text-xs font-medium"
      style={{ background: bg, color, border: `1px solid ${border}` }}>
      {status || 'pending'}
    </span>
  );
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
  const [phoneOptions, setPhoneOptions]   = useState<{ id: string; phone: string; provider: string; trunkId: string }[]>([]);
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
    const TRUNK_PROVIDERS: Record<string, string> = {
      'ST_pTYcg7Az9q8R': 'Vobiz',
      'ST_7AXVHfHRbCwP': 'Viva India',
    };
    const providerFromTrunk = (trunkId: string, phone: string) => {
      if (trunkId && TRUNK_PROVIDERS[trunkId]) return TRUNK_PROVIDERS[trunkId];
      if (phone.startsWith('+1')) return 'Twilio US';
      return ''; // unknown — show number only, no suffix
    };

    const savedDefault = localStorage.getItem(`bank_default_phone_${u.bank_id || 'default'}`);
    fetch(`${API_URL}/api/ops/phone-pools`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        const opts: { id: string; phone: string; provider: string; trunkId: string }[] = [];
        for (const pool of data.pools ?? []) {
          for (const n of pool.numbers ?? []) {
            if (!n.phone_number || n.status !== 'active') continue;
            opts.push({
              id: n.id, phone: n.phone_number,
              trunkId: n.livekit_trunk_id || '',
              provider: providerFromTrunk(n.livekit_trunk_id || '', n.phone_number),
            });
          }
        }
        const sorted = opts.sort((a, b) => a.phone.localeCompare(b.phone));
        setPhoneOptions(sorted);
        if (savedDefault && sorted.some(o => o.id === savedDefault)) {
          setPhoneNumberId(savedDefault);
        } else if (sorted.length > 0) {
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
    { label: 'Active Calls', value: batchStatus?.active_calls ?? 0, accent: P.accent },
    { label: 'Completed',    value: batchStatus?.completed    ?? 0, accent: '#ecfdf5' },
    { label: 'Pending',      value: batchStatus?.pending      ?? 0, accent: P.bg },
    { label: 'Failed',       value: batchStatus?.failed       ?? 0, accent: '#fef2f2' },
  ];

  const selStyle: React.CSSProperties = {
    border: `1px solid ${P.border}`, background: P.card, color: P.text,
    borderRadius: '0.5rem', padding: '0.5rem 0.75rem', fontSize: '0.875rem',
    width: '100%', outline: 'none',
  };

  const btnStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.5rem 1rem', borderRadius: '0.5rem', fontSize: '0.875rem', fontWeight: 500,
    border: `1px solid ${P.border}`, background: P.card, color: P.sub,
    cursor: 'pointer', transition: 'background 0.15s',
  };

  return (
    <div className="min-h-screen" style={{ background: P.bg }}>

      {/* Header */}
      <div style={{ background: P.card, borderBottom: `1px solid ${P.border}` }}>
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/bank/dashboard')}
              className="p-2 rounded-lg transition-colors"
              style={{ color: P.muted }}
              onMouseEnter={e => (e.currentTarget.style.background = P.accent)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <h1 className="text-base font-semibold" style={{ color: P.text }}>Batch Calling</h1>
              <p className="text-xs" style={{ color: P.muted }}>Upload Excel, trigger calls, monitor progress</p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">

        {/* Notification */}
        {notice && (
          <div className="flex items-center gap-2.5 rounded-lg px-4 py-3 text-sm"
            style={notice.ok
              ? { background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0' }
              : { background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
            {notice.ok ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
            {notice.msg}
          </div>
        )}

        {/* Live Status */}
        {batchStatus && (
          <div className="rounded-xl p-5" style={{ background: P.card, border: `1px solid ${P.border}` }}>
            <p className="text-xs font-semibold mb-4 uppercase tracking-wider" style={{ color: P.muted }}>Live Status</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {statItems.map(({ label, value, accent }) => (
                <div key={label} className="rounded-lg px-4 py-3" style={{ background: accent, border: `1px solid ${P.border}` }}>
                  <p className="text-2xl font-bold" style={{ color: P.text }}>{value}</p>
                  <p className="text-xs mt-0.5" style={{ color: P.sub }}>{label}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Voice Config */}
        <div className="rounded-xl p-5" style={{ background: P.card, border: `1px solid ${P.border}` }}>
          <p className="text-xs font-semibold mb-4 uppercase tracking-wider" style={{ color: P.muted }}>Voice Config & Upload</p>
          <div className="flex flex-wrap gap-4 items-end">
            {[
              { label: 'Language', val: language, set: setLanguage,
                opts: [['hindi','Hindi'],['marathi','Marathi'],['english','English']] },
              { label: 'Voice', val: gender, set: setGender,
                opts: [['male','Male (Rajesh)'],['female','Female (Diya)']] },
              { label: 'Agent Type', val: agentType, set: setAgentType,
                opts: [['loan_enquiry','Loan Enquiry — Pusad Urban'],['account_opening','Account Opening — Union Bank']] },
            ].map(({ label, val, set, opts }) => (
              <div key={label} className="flex-1 min-w-[140px]">
                <label className="block text-xs font-medium mb-1.5" style={{ color: P.sub }}>{label}</label>
                <select value={val} onChange={e => set(e.target.value)} style={selStyle}>
                  {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            ))}
            <div className="flex-1 min-w-[200px]">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium" style={{ color: P.sub }}>From Number (Caller ID)</label>
                {phoneNumberId && (
                  <button onClick={() => { localStorage.setItem(`bank_default_phone_${bankId || 'default'}`, phoneNumberId); notify('Default number saved'); }}
                    className="text-xs" style={{ color: P.muted }}>★ save</button>
                )}
              </div>
              <select value={phoneNumberId} onChange={e => setPhoneNumberId(e.target.value)} style={selStyle}>
                <option value="">Auto — pool picks least-loaded</option>
                {phoneOptions.map(p => (
                  <option key={p.id} value={p.id}>{p.phone}{p.provider ? ` · ${p.provider}` : ''}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs mt-3" style={{ color: P.border }}>
            Voice + language are baked into every row at upload time. Existing batches keep their original config.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <label style={btnStyle}
            className="cursor-pointer"
            onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = P.hov)}
            onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = P.card)}>
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
            <button key={label} onClick={onClick} disabled={busy}
              style={{ ...btnStyle, opacity: busy ? 0.6 : 1 }}
              onMouseEnter={e => { if (!busy) (e.currentTarget as HTMLElement).style.background = P.hov; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = P.card; }}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
              {label}
            </button>
          ))}

          <button onClick={emergencyStop} disabled={stopping}
            style={{ ...btnStyle, marginLeft: 'auto', color: '#dc2626', borderColor: '#fca5a5', background: 'transparent' }}
            onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = '#fef2f2')}
            onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'transparent')}>
            {stopping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
            Emergency Stop
          </button>
        </div>

        {/* Upload History */}
        <div className="rounded-xl overflow-hidden" style={{ background: P.card, border: `1px solid ${P.border}` }}>
          <div className="px-5 py-4 flex items-center gap-2" style={{ borderBottom: `1px solid ${P.border}` }}>
            <FileSpreadsheet className="w-4 h-4" style={{ color: P.muted }} />
            <h2 className="text-sm font-semibold" style={{ color: P.sub }}>Upload History</h2>
            <span className="ml-auto text-xs" style={{ color: P.muted }}>Click a row to view calls</span>
          </div>

          {loading ? (
            <div className="py-12 flex justify-center">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: P.border }} />
            </div>
          ) : batches.length === 0 ? (
            <div className="py-12 text-center">
              <FileSpreadsheet className="w-8 h-8 mx-auto mb-2" style={{ color: P.border }} />
              <p className="text-sm" style={{ color: P.muted }}>No batches uploaded yet</p>
            </div>
          ) : (
            <div>
              {batches.map((batch: any, i: number) => {
                const bId    = batch.batch_id || batch.id;
                const isOpen = expandedBatch === bId;
                const calls  = batchCalls[bId] || [];
                const isBusy = loadingCalls === bId;

                return (
                  <div key={batch.id || bId} style={{ borderBottom: i < batches.length - 1 ? `1px solid ${P.bg}` : 'none' }}>
                    <button onClick={() => toggleBatch(bId)} className="w-full px-5 py-3.5 flex items-center justify-between text-left transition-colors"
                      onMouseEnter={e => (e.currentTarget.style.background = P.hov)}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate" style={{ color: P.text }}>
                          {batch.filename || batch.file_name || 'Unknown file'}
                        </p>
                        <p className="text-xs mt-0.5" style={{ color: P.muted }}>
                          {batch.total_records ?? batch.count ?? 0} records · {formatDateTime(batch.uploaded_at || batch.created_at || '')}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                        <StatusBadge status={batch.status || 'pending'} />
                        {isOpen
                          ? <ChevronUp className="w-4 h-4" style={{ color: P.muted }} />
                          : <ChevronDown className="w-4 h-4" style={{ color: P.muted }} />}
                      </div>
                    </button>

                    {isOpen && (
                      <div style={{ borderTop: `1px solid ${P.border}`, background: P.bg }}>
                        {isBusy ? (
                          <div className="py-8 flex justify-center">
                            <Loader2 className="w-5 h-5 animate-spin" style={{ color: P.border }} />
                          </div>
                        ) : calls.length === 0 ? (
                          <p className="py-6 text-center text-sm" style={{ color: P.muted }}>No calls in this batch</p>
                        ) : (
                          <div>
                            <div className="grid grid-cols-[2fr_1.5fr_1fr_0.5fr_0.5fr_0.5fr] gap-2 px-5 py-2 text-[10px] font-semibold uppercase tracking-wider"
                              style={{ color: P.muted, borderBottom: `1px solid ${P.border}` }}>
                              <span>Name</span><span>Phone</span><span>Status</span>
                              <span>Duration</span><span>Interested</span><span>Form</span>
                            </div>
                            <div className="max-h-72 overflow-y-auto">
                              {calls.map((call: any) => (
                                <div key={call.id} className="grid grid-cols-[2fr_1.5fr_1fr_0.5fr_0.5fr_0.5fr] gap-2 px-5 py-2.5 items-center"
                                  style={{ borderBottom: `1px solid ${P.border}20` }}>
                                  <span className="flex items-center gap-1.5 text-sm font-medium truncate" style={{ color: P.text }}>
                                    <User className="w-3 h-3 flex-shrink-0" style={{ color: P.muted }} />
                                    {call.customer_name || '—'}
                                  </span>
                                  <span className="flex items-center gap-1.5 font-mono text-xs truncate" style={{ color: P.sub }}>
                                    <Phone className="w-3 h-3 flex-shrink-0" style={{ color: P.muted }} />
                                    {call.phone || '—'}
                                  </span>
                                  <span><StatusBadge status={call.status || ''} /></span>
                                  <span className="flex items-center gap-1 text-xs" style={{ color: P.sub }}>
                                    <Clock className="w-3 h-3" />
                                    {call.call_duration ? `${call.call_duration}s` : '—'}
                                  </span>
                                  <span className="text-xs font-medium" style={{
                                    color: call.interested === true ? '#059669' : call.interested === false ? '#dc2626' : P.muted
                                  }}>
                                    {call.interested === true ? 'Yes' : call.interested === false ? 'No' : '—'}
                                  </span>
                                  <span className="text-xs font-medium" style={{ color: call.form_sent ? '#059669' : P.muted }}>
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
