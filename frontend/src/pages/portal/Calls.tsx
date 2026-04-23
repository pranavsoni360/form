import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { portalApi } from '../../services/api'
import { Placeholder } from '../../components/Placeholder'
import { Button } from '../../components/Field'
import { StatusBadge } from '../../components/StatusBadge'

export default function PortalCalls() {
  const [calls, setCalls] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    portalApi.calls().then((d) => setCalls(d.calls)).finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Calls</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate('/portal/calls/bulk')}>+ Bulk upload</Button>
          <Button onClick={() => navigate('/portal/calls/new')}>+ New call</Button>
        </div>
      </div>
      {loading ? (
        <div className="text-sm text-[var(--color-muted)]">Loading…</div>
      ) : calls.length === 0 ? (
        <Placeholder title="No calls yet" hint="Start a new call to the customer from here." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-sunken)] text-xs uppercase text-[var(--color-muted)]">
              <tr>
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-left">Phone</th>
                <th className="px-4 py-3 text-left">Vendor</th>
                <th className="px-4 py-3 text-left">Language</th>
                <th className="px-4 py-3 text-left">Duration</th>
                <th className="px-4 py-3 text-left">Started</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {calls.map((c) => (
                <tr key={c.id} className="hover:bg-[var(--color-faint)]">
                  <td className="px-4 py-3 font-medium">
                    <Link to={`/portal/calls/${c.id}`} className="hover:text-[var(--color-brand)]">{c.customer_name || '—'}</Link>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-muted)]">{c.phone}</td>
                  <td className="px-4 py-3">{c.vendor_code || <span className="text-[var(--color-muted)]">Direct</span>}</td>
                  <td className="px-4 py-3 capitalize">{c.language || '—'}</td>
                  <td className="px-4 py-3">{c.call_duration ? `${Math.floor(c.call_duration / 60)}m ${c.call_duration % 60}s` : '—'}</td>
                  <td className="px-4 py-3 text-[var(--color-muted)]">{c.started_at ? new Date(c.started_at).toLocaleString() : '—'}</td>
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
