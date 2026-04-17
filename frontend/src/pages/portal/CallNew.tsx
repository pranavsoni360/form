import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { portalApi } from '../../services/api'
import { Field, Input, Button } from '../../components/Field'

const LANGUAGES = ['hindi', 'marathi', 'english']
const LOAN_TYPES = ['Personal Loan', 'Home Loan', 'Vehicle Loan', 'Education Loan', 'Business Loan']

export default function CallNew() {
  const navigate = useNavigate()
  const [form, setForm] = useState({
    customer_name: '',
    phone: '',
    loan_type: '',
    loan_amount: '',
    language: 'hindi',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      const res = await portalApi.initiateCall(form)
      navigate(`/portal/calls/${res.call.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start call')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">New call</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          The AI agent will call the customer in the chosen language, answer their questions, and collect loan details.
        </p>
      </div>
      <form onSubmit={submit} className="space-y-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Customer name" required>
            <Input value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} required placeholder="Rajesh Kumar" />
          </Field>
          <Field label="Phone" required hint="Indian mobile (10 digits) or E.164">
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required placeholder="+91 99999 99999" />
          </Field>
          <Field label="Loan type">
            <select value={form.loan_type} onChange={(e) => setForm({ ...form, loan_type: e.target.value })} className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-input)] px-3 py-2 text-sm">
              <option value="">Let the agent decide</option>
              {LOAN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Loan amount (₹)">
            <Input value={form.loan_amount} onChange={(e) => setForm({ ...form, loan_amount: e.target.value })} placeholder="500000" />
          </Field>
          <Field label="Language" required>
            <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-input)] px-3 py-2 text-sm capitalize">
              {LANGUAGES.map((l) => <option key={l} value={l} className="capitalize">{l}</option>)}
            </select>
          </Field>
        </div>
        {error && <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => navigate('/portal/calls')}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Queuing…' : 'Start call'}</Button>
        </div>
      </form>
    </div>
  )
}
