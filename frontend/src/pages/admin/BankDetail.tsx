import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { adminApi } from '../../services/api'
import { Button } from '../../components/Field'
import { StatusBadge } from '../../components/StatusBadge'
import { BankFormModal } from '../../components/modals/BankFormModal'
import { UserCreateModal } from '../../components/modals/UserCreateModal'
import { VendorFormModal } from '../../components/modals/VendorFormModal'
import { ResetPasswordModal } from '../../components/modals/ResetPasswordModal'

export default function BankDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [bank, setBank] = useState<any | null>(null)
  const [tab, setTab] = useState<'users' | 'vendors'>('users')
  const [editing, setEditing] = useState(false)
  const [creatingUser, setCreatingUser] = useState(false)
  const [creatingVendor, setCreatingVendor] = useState(false)
  const [resetUser, setResetUser] = useState<{ id: string; username: string; full_name?: string } | null>(null)

  const load = () => {
    if (!id) return
    adminApi.bank(id).then((d) => setBank(d.bank))
  }
  useEffect(load, [id])

  if (!bank) return <div className="text-sm text-[var(--color-muted)]">Loading…</div>

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin/banks" className="text-xs text-[var(--color-muted)] hover:text-[var(--color-heading)]">← All banks</Link>
        <div className="mt-2 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{bank.name}</h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {bank.code} · {bank.contact_email || 'no email'} · {bank.contact_phone || 'no phone'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={bank.status} />
            <Button variant="secondary" onClick={() => setEditing(true)}>Edit bank</Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Vendor limit" value={`${bank.vendors.length} / ${bank.vendor_limit}`} />
        <Stat label="Active users" value={bank.users.filter((u: any) => u.is_active).length} />
        <Stat label="Applications" value={bank.application_count} />
        <Stat label="Created" value={new Date(bank.created_at).toLocaleDateString()} />
      </div>

      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)]">
        <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4">
          <div className="flex">
            {(['users', 'vendors'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-3 text-sm font-medium transition-colors ${
                  tab === t ? 'border-b-2 border-[var(--color-brand)] text-[var(--color-brand)]' : 'text-[var(--color-muted)] hover:text-[var(--color-heading)]'
                }`}
              >
                {t === 'users' ? `Bank users (${bank.users.length})` : `Vendors (${bank.vendors.length} / ${bank.vendor_limit})`}
              </button>
            ))}
          </div>
          <div className="py-2">
            {tab === 'users' ? (
              <Button
                size="sm"
                onClick={() => setCreatingUser(true)}
                disabled={bank.users.some((u: any) => u.is_active)}
                title={bank.users.some((u: any) => u.is_active) ? 'One user per bank. Deactivate the existing user first.' : undefined}
              >
                + Create user
              </Button>
            ) : (
              <Button size="sm" onClick={() => setCreatingVendor(true)} disabled={bank.vendors.length >= bank.vendor_limit}>
                + Create vendor
              </Button>
            )}
          </div>
        </div>

        {tab === 'users' ? (
          bank.users.length === 0 ? (
            <div className="p-8 text-center text-sm text-[var(--color-muted)]">No bank users yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-sunken)] text-xs uppercase text-[var(--color-muted)]">
                <tr>
                  <th className="px-4 py-3 text-left">Username</th>
                  <th className="px-4 py-3 text-left">Full name</th>
                  <th className="px-4 py-3 text-left">Email</th>
                  <th className="px-4 py-3 text-left">Last login</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {bank.users.map((u: any) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3 font-mono">{u.username}</td>
                    <td className="px-4 py-3">{u.full_name}</td>
                    <td className="px-4 py-3 text-[var(--color-muted)]">{u.email || '—'}</td>
                    <td className="px-4 py-3 text-[var(--color-muted)]">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'never'}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={u.is_active ? 'active' : 'inactive'} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {u.is_active && (
                          <>
                            <button
                              onClick={() => setResetUser({ id: u.id, username: u.username, full_name: u.full_name })}
                              className="text-xs text-[var(--color-brand)] hover:underline"
                            >
                              Reset password
                            </button>
                            <button
                              onClick={async () => {
                                if (!confirm(`Deactivate ${u.username}?`)) return
                                await adminApi.deactivateUser(u.id); load()
                              }}
                              className="text-xs text-red-500 hover:underline"
                            >
                              Deactivate
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          bank.vendors.length === 0 ? (
            <div className="p-8 text-center text-sm text-[var(--color-muted)]">No vendors yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-sunken)] text-xs uppercase text-[var(--color-muted)]">
                <tr>
                  <th className="px-4 py-3 text-left">Vendor</th>
                  <th className="px-4 py-3 text-left">Code</th>
                  <th className="px-4 py-3 text-left">Category</th>
                  <th className="px-4 py-3 text-left">Users</th>
                  <th className="px-4 py-3 text-left">Applications</th>
                  <th className="px-4 py-3 text-left">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {bank.vendors.map((v: any) => (
                  <tr
                    key={v.id}
                    onClick={() => navigate(`/admin/vendors/${v.id}`)}
                    className="cursor-pointer hover:bg-[var(--color-faint)] transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-[var(--color-heading)]">{v.name}</td>
                    <td className="px-4 py-3 text-[var(--color-muted)]">{v.code}</td>
                    <td className="px-4 py-3">{v.category || '—'}</td>
                    <td className="px-4 py-3">{v.active_user_count}</td>
                    <td className="px-4 py-3">{v.application_count}</td>
                    <td className="px-4 py-3"><StatusBadge status={v.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>

      <BankFormModal open={editing} onClose={() => setEditing(false)} onCreated={load} existing={bank} />
      <UserCreateModal
        open={creatingUser}
        onClose={() => setCreatingUser(false)}
        onCreated={load}
        title="Create bank user"
        description={`A new user for ${bank.name}. A password will be auto-generated.`}
        createFn={(u) => adminApi.createBankUser(bank.id, u)}
      />
      <VendorFormModal
        open={creatingVendor}
        onClose={() => setCreatingVendor(false)}
        onSaved={load}
        bankId={bank.id}
        createFn={(v) => adminApi.createVendor(v)}
      />
      {resetUser && (
        <ResetPasswordModal
          open={!!resetUser}
          onClose={() => setResetUser(null)}
          username={resetUser.username}
          displayName={resetUser.full_name}
          resetFn={(pw) => adminApi.resetUserPassword(resetUser.id, pw)}
          onDone={load}
        />
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-3">
      <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className="mt-1 text-lg font-semibold text-[var(--color-heading)]">{value}</div>
    </div>
  )
}
