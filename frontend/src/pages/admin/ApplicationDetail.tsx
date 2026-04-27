import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { adminApi } from '../../services/api'
import { StatusBadge, SuggestionBadge } from '../../components/StatusBadge'
import { ApplicationBody } from '../../components/ApplicationBody'

export default function AdminApplicationDetail() {
  const { id } = useParams<{ id: string }>()
  const [app, setApp] = useState<any | null>(null)
  const [timeline, setTimeline] = useState<any[]>([])

  useEffect(() => {
    if (!id) return
    adminApi.application(id).then((d) => { setApp(d.application); setTimeline(d.timeline) })
  }, [id])

  if (!app) return <div className="text-sm text-[var(--color-muted)]">Loading…</div>

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin/applications" className="text-xs text-[var(--color-muted)] hover:text-[var(--color-heading)]">← All applications</Link>
        <div className="mt-2 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{app.customer_name}</h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {app.loan_id} · {app.bank_code || 'unassigned'}{app.vendor_code && ` · vendor ${app.vendor_code}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SuggestionBadge suggestion={app.system_suggestion} score={app.system_score} />
            <StatusBadge status={app.status} />
          </div>
        </div>
      </div>
      <ApplicationBody app={app} timeline={timeline} readOnly />
    </div>
  )
}
