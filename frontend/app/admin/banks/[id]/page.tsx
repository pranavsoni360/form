'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { getBankDetail, createBankUser, updateBankUser, deactivateBankUser, updateBank } from '@/lib/api';
import { ArrowLeft, Building2, Users, Plus, Loader2, X, Copy, Check, UserPlus, Shield, Eye } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import { getAccessToken, getCurrentUser, logout as authLogout } from '@/lib/auth';

export default function BankDetailPage() {
  const router = useRouter();
  const params = useParams();
  const bankId = params.id as string;

  const [bank, setBank] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [creating, setCreating] = useState(false);
  const [userForm, setUserForm] = useState({ full_name: '', username: '', email: '', role: 'bank_officer' });
  const [createdCreds, setCreatedCreds] = useState<{ username: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');

  useEffect(() => {
    const t = getAccessToken('admin');
    if (!t) { router.push('/admin/login'); return; }
    setToken(t);
  }, []);

  useEffect(() => { if (token) fetchBank(); }, [token]);

  const fetchBank = async () => {
    setLoading(true);
    try {
      const data = await getBankDetail(token, bankId);
      setBank(data.bank);
      setUsers(data.users || []);
    } catch (err: any) {
      if (err.message?.includes('401')) router.push('/admin/login');
    } finally { setLoading(false); }
  };

  const handleCreateUser = async () => {
    if (!userForm.full_name || !userForm.username) { setError('Name and username required'); return; }
    setCreating(true); setError('');
    try {
      const data = await createBankUser(token, bankId, userForm);
      setCreatedCreds({ username: data.user.username, password: data.password });
      setShowCreateUser(false);
      setUserForm({ full_name: '', username: '', email: '', role: 'bank_officer' });
      await fetchBank();
    } catch (err: any) {
      setError(err.message || 'Failed to create user');
    } finally { setCreating(false); }
  };

  const handleDeactivate = async (userId: string) => {
    if (!confirm('Deactivate this user?')) return;
    try {
      await deactivateBankUser(token, bankId, userId);
      await fetchBank();
    } catch (err: any) { alert(err.message); }
  };

  const copyCredentials = () => {
    if (!createdCreds) return;
    navigator.clipboard.writeText(`Username: ${createdCreds.username}\nPassword: ${createdCreds.password}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const inp = "w-full px-4 py-3 border border-gray-300 dark:border-gray-600 dark:bg-dark-input dark:text-gray-100 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm";

  if (loading) {
    return <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center"><Loader2 className="w-8 h-8 text-blue-600 animate-spin" /></div>;
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors">
      <div className="bg-white dark:bg-dark-card shadow dark:shadow-gray-900/50">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/admin/banks')} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition">
              <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-300" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">{bank?.name}</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">{bank?.code} · {bank?.contact_email}</p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Bank Info Card */}
        <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm dark:shadow-gray-900/30 p-5">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-14 h-14 bg-blue-100 dark:bg-blue-900/30 rounded-2xl flex items-center justify-center">
              <Building2 className="w-7 h-7 text-blue-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">{bank?.name}</h2>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500 dark:text-gray-400">{bank?.code}</span>
                <span className={`px-2 py-0.5 text-xs rounded-full ${bank?.status === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-gray-100 text-gray-600'}`}>
                  {bank?.status}
                </span>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">Email:</span>
              <span className="ml-2 text-gray-900 dark:text-white">{bank?.contact_email || '--'}</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Phone:</span>
              <span className="ml-2 text-gray-900 dark:text-white">{bank?.contact_phone || '--'}</span>
            </div>
          </div>
        </div>

        {/* Created Credentials Toast */}
        {createdCreds && (
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-green-800 dark:text-green-300">User Created Successfully</h3>
              <button onClick={() => setCreatedCreds(null)}><X className="w-4 h-4 text-green-600" /></button>
            </div>
            <p className="text-sm text-green-700 dark:text-green-300 mb-2">Save these credentials — the password is shown only once.</p>
            <div className="bg-white dark:bg-dark-section rounded-lg p-3 font-mono text-sm">
              <p className="text-gray-900 dark:text-gray-100">Username: <strong>{createdCreds.username}</strong></p>
              <p className="text-gray-900 dark:text-gray-100">Password: <strong>{createdCreds.password}</strong></p>
            </div>
            <button onClick={copyCredentials}
              className="mt-3 flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition">
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} {copied ? 'Copied!' : 'Copy Credentials'}
            </button>
          </div>
        )}

        {/* Users Section */}
        <div className="bg-white dark:bg-dark-card rounded-xl shadow-sm dark:shadow-gray-900/30">
          <div className="flex items-center justify-between p-5 border-b border-gray-100 dark:border-gray-700/50">
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-600" />
              <h2 className="font-semibold text-gray-900 dark:text-white">Bank Users</h2>
              <span className="px-2 py-0.5 text-xs bg-gray-100 dark:bg-dark-section text-gray-600 dark:text-gray-400 rounded-full">{users.length}</span>
            </div>
            <button onClick={() => setShowCreateUser(true)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
              <UserPlus className="w-4 h-4" /> Add User
            </button>
          </div>
          {users.length > 0 ? (
            <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
              {users.map((u: any) => (
                <div key={u.id} className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${u.role === 'bank_supervisor' ? 'bg-purple-100 dark:bg-purple-900/30' : 'bg-blue-100 dark:bg-blue-900/30'}`}>
                      {u.role === 'bank_supervisor' ? <Shield className="w-5 h-5 text-purple-600" /> : <Eye className="w-5 h-5 text-blue-600" />}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{u.full_name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">@{u.username} · {u.role === 'bank_supervisor' ? 'Supervisor' : 'Officer'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 text-xs rounded-full ${u.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                    {u.is_active && (
                      <button onClick={() => handleDeactivate(u.id)}
                        className="text-xs text-red-600 dark:text-red-400 hover:underline">Deactivate</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center">
              <Users className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-2" />
              <p className="text-sm text-gray-500 dark:text-gray-400">No users yet</p>
            </div>
          )}
        </div>
      </div>

      {/* Create User Modal */}
      {showCreateUser && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-dark-card rounded-2xl shadow-2xl p-6 max-w-md w-full">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">Add Bank User</h2>
              <button onClick={() => setShowCreateUser(false)}><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Full Name *</label>
                <input value={userForm.full_name} onChange={e => setUserForm({...userForm, full_name: e.target.value})} className={inp} placeholder="John Doe" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username *</label>
                <input value={userForm.username} onChange={e => setUserForm({...userForm, username: e.target.value.toLowerCase().replace(/\s/g, '_')})} className={inp} placeholder="john_doe" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
                <input type="email" value={userForm.email} onChange={e => setUserForm({...userForm, email: e.target.value})} className={inp} placeholder="john@bank.com" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Role *</label>
                <div className="grid grid-cols-2 gap-2">
                  {[{ value: 'bank_officer', label: 'Officer', desc: 'First-stage review' }, { value: 'bank_supervisor', label: 'Supervisor', desc: 'Final approval + disbursement' }].map(r => (
                    <button key={r.value} type="button" onClick={() => setUserForm({...userForm, role: r.value})}
                      className={`p-3 rounded-lg border-2 text-left transition ${userForm.role === r.value ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-500' : 'border-gray-200 dark:border-gray-600 hover:border-blue-300'}`}>
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{r.label}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{r.desc}</p>
                    </button>
                  ))}
                </div>
              </div>
              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
              <button onClick={handleCreateUser} disabled={creating}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2 transition">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Create User
              </button>
              <p className="text-xs text-gray-400 dark:text-gray-500 text-center">A random password will be generated and shown once</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
