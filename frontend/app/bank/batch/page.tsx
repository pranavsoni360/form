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

// ── Status helpers ────────────────────────────────────────────────────────────

const BATCH_STATUS_STYLE: Record<string, string> = {
  running:   'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  pending:   'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  paused:    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  failed:    'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
};

const CALL_STATUS_STYLE: Record<string, string> = {
  Calling:                      'bg-blue-100 text-blue-700',
  Completed:                    'bg-green-100 text-green-700',
  Pending:                      'bg-gray-100 text-gray-600',
  Failed:                       'bg-red-100 text-red-700',
  Scheduled:                    'bg-yellow-100 text-yellow-700',
  'Called - Callback Requested':'bg-purple-100 text-purple-700',
  'Not Interested':             'bg-orange-100 text-orange-700',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function BatchPage() {
  const router = useRouter();

  // Auth
  const [token, setToken]   = useState('');
  const [bankId, setBankId] = useState('');

  // Data
  const [batches, setBatches]       = useState<any[]>([]);
  const [batchStatus, setBatchStatus] = useState<any>(null);
  const [loading, setLoading]         = useState(true);

  // Upload
  const [uploading, setUploading] = useState(false);
  const [language, setLanguage]   = useState('hindi');
  const [gender, setGender]       = useState('male');
  const [agentType, setAgentType] = useState('loan_enquiry');

  // Action loading states
  const [starting, setStarting]   = useState(false);
  const [stopping, setStopping]   = useState(false);
  const [retrying, setRetrying]   = useState(false);
  const [cleaning, setCleaning]   = useState(false);
  const [resuming, setResuming]   = useState(false);

  // Inline notification
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);

  // Drill-down
  const [expandedBatch, setExpandedBatch]   = useState<string | null>(null);
  const [batchCalls, setBatchCalls]         = useState<Record<string, any[]>>({});
  const [loadingCalls, setLoadingCalls]     = useState<string | null>(null);

  // SSE: batch progress events → debounced status refetch
  const liveBatches = useEventStream<BatchesState>('batches', batchesReducer, initialBatchesState);

  // ── Notify helper ───────────────────────────────────────────────────────────

  const notify = useCallback((msg: string, ok = true) => {
    setNotice({ msg, ok });
    setTimeout(() => setNotice(null), 4000);
  }, []);

  // ── Auth init ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const t = getAccessToken('bank');
    const u = getCurrentUser('bank') as any;
    if (!t || !u) { router.push('/bank/login'); return; }
    setToken(t);
    setBankId(u.bank_id || '');
  }, []);

  // ── Data fetchers ───────────────────────────────────────────────────────────

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
      const data = await res.json();
      setBatchStatus(data);
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

  const refresh = useCallback(() => {
    fetchBatches();
    fetchStatus();
  }, [fetchBatches, fetchStatus]);

  // ── Initial load & SSE-driven refresh ──────────────────────────────────────

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

  // ── Upload ──────────────────────────────────────────────────────────────────

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const params = new URLSearchParams({
        language,
        gender,
        agent_type: agentType,
        ...(bankId ? { bank_id: bankId } : {}),
      });
      const res = await fetch(`${API_URL}/api/agent/upload-excel?${params}`, {
        method: 'POST', body: fd,
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || `Upload failed (${res.status})`);
      }
      const data = await res.json();
      notify(`Uploaded ${data.inserted_count ?? '?'} records — ${data.auto_calling ? 'calls starting automatically' : 'click Start Batch to begin'}`);
      refresh();
    } catch (err: any) {
      notify(err.message || 'Upload failed', false);
    } finally { setUploading(false); }
  };

  // ── Actions ─────────────────────────────────────────────────────────────────

  const apiPost = async (path: string): Promise<any> => {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.detail || `Request failed (${res.status})`);
    }
    return res.json();
  };

  const triggerBatch = async () => {
    if (!confirm('Start batch calling? This will initiate calls to all pending customers.')) return;
    setStarting(true);
    try {
      const data = await apiPost('/api/agent/batch-call');
      notify(data.message || 'Batch started');
      refresh();
    } catch (err: any) { notify(err.message, false); }
    finally { setStarting(false); }
  };

  const emergencyStop = async () => {
    if (!confirm('EMERGENCY STOP: This will terminate ALL active calls immediately.')) return;
    setStopping(true);
    try {
      await apiPost('/api/agent/emergency-stop');
      notify('Emergency stop sent — active calls will terminate');
      refresh();
    } catch (err: any) { notify(err.message, false); }
    finally { setStopping(false); }
  };

  const retryFailed = async () => {
    setRetrying(true);
    try {
      const data = await apiPost('/api/agent/batch-retry');
      notify(data.message || 'Failed calls reset — restarting batch');
      refresh();
    } catch (err: any) { notify(err.message, false); }
    finally { setRetrying(false); }
  };

  const cleanupStuck = async () => {
    setCleaning(true);
    try {
      const data = await apiPost('/api/agent/stale-cleanup');
      notify(data.message || 'Stuck calls cleaned up');
      refresh();
    } catch (err: any) { notify(err.message, false); }
    finally { setCleaning(false); }
  };

  const resumeCalling = async () => {
    setResuming(true);
    try {
      const data = await apiPost('/api/agent/resume-calling');
      notify(data.message || 'Batch resumed');
      refresh();
    } catch (err: any) { notify(err.message, false); }
    finally { setResuming(false); }
  };

  // ── Drill-down toggle ───────────────────────────────────────────────────────

  const toggleBatch = (batchId: string) => {
    if (expandedBatch === batchId) {
      setExpandedBatch(null);
      return;
    }
    setExpandedBatch(batchId);
    if (!batchCalls[batchId]) fetchBatchCalls(batchId);
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">

      {/* Header */}
      <div className="bg-white dark:bg-dark-card shadow dark:shadow-gray-900/50">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/bank/dashboard')} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition">
              <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-300" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">Batch Calling</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">Upload Excel, trigger calls, monitor progress</p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">

        {/* Inline notification */}
        {notice && (
          <div className={`flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm font-medium ${
            notice.ok
              ? 'bg-green-50 border border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-800 dark:text-green-300'
              : 'bg-red-50 border border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300'
          }`}>
            {notice.ok
              ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
              : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
            {notice.msg}
          </div>
        )}

        {/* Live Status */}
        {batchStatus && (
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm p-5">
            <h2 className="font-semibold text-gray-900 dark:text-white mb-3">Live Status</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: 'Active Calls', value: batchStatus.active_calls ?? 0,  color: 'text-blue-600'   },
                { label: 'Completed',    value: batchStatus.completed    ?? 0,  color: 'text-green-600'  },
                { label: 'Pending',      value: batchStatus.pending      ?? 0,  color: 'text-yellow-600' },
                { label: 'Failed',       value: batchStatus.failed       ?? 0,  color: 'text-red-600'    },
              ].map(({ label, value, color }) => (
                <div key={label} className="text-center">
                  <p className={`text-2xl font-bold ${color}`}>{value}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Voice config */}
        <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm p-5 flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Agent Language</label>
            <select value={language} onChange={e => setLanguage(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white">
              <option value="hindi">Hindi</option>
              <option value="marathi">Marathi</option>
              <option value="english">English</option>
            </select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Agent Voice</label>
            <select value={gender} onChange={e => setGender(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white">
              <option value="male">Male (Rajesh)</option>
              <option value="female">Female (Diya)</option>
            </select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Agent Type</label>
            <select value={agentType} onChange={e => setAgentType(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white">
              <option value="loan_enquiry">Loan Enquiry — Pusad Urban Bank</option>
              <option value="account_opening">Account Opening — Union Bank of India</option>
            </select>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 w-full">
            Voice + language are baked in at upload time. Existing batches keep their original config.
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-3">
          {/* Upload */}
          <label className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium cursor-pointer transition
            ${uploading ? 'bg-blue-400 text-white cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading ? 'Uploading…' : 'Upload Excel'}
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleUpload} disabled={uploading} />
          </label>

          {/* Start */}
          <button onClick={triggerBatch} disabled={starting}
            className="flex items-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-60 transition">
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Start Batch
          </button>

          {/* Resume */}
          <button onClick={resumeCalling} disabled={resuming}
            className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-60 transition">
            {resuming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Resume
          </button>

          {/* Retry failed */}
          <button onClick={retryFailed} disabled={retrying}
            className="flex items-center gap-2 px-4 py-2.5 bg-yellow-500 text-white rounded-lg text-sm font-medium hover:bg-yellow-600 disabled:opacity-60 transition">
            {retrying ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
            Retry Failed
          </button>

          {/* Cleanup stuck */}
          <button onClick={cleanupStuck} disabled={cleaning}
            className="flex items-center gap-2 px-4 py-2.5 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 disabled:opacity-60 transition">
            {cleaning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
            Cleanup Stuck
          </button>

          {/* Emergency stop */}
          <button onClick={emergencyStop} disabled={stopping}
            className="flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-60 transition">
            {stopping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
            Emergency Stop
          </button>

          {/* Refresh */}
          <button onClick={refresh}
            className="flex items-center gap-2 px-4 py-2.5 bg-gray-200 dark:bg-dark-section text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-300 dark:hover:bg-gray-700 transition">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>

        {/* Batch history with drill-down */}
        <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-gray-100 dark:border-gray-700/50 flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-blue-600" />
            <h2 className="font-semibold text-gray-900 dark:text-white">Upload History</h2>
            <span className="ml-auto text-xs text-gray-400">Click a row to see calls</span>
          </div>

          {loading ? (
            <div className="p-8 text-center"><Loader2 className="w-6 h-6 text-blue-600 animate-spin mx-auto" /></div>
          ) : batches.length === 0 ? (
            <div className="p-8 text-center">
              <FileSpreadsheet className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
              <p className="text-sm text-gray-500 dark:text-gray-400">No batches uploaded yet</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {batches.map((batch: any) => {
                const bId       = batch.batch_id || batch.id;
                const isOpen    = expandedBatch === bId;
                const calls     = batchCalls[bId] || [];
                const isLoading = loadingCalls === bId;
                const statusStyle = BATCH_STATUS_STYLE[batch.status] || BATCH_STATUS_STYLE.pending;

                return (
                  <div key={batch.id || bId}>
                    {/* Batch row */}
                    <button
                      onClick={() => toggleBatch(bId)}
                      className="w-full px-5 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800/50 transition text-left"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                          {batch.filename || batch.file_name || 'Unknown file'}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {batch.total_records ?? batch.count ?? 0} records ·{' '}
                          {formatDateTime(batch.uploaded_at || batch.created_at || '')}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                        <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${statusStyle}`}>
                          {batch.status || 'pending'}
                        </span>
                        {isOpen ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                      </div>
                    </button>

                    {/* Expanded call list */}
                    {isOpen && (
                      <div className="border-t border-gray-100 dark:border-gray-700/50 bg-gray-50 dark:bg-gray-900/50">
                        {isLoading ? (
                          <div className="py-6 text-center">
                            <Loader2 className="w-5 h-5 text-blue-600 animate-spin mx-auto" />
                          </div>
                        ) : calls.length === 0 ? (
                          <p className="py-5 text-center text-xs text-gray-500 dark:text-gray-400">No calls in this batch</p>
                        ) : (
                          <div>
                            {/* Column headers */}
                            <div className="grid grid-cols-[2fr_1.5fr_1fr_0.5fr_0.5fr_0.5fr] gap-2 px-5 py-2 text-[10px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100 dark:border-gray-700/50">
                              <span>Name</span>
                              <span>Phone</span>
                              <span>Status</span>
                              <span>Duration</span>
                              <span>Interested</span>
                              <span>Form</span>
                            </div>
                            <div className="divide-y divide-gray-100 dark:divide-gray-700/30 max-h-72 overflow-y-auto">
                              {calls.map((call: any) => (
                                <div key={call.id}
                                  className="grid grid-cols-[2fr_1.5fr_1fr_0.5fr_0.5fr_0.5fr] gap-2 px-5 py-2.5 items-center text-sm">
                                  <span className="flex items-center gap-1.5 text-gray-800 dark:text-gray-200 font-medium truncate">
                                    <User className="w-3 h-3 text-gray-400 flex-shrink-0" />
                                    {call.customer_name || '—'}
                                  </span>
                                  <span className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400 font-mono text-xs truncate">
                                    <Phone className="w-3 h-3 text-gray-400 flex-shrink-0" />
                                    {call.phone || '—'}
                                  </span>
                                  <span>
                                    <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full ${
                                      CALL_STATUS_STYLE[call.status] || 'bg-gray-100 text-gray-600'
                                    }`}>
                                      {call.status || '—'}
                                    </span>
                                  </span>
                                  <span className="flex items-center gap-1 text-xs text-gray-500">
                                    <Clock className="w-3 h-3" />
                                    {call.call_duration ? `${call.call_duration}s` : '—'}
                                  </span>
                                  <span className={`text-xs font-medium ${
                                    call.interested === true  ? 'text-green-600' :
                                    call.interested === false ? 'text-red-500' : 'text-gray-400'
                                  }`}>
                                    {call.interested === true ? 'Yes' : call.interested === false ? 'No' : '—'}
                                  </span>
                                  <span className={`text-xs font-medium ${call.form_sent ? 'text-green-600' : 'text-gray-400'}`}>
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
