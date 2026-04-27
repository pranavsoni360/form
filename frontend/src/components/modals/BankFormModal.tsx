import { useEffect, useState } from 'react'
import { Modal } from '../Modal'
import { Field, Input, Button } from '../Field'
import { CredentialsPanel } from '../Credentials'
import { adminApi } from '../../services/api'

// Same slug shape as the backend so the preview matches what gets stored.
function slugify(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40)
}

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
  const [username, setUsername] = useState('')
  const [usernameManuallyEdited, setUsernameManuallyEdited] = useState(false)
  const [vendorLimit, setVendorLimit] = useState<number>(existing?.vendor_limit ?? 5)
  const [status, setStatus] = useState<string>(existing?.status || 'active')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [generated, setGenerated] = useState<{ username: string; password: string; bankName: string } | null>(null)

  // Auto-derive username from bank name until admin manually edits it (Vaani pattern).
  useEffect(() => {
    if (!isEdit && !usernameManuallyEdited) {
      setUsername(slugify(name))
    }
  }, [name, isEdit, usernameManuallyEdited])

  const reset = () => {
    setGenerated(null); setError(null)
    setName(''); setUsername(''); setUsernameManuallyEdited(false)
    setVendorLimit(5); setStatus('active')
  }

  const close = () => {
    const hadNewUser = !!generated
    reset()
    onClose()
    if (hadNewUser) onCreated()  // refresh list only after admin dismisses credentials
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      if (isEdit) {
        await adminApi.updateBank(existing.id, {
          name,
          vendor_limit: vendorLimit,
          status,
        })
        onCreated()
        onClose()
      } else {
        if (!username) {
          setError('Username is required'); setSaving(false); return
        }
        const res = await adminApi.createBank({
          name,
          vendor_limit: vendorLimit,
          owner_username: username,
          owner_full_name: name,
        })
        setGenerated({
          username: res.user.username,
          password: res.user.generated_password,
          bankName: res.bank.name,
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (generated) {
    return (
      <Modal open={open} onClose={close} title="Bank created" description={`Share these credentials with ${generated.bankName}.`} size="md">
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
    <Modal open={open} onClose={close} title={isEdit ? 'Edit bank' : 'Create bank'} size="md">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Bank name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="e.g. Buldhana Urban Co-op"
            autoFocus
          />
        </Field>

        {!isEdit && (
          <Field label="Username" required hint="Admin hands this off to the bank for login">
            <Input
              value={username}
              onChange={(e) => { setUsername(e.target.value.toLowerCase()); setUsernameManuallyEdited(true) }}
              required
              placeholder="auto-generated from bank name"
            />
          </Field>
        )}

        <Field label="Vendor limit" required hint="Max vendors this bank can create">
          <Input
            type="number"
            min={0}
            value={vendorLimit}
            onChange={(e) => setVendorLimit(parseInt(e.target.value || '0', 10))}
            required
          />
        </Field>

        {isEdit && (
          <Field label="Status">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-input)] px-3 py-2 text-sm"
            >
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </Field>
        )}

        {error && <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create bank'}</Button>
        </div>
      </form>
    </Modal>
  )
}
