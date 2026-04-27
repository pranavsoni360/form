import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { portalApi } from '../../services/api'
import { Placeholder } from '../../components/Placeholder'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../../components/Field'
import { StatusBadge } from '../../components/StatusBadge'
import { VendorFormModal } from '../../components/modals/VendorFormModal'

export default function PortalVendors() {
  const { user } = useAuth()
  const [data, setData] = useState<{ vendors: any[]; vendor_limit: number; vendor_count: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const load = () => {
    setLoading(true)
    portalApi.vendors().then(setData).finally(() => setLoading(false))
  }

  useEffect(() => {
    if (user?.role !== 'bank_user') {
      setLoading(false); return
    }
    load()
  }, [user?.role])

  if (user?.role !== 'bank_user') return <Placeholder title="Vendors" hint="Only bank users can manage vendors." />
  if (loading) return <div className="text-sm text-[var(--color-muted)]">Loading…</div>
  if (!data) return <Placeholder title="No vendor data" />

  const atLimit = data.vendor_count >= data.vendor_limit

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Vendors</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {data.vendor_count} of {data.vendor_limit} used
          </p>
        </div>
        <Button disabled={atLimit} onClick={() => setCreating(true)}>
          {atLimit ? 'Limit reached' : '+ Create vendor'}
        </Button>
      </div>
      {data.vendors.length === 0 ? (
        <Placeholder title="No vendors yet" hint="Add shops or retailers who sell on behalf of your bank." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-sunken)] text-xs uppercase text-[var(--color-muted)]">
              <tr>
                <th className="px-4 py-3 text-left">Vendor</th>
                <th className="px-4 py-3 text-left">Code</th>
                <th className="px-4 py-3 text-left">Category</th>
                <th className="px-4 py-3 text-left">Users</th>
                <th className="px-4 py-3 text-left">Applications</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {data.vendors.map((v) => (
                <tr key={v.id} className="hover:bg-[var(--color-faint)]">
                  <td className="px-4 py-3 font-medium">
                    <Link to={`/portal/vendors/${v.id}`} className="hover:text-[var(--color-brand)]">{v.name}</Link>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-muted)]">{v.code}</td>
                  <td className="px-4 py-3">{v.category || '—'}</td>
                  <td className="px-4 py-3">{v.active_user_count ?? 0}</td>
                  <td className="px-4 py-3">{v.application_count ?? 0}</td>
                  <td className="px-4 py-3"><StatusBadge status={v.status} /></td>
                  <td className="px-4 py-3 text-xs">
                    <Link to={`/portal/vendors/${v.id}`} className="text-[var(--color-brand)] hover:underline">Manage</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <VendorFormModal
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={load}
        createFn={(v) => portalApi.createVendor(v)}
      />
    </div>
  )
}
