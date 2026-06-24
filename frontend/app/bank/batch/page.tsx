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

// ── Shared styles ─────────────────────────────────────────────────────────────

const sel = "w-full px-3 py-2 rounded-md border border-[#2D3139] bg-[#1A1D23] text-sm text-[#C8CBD4] focus:outline-none focus:border-[#4A5568] transition-colors";

const statusBadge = (status: string): React.CSSProperties => {
  if (status === 'completed' || status === 'Completed')
    return { background: '#0D1F18', color: '#4ADE80', border: '1px solid #14532D' };
  if (status === 'running' || status === 'in_progress' || status === 'Calling')
    return { background: '#0F1825', color: '#60A5FA', border: '1px solid #1E3A5F' };
  if (status === 'failed' || status === 'Failed')
    return { background: '#1F0D0D', color: '#F87171', border: '1px solid #7F1D1D' };
  if (status === 'paused' || status === 'Scheduled' || status === 'Called - Callback Requested')
    return { background: '#1F1A0D', color: '#FBBF24', border: '1px solid #78350F' };
  return { background: '#1A1D23', color: '#565D6E', border: '1px solid #2D3139' };
};

const actionBtn = {
  base: "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50",
  steel: { background: '#1E2128', color: '#C8CBD4', border: '1px solid #2D3139' } as React.CSSProperties,
  danger: { background: 'transparent', color: '#EF4444', border: '1px solid #3D1A1A' } as React.CSSProperties,
};

