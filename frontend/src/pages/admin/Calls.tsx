import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminCallsApi } from '../../services/api'
import { Placeholder } from '../../components/Placeholder'
import { StatusBadge } from '../../components/StatusBadge'

export default function AdminCalls() {
  const [calls, setCalls] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string | undefined>()

  useEffect(() => {
    setLoading(true)
    adminCallsApi.list(filter ? { status: filter } : {}).then((d) => setCalls(d.calls)).finally(() => setLoading(false))
  }, [filter])

  const statuses = ['queued', 'dialing', 'in_progress', 'completed', 'failed', 'not_answered']

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Calls</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">All call logs across banks and vendors.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Pill active={filter === undefined} onClick={() => setFilter(undefined)}>All</Pill>
        {statuses.map((s) => <Pill key={s} active={filter === s} onClick={() => setFilter(s)}>{s.replace(/_/g, ' ')}</Pill>)}
      </div>
      {loading ? (
        <div className="text-sm text-[var(--color-muted)]">Loading…</div>
      ) : calls.length === 0 ? (
        <Placeholder title="No calls in this view" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-sunken)] text-xs uppercase text-[var(--color-muted)]">
              <tr>
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-left">Phone</th>
                <th className="px-4 py-3 text-left">Bank</th>
                <th className="px-4 py-3 text-left">Vendor</th>
                <th className="px-4 py-3 text-left">Duration</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {calls.map((c) => (
                <tr key={c.id} className="hover:bg-[var(--color-faint)]">
                  <td className="px-4 py-3 font-medium">
                    <Link to={`/admin/calls/${c.id}`} className="hover:text-[var(--color-brand)]">{c.customer_name || '—'}</Link>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-muted)]">{c.phone}</td>
                  <td className="px-4 py-3">{c.bank_code || '—'}</td>
                  <td className="px-4 py-3">{c.vendor_code || <span className="text-[var(--color-muted)]">Direct</span>}</td>
                  <td className="px-4 py-3">{c.call_duration ? `${Math.floor(c.call_duration / 60)}m ${c.call_duration % 60}s` : '—'}</td>
                  <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`rounded-full px-3 py-1 text-xs capitalize transition-colors ${
      active ? 'bg-[var(--color-brand)] text-white' : 'border border-[var(--color-line)] text-[var(--color-muted)] hover:text-[var(--color-heading)]'
    }`}>{children}</button>
  )
}
