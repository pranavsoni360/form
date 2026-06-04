'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Phone, Search, ChevronRight, X,
  Clock, Mic, Globe, TrendingUp,
} from 'lucide-react';

import { API_URL } from '@/lib/api/index';
import { getAccessToken } from '@/lib/auth';

import EmptyState        from '@/components/ui/EmptyState';
import { SkeletonTable } from '@/components/ui/skeleton';

interface Call {
  _id:             string;
  customer_name:   string;
  phone:           string;
  status:          string;
  call_duration?:  number;
  language?:       string;
  interested?:     boolean;
  created_at?:     string;
  transcript?:     string;
  summary?:        string;
  recording_url?:  string;
  sentiment?:      string;
  loan_id?:        string;
}

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string }> = {
  'Calling':                 { label: 'In Progress',    bg: 'rgba(37,99,235,0.1)',   color: '#2563EB' },
  'Called':                  { label: 'Called',         bg: 'rgba(5,150,105,0.1)',   color: '#059669' },
  'Called - Interested':     { label: 'Interested',     bg: 'rgba(5,150,105,0.1)',   color: '#059669' },
  'Called - Not Interested': { label: 'Not Interested', bg: 'rgba(234,88,12,0.1)',   color: '#EA580C' },
  'Not Answered':            { label: 'No Answer',      bg: 'rgba(217,119,6,0.1)',   color: '#D97706' },
  'Call Not Connected':      { label: 'Not Connected',  bg: 'rgba(217,119,6,0.1)',   color: '#D97706' },
  'Failed':                  { label: 'Failed',         bg: 'rgba(220,38,38,0.1)',   color: '#DC2626' },
  'Pending':                 { label: 'Pending',        bg: 'rgba(100,116,139,0.1)', color: '#64748B' },
};

const FILTERS = ['all', 'Called - Interested', 'Called - Not Interested', 'Not Answered', 'Failed', 'Pending'];

function formatCallDate(raw?: string): string {
  if (!raw) return '—';
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return '—';
    if (d.getFullYear() < 2020 || d.getFullYear() > 2030) return '—';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      + ', ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch {
    return '—';
  }
}

