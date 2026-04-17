import { useEffect, useState } from 'react'
import { portalApi } from '../../services/api'
import { Placeholder } from '../../components/Placeholder'
import { useAuth } from '../../contexts/AuthContext'

export default function PortalVendors() {
  const { user } = useAuth()
  const [data, setData] = useState<{ vendors: any[]; vendor_limit: number; vendor_count: number } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (user?.role !== 'bank_user') {
      setLoading(false)
      return
    }
    portalApi.vendors().then(setData).finally(() => setLoading(false))
  }, [user?.role])

  if (user?.role !== 'bank_user') {
    return <Placeholder title="Vendors" hint="Only bank users can manage vendors." />
  }
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
        <button
          disabled={atLimit}
          className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm text-white hover:bg-[var(--color-brand-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          + Create vendor
        </button>
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
                <th className="px-4 py-3 text-left">Applications</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {data.vendors.map((v) => (
                <tr key={v.id} className="hover:bg-[var(--color-faint)]">
                  <td className="px-4 py-3 font-medium">{v.name}</td>
                  <td className="px-4 py-3 text-[var(--color-muted)]">{v.code}</td>
                  <td className="px-4 py-3">{v.category || '—'}</td>
                  <td className="px-4 py-3">{v.application_count}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-1 text-xs ${
                      v.status === 'active' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'
                    }`}>{v.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
