'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL, formatDate, formatDateTime } from '@/lib/api';
import { getAccessToken, getCurrentUser } from '@/lib/auth';
import { ArrowLeft, Phone, PhoneOff, Clock, ChevronRight, Search, Filter, Loader2, Building2 } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';

interface Call {
  _id: string;
  customer_name: string;
  phone: string;
  status: string;
  call_duration?: number;
  language?: string;
  loan_type?: string;
  loan_amount?: number;
  created_at?: string;
  ended_at?: string;
  interested?: boolean;
  form_sent?: boolean;
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  completed: { label: 'Completed', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' },
  in_progress: { label: 'In Progress', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  failed: { label: 'Failed', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  not_answered: { label: 'Not Answered', color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300' },
  queued: { label: 'Queued', color: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300' },
};

export default function CallsPage() {
  const router = useRouter();
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [token, setToken] = useState('');

  useEffect(() => {
    const t = getAccessToken('bank');
    if (!t) { router.push('/bank/login'); return; }
    setToken(t);
  }, []);

  useEffect(() => { if (token) fetchCalls(); }, [token, statusFilter]);

  const fetchCalls = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const res = await fetch(`${API_URL}/api/agent/calls?${params}`, {
        headers: { Authorization: `Bearer ${token}` }, credentials: 'include',
      });
      const data = await res.json();
      setCalls(data.calls || []);
    } catch { } finally { setLoading(false); }
  };

  const filtered = calls.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.customer_name?.toLowerCase().includes(q) || c.phone?.includes(q);
  });

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">
      <div className="bg-white dark:bg-dark-card shadow dark:shadow-gray-900/50">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/bank/dashboard')} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition">
              <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-300" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">Call Logs</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">{calls.length} calls total</p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {/* Search + Filter */}
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or phone..."
              className="w-full pl-10 pr-4 py-2.5 border border-gray-300 dark:border-gray-600 dark:bg-dark-input dark:text-gray-100 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
          <div className="flex gap-2 overflow-x-auto">
            {['all', 'completed', 'in_progress', 'failed', 'not_answered'].map(s => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                  statusFilter === s ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-dark-section text-gray-700 dark:text-gray-300'
                }`}>
                {s === 'all' ? 'All' : STATUS_MAP[s]?.label || s}
              </button>
            ))}
          </div>
        </div>

        {/* Calls Table */}
        {loading ? (
          <div className="bg-white dark:bg-dark-card rounded-xl p-12 text-center">
            <Loader2 className="w-8 h-8 text-blue-600 animate-spin mx-auto mb-3" />
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading calls...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white dark:bg-dark-card rounded-xl p-12 text-center">
            <Phone className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
            <p className="text-sm text-gray-500 dark:text-gray-400">No calls found</p>
          </div>
        ) : (
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700/50">
              <thead className="bg-gray-50 dark:bg-dark-section">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Customer</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Duration</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Language</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Interest</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Date</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {filtered.map(call => {
                  const st = STATUS_MAP[call.status] || { label: call.status, color: 'bg-gray-100 text-gray-700' };
                  return (
                    <tr key={call._id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition"
                      onClick={() => router.push(`/bank/calls/${call._id}`)}>
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium text-gray-900 dark:text-white">{call.customer_name || 'Unknown'}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">{call.phone}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${st.color}`}>{st.label}</span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                        {call.call_duration ? `${Math.floor(call.call_duration / 60)}:${String(call.call_duration % 60).padStart(2, '0')}` : '--'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{call.language || '--'}</td>
                      <td className="px-4 py-3">
                        {call.interested === true ? <span className="text-green-600 text-xs font-medium">Interested</span> :
                         call.interested === false ? <span className="text-red-600 text-xs font-medium">Not Interested</span> :
                         <span className="text-gray-400 text-xs">--</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">{formatDateTime(call.created_at || '')}</td>
                      <td className="px-4 py-3"><ChevronRight className="w-4 h-4 text-gray-400" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
