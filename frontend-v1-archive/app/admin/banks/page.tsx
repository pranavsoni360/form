'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getBanks, createBank } from '@/lib/api';
import { ArrowLeft, Building2, Plus, ChevronRight, Loader2, X } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import { getAccessToken, getCurrentUser, logout as authLogout } from '@/lib/auth';

export default function BanksPage() {
  const router = useRouter();
  const [banks, setBanks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', contact_email: '', contact_phone: '', address: '' });
  const [error, setError] = useState('');
  const [token, setToken] = useState('');

  useEffect(() => {
    const t = getAccessToken('admin');
    if (!t) { router.push('/admin/login'); return; }
    setToken(t);
  }, []);

  useEffect(() => { if (token) fetchBanks(); }, [token]);

  const fetchBanks = async () => {
    setLoading(true);
    try {
      const data = await getBanks(token);
      setBanks(data.banks || []);
    } catch (err: any) {
      if (err.message?.includes('401')) router.push('/admin/login');
    } finally { setLoading(false); }
  };

  const handleCreate = async () => {
    if (!form.name || !form.code) { setError('Name and code are required'); return; }
    setCreating(true); setError('');
    try {
      await createBank(token, form);
      setShowCreate(false);
      setForm({ name: '', code: '', contact_email: '', contact_phone: '', address: '' });
      await fetchBanks();
    } catch (err: any) {
      setError(err.message || 'Failed to create bank');
    } finally { setCreating(false); }
  };

  const inp = "w-full px-4 py-3 border border-gray-300 dark:border-gray-600 dark:bg-dark-input dark:text-gray-100 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm";

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">
      <div className="bg-white dark:bg-dark-card shadow dark:shadow-gray-900/50">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/admin/dashboard')} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition">
              <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-300" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">Bank Management</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">{banks.length} banks registered</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => setShowCreate(true)} className="flex items-center gap-1 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
              <Plus className="w-4 h-4" /> Add Bank
            </button>
            <ThemeToggle />
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Create Bank Modal */}
        {showCreate && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-dark-card rounded-2xl shadow-2xl p-6 max-w-md w-full">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-gray-900 dark:text-white">Create Bank</h2>
                <button onClick={() => setShowCreate(false)}><X className="w-5 h-5 text-gray-400" /></button>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Bank Name *</label>
                  <input value={form.name} onChange={e => setForm({...form, name: e.target.value})} className={inp} placeholder="e.g. HDFC Bank" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Code *</label>
                  <input value={form.code} onChange={e => setForm({...form, code: e.target.value.toUpperCase()})} className={inp} placeholder="e.g. HDFC" maxLength={20} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Contact Email</label>
                  <input type="email" value={form.contact_email} onChange={e => setForm({...form, contact_email: e.target.value})} className={inp} placeholder="admin@bank.com" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Contact Phone</label>
                  <input value={form.contact_phone} onChange={e => setForm({...form, contact_phone: e.target.value})} className={inp} placeholder="+91..." />
                </div>
                {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
                <button onClick={handleCreate} disabled={creating}
                  className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2 transition">
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create Bank
                </button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 text-blue-600 animate-spin" /></div>
        ) : banks.length === 0 ? (
          <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm p-12 text-center">
            <Building2 className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
            <p className="text-gray-500 dark:text-gray-400 mb-4">No banks created yet</p>
            <button onClick={() => setShowCreate(true)} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">Create First Bank</button>
          </div>
        ) : (
          <div className="space-y-3">
            {banks.map((bank: any) => (
              <div key={bank.id} onClick={() => router.push(`/admin/banks/${bank.id}`)}
                className="bg-white dark:bg-dark-card rounded-xl shadow-sm dark:shadow-gray-900/30 p-5 hover:shadow-md cursor-pointer transition-all group">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex items-center justify-center">
                      <Building2 className="w-6 h-6 text-blue-600" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 dark:text-white">{bank.name}</h3>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{bank.code} · {bank.contact_email || 'No email'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`px-2.5 py-1 text-xs rounded-full ${bank.status === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'}`}>
                      {bank.status}
                    </span>
                    <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-blue-600 transition" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
