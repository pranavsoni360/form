'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Upload, Play, Square, RefreshCw,
  FileSpreadsheet, Phone, CheckCircle2,
  XCircle, Clock,
} from 'lucide-react';

import { API_URL } from '@/lib/api/index';
import { getAccessToken } from '@/lib/auth';

import EmptyState        from '@/components/ui/EmptyState';
import { SkeletonTable } from '@/components/ui/skeleton';
import DataCard          from '@/components/ui/DataCard';

function formatBatchDate(raw?: string): string {
  if (!raw) return '—';
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime()) || d.getFullYear() < 2020) return '—';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      + ', ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { return '—'; }
}

export default function BatchPage() {
  const router = useRouter();

  const [batches, setBatches]         = useState<any[]>([]);
  const [loading, setLoading]         = useState(true);
  const [uploading, setUploading]     = useState(false);
  const [batchStatus, setBatchStatus] = useState<any>(null);
  const [token, setToken]             = useState('');

  useEffect(() => {
    const t = getAccessToken('bank');
    if (!t) { router.replace('/bank/login'); return; }
    setToken(t);
  }, []);

  useEffect(() => {
    if (!token) return;
    fetchBatches();
    fetchStatus();
    // Poll status every 5s for live updates
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [token]);

  const fetchBatches = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/agent/uploads`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      const data = await res.json();
      setBatches(data.uploads || []);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/api/agent/batch-status`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      setBatchStatus(await res.json());
    } catch {
      // silently fail
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_URL}/api/agent/upload-excel`, {
        method: 'POST',
        body: fd,
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.detail || 'Upload failed');
      }
      await fetchBatches();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const triggerBatch = async () => {
    if (!confirm('Start batch calling? This will initiate calls to all pending customers.')) return;
    try {
      await fetch(`${API_URL}/api/agent/batch-call`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      fetchStatus();
    } catch {
      // silently fail
    }
  };

  const emergencyStop = async () => {
    if (!confirm('EMERGENCY STOP: This will terminate ALL active calls immediately.')) return;
    try {
      await fetch(`${API_URL}/api/agent/emergency-stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      fetchStatus();
    } catch {
      // silently fail
    }
  };

  const statusBadge = (status: string) => {
    const map: Record<string, { bg: string; color: string; label: string }> = {
      completed:   { bg: 'rgba(5,150,105,0.1)',   color: '#059669', label: 'Completed' },
      in_progress: { bg: 'rgba(37,99,235,0.1)',   color: '#2563EB', label: 'In progress' },
      uploaded:    { bg: 'rgba(100,116,139,0.08)', color: '#64748B', label: 'Uploaded' },
    };
    const s = map[status] || map.uploaded;
    return (
      <span className="text-xs font-semibold px-2.5 py-1 rounded-full"
        style={{ background: s.bg, color: s.color }}>
        {s.label}
      </span>
    );
  };

  return (
    <div className="space-y-6 animate-fade-in">

      {/* Heading */}
      <div>
        <h2 className="text-2xl font-bold"
          style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
          Batch Calling
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Upload Excel, trigger calls, monitor progress
        </p>
      </div>

      {/* Live status stat cards — matches dashboard design */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <DataCard
          title="Active calls"
          value={batchStatus?.active_calls ?? 0}
          icon={<Phone className="w-5 h-5" />}
          accent="blue"
        />
        <DataCard
          title="Completed"
          value={batchStatus?.completed ?? 0}
          icon={<CheckCircle2 className="w-5 h-5" />}
          accent="green"
        />
        <DataCard
          title="Pending"
          value={batchStatus?.pending ?? 0}
          icon={<Clock className="w-5 h-5" />}
          accent="orange"
        />
        <DataCard
          title="Failed"
          value={batchStatus?.failed ?? 0}
          icon={<XCircle className="w-5 h-5" />}
          accent="red"
        />
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-3">
        <label
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white cursor-pointer transition-all"
          style={{ background: 'linear-gradient(135deg, #1A1A2E 0%, #0F3460 100%)', boxShadow: '0 2px 8px rgba(26,26,46,0.25)' }}
          onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-1px)')}
          onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}>
          <Upload className="w-4 h-4" />
          {uploading ? 'Uploading...' : 'Upload Excel'}
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={handleUpload}
            disabled={uploading}
          />
        </label>

        <button
          onClick={triggerBatch}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all"
          style={{ background: 'linear-gradient(135deg, #059669 0%, #047857 100%)', boxShadow: '0 2px 8px rgba(5,150,105,0.25)' }}
          onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-1px)')}
          onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}>
          <Play className="w-4 h-4" /> Start batch
        </button>

        <button
          onClick={emergencyStop}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all"
          style={{ background: 'linear-gradient(135deg, #DC2626 0%, #B91C1C 100%)', boxShadow: '0 2px 8px rgba(220,38,38,0.25)' }}
          onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-1px)')}
          onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}>
          <Square className="w-4 h-4" /> Emergency stop
        </button>

        <button
          onClick={() => { fetchBatches(); fetchStatus(); }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all"
          style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--border)'}
          onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-subtle)'}>
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {/* Upload history */}
      <div className="rounded-2xl overflow-hidden"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4"
          style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
          <div className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'rgba(37,99,235,0.1)', color: '#2563EB' }}>
            <FileSpreadsheet className="w-3.5 h-3.5" />
          </div>
          <h3 className="font-semibold text-sm"
            style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
            Upload history
          </h3>
          <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
            style={{ background: 'rgba(37,99,235,0.1)', color: '#2563EB' }}>
            {batches.length}
          </span>
        </div>

        {loading ? (
          <SkeletonTable rows={4} />
        ) : batches.length === 0 ? (
          <EmptyState
            title="No batches uploaded yet"
            description="Upload an Excel or CSV file to start batch calling."
            icon={<FileSpreadsheet className="w-10 h-10" />}
          />
        ) : (
          <div>
            {batches.map((batch: any, i) => (
              <div
                key={batch._id || batch.id || i}
                className="flex items-center justify-between px-5 py-4 transition-colors"
                style={{ borderBottom: i < batches.length - 1 ? '1px solid var(--border)' : 'none' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(37,99,235,0.06)', color: '#2563EB', border: '1px solid rgba(37,99,235,0.12)' }}>
                    <FileSpreadsheet className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold"
                      style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                      {batch.filename || batch.file_name || 'Unnamed file'}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {batch.total_records || batch.count || 0} records
                      {' · '}
                      {formatBatchDate(batch.uploaded_at || batch.created_at)}
                    </p>
                  </div>
                </div>
                {statusBadge(batch.status || 'uploaded')}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
