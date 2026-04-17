import { useEffect, useState } from 'react'
import { adminApi } from '../../services/api'
import { Placeholder } from '../../components/Placeholder'

export default function BanksList() {
  const [banks, setBanks] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    adminApi.banks().then((d) => setBanks(d.banks)).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-sm text-[var(--color-muted)]">Loading…</div>
  if (!banks.length) return <Placeholder title="No banks yet" hint="Seed mock data or create a bank to get started." />

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Banks</h1>
        <button className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm text-white hover:bg-[var(--color-brand-hover)] transition-colors">
          + Create bank
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-sunken)] text-xs uppercase text-[var(--color-muted)]">
            <tr>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Code</th>
              <th className="px-4 py-3 text-left">Vendors</th>
              <th className="px-4 py-3 text-left">Applications</th>
              <th className="px-4 py-3 text-left">Users</th>
              <th className="px-4 py-3 text-left">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {banks.map((b) => (
              <tr key={b.id} className="hover:bg-[var(--color-faint)]">
                <td className="px-4 py-3 font-medium text-[var(--color-heading)]">{b.name}</td>
                <td className="px-4 py-3 text-[var(--color-muted)]">{b.code}</td>
                <td className="px-4 py-3">{b.vendor_count} / {b.vendor_limit}</td>
                <td className="px-4 py-3">{b.application_count}</td>
                <td className="px-4 py-3">{b.active_user_count}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-1 text-xs ${
                    b.status === 'active' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'
                  }`}>{b.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
