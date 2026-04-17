import { useState } from 'react'
import { Modal } from '../Modal'
import { Field, Input, Button } from '../Field'

export function VendorFormModal({
  open,
  onClose,
  onSaved,
  bankId,
  existing,
  createFn,
  updateFn,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  bankId?: string  // required for admin-side create
  existing?: any
  createFn: (payload: any) => Promise<{ vendor: any }>
  updateFn?: (id: string, payload: any) => Promise<{ vendor: any }>
}) {
  const isEdit = !!existing
  const [name, setName] = useState(existing?.name || '')
  const [code, setCode] = useState(existing?.code || '')
  const [category, setCategory] = useState(existing?.category || '')
  const [contactName, setContactName] = useState(existing?.contact_name || '')
  const [contactEmail, setContactEmail] = useState(existing?.contact_email || '')
  const [contactPhone, setContactPhone] = useState(existing?.contact_phone || '')
  const [address, setAddress] = useState(existing?.address || '')
  const [status, setStatus] = useState<string>(existing?.status || 'active')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      const payload: any = {
        name, code, category,
        contact_name: contactName, contact_email: contactEmail,
        contact_phone: contactPhone, address,
      }
      if (bankId) payload.bank_id = bankId
      if (isEdit) {
        if (!updateFn) throw new Error('update not supported')
        payload.status = status
        await updateFn(existing.id, payload)
      } else {
        await createFn(payload)
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit vendor' : 'Create vendor'} size="md">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vendor name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="ElectroHub Electronics" />
          </Field>
          <Field label="Code" required>
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required placeholder="EH01" />
          </Field>
        </div>
        <Field label="Category">
          <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Electronics, Furniture, …" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact name">
            <Input value={contactName} onChange={(e) => setContactName(e.target.value)} />
          </Field>
          <Field label="Contact phone">
            <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="+91…" />
          </Field>
        </div>
        <Field label="Contact email">
          <Input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
        </Field>
        <Field label="Address">
          <Input value={address} onChange={(e) => setAddress(e.target.value)} />
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
        {error && <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create vendor'}</Button>
        </div>
      </form>
    </Modal>
  )
}
