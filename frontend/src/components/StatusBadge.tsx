const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-[var(--color-sunken)] text-[var(--color-muted)]',
  submitted: 'bg-blue-500/10 text-blue-500',
  system_reviewed: 'bg-purple-500/10 text-purple-500',
  approved: 'bg-green-500/10 text-green-500',
  rejected: 'bg-red-500/10 text-red-500',
  documents_requested: 'bg-yellow-500/10 text-yellow-600',
  documents_submitted: 'bg-indigo-500/10 text-indigo-500',
  disbursed: 'bg-emerald-500/10 text-emerald-500',
  active: 'bg-green-500/10 text-green-500',
  inactive: 'bg-red-500/10 text-red-500',
  // call statuses
  queued: 'bg-[var(--color-sunken)] text-[var(--color-muted)]',
  dialing: 'bg-blue-500/10 text-blue-500',
  in_progress: 'bg-blue-500/10 text-blue-500',
  'In Progress': 'bg-blue-500/10 text-blue-500',
  Pending: 'bg-[var(--color-sunken)] text-[var(--color-muted)]',
  Dialing: 'bg-blue-500/10 text-blue-500',
  completed: 'bg-green-500/10 text-green-500',
  failed: 'bg-red-500/10 text-red-500',
  not_answered: 'bg-yellow-500/10 text-yellow-600',
}

export function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLOR[status] || 'bg-[var(--color-sunken)] text-[var(--color-muted)]'
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {String(status).replace(/_/g, ' ')}
    </span>
  )
}

const SUGGESTION_COLOR: Record<string, string> = {
  approve: 'bg-green-500/10 text-green-500',
  deny: 'bg-red-500/10 text-red-500',
  review: 'bg-yellow-500/10 text-yellow-600',
}

export function SuggestionBadge({ suggestion, score }: { suggestion?: string | null; score?: number | null }) {
  if (!suggestion) return <span className="text-[var(--color-muted)]">—</span>
  const cls = SUGGESTION_COLOR[suggestion] || 'bg-[var(--color-sunken)] text-[var(--color-muted)]'
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span className={`rounded-full px-2 py-0.5 font-medium ${cls}`}>{suggestion}</span>
      {score != null && <span className="text-[var(--color-muted)]">{score}</span>}
    </span>
  )
}
