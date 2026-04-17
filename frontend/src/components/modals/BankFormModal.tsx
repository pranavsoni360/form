import { useState } from 'react'
import { Modal } from '../Modal'
import { Field, Input, Button } from '../Field'
import { adminApi } from '../../services/api'

export function BankFormModal({
  open,
  onClose,
  onCreated,
  existing,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  existing?: any
}) {
  const isEdit = !!existing
  const [name, setName] = useState(existing?.name || '')
  const [code, setCode] = useState(existing?.code || '')
  const [email, setEmail] = useState(existing?.contact_email || '')
  const [phone, setPhone] = useState(existing?.contact_phone || '')
  const [address, setAddress] = useState(existing?.address || '')
  const [vendorLimit, setVendorLimit] = useState<number>(existing?.vendor_limit ?? 5)
  const [status, setStatus] = useState<string>(existing?.status || 'active')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      if (isEdit) {
        await adminApi.updateBank(existing.id, {
          name, code, contact_email: email, contact_phone: phone,
          address, vendor_limit: vendorLimit, status,
        })
      } else {
        await adminApi.createBank({
          name, code, contact_email: email, contact_phone: phone,
          address, vendor_limit: vendorLimit,
        })
      }
      onCreated()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit bank' : 'Create bank'} size="md">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Buldhana Urban Co-op" />
          </Field>
          <Field label="Code" required hint="Short unique identifier">
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required placeholder="BUCB" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ops@bank.com" />
          </Field>
          <Field label="Contact phone">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" />
          </Field>
        </div>
        <Field label="Address">
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Main branch, …" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vendor limit" required hint="Max vendors this bank can create">
            <Input type="number" min={0} value={vendorLimit} onChange={(e) => setVendorLimit(parseInt(e.target.value || '0', 10))} required />
          </Field>
          {isEdit && (
            <Field label="Status">
              <select
                value={status} onChange={(e) => setStatus(e.target.value)}
                className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-input)] px-3 py-2 text-sm"
              >
                <option value="active">active</option>
                <option value="inactive">inactive</option>
              </select>
            </Field>
          )}
        </div>
        {error && <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create bank'}</Button>
        </div>
      </form>
    </Modal>
  )
}
