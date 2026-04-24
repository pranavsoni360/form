// Three-stage bulk calling UI:
//   Stage 1: Upload — CSV file + (admin only) bank/vendor + language/gender.
//   Stage 2: Select — show the batch row we just created; user confirms & starts.
//   Stage 3: Running — live progress via SSE + cancel button.
//
// Like SingleCallForm, the only differences between admin and portal modes are
// (a) whether BankVendorPicker is shown and (b) which endpoint handles the
// upload. `uploadApi` is injected so pages wire it to the right apiFetch call.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Field, Input, Button, Select } from '../Field'
import { BankVendorPicker, type BankVendor } from './BankVendorPicker'
import { batchApi } from '../../services/api'
import { useBatchSSE } from './useBatchSSE'

type UploadResponse = {
  batch_id: string
  batch_uuid?: string
  total_records?: number
  inserted_count?: number
}

type Stage =
  | { kind: 'upload' }
  | { kind: 'select'; batchUuid: string; total: number; filename: string }
  | { kind: 'running'; batchUuid: string }

const LANGUAGES = ['hindi', 'marathi', 'english']
const GENDERS = ['male', 'female']

export function BulkUploadPanel({
  mode,
  uploadApi,
}: {
  mode: 'admin' | 'portal'
  uploadApi: (formData: FormData) => Promise<UploadResponse>
}) {
  const [stage, setStage] = useState<Stage>({ kind: 'upload' })

  if (stage.kind === 'upload') {
    return (
      <UploadStep
        mode={mode}
        uploadApi={uploadApi}
        onUploaded={(batchUuid, total, filename) =>
          setStage({ kind: 'select', batchUuid, total, filename })
        }
      />
    )
  }
  if (stage.kind === 'select') {
    return (
      <SelectStep
        batchUuid={stage.batchUuid}
        total={stage.total}
        filename={stage.filename}
        onStarted={() => setStage({ kind: 'running', batchUuid: stage.batchUuid })}
        onBack={() => setStage({ kind: 'upload' })}
      />
    )
  }
  return <RunningStep batchUuid={stage.batchUuid} onNewBatch={() => setStage({ kind: 'upload' })} />
}

