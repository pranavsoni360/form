import { useEffect, useRef } from 'react'
import { useLiveTranscript, type TranscriptEntry } from '../hooks/useLiveTranscript'

export function LiveTranscriptPanel({
  callId,
  callStatus,
  startedAt,
}: {
  callId: string
  callStatus?: string
  startedAt?: string | null
}) {
  const isActive = !!callId && !(callStatus && /completed|failed|not_answered|Called/i.test(callStatus))
  const { entries, connected, done, error } = useLiveTranscript(callId, true)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [entries.length])

  const baseTs = startedAt ? new Date(startedAt).getTime() : null

  return (
    <div className="flex flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] h-full min-h-[400px]">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${done ? 'bg-[var(--color-muted)]' : connected ? 'bg-green-500 animate-pulse' : isActive ? 'bg-yellow-500' : 'bg-[var(--color-muted)]'}`} />
          <span className="text-sm font-medium text-[var(--color-heading)]">
            {done ? 'Call ended' : connected ? 'Live' : isActive ? 'Connecting…' : 'Idle'}
          </span>
        </div>
        <span className="text-xs text-[var(--color-muted)]">{entries.length} turn{entries.length === 1 ? '' : 's'}</span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto p-4 scrollbar-thin">
        {error && <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500 mb-3">{error}</div>}
        {entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">
            {done ? 'No transcript recorded.' : 'Waiting for conversation…'}
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((e, i) => <Turn key={i} entry={e} baseTs={baseTs} />)}
          </div>
        )}
      </div>
    </div>
  )
}

function Turn({ entry, baseTs }: { entry: TranscriptEntry; baseTs: number | null }) {
  const isAgent = entry.role === 'agent'
  const ts = entry.timestamp ? toElapsed(entry.timestamp, baseTs) : ''
  return (
    <div className={`flex gap-3 ${isAgent ? '' : 'flex-row-reverse'}`}>
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
        isAgent ? 'bg-[var(--color-brand-dim)] text-[var(--color-brand)]' : 'bg-[var(--color-sunken)] text-[var(--color-heading)]'
      }`}>
        {isAgent ? 'A' : 'U'}
      </div>
      <div className={`flex min-w-0 flex-col ${isAgent ? '' : 'items-end'}`}>
        <div className="text-xs text-[var(--color-muted)]">
          {isAgent ? 'Agent' : 'Customer'} {ts && <span className="ml-1 font-mono">{ts}</span>}
        </div>
        <div className={`mt-1 max-w-[48ch] rounded-xl px-3 py-2 text-sm ${
          isAgent ? 'bg-[var(--color-brand-dim)] text-[var(--color-heading)]' : 'bg-[var(--color-sunken)] text-[var(--color-heading)]'
        } ${entry.final === false ? 'italic opacity-70' : ''}`}>
          {entry.text}
        </div>
      </div>
    </div>
  )
}

function toElapsed(ts: string, base: number | null): string {
  try {
    const t = new Date(ts).getTime()
    if (!base || !Number.isFinite(t)) return ''
    const secs = Math.max(0, Math.round((t - base) / 1000))
    const mm = String(Math.floor(secs / 60)).padStart(2, '0')
    const ss = String(secs % 60).padStart(2, '0')
    return `${mm}:${ss}`
  } catch { return '' }
}
