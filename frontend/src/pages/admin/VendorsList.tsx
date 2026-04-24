import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { adminApi } from '../../services/api'
import { Placeholder } from '../../components/Placeholder'
import { StatusBadge } from '../../components/StatusBadge'

export default function VendorsList() {
  const [vendors, setVendors] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    adminApi.vendors().then((d) => setVendors(d.vendors)).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-sm text-[var(--color-muted)]">Loading…</div>
  if (!vendors.length) return <Placeholder title="No vendors yet" hint="Banks create vendors from their portal, or admins from bank detail." />

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Vendors</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">All vendors across every bank.</p>
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-sunken)] text-xs uppercase text-[var(--color-muted)]">
            <tr>
              <th className="px-4 py-3 text-left">Vendor</th>
              <th className="px-4 py-3 text-left">Code</th>
              <th className="px-4 py-3 text-left">Bank</th>
              <th className="px-4 py-3 text-left">Category</th>
              <th className="px-4 py-3 text-left">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {vendors.map((v) => (
              <tr
                key={v.id}
                onClick={() => navigate(`/admin/vendors/${v.id}`)}
                className="cursor-pointer hover:bg-[var(--color-faint)] transition-colors"
              >
                <td className="px-4 py-3 font-medium text-[var(--color-heading)]">{v.name}</td>
                <td className="px-4 py-3 text-[var(--color-muted)]">{v.code}</td>
                <td className="px-4 py-3">
                  <Link
                    to={`/admin/banks/${v.bank_id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="hover:text-[var(--color-brand)]"
                  >
                    {v.bank_name}
                  </Link>
                  <span className="ml-1 text-[var(--color-muted)]">({v.bank_code})</span>
                </td>
                <td className="px-4 py-3">{v.category || '—'}</td>
                <td className="px-4 py-3"><StatusBadge status={v.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
