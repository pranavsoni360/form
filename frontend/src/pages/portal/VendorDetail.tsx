import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { portalApi } from '../../services/api'
import { Button } from '../../components/Field'
import { StatusBadge } from '../../components/StatusBadge'
import { VendorFormModal } from '../../components/modals/VendorFormModal'
import { UserCreateModal } from '../../components/modals/UserCreateModal'
import { ResetPasswordModal } from '../../components/modals/ResetPasswordModal'

export default function PortalVendorDetail() {
  const { id } = useParams<{ id: string }>()
  const [vendor, setVendor] = useState<any | null>(null)
  const [editing, setEditing] = useState(false)
  const [creatingUser, setCreatingUser] = useState(false)
  const [resetUser, setResetUser] = useState<{ id: string; username: string; full_name?: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = () => {
    if (!id) return
    portalApi.vendor(id).then((d) => setVendor(d.vendor)).catch((e) => setErr(String(e)))
  }
  useEffect(load, [id])

  if (err) return <div className="rounded-lg border border-red-400/40 bg-red-500/10 p-4 text-sm text-red-500">{err}</div>
  if (!vendor) return <div className="text-sm text-[var(--color-muted)]">Loading…</div>

  return (
    <div className="space-y-6">
      <div>
        <Link to="/portal/vendors" className="text-xs text-[var(--color-muted)] hover:text-[var(--color-heading)]">← All vendors</Link>
        <div className="mt-2 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{vendor.name}</h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {vendor.code} · {vendor.category || 'uncategorized'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={vendor.status} />
            <Button variant="secondary" onClick={() => setEditing(true)}>Edit vendor</Button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)]">
        <div className="flex items-center justify-between border-b border-[var(--color-line)] p-4">
          <h2 className="text-sm font-semibold">Vendor users ({vendor.users?.length ?? 0})</h2>
          <Button size="sm" onClick={() => setCreatingUser(true)}>+ Create user</Button>
        </div>
        {!vendor.users || vendor.users.length === 0 ? (
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
                      <button
                        onClick={() => setResetUser({ id: u.id, username: u.username, full_name: u.full_name })}
                        className="text-xs text-[var(--color-brand)] hover:underline"
                      >
                        Reset password
                      </button>
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
        createFn={(v) => portalApi.createVendor(v)}
        updateFn={(vid, v) => portalApi.updateVendor(vid, v)}
      />
      <UserCreateModal
        open={creatingUser}
        onClose={() => setCreatingUser(false)}
        onCreated={load}
        title="Create vendor user"
        description={`One shared account for ${vendor.name} staff.`}
        createFn={(u) => portalApi.createVendorUser(vendor.id, u)}
      />
      {resetUser && (
        <ResetPasswordModal
          open={!!resetUser}
          onClose={() => setResetUser(null)}
          username={resetUser.username}
          displayName={resetUser.full_name}
          resetFn={(pw) => portalApi.resetUserPassword(resetUser.id, pw)}
          onDone={load}
        />
      )}
    </div>
  )
}
