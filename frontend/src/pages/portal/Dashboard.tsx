import { useEffect, useState } from 'react'
import { portalApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'

export default function PortalDashboard() {
  const { user } = useAuth()
  const [apps, setApps] = useState<any[]>([])
  const [vendorInfo, setVendorInfo] = useState<{ vendor_count: number; vendor_limit: number } | null>(null)

  useEffect(() => {
    portalApi.applications().then((d) => setApps(d.applications)).catch(() => {})
    if (user?.role === 'bank_user') {
      portalApi.vendors().then((d) => setVendorInfo({ vendor_count: d.vendor_count, vendor_limit: d.vendor_limit })).catch(() => {})
    }
  }, [user?.role])

  const byStatus: Record<string, number> = {}
  for (const a of apps) byStatus[a.status] = (byStatus[a.status] || 0) + 1

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {user?.role === 'bank_user' ? user.bank_name : user?.vendor_name}
        </h1>
        <p className="text-sm text-[var(--color-muted)]">
          Welcome back, {user?.name}. You have {apps.length} application{apps.length === 1 ? '' : 's'} in view.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card label="Applications" value={apps.length} />
        <Card label="Approved" value={byStatus.approved || 0} />
        <Card label="Pending review" value={(byStatus.submitted || 0) + (byStatus.system_reviewed || 0)} />
        <Card label="Disbursed" value={byStatus.disbursed || 0} />
        {vendorInfo && (
          <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-4 md:col-span-2">
            <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Vendor usage</div>
            <div className="mt-2 text-2xl font-semibold">{vendorInfo.vendor_count} / {vendorInfo.vendor_limit}</div>
            <div className="mt-2 h-2 rounded-full bg-[var(--color-sunken)]">
              <div className="h-2 rounded-full bg-[var(--color-brand)]" style={{ width: `${(vendorInfo.vendor_count / Math.max(vendorInfo.vendor_limit, 1)) * 100}%` }} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  )
}
