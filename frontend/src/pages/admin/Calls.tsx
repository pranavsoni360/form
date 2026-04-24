import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { adminCallsApi } from '../../services/api'
import { Placeholder } from '../../components/Placeholder'
import { StatusBadge } from '../../components/StatusBadge'
import { Button } from '../../components/Field'
import { Modal } from '../../components/Modal'

export default function AdminCalls() {
  const [calls, setCalls] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string | undefined>()
  const [deleting, setDeleting] = useState<any | null>(null)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const navigate = useNavigate()

  const load = () => {
    setLoading(true)
    adminCallsApi.list(filter ? { status: filter } : {}).then((d) => setCalls(d.calls)).finally(() => setLoading(false))
  }

  useEffect(load, [filter])

  const statuses = ['queued', 'dialing', 'in_progress', 'completed', 'failed', 'not_answered']

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Calls</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">All call logs across banks and vendors.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate('/admin/calls/bulk')}>+ Bulk upload</Button>
          <Button onClick={() => navigate('/admin/calls/new')}>+ New call</Button>
        </div>
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
                <th className="px-4 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {calls.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/admin/calls/${c.id}`)}
                  className="cursor-pointer hover:bg-[var(--color-faint)] transition-colors"
                >
                  <td className="px-4 py-3 font-medium text-[var(--color-heading)]">{c.customer_name || '—'}</td>
                  <td className="px-4 py-3 text-[var(--color-muted)]">{c.phone}</td>
                  <td className="px-4 py-3">{c.bank_code || '—'}</td>
                  <td className="px-4 py-3">{c.vendor_code || <span className="text-[var(--color-muted)]">Direct</span>}</td>
                  <td className="px-4 py-3">{c.call_duration ? `${Math.floor(c.call_duration / 60)}m ${c.call_duration % 60}s` : '—'}</td>
                  <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                  <td className="px-2 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <RowMenu
                      open={openMenu === c.id}
                      onOpenChange={(o) => setOpenMenu(o ? c.id : null)}
                      onDelete={() => {
                        setDeleting(c)
                        setOpenMenu(null)
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <DeleteCallModal
        call={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null)
          load()
        }}
      />
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

function RowMenu({
  open,
  onOpenChange,
  onDelete,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onDelete: () => void
}) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Portal-rendered dropdown positioned via fixed coords so the table's
  // overflow-hidden (needed for rounded header corners) can't clip it.
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null)

  useEffect(() => {
    if (!open) {
      setCoords(null)
      return
    }
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setCoords({ top: rect.bottom + 4, right: window.innerWidth - rect.right })

    const closeIfOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (btnRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      onOpenChange(false)
    }
    // Close on scroll/resize to avoid the menu floating detached from its row.
    const closeAll = () => onOpenChange(false)
    window.addEventListener('mousedown', closeIfOutside)
    window.addEventListener('scroll', closeAll, true)
    window.addEventListener('resize', closeAll)
    return () => {
      window.removeEventListener('mousedown', closeIfOutside)
      window.removeEventListener('scroll', closeAll, true)
      window.removeEventListener('resize', closeAll)
    }
  }, [open, onOpenChange])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-label="Row actions"
        className="rounded p-1.5 text-[var(--color-muted)] hover:bg-[var(--color-faint)] hover:text-[var(--color-heading)]"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
      {open && coords && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: coords.top, right: coords.right, zIndex: 50 }}
          className="w-44 rounded-lg border border-[var(--color-line)] bg-[var(--color-elevated)] shadow-lg"
        >
          <button
            type="button"
            onClick={onDelete}
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-500 hover:bg-[var(--color-faint)]"
          >
            Delete call log
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}

function DeleteCallModal({
  call,
  onClose,
  onDeleted,
}: {
  call: any | null
  onClose: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!call) return null

  const linkedCount = call.linked_application_count ?? 0
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await adminCallsApi.remove(call.id)
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
      setBusy(false)
    }
  }

  return (
    <Modal
      open={!!call}
      onClose={onClose}
      title="Delete call log"
      description={`This cannot be undone. ${call.customer_name || 'This call'} (${call.phone}) will be permanently removed.`}
      size="md"
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-sm text-red-500">
          <div className="font-semibold">This will also delete:</div>
          <ul className="mt-1 list-disc pl-5 space-y-0.5">
            <li>
              {linkedCount === 0
                ? 'No linked loan application.'
                : linkedCount === 1
                  ? '1 linked loan application (and its autosave log, status history, uploaded documents).'
                  : `${linkedCount} linked loan applications (and their autosave logs, status histories, uploaded documents).`}
            </li>
            <li>Transcript, recording reference, and all call metadata.</li>
          </ul>
        </div>
        {error && (
          <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" variant="danger" onClick={confirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete permanently'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
