import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { portalApi } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { StatusBadge, SuggestionBadge } from '../../components/StatusBadge'
import { ApplicationBody } from '../../components/ApplicationBody'
import { Button, Textarea, Field } from '../../components/Field'
import { Modal } from '../../components/Modal'

export default function PortalApplicationDetail() {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [app, setApp] = useState<any | null>(null)
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState<null | 'approve' | 'reject' | 'request' | 'disburse'>(null)
  const [notes, setNotes] = useState('')
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const load = () => {
    if (!id) return
    portalApi.application(id).then((d) => setApp(d.application)).catch((e) => setErr(String(e)))
  }
  useEffect(load, [id])

  if (err) return <div className="rounded-lg border border-red-400/40 bg-red-500/10 p-4 text-sm text-red-500">{err}</div>
  if (!app) return <div className="text-sm text-[var(--color-muted)]">Loading…</div>

  const isBank = user?.role === 'bank_user'
  const status = app.status as string
  const canApprove = isBank && ['submitted', 'system_reviewed'].includes(status)
  const canReject = isBank && ['submitted', 'system_reviewed', 'approved', 'documents_requested', 'documents_submitted'].includes(status)
  const canRequestDocs = isBank && status === 'approved'
  const canDisburse = isBank && ['approved', 'documents_submitted'].includes(status)

  const runAction = async (fn: () => Promise<any>, success: string) => {
    setBusy(true); setErr(null)
    try {
      await fn()
      setModal(null); setNotes(''); setReason('')
      load()
      // simple toast-ish: just alert via console + banner on refresh
      console.info(success)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link to="/portal/applications" className="text-xs text-[var(--color-muted)] hover:text-[var(--color-heading)]">← All applications</Link>
        <div className="mt-2 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{app.customer_name}</h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {app.loan_id} · {app.bank_code || 'unassigned'}{app.vendor_code && ` · vendor ${app.vendor_code}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SuggestionBadge suggestion={app.system_suggestion} score={app.system_score} />
            <StatusBadge status={status} />
          </div>
        </div>
      </div>

      <ApplicationBody
        app={app}
        timeline={app.status_history || []}
        readOnly={!isBank}
        actions={isBank && (
          <div className="space-y-2">
            {canApprove && <Button onClick={() => setModal('approve')} className="w-full">Approve</Button>}
            {canReject &&  <Button variant="danger" onClick={() => setModal('reject')} className="w-full">Reject</Button>}
            {canRequestDocs && <Button variant="secondary" onClick={() => setModal('request')} className="w-full">Request documents</Button>}
            {canDisburse && <Button variant="secondary" onClick={() => setModal('disburse')} className="w-full">Mark disbursed</Button>}
            {!canApprove && !canReject && !canRequestDocs && !canDisburse && (
              <p className="text-xs text-[var(--color-muted)]">No actions available for status <StatusBadge status={status} /></p>
            )}
            <button
              onClick={() => navigate('/portal/applications')}
              className="w-full text-xs text-[var(--color-muted)] hover:text-[var(--color-heading)] pt-2"
            >
              Back to list
            </button>
          </div>
        )}
      />

      <Modal open={modal === 'approve'} onClose={() => setModal(null)} title="Approve application">
        <form onSubmit={(e) => { e.preventDefault(); runAction(() => portalApi.approve(app.id, notes), 'Approved') }} className="space-y-4">
          <Field label="Notes (optional)"><Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          {err && <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{err}</div>}
          <div className="flex justify-end gap-2"><Button variant="secondary" type="button" onClick={() => setModal(null)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? 'Approving…' : 'Confirm approve'}</Button></div>
        </form>
      </Modal>
      <Modal open={modal === 'reject'} onClose={() => setModal(null)} title="Reject application">
        <form onSubmit={(e) => { e.preventDefault(); runAction(() => portalApi.reject(app.id, reason, notes), 'Rejected') }} className="space-y-4">
          <Field label="Rejection reason" required><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
          <Field label="Notes"><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          {err && <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{err}</div>}
          <div className="flex justify-end gap-2"><Button variant="secondary" type="button" onClick={() => setModal(null)}>Cancel</Button><Button variant="danger" type="submit" disabled={busy}>{busy ? 'Rejecting…' : 'Confirm reject'}</Button></div>
        </form>
      </Modal>
      <Modal open={modal === 'request'} onClose={() => setModal(null)} title="Request documents">
        <form onSubmit={(e) => { e.preventDefault(); runAction(() => portalApi.requestDocs(app.id, notes), 'Documents requested') }} className="space-y-4">
          <Field label="Notes" hint="Sent to the customer over WhatsApp"><Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          {err && <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{err}</div>}
          <div className="flex justify-end gap-2"><Button variant="secondary" type="button" onClick={() => setModal(null)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Request documents'}</Button></div>
        </form>
      </Modal>
      <Modal open={modal === 'disburse'} onClose={() => setModal(null)} title="Mark disbursed">
        <form onSubmit={(e) => { e.preventDefault(); runAction(() => portalApi.disburse(app.id, notes), 'Disbursed') }} className="space-y-4">
          <Field label="Notes"><Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          {err && <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{err}</div>}
          <div className="flex justify-end gap-2"><Button variant="secondary" type="button" onClick={() => setModal(null)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Confirm disbursement'}</Button></div>
        </form>
      </Modal>
    </div>
  )
}
