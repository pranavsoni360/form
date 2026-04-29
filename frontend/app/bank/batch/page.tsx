'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL, formatDateTime } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { ArrowLeft, Upload, Play, Square, RefreshCw, FileSpreadsheet, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';

export default function BatchPage() {
  const router = useRouter();
  const [batches, setBatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [batchStatus, setBatchStatus] = useState<any>(null);
  const [token, setToken] = useState('');
  const [language, setLanguage] = useState('hindi');
  const [gender, setGender] = useState('male');

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
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [token]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const qs = `language=${encodeURIComponent(language)}&gender=${encodeURIComponent(gender)}`;
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

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">
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

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Live Status */}
        {batchStatus && (
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm p-5">
            <h2 className="font-semibold text-gray-900 dark:text-white mb-3">Live Status</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="text-center">
                <p className="text-2xl font-bold text-blue-600">{batchStatus.active_calls || 0}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Active Calls</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-green-600">{batchStatus.completed || 0}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Completed</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-yellow-600">{batchStatus.pending || 0}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Pending</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-red-600">{batchStatus.failed || 0}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Failed</p>
              </div>
            </div>
          </div>
        )}

        {/* Agent voice config — applied to every record in the next upload */}
        <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm p-5 flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">🌐 Agent Language</label>
            <select
              value={language}
              onChange={e => setLanguage(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white"
            >
              <option value="hindi">🇮🇳 Hindi</option>
              <option value="marathi">🏛️ Marathi</option>
              <option value="english">🌍 English</option>
            </select>
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">👤 Agent Voice</label>
            <select
              value={gender}
              onChange={e => setGender(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white"
            >
              <option value="male">👨 Male (Rajesh)</option>
              <option value="female">👩 Female (Diya)</option>
            </select>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 w-full">
            Selected voice + language are stored per row at upload. Existing batches keep their original config.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium cursor-pointer hover:bg-blue-700 transition">
            <Upload className="w-4 h-4" /> {uploading ? 'Uploading...' : 'Upload Excel'}
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleUpload} disabled={uploading} />
          </label>
          <button onClick={triggerBatch} className="flex items-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition">
            <Play className="w-4 h-4" /> Start Batch
          </button>
          <button onClick={emergencyStop} className="flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition">
            <Square className="w-4 h-4" /> Emergency Stop
          </button>
          <button onClick={fetchBatches} className="flex items-center gap-2 px-4 py-2.5 bg-gray-200 dark:bg-dark-section text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-300 dark:hover:bg-gray-700 transition">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>

        {/* Batch History */}
        <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm">
          <div className="p-5 border-b border-gray-100 dark:border-gray-700/50">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-blue-600" />
              <h2 className="font-semibold text-gray-900 dark:text-white">Upload History</h2>
            </div>
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
              {batches.map((batch: any) => (
                <div key={batch._id || batch.id} className="p-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{batch.filename || batch.file_name}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {batch.total_records || batch.count || 0} records · {formatDateTime(batch.uploaded_at || batch.created_at || '')}
                    </p>
                  </div>
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                    batch.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' :
                    batch.status === 'in_progress' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' :
                    'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
                  }`}>
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
