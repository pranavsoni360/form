import { useEffect, useState } from 'react'
import { adminApi } from '../../services/api'
import { Button } from '../../components/Field'

type Stats = {
  total_applications: number
  total_banks: number
  total_vendors: number
  total_bank_users: number
  total_vendor_users: number
  active_calls: number
  approval_rate: number
  status_counts: Record<string, number>
  bank_counts: { bank_id: string; bank_name: string; bank_code: string; vendor_limit: number; vendor_count: number; count: number }[]
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)

  const load = () => adminApi.stats().then(setStats).catch((e) => setError(String(e)))
  useEffect(() => { void load() }, [])

  const seed = async () => {
    setSeeding(true)
    try {
      await adminApi.seedMockData()
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setSeeding(false)
    }
  }

  if (error) return <div className="rounded-lg border border-red-400/40 bg-red-500/10 p-4 text-sm text-red-500">{error}</div>
  if (!stats) return <div className="text-sm text-[var(--color-muted)]">Loading stats…</div>

  const cards = [
    { label: 'Banks',        value: stats.total_banks,         hint: 'Active tenants' },
    { label: 'Vendors',      value: stats.total_vendors,       hint: 'Partner shops' },
    { label: 'Applications', value: stats.total_applications,  hint: 'Total submitted' },
    { label: 'Approval rate',value: `${stats.approval_rate}%`, hint: 'approved / reviewed' },
    { label: 'Active calls', value: stats.active_calls,        hint: 'In-progress' },
    { label: 'Bank users',   value: stats.total_bank_users,    hint: 'Active accounts' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-heading)]">Overview</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">System-wide metrics across every tenant.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={seed} disabled={seeding}>
          {seeding ? 'Seeding…' : 'Seed mock data'}
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-4">
            <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{c.label}</div>
            <div className="mt-2 text-2xl font-semibold text-[var(--color-heading)]">{c.value}</div>
            <div className="mt-1 text-xs text-[var(--color-muted)]">{c.hint}</div>
          </div>
        ))}
      </div>

      <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)]">
        <div className="flex items-center justify-between border-b border-[var(--color-line)] p-4">
          <h2 className="text-sm font-semibold text-[var(--color-heading)]">Per-bank usage</h2>
          <span className="text-xs text-[var(--color-muted)]">{stats.bank_counts.length} banks</span>
        </div>
        <div className="divide-y divide-[var(--color-line)]">
          {stats.bank_counts.map((b) => (
            <div key={b.bank_id} className="flex items-center justify-between p-4">
              <div>
                <div className="font-medium text-[var(--color-heading)]">{b.bank_name}</div>
                <div className="text-xs text-[var(--color-muted)]">{b.bank_code}</div>
              </div>
              <div className="flex items-center gap-6 text-sm">
                <div className="text-right">
                  <div className="text-xs uppercase text-[var(--color-muted)]">Vendors</div>
                  <div className="font-medium text-[var(--color-heading)]">{b.vendor_count} / {b.vendor_limit}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase text-[var(--color-muted)]">Applications</div>
                  <div className="font-medium text-[var(--color-heading)]">{b.count}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-4">
        <h2 className="text-sm font-semibold text-[var(--color-heading)] mb-3">Applications by status</h2>
        <div className="flex flex-wrap gap-2">
          {Object.entries(stats.status_counts).map(([status, count]) => (
            <span key={status} className="inline-flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-[var(--color-faint)] px-3 py-1 text-xs">
              <span className="text-[var(--color-muted)]">{status.replace(/_/g, ' ')}</span>
              <span className="font-semibold text-[var(--color-heading)]">{count}</span>
            </span>
          ))}
        </div>
      </section>
    </div>
  )
}