// ── Component ─────────────────────────────────────────────────────────────────

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
    { label: 'Active Calls', value: batchStatus?.active_calls ?? 0 },
    { label: 'Completed',    value: batchStatus?.completed    ?? 0 },
    { label: 'Pending',      value: batchStatus?.pending      ?? 0 },
    { label: 'Failed',       value: batchStatus?.failed       ?? 0 },
  ];

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen" style={{ background: '#0F1117' }}>

      {/* Header */}
      <div style={{ background: '#13161C', borderBottom: '1px solid #1E2128' }}>
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/bank/dashboard')}
              className="p-2 rounded-lg transition-colors"
              style={{ color: '#8B92A5' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#1E2128')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <h1 className="text-base font-semibold" style={{ color: '#E8EAF0', letterSpacing: '-0.01em' }}>Batch Calling</h1>
              <p className="text-xs" style={{ color: '#565D6E' }}>Upload Excel, trigger calls, monitor progress</p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">

        {/* Inline notification */}
        {notice && (
          <div className="flex items-center gap-2.5 rounded-lg px-4 py-3 text-sm"
            style={notice.ok
              ? { background: '#0D1F18', color: '#4ADE80', border: '1px solid #14532D' }
              : { background: '#1F0D0D', color: '#F87171', border: '1px solid #7F1D1D' }}>
            {notice.ok
              ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
              : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
            {notice.msg}
          </div>
        )}

        {/* Live Status */}
        {batchStatus && (
          <div className="rounded-xl p-5" style={{ background: '#13161C', border: '1px solid #1E2128' }}>
            <p className="text-xs font-medium mb-4" style={{ color: '#565D6E', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Live Status</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {statItems.map(({ label, value }) => (
                <div key={label} className="rounded-lg px-4 py-3" style={{ background: '#0F1117', border: '1px solid #1E2128' }}>
                  <p className="text-2xl font-semibold" style={{ color: '#E8EAF0', letterSpacing: '-0.02em' }}>{value}</p>
                  <p className="text-xs mt-0.5" style={{ color: '#565D6E' }}>{label}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Voice Config */}
        <div className="rounded-xl p-5" style={{ background: '#13161C', border: '1px solid #1E2128' }}>
          <p className="text-xs font-medium mb-4" style={{ color: '#565D6E', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Voice Config & Upload</p>
          <div className="flex flex-wrap gap-4 items-end">
            <div className="flex-1 min-w-[160px]">
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#8B92A5' }}>Language</label>
              <select value={language} onChange={e => setLanguage(e.target.value)} className={sel}>
                <option value="hindi">Hindi</option>
                <option value="marathi">Marathi</option>
                <option value="english">English</option>
              </select>
            </div>
            <div className="flex-1 min-w-[160px]">
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#8B92A5' }}>Voice</label>
              <select value={gender} onChange={e => setGender(e.target.value)} className={sel}>
                <option value="male">Male (Rajesh)</option>
                <option value="female">Female (Diya)</option>
              </select>
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#8B92A5' }}>Agent Type</label>
              <select value={agentType} onChange={e => setAgentType(e.target.value)} className={sel}>
                <option value="loan_enquiry">Loan Enquiry — Pusad Urban</option>
                <option value="account_opening">Account Opening — Union Bank</option>
              </select>
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#8B92A5' }}>From Number (Caller ID)</label>
              <select value={phoneNumberId} onChange={e => setPhoneNumberId(e.target.value)} className={sel}>
                <option value="">Auto (pool picks least-loaded)</option>
                {phoneOptions.map(p => (
                  <option key={p.id} value={p.id}>{p.phone} · {p.provider}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs mt-3" style={{ color: '#3D4452' }}>
            Voice + language are baked into every row at upload time. Existing batches keep their original config.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {/* Upload */}
          <label className={`${actionBtn.base} cursor-pointer`} style={actionBtn.steel}
            onMouseEnter={e => (e.currentTarget.style.background = '#252830')}
            onMouseLeave={e => (e.currentTarget.style.background = '#1E2128')}>
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading ? 'Uploading…' : 'Upload Excel'}
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleUpload} disabled={uploading} />
          </label>

          {[
            { label: 'Start Batch',   icon: <Play className="w-4 h-4" />,     loading: starting, onClick: triggerBatch },
            { label: 'Resume',        icon: <Play className="w-4 h-4" />,     loading: resuming, onClick: resumeCalling },
            { label: 'Retry Failed',  icon: <RotateCcw className="w-4 h-4" />,loading: retrying, onClick: retryFailed },
            { label: 'Cleanup Stuck', icon: <Wrench className="w-4 h-4" />,   loading: cleaning, onClick: cleanupStuck },
            { label: 'Refresh',       icon: <RefreshCw className="w-4 h-4" />,loading: false,    onClick: refresh },
          ].map(({ label, icon, loading: busy, onClick }) => (
            <button key={label} onClick={onClick} disabled={busy}
              className={actionBtn.base} style={actionBtn.steel}
              onMouseEnter={e => { if (!busy) (e.currentTarget as HTMLElement).style.background = '#252830'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#1E2128'; }}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
              {label}
            </button>
          ))}

          <button onClick={emergencyStop} disabled={stopping}
            className={`${actionBtn.base} ml-auto`} style={actionBtn.danger}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#1A0D0D'; (e.currentTarget as HTMLElement).style.borderColor = '#7F1D1D'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.borderColor = '#3D1A1A'; }}>
            {stopping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
            Emergency Stop
          </button>
        </div>

        {/* Upload History */}
        <div className="rounded-xl overflow-hidden" style={{ background: '#13161C', border: '1px solid #1E2128' }}>
          <div className="px-5 py-4 flex items-center gap-2" style={{ borderBottom: '1px solid #1E2128' }}>
            <FileSpreadsheet className="w-4 h-4" style={{ color: '#565D6E' }} />
            <h2 className="text-sm font-medium" style={{ color: '#8B92A5' }}>Upload History</h2>
            <span className="ml-auto text-xs" style={{ color: '#3D4452' }}>Click a row to see calls</span>
          </div>

          {loading ? (
            <div className="p-10 flex justify-center">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: '#3D4452' }} />
            </div>
          ) : batches.length === 0 ? (
            <div className="p-10 text-center">
              <FileSpreadsheet className="w-8 h-8 mx-auto mb-2" style={{ color: '#2D3139' }} />
              <p className="text-sm" style={{ color: '#3D4452' }}>No batches uploaded yet</p>
            </div>
          ) : (
            <div>
              {batches.map((batch: any, i: number) => {
                const bId     = batch.batch_id || batch.id;
                const isOpen  = expandedBatch === bId;
                const calls   = batchCalls[bId] || [];
                const isBusy  = loadingCalls === bId;

                return (
                  <div key={batch.id || bId} style={{ borderBottom: i < batches.length - 1 ? '1px solid #1A1D23' : 'none' }}>
                    <button onClick={() => toggleBatch(bId)}
                      className="w-full px-5 py-3.5 flex items-center justify-between text-left transition-colors"
                      onMouseEnter={e => (e.currentTarget.style.background = '#0F1117')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate" style={{ color: '#C8CBD4' }}>
                          {batch.filename || batch.file_name || 'Unknown file'}
                        </p>
                        <p className="text-xs mt-0.5" style={{ color: '#3D4452' }}>
                          {batch.total_records ?? batch.count ?? 0} records · {formatDateTime(batch.uploaded_at || batch.created_at || '')}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                        <span className="px-2 py-0.5 text-xs font-medium rounded" style={statusBadge(batch.status || '')}>
                          {batch.status || 'pending'}
                        </span>
                        {isOpen
                          ? <ChevronUp className="w-4 h-4" style={{ color: '#565D6E' }} />
                          : <ChevronDown className="w-4 h-4" style={{ color: '#565D6E' }} />}
                      </div>
                    </button>

                    {isOpen && (
                      <div style={{ borderTop: '1px solid #1A1D23', background: '#0F1117' }}>
                        {isBusy ? (
                          <div className="py-6 flex justify-center">
                            <Loader2 className="w-5 h-5 animate-spin" style={{ color: '#3D4452' }} />
                          </div>
                        ) : calls.length === 0 ? (
                          <p className="py-5 text-center text-xs" style={{ color: '#3D4452' }}>No calls in this batch</p>
                        ) : (
                          <div>
                            <div className="grid grid-cols-[2fr_1.5fr_1fr_0.5fr_0.5fr_0.5fr] gap-2 px-5 py-2 text-[10px] font-semibold uppercase tracking-wide"
                              style={{ color: '#3D4452', borderBottom: '1px solid #1A1D23' }}>
                              <span>Name</span><span>Phone</span><span>Status</span>
                              <span>Duration</span><span>Interested</span><span>Form</span>
                            </div>
                            <div className="max-h-72 overflow-y-auto">
                              {calls.map((call: any) => (
                                <div key={call.id}
                                  className="grid grid-cols-[2fr_1.5fr_1fr_0.5fr_0.5fr_0.5fr] gap-2 px-5 py-2.5 items-center"
                                  style={{ borderBottom: '1px solid #1A1D23' }}>
                                  <span className="flex items-center gap-1.5 text-sm font-medium truncate" style={{ color: '#C8CBD4' }}>
                                    <User className="w-3 h-3 flex-shrink-0" style={{ color: '#565D6E' }} />
                                    {call.customer_name || '—'}
                                  </span>
                                  <span className="flex items-center gap-1.5 font-mono text-xs truncate" style={{ color: '#565D6E' }}>
                                    <Phone className="w-3 h-3 flex-shrink-0" style={{ color: '#3D4452' }} />
                                    {call.phone || '—'}
                                  </span>
                                  <span>
                                    <span className="px-1.5 py-0.5 text-[10px] font-medium rounded" style={statusBadge(call.status || '')}>
                                      {call.status || '—'}
                                    </span>
                                  </span>
                                  <span className="flex items-center gap-1 text-xs" style={{ color: '#565D6E' }}>
                                    <Clock className="w-3 h-3" />
                                    {call.call_duration ? `${call.call_duration}s` : '—'}
                                  </span>
                                  <span className="text-xs font-medium" style={{
                                    color: call.interested === true ? '#4ADE80' : call.interested === false ? '#F87171' : '#3D4452'
                                  }}>
                                    {call.interested === true ? 'Yes' : call.interested === false ? 'No' : '—'}
                                  </span>
                                  <span className="text-xs font-medium" style={{ color: call.form_sent ? '#4ADE80' : '#3D4452' }}>
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