// ─────────────────────────────────────────────────────────────
// Stage 1: Upload
// ─────────────────────────────────────────────────────────────
function UploadStep({
  mode,
  uploadApi,
  onUploaded,
}: {
  mode: 'admin' | 'portal'
  uploadApi: (formData: FormData) => Promise<UploadResponse>
  onUploaded: (batchUuid: string, total: number, filename: string) => void
}) {
  const [scope, setScope] = useState<BankVendor>({ bankId: '', vendorId: '' })
  const [language, setLanguage] = useState('hindi')
  const [gender, setGender] = useState('male')
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!file) return setError('Select a CSV or Excel file.')
    if (mode === 'admin' && !scope.bankId) return setError('Select a bank.')
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('language', language)
      fd.append('gender', gender)
      if (mode === 'admin') {
        fd.append('bank_id', scope.bankId)
        if (scope.vendorId) fd.append('vendor_id', scope.vendorId)
      }
      const res = await uploadApi(fd)
      const batchUuid = res.batch_uuid || res.batch_id
      const total = res.total_records ?? res.inserted_count ?? 0
      onUploaded(batchUuid, total, file.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-6"
    >
      <div>
        <h2 className="text-lg font-semibold">Upload customer list</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          CSV or Excel with at least <code>name</code> and <code>phone</code> columns. Optional:
          loan_type, loan_amount, email, aadhar_number, pan_number.
        </p>
      </div>
      {mode === 'admin' && (
        <div className="border-b border-[var(--color-line)] pb-4">
          <BankVendorPicker value={scope} onChange={setScope} disabled={uploading} />
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="File" required hint={file ? `${file.name} (${(file.size / 1024).toFixed(1)} KB)` : 'CSV / XLSX'}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            disabled={uploading}
            className="block w-full text-sm text-[var(--color-muted)] file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--color-brand)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-[var(--color-brand-hover)]"
          />
        </Field>
        <div />
        <Field label="Default language" required>
          <Select value={language} onChange={(e) => setLanguage(e.target.value)} className="capitalize" disabled={uploading}>
            {LANGUAGES.map((l) => (
              <option key={l} value={l} className="capitalize">
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default agent voice" required>
          <Select value={gender} onChange={(e) => setGender(e.target.value)} className="capitalize" disabled={uploading}>
            {GENDERS.map((g) => (
              <option key={g} value={g} className="capitalize">
                {g}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {error && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {error}
        </div>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={uploading || !file}>
          {uploading ? 'Uploading…' : 'Upload & preview'}
        </Button>
      </div>
    </form>
  )
}

// ─────────────────────────────────────────────────────────────
// Stage 2: Select (confirm + start)
// ─────────────────────────────────────────────────────────────
function SelectStep({
  batchUuid,
  total,
  filename,
  onStarted,
  onBack,
}: {
  batchUuid: string
  total: number
  filename: string
  onStarted: () => void
  onBack: () => void
}) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [calls, setCalls] = useState<any[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  // Pull the actual customer rows so the operator can eyeball names/phones/loan
  // values before dialing. Avoids accidentally dialing the wrong CSV.
  useEffect(() => {
    let cancelled = false
    batchApi
      .get(batchUuid)
      .then((d: any) => {
        if (!cancelled) setCalls(d.calls || [])
      })
      .catch((err) => {
        if (!cancelled) setLoadErr(err instanceof Error ? err.message : 'Could not load customer list')
      })
    return () => {
      cancelled = true
    }
  }, [batchUuid])

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      await batchApi.start(batchUuid)
      onStarted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start batch')
      setStarting(false)
    }
  }

  const fmtAmount = (v: any) => (v != null && v !== '' ? `₹${Number(v).toLocaleString('en-IN')}` : '—')

  return (
    <div className="space-y-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-6">
      <div>
        <h2 className="text-lg font-semibold">Ready to start</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Review the customer list below and click <strong>Start batch</strong> to begin dialing.
        </p>
      </div>
      <dl className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
        <Cell label="File">{filename}</Cell>
        <Cell label="Customers">{total}</Cell>
        <Cell label="Batch ID" mono>{batchUuid.slice(0, 8)}…</Cell>
      </dl>

      {/* Customer preview — fetched from GET /api/calls/batch/{id} so the operator
          sees exactly what's about to be dialed, not just a count. */}
      <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
        <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-2.5">
          <h3 className="text-sm font-semibold">Customers to call</h3>
          <span className="text-xs text-[var(--color-muted)]">{calls ? `${calls.length} rows` : 'loading…'}</span>
        </div>
        <div className="max-h-[360px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-[var(--color-sunken)] text-xs uppercase text-[var(--color-muted)]">
              <tr>
                <th className="px-4 py-2 text-left">#</th>
                <th className="px-4 py-2 text-left">Customer</th>
                <th className="px-4 py-2 text-left">Phone</th>
                <th className="px-4 py-2 text-left">Loan type</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2 text-left">Language</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {calls === null ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-[var(--color-muted)]">
                    Loading customers…
                  </td>
                </tr>
              ) : calls.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-[var(--color-muted)]">
                    No rows parsed from the file.
                  </td>
                </tr>
              ) : (
                calls.map((c, i) => (
                  <tr key={c.id}>
                    <td className="px-4 py-2 text-[var(--color-muted)]">{i + 1}</td>
                    <td className="px-4 py-2 font-medium text-[var(--color-heading)]">{c.customer_name || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-[var(--color-muted)]">{c.phone || '—'}</td>
                    <td className="px-4 py-2 capitalize">{c.loan_type || '—'}</td>
                    <td className="px-4 py-2 text-right">{fmtAmount(c.loan_amount)}</td>
                    <td className="px-4 py-2 capitalize">{c.language || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {loadErr && (
          <div className="border-t border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-red-500">
            {loadErr}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onBack} disabled={starting}>
          Upload different file
        </Button>
        <Button type="button" onClick={start} disabled={starting}>
          {starting ? 'Starting…' : 'Start batch'}
        </Button>
      </div>
    </div>
  )
}

function Cell({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2">
      <dt className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{label}</dt>
      <dd className={`mt-0.5 font-medium ${mono ? 'font-mono text-xs' : ''}`}>{children}</dd>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Stage 3: Running (live progress)
// ─────────────────────────────────────────────────────────────
function RunningStep({ batchUuid, onNewBatch }: { batchUuid: string; onNewBatch: () => void }) {
  const { snapshot, done, error } = useBatchSSE(batchUuid)
  const [cancelling, setCancelling] = useState(false)
  const [cancelErr, setCancelErr] = useState<string | null>(null)

  const counts = snapshot?.counts || {}
  const total = Number(counts._total || snapshot?.calls?.length || 0)

  // Treat anything NOT in a still-pending-ish bucket as finished.
  const finishedStatuses = useMemo(
    () =>
      Object.keys(counts).filter(
        (k) =>
          k !== '_total' &&
          !['Pending', 'queued', 'Calling', 'Scheduled', 'dialing', 'in_progress'].includes(k),
      ),
    [counts],
  )
  const finished = finishedStatuses.reduce((acc, k) => acc + (counts[k] || 0), 0)
  const pct = total > 0 ? Math.round((finished / total) * 100) : 0

  const cancel = async () => {
    setCancelling(true)
    setCancelErr(null)
    try {
      await batchApi.cancel(batchUuid)
    } catch (err) {
      setCancelErr(err instanceof Error ? err.message : 'Cancel failed')
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {done ? 'Batch finished' : 'Calling in progress'}
            </h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Batch {batchUuid.slice(0, 8)}… · {finished}/{total} completed
            </p>
          </div>
          {!done ? (
            <Button variant="danger" onClick={cancel} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </Button>
          ) : (
            <Button onClick={onNewBatch}>+ New batch</Button>
          )}
        </div>
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-[var(--color-sunken)]">
          <div
            className="h-full rounded-full bg-[var(--color-brand)] transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-[var(--color-muted)]">
          {Object.entries(counts)
            .filter(([k]) => k !== '_total')
            .map(([k, v]) => (
              <span
                key={k}
                className="rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-0.5"
              >
                {k}: <strong className="text-[var(--color-heading)]">{v as number}</strong>
              </span>
            ))}
        </div>
        {(error || cancelErr) && (
          <div className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
            {error || cancelErr}
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-sunken)] text-xs uppercase text-[var(--color-muted)]">
            <tr>
              <th className="px-4 py-3 text-left">Customer</th>
              <th className="px-4 py-3 text-left">Phone</th>
              <th className="px-4 py-3 text-left">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {(snapshot?.calls || []).map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-2 font-medium">{c.customer_name || '—'}</td>
                <td className="px-4 py-2 text-[var(--color-muted)]">{c.phone}</td>
                <td className="px-4 py-2">{c.status}</td>
              </tr>
            ))}
            {!snapshot && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-sm text-[var(--color-muted)]">
                  Loading progress…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
