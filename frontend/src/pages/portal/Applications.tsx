import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { portalApi } from '../../services/api'
import { Placeholder } from '../../components/Placeholder'
import { StatusBadge, SuggestionBadge } from '../../components/StatusBadge'

export default function PortalApplications() {
  const [apps, setApps] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string | undefined>(undefined)

  useEffect(() => {
    setLoading(true)
    portalApi.applications(filter).then((d) => setApps(d.applications)).finally(() => setLoading(false))
  }, [filter])

  const statuses = ['submitted', 'system_reviewed', 'approved', 'documents_requested', 'documents_submitted', 'disbursed', 'rejected']

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Applications</h1>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilter(undefined)}
          className={`rounded-full px-3 py-1 text-xs capitalize transition-colors ${filter === undefined ? 'bg-[var(--color-brand)] text-white' : 'border border-[var(--color-line)] text-[var(--color-muted)] hover:text-[var(--color-heading)]'}`}
        >All</button>
        {statuses.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-full px-3 py-1 text-xs capitalize transition-colors ${filter === s ? 'bg-[var(--color-brand)] text-white' : 'border border-[var(--color-line)] text-[var(--color-muted)] hover:text-[var(--color-heading)]'}`}
          >{s.replace(/_/g, ' ')}</button>
        ))}
      </div>
      {loading ? (
        <div className="text-sm text-[var(--color-muted)]">Loading…</div>
      ) : apps.length === 0 ? (
        <Placeholder title="No applications in this view" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-sunken)] text-xs uppercase text-[var(--color-muted)]">
              <tr>
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-left">Loan ID</th>
                <th className="px-4 py-3 text-left">Vendor</th>
                <th className="px-4 py-3 text-left">Amount</th>
                <th className="px-4 py-3 text-left">AI</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {apps.map((a) => (
                <tr key={a.id} className="hover:bg-[var(--color-faint)]">
                  <td className="px-4 py-3 font-medium">
                    <Link to={`/portal/applications/${a.id}`} className="hover:text-[var(--color-brand)]">{a.customer_name}</Link>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-muted)]">{a.loan_id}</td>
                  <td className="px-4 py-3">{a.vendor_code || <span className="text-[var(--color-muted)]">Direct</span>}</td>
                  <td className="px-4 py-3">₹{Number(a.loan_amount_requested || 0).toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3"><SuggestionBadge suggestion={a.system_suggestion} score={a.system_score} /></td>
                  <td className="px-4 py-3"><StatusBadge status={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
