import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminApi } from '../../services/api'
import { Placeholder } from '../../components/Placeholder'
import { Button } from '../../components/Field'
import { StatusBadge } from '../../components/StatusBadge'
import { BankFormModal } from '../../components/modals/BankFormModal'

export default function BanksList() {
  const [banks, setBanks] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()

  const load = () => {
    setLoading(true)
    adminApi.banks().then((d) => setBanks(d.banks)).finally(() => setLoading(false))
  }
  useEffect(load, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Banks</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">Tenant banks. Each has its own users, vendors, and applications.</p>
        </div>
        <Button onClick={() => setCreating(true)}>+ Create bank</Button>
      </div>

      {loading ? (
        <div className="text-sm text-[var(--color-muted)]">Loading…</div>
      ) : banks.length === 0 ? (
        <Placeholder title="No banks yet" hint="Create a bank or seed mock data to get started." />
      ) : (
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
                <tr
                  key={b.id}
                  onClick={() => navigate(`/admin/banks/${b.id}`)}
                  className="cursor-pointer hover:bg-[var(--color-faint)] transition-colors"
                >
                  <td className="px-4 py-3 font-medium text-[var(--color-heading)]">{b.name}</td>
                  <td className="px-4 py-3 text-[var(--color-muted)]">{b.code}</td>
                  <td className="px-4 py-3">
                    <span className="font-medium">{b.vendor_count}</span> <span className="text-[var(--color-muted)]">/ {b.vendor_limit}</span>
                  </td>
                  <td className="px-4 py-3">{b.application_count}</td>
                  <td className="px-4 py-3">{b.active_user_count}</td>
                  <td className="px-4 py-3"><StatusBadge status={b.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <BankFormModal open={creating} onClose={() => setCreating(false)} onCreated={load} />
    </div>
  )
}
