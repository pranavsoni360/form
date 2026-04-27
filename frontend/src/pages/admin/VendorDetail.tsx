import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { adminApi } from '../../services/api'
import { Button } from '../../components/Field'
import { StatusBadge } from '../../components/StatusBadge'
import { VendorFormModal } from '../../components/modals/VendorFormModal'
import { UserCreateModal } from '../../components/modals/UserCreateModal'
import { ResetPasswordModal } from '../../components/modals/ResetPasswordModal'

export default function VendorDetail() {
  const { id } = useParams<{ id: string }>()
  const [vendor, setVendor] = useState<any | null>(null)
  const [editing, setEditing] = useState(false)
  const [creatingUser, setCreatingUser] = useState(false)
  const [resetUser, setResetUser] = useState<{ id: string; username: string; full_name?: string } | null>(null)

  const load = () => {
    if (!id) return
    adminApi.vendor(id).then((d) => setVendor(d.vendor))
  }
  useEffect(load, [id])

  if (!vendor) return <div className="text-sm text-[var(--color-muted)]">Loading…</div>

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin/vendors" className="text-xs text-[var(--color-muted)] hover:text-[var(--color-heading)]">← All vendors</Link>
        <div className="mt-2 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{vendor.name}</h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {vendor.code} · {vendor.category || 'uncategorized'} · under{' '}
              <Link to={`/admin/banks/${vendor.bank_id}`} className="text-[var(--color-brand)] hover:underline">{vendor.bank_name}</Link>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={vendor.status} />
            <Button variant="secondary" onClick={() => setEditing(true)}>Edit vendor</Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Bank" value={vendor.bank_code} />
        <Stat label="Active users" value={vendor.users.filter((u: any) => u.is_active).length} />
        <Stat label="Applications" value={vendor.application_count} />
        <Stat label="Created" value={new Date(vendor.created_at).toLocaleDateString()} />
      </div>

      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)]">
        <div className="flex items-center justify-between border-b border-[var(--color-line)] p-4">
          <h2 className="text-sm font-semibold">Vendor users ({vendor.users.length})</h2>
          <Button size="sm" onClick={() => setCreatingUser(true)}>+ Create user</Button>
        </div>
        {vendor.users.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--color-muted)]">No users yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-sunken)] text-xs uppercase text-[var(--color-muted)]">
              <tr>
                <th className="px-4 py-3 text-left">Username</th>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Last login</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {vendor.users.map((u: any) => (
                <tr key={u.id}>
                  <td className="px-4 py-3 font-mono">{u.username}</td>
                  <td className="px-4 py-3">{u.full_name}</td>
                  <td className="px-4 py-3 text-[var(--color-muted)]">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'never'}</td>
                  <td className="px-4 py-3"><StatusBadge status={u.is_active ? 'active' : 'inactive'} /></td>
                  <td className="px-4 py-3">
                    {u.is_active && (
                      <div className="flex items-center gap-3">
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
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <VendorFormModal
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={load}
        existing={vendor}
        createFn={(v) => adminApi.createVendor(v)}
        updateFn={(vid, v) => adminApi.updateVendor(vid, v)}
      />
      <UserCreateModal
        open={creatingUser}
        onClose={() => setCreatingUser(false)}
        onCreated={load}
        title="Create vendor user"
        description={`One user account shared by ${vendor.name} staff.`}
        createFn={(u) => adminApi.createVendorUser(vendor.id, u)}
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
