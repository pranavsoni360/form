import { useEffect, useState } from 'react'
import { adminApi } from '../../services/api'
import { Placeholder } from '../../components/Placeholder'

const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-[var(--color-sunken)] text-[var(--color-muted)]',
  submitted: 'bg-blue-500/10 text-blue-500',
  system_reviewed: 'bg-purple-500/10 text-purple-500',
  approved: 'bg-green-500/10 text-green-500',
  rejected: 'bg-red-500/10 text-red-500',
  documents_requested: 'bg-yellow-500/10 text-yellow-600',
  documents_submitted: 'bg-indigo-500/10 text-indigo-500',
  disbursed: 'bg-emerald-500/10 text-emerald-500',
}

export default function AdminApplicationsList() {
  const [apps, setApps] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    adminApi.applications().then((d) => setApps(d.applications)).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-sm text-[var(--color-muted)]">Loading…</div>
  if (!apps.length) return <Placeholder title="No applications" hint="Seed mock data or wait for customers to submit forms." />

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Applications</h1>
      <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-sunken)] text-xs uppercase text-[var(--color-muted)]">
            <tr>
              <th className="px-4 py-3 text-left">Customer</th>
              <th className="px-4 py-3 text-left">Loan ID</th>
              <th className="px-4 py-3 text-left">Bank</th>
              <th className="px-4 py-3 text-left">Vendor</th>
              <th className="px-4 py-3 text-left">Amount</th>
              <th className="px-4 py-3 text-left">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {apps.map((a) => (
              <tr key={a.id} className="hover:bg-[var(--color-faint)]">
                <td className="px-4 py-3 font-medium text-[var(--color-heading)]">{a.customer_name}</td>
                <td className="px-4 py-3 text-[var(--color-muted)]">{a.loan_id || '—'}</td>
                <td className="px-4 py-3">{a.bank_code || '—'}</td>
                <td className="px-4 py-3">{a.vendor_code || <span className="text-[var(--color-muted)]">Direct</span>}</td>
                <td className="px-4 py-3">₹{Number(a.loan_amount_requested || 0).toLocaleString('en-IN')}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-1 text-xs ${STATUS_COLOR[a.status] || 'bg-[var(--color-sunken)] text-[var(--color-muted)]'}`}>
                    {a.status.replace(/_/g, ' ')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
