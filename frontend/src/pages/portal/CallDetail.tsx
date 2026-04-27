import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { portalApi } from '../../services/api'
import { StatusBadge } from '../../components/StatusBadge'
import { LiveTranscriptPanel } from '../../components/LiveTranscriptPanel'

export default function PortalCallDetail() {
  const { id } = useParams<{ id: string }>()
  const [call, setCall] = useState<any | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    portalApi.call(id).then((d) => setCall(d.call)).catch((e) => setErr(String(e)))
    const timer = window.setInterval(() => {
      portalApi.call(id).then((d) => setCall(d.call)).catch(() => {})
    }, 5000)
    return () => window.clearInterval(timer)
  }, [id])

  if (err) return <div className="rounded-lg border border-red-400/40 bg-red-500/10 p-4 text-sm text-red-500">{err}</div>
  if (!call) return <div className="text-sm text-[var(--color-muted)]">Loading…</div>

  const duration = call.call_duration ? `${Math.floor(call.call_duration / 60)}m ${call.call_duration % 60}s` : '—'

  return (
    <div className="space-y-6">
      <div>
        <Link to="/portal/calls" className="text-xs text-[var(--color-muted)] hover:text-[var(--color-heading)]">← All calls</Link>
        <div className="mt-2 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{call.customer_name || 'Unknown'}</h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {call.phone} · {call.vendor_code ? `vendor ${call.vendor_code}` : 'direct'} · {call.language || 'hindi'}
            </p>
          </div>
          <StatusBadge status={call.status} />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Duration" value={duration} />
        <Stat label="Interested" value={call.interested ? 'Yes' : 'No'} />
        <Stat label="Form sent" value={call.form_sent ? 'Yes' : 'No'} />
        <Stat label="Started" value={call.started_at ? new Date(call.started_at).toLocaleString() : '—'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <LiveTranscriptPanel callId={call.id} callStatus={call.status} startedAt={call.started_at} />
        </div>
        <aside className="space-y-4">
          <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-4">
            <h3 className="text-sm font-semibold mb-2">Collected data</h3>
            {call.collected_data && Object.keys(call.collected_data).length > 0 ? (
              <dl className="grid grid-cols-1 gap-2 text-sm">
                {Object.entries(call.collected_data).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-xs text-[var(--color-muted)]">{k.replace(/_/g, ' ')}</dt>
                    <dd className="text-[var(--color-heading)]">{String(v ?? '—')}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-xs text-[var(--color-muted)]">No data collected yet.</p>
            )}
          </div>
          {call.recording_url && (
            <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-4">
              <h3 className="text-sm font-semibold mb-2">Recording</h3>
              <audio controls src={call.recording_url} className="w-full" />
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-3">
      <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className="mt-1 text-sm font-semibold text-[var(--color-heading)]">{value}</div>
    </div>
  )
}
