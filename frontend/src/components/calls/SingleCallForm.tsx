// Shared single-call form used by both admin and portal pages. The only
// difference between the two modes is:
//   - admin mode: BankVendorPicker is shown; bankId + vendorId are appended
//     to the payload before hitting the admin endpoint.
//   - portal mode: bank/vendor are derived server-side from the JWT, so the
//     form just sends customer + call details.
//
// The caller wires `onSubmit` to the right API method (adminCallsApi.initiateCall
// or portalApi.initiateCall) and handles navigation on success.
import { useState } from 'react'
import { Field, Input, Button, Select } from '../Field'
import { BankVendorPicker, type BankVendor } from './BankVendorPicker'

const LANGUAGES = ['hindi', 'marathi', 'english']
const LOAN_TYPES = ['Personal Loan', 'Home Loan', 'Vehicle Loan', 'Education Loan', 'Business Loan']

export type SingleCallPayload = {
  customer_name: string
  phone: string
  loan_type?: string
  loan_amount?: string
  language: string
  bank_id?: string
  vendor_id?: string | null
}

export function SingleCallForm({
  mode,
  onSubmit,
  onCancel,
  submitLabel = 'Start call',
}: {
  mode: 'admin' | 'portal'
  onSubmit: (payload: SingleCallPayload) => Promise<void>
  onCancel: () => void
  submitLabel?: string
}) {
  const [form, setForm] = useState({
    customer_name: '',
    phone: '',
    loan_type: '',
    loan_amount: '',
    language: 'hindi',
  })
  const [scope, setScope] = useState<BankVendor>({ bankId: '', vendorId: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (mode === 'admin' && !scope.bankId) {
      setError('Select a bank to attribute this call to.')
      return
    }
    setSaving(true)
    try {
      const payload: SingleCallPayload = { ...form }
      if (mode === 'admin') {
        payload.bank_id = scope.bankId
        payload.vendor_id = scope.vendorId || null
      }
      await onSubmit(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start call')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-6"
    >
      {mode === 'admin' && (
        <div className="border-b border-[var(--color-line)] pb-4">
          <BankVendorPicker value={scope} onChange={setScope} disabled={saving} />
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Customer name" required>
          <Input
            value={form.customer_name}
            onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
            required
            placeholder="Rajesh Kumar"
            disabled={saving}
          />
        </Field>
        <Field label="Phone" required hint="Indian mobile (10 digits) or E.164">
          <Input
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            required
            placeholder="+91 99999 99999"
            disabled={saving}
          />
        </Field>
        <Field label="Loan type">
          <Select
            value={form.loan_type}
            onChange={(e) => setForm({ ...form, loan_type: e.target.value })}
            disabled={saving}
          >
            <option value="">Let the agent decide</option>
            {LOAN_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Loan amount (₹)">
          <Input
            value={form.loan_amount}
            onChange={(e) => setForm({ ...form, loan_amount: e.target.value })}
            placeholder="500000"
            disabled={saving}
          />
        </Field>
        <Field label="Language" required>
          <Select
            value={form.language}
            onChange={(e) => setForm({ ...form, language: e.target.value })}
            className="capitalize"
            disabled={saving}
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l} className="capitalize">
                {l}
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
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? 'Queuing…' : submitLabel}
        </Button>
      </div>
    </form>
  )
}
