'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL, formatDateTime } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { ArrowLeft, Upload, Play, Square, RefreshCw, FileSpreadsheet, Loader2 } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import { useEventStream } from '@/lib/realtime/useEventStream';
import { batchesReducer, initialBatchesState, type BatchesState } from '@/lib/realtime/reducers';

export default function BatchPage() {
  const router = useRouter();
  const [batches, setBatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [batchStatus, setBatchStatus] = useState<any>(null);
  const [token, setToken] = useState('');
  const [language, setLanguage] = useState('hindi');
  const [gender, setGender] = useState('male');
  const [agentType, setAgentType] = useState<string>('loan_enquiry');

  const liveBatches = useEventStream<BatchesState>('batches', batchesReducer, initialBatchesState);

  useEffect(() => {
    const t = getAccessToken('bank');
    if (!t) { router.push('/bank/login'); return; }
    setToken(t);
  }, []);

  useEffect(() => { if (token) fetchBatches(); }, [token]);

  const fetchBatches = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/agent/uploads`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' });
      const data = await res.json();
      setBatches(data.uploads || []);
    } catch { } finally { setLoading(false); }
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/api/agent/batch-status`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' });
      setBatchStatus(await res.json());
    } catch { }
  };

  useEffect(() => {
    if (!token) return;
    fetchStatus();
  }, [token]);

  useEffect(() => {
    if (!token) return;
    if (Object.keys(liveBatches.byId).length === 0) return;
    const timer = setTimeout(fetchStatus, 500);
    return () => clearTimeout(timer);
  }, [token, liveBatches.byId]);

  useEffect(() => {
    if (!token) return;
    const onFocus = () => fetchStatus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [token]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const qs = `language=${encodeURIComponent(language)}&gender=${encodeURIComponent(gender)}&agent_type=${encodeURIComponent(agentType)}`;
      const res = await fetch(`${API_URL}/api/agent/upload-excel?${qs}`, {
        method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` }, credentials: 'include',
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.detail || 'Upload failed'); }
      await fetchBatches();
    } catch (err: any) { alert(err.message); }
    finally { setUploading(false); }
  };

  const triggerBatch = async () => {
    if (!confirm('Start batch calling? This will initiate calls to all pending customers.')) return;
    try {
      await fetch(`${API_URL}/api/agent/batch-call`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, credentials: 'include' });
      fetchStatus();
    } catch { }
  };

  const emergencyStop = async () => {
    if (!confirm('EMERGENCY STOP: This will terminate ALL active calls immediately.')) return;
    try {
      await fetch(`${API_URL}/api/agent/emergency-stop`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, credentials: 'include' });
      fetchStatus();
    } catch { }
  };

  const sel = "w-full px-3 py-2 rounded-md border border-[#2D3139] bg-[#1A1D23] text-sm text-[#C8CBD4] focus:outline-none focus:border-[#4A5568] transition-colors";

  const statItems = [
    { label: 'Active Calls', value: batchStatus?.active_calls || 0 },
    { label: 'Completed',    value: batchStatus?.completed    || 0 },
    { label: 'Pending',      value: batchStatus?.pending      || 0 },
    { label: 'Failed',       value: batchStatus?.failed       || 0 },
  ];

  return (
    <div className="min-h-screen" style={{ background: '#0F1117' }}>

      {/* Header */}
      <div style={{ background: '#13161C', borderBottom: '1px solid #1E2128' }}>
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/bank/dashboard')}
              className="p-2 rounded-lg transition-colors"
              style={{ color: '#8B92A5' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#1E2128')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
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

        {/* Live Status */}
        {batchStatus && (
          <div className="rounded-xl p-5" style={{ background: '#13161C', border: '1px solid #1E2128' }}>
            <p className="text-xs font-medium mb-4" style={{ color: '#565D6E', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Live Status</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
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
            <div className="flex-1 min-w-[180px]">
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#8B92A5' }}>Language</label>
              <select value={language} onChange={e => setLanguage(e.target.value)} className={sel}>
                <option value="hindi">Hindi</option>
                <option value="marathi">Marathi</option>
                <option value="english">English</option>
              </select>
            </div>
            <div className="flex-1 min-w-[180px]">
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#8B92A5' }}>Voice</label>
              <select value={gender} onChange={e => setGender(e.target.value)} className={sel}>
                <option value="male">Male (Rajesh)</option>
                <option value="female">Female (Diya)</option>
              </select>
            </div>
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#8B92A5' }}>Agent Type</label>
              <select value={agentType} onChange={e => setAgentType(e.target.value)} className={sel}>
                <option value="loan_enquiry">Loan Enquiry — Pusad Urban</option>
                <option value="account_opening">Account Opening — Union Bank</option>
              </select>
            </div>
          </div>
          <p className="text-xs mt-3" style={{ color: '#3D4452' }}>
            These are baked into every row at upload time. Existing batches keep their original config.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-2">
          <label
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors"
            style={{ background: '#1E2128', color: '#C8CBD4', border: '1px solid #2D3139' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#252830')}
            onMouseLeave={e => (e.currentTarget.style.background = '#1E2128')}
          >
            <Upload className="w-4 h-4" />
            {uploading ? 'Uploading...' : 'Upload Excel'}
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleUpload} disabled={uploading} />
          </label>

          <button
            onClick={triggerBatch}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ background: '#1E2128', color: '#C8CBD4', border: '1px solid #2D3139' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#252830')}
            onMouseLeave={e => (e.currentTarget.style.background = '#1E2128')}
          >
            <Play className="w-4 h-4" /> Start Batch
          </button>

          <button
            onClick={fetchStatus}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ background: '#1E2128', color: '#C8CBD4', border: '1px solid #2D3139' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#252830')}
            onMouseLeave={e => (e.currentTarget.style.background = '#1E2128')}
          >
            <RefreshCw className="w-4 h-4" /> Resume
          </button>

          <button
            onClick={fetchBatches}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ background: '#1E2128', color: '#C8CBD4', border: '1px solid #2D3139' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#252830')}
            onMouseLeave={e => (e.currentTarget.style.background = '#1E2128')}
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>

          <button
            onClick={emergencyStop}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ml-auto"
            style={{ background: 'transparent', color: '#EF4444', border: '1px solid #3D1A1A' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#1A0D0D'; e.currentTarget.style.borderColor = '#7F1D1D'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = '#3D1A1A'; }}
          >
            <Square className="w-4 h-4" /> Emergency Stop
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
              {batches.map((batch: any, i: number) => (
                <div
                  key={batch._id || batch.id}
                  className="px-5 py-3.5 flex items-center justify-between transition-colors"
                  style={{ borderBottom: i < batches.length - 1 ? '1px solid #1A1D23' : 'none' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#0F1117')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <div>
                    <p className="text-sm font-medium" style={{ color: '#C8CBD4' }}>{batch.filename || batch.file_name}</p>
                    <p className="text-xs mt-0.5" style={{ color: '#3D4452' }}>
                      {batch.total_records || batch.count || 0} records · {formatDateTime(batch.uploaded_at || batch.created_at || '')}
                    </p>
                  </div>
                  <span
                    className="px-2 py-0.5 text-xs font-medium rounded"
                    style={
                      batch.status === 'completed'   ? { background: '#0D1F18', color: '#4ADE80', border: '1px solid #14532D' } :
                      batch.status === 'in_progress' ? { background: '#0F1825', color: '#60A5FA', border: '1px solid #1E3A5F' } :
                                                       { background: '#1A1D23', color: '#565D6E', border: '1px solid #2D3139' }
                    }
                  >
                    {batch.status || 'uploaded'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