function fmtDuration(s?: number): string {
  if (!s) return '—';
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

function CallDetailModal({ call, onClose }: { call: Call; onClose: () => void }) {
  const st = STATUS_CONFIG[call.status] || { label: call.status, bg: 'rgba(100,116,139,0.1)', color: '#64748B' };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div className="relative w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl overflow-hidden animate-scale-in"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
              style={{ background: 'rgba(37,99,235,0.08)', color: '#2563EB', fontFamily: 'Plus Jakarta Sans' }}>
              {call.customer_name?.charAt(0)?.toUpperCase() || '?'}
            </div>
            <div>
              <p className="text-sm font-bold"
                style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                {call.customer_name || 'Unknown'}
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{call.phone}</p>
            </div>
          </div>
          <button onClick={onClose}
            className="p-1.5 rounded-xl transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-subtle)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {/* Meta grid */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { icon: Phone, label: 'Status', value: <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: st.bg, color: st.color }}>{st.label}</span> },
              { icon: Clock, label: 'Duration', value: fmtDuration(call.call_duration) },
              { icon: Globe, label: 'Language', value: call.language || '—' },
              { icon: TrendingUp, label: 'Interest', value: call.interested === true ? '✓ Interested' : call.interested === false ? '✗ Not interested' : '—' },
            ].map(item => (
              <div key={item.label} className="rounded-xl p-3"
                style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <item.icon className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{item.label}</span>
                </div>
                <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  {item.value}
                </div>
              </div>
            ))}
          </div>

          {/* Date */}
          <div className="rounded-xl px-4 py-3 flex items-center justify-between"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Call date</span>
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              {formatCallDate(call.created_at)}
            </span>
          </div>

          {/* Summary */}
          {call.summary && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider mb-2"
                style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
                AI Summary
              </p>
              <div className="rounded-xl p-4"
                style={{ background: 'rgba(124,58,237,0.04)', border: '1px solid rgba(124,58,237,0.15)' }}>
                <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  {call.summary}
                </p>
              </div>
            </div>
          )}

          {/* Transcript */}
          {call.transcript && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider mb-2"
                style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
                Transcript
              </p>
              <div className="rounded-xl p-4 max-h-48 overflow-y-auto"
                style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <pre className="text-xs leading-relaxed whitespace-pre-wrap"
                  style={{ color: 'var(--text-secondary)', fontFamily: 'DM Sans' }}>
                  {call.transcript}
                </pre>
              </div>
            </div>
          )}

          {/* Recording */}
          {call.recording_url && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider mb-2"
                style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
                Recording
              </p>
              <div className="rounded-xl p-3"
                style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <audio controls className="w-full" src={`${API_URL}${call.recording_url}`} />
              </div>
            </div>
          )}

          {/* No extra data fallback */}
          {!call.summary && !call.transcript && !call.recording_url && (
            <div className="rounded-xl p-4 text-center"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
              <Mic className="w-6 h-6 mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Transcript and recording will be available once the voice agent is active.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CallsPage() {
  const router = useRouter();

  const [calls, setCalls]               = useState<Call[]>([]);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [token, setToken]               = useState('');
  const [selectedCall, setSelectedCall] = useState<Call | null>(null);

  useEffect(() => {
    const t = getAccessToken('bank');
    if (!t) { router.replace('/bank/login'); return; }
    setToken(t);
  }, []);

  useEffect(() => {
    if (!token) return;
    fetchCalls();
  }, [token, statusFilter]);

  const fetchCalls = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const res = await fetch(`${API_URL}/api/agent/calls?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      const data = await res.json();
      setCalls(data.calls || []);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  };

  const filtered = calls.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.customer_name?.toLowerCase().includes(q) || c.phone?.includes(q);
  });

  return (
    <div className="space-y-6 animate-fade-in">

      {/* Heading */}
      <div>
        <h2 className="text-2xl font-bold"
          style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
          Call Logs
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          {calls.length} call{calls.length !== 1 ? 's' : ''} total
        </p>
      </div>

      {/* Search + filters */}
      <div className="rounded-2xl p-4 space-y-3"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
            style={{ color: 'var(--text-muted)' }} />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or phone..."
            className="w-full pl-9 pr-4 py-2.5 rounded-xl text-sm outline-none"
            style={{
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
            }}
            onFocus={e => e.target.style.borderColor = '#1A1A2E'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'}
          />
        </div>
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
          {FILTERS.map(s => {
            const cfg = STATUS_CONFIG[s];
            return (
              <button key={s} onClick={() => setStatusFilter(s)}
                className="px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all flex-shrink-0"
                style={statusFilter === s
                  ? { background: '#1A1A2E', color: '#fff' }
                  : { background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>
                {s === 'all' ? 'All' : cfg?.label || s}
              </button>
            );
          })}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <SkeletonTable rows={6} />
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <EmptyState
            title="No calls found"
            description="No calls match your search or filter."
            icon={<Phone className="w-10 h-10" />}
          />
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>

          {/* Header */}
          <div className="grid grid-cols-12 px-5 py-3 text-xs font-semibold uppercase tracking-wider"
            style={{
              background: 'var(--bg-subtle)',
              borderBottom: '1px solid var(--border)',
              color: 'var(--text-muted)',
              letterSpacing: '0.07em',
            }}>
            <div className="col-span-4">Customer</div>
            <div className="col-span-2">Status</div>
            <div className="col-span-1">Duration</div>
            <div className="col-span-2">Language</div>
            <div className="col-span-2">Interest</div>
            <div className="col-span-1">Date</div>
          </div>

          {/* Rows */}
          {filtered.map((call, i) => {
            const st = STATUS_CONFIG[call.status] || { label: call.status, bg: 'rgba(100,116,139,0.1)', color: '#64748B' };
            return (
              <div
                key={call._id}
                onClick={() => setSelectedCall(call)}
                className="grid grid-cols-12 px-5 py-4 cursor-pointer transition-colors items-center"
                style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>

                {/* Customer */}
                <div className="col-span-4 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                    style={{ background: 'rgba(37,99,235,0.08)', color: '#2563EB' }}>
                    {call.customer_name?.charAt(0)?.toUpperCase() || '?'}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate"
                      style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
                      {call.customer_name || 'Unknown'}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{call.phone}</p>
                  </div>
                </div>

                {/* Status */}
                <div className="col-span-2">
                  <span className="text-xs font-semibold px-2 py-1 rounded-full"
                    style={{ background: st.bg, color: st.color }}>
                    {st.label}
                  </span>
                </div>

                {/* Duration */}
                <div className="col-span-1">
                  <span className="text-sm" style={{ color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono' }}>
                    {fmtDuration(call.call_duration)}
                  </span>
                </div>

                {/* Language */}
                <div className="col-span-2">
                  <span className="text-sm capitalize" style={{ color: 'var(--text-secondary)' }}>
                    {call.language || '—'}
                  </span>
                </div>

                {/* Interest */}
                <div className="col-span-2">
                  {call.interested === true ? (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(5,150,105,0.1)', color: '#059669' }}>
                      Interested
                    </span>
                  ) : call.interested === false ? (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(234,88,12,0.1)', color: '#EA580C' }}>
                      Not interested
                    </span>
                  ) : (
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>—</span>
                  )}
                </div>

                {/* Date + arrow */}
                <div className="col-span-1 flex items-center justify-between">
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {formatCallDate(call.created_at)}
                  </span>
                  <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Call detail modal */}
      {selectedCall && (
        <CallDetailModal call={selectedCall} onClose={() => setSelectedCall(null)} />
      )}
    </div>
  );
}
