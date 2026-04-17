import { useState } from 'react'
import { Modal } from '../Modal'
import { Field, Input, Button } from '../Field'
import { CredentialsPanel } from '../Credentials'

export function UserCreateModal({
  open,
  onClose,
  onCreated,
  title,
  description,
  createFn,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  title: string
  description?: string
  createFn: (user: { username: string; email?: string; full_name: string }) => Promise<{ user: any }>
}) {
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generated, setGenerated] = useState<{ username: string; password: string } | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      const res = await createFn({ username, email: email || undefined, full_name: fullName })
      setGenerated({ username: res.user.username, password: res.user.generated_password })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user')
    } finally {
      setSaving(false)
    }
  }

  const close = () => {
    setGenerated(null); setUsername(''); setEmail(''); setFullName(''); setError(null)
    onClose()
  }

  return (
    <Modal open={open} onClose={close} title={title} description={description} size="md">
      {generated ? (
        <div className="space-y-4">
          <CredentialsPanel username={generated.username} password={generated.password} />
          <div className="flex justify-end">
            <Button type="button" onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Username" required>
            <Input value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} required placeholder="unique login id" />
          </Field>
          <Field label="Full name" required>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} required placeholder="Full legal name" />
          </Field>
          <Field label="Email" hint="Optional — for future password reset">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {error && <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create user'}</Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
