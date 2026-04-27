import { useState } from 'react'
import { Modal } from '../Modal'
import { Field, Input, Button } from '../Field'
import { CredentialsPanel } from '../Credentials'

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
  createFn: (payload: any) => Promise<{ vendor: any; user?: any }>
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
  const [ownerName, setOwnerName] = useState('')
  const [ownerUsername, setOwnerUsername] = useState('')
  const [status, setStatus] = useState<string>(existing?.status || 'active')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [generated, setGenerated] = useState<{ username: string; password: string; vendorName: string } | null>(null)

  const reset = () => {
    setGenerated(null); setError(null)
    setName(''); setCode(''); setCategory('')
    setContactName(''); setContactEmail(''); setContactPhone(''); setAddress('')
    setOwnerName(''); setOwnerUsername(''); setStatus('active')
  }

  const close = () => {
    const hadNewUser = !!generated
    reset()
    onClose()
    if (hadNewUser) onSaved()
  }

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
        onSaved()
        onClose()
      } else {
        payload.owner_username = ownerUsername || undefined
        payload.owner_full_name = ownerName || undefined
        const res = await createFn(payload)
        if (res.user) {
          setGenerated({
            username: res.user.username,
            password: res.user.generated_password,
            vendorName: res.vendor.name,
          })
        } else {
          onSaved()
          onClose()
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (generated) {
    return (
      <Modal open={open} onClose={close} title="Vendor created" description={`Share these credentials with ${generated.vendorName}.`} size="md">
        <div className="space-y-4">
          <CredentialsPanel username={generated.username} password={generated.password} />
          <div className="flex justify-end">
            <Button type="button" onClick={close}>Done</Button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={open} onClose={close} title={isEdit ? 'Edit vendor' : 'Create vendor'} size="md">
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

        {!isEdit && (
          <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-faint)] p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">Vendor account</div>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Auto-generated username and password for the vendor's shared login. Override below if desired.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="Staff display name" hint="Optional — defaults to '<vendor> Staff'">
                <Input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="e.g. Front Desk" />
              </Field>
              <Field label="Username" hint="Optional — defaults to '<bank>_<code>'">
                <Input value={ownerUsername} onChange={(e) => setOwnerUsername(e.target.value.toLowerCase())} placeholder="auto" />
              </Field>
            </div>
          </div>
        )}

        {error && <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create vendor'}</Button>
        </div>
      </form>
    </Modal>
  )
}
