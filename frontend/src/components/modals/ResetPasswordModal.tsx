import { useState } from 'react'
import { Modal } from '../Modal'
import { Field, Input, Button } from '../Field'
import { CredentialsPanel } from '../Credentials'

export function ResetPasswordModal({
  open,
  onClose,
  username,
  displayName,
  resetFn,
  onDone,
}: {
  open: boolean
  onClose: () => void
  username: string
  displayName?: string
  /** Reset callback. Receives optional custom password (empty → auto-generate). */
  resetFn: (password?: string) => Promise<{ username: string; new_password: string }>
  onDone?: () => void
}) {
  const [custom, setCustom] = useState('')
  const [generated, setGenerated] = useState<{ username: string; password: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const reset = () => { setCustom(''); setGenerated(null); setError(null) }

  const close = () => {
    const hadReset = !!generated
    reset()
    onClose()
    if (hadReset) onDone?.()
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      const res = await resetFn(custom || undefined)
      setGenerated({ username: res.username, password: res.new_password })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password')
    } finally {
      setSaving(false)
    }
  }

  if (generated) {
    return (
      <Modal
        open={open}
        onClose={close}
        title="Password reset"
        description={`Share these new credentials with ${displayName || generated.username}.`}
        size="md"
      >
        <div className="space-y-4">
          <CredentialsPanel
            title="New credentials"
            username={generated.username}
            password={generated.password}
          />
          <p className="text-xs text-[var(--color-muted)]">
            Existing sessions for this user have been invalidated. They'll need the new password to sign back in.
          </p>
          <div className="flex justify-end">
            <Button type="button" onClick={close}>Done</Button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Reset password"
      description={`Issue a new password for ${displayName ? `${displayName} (${username})` : username}.`}
      size="md"
    >
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="New password"
          hint="Leave blank to auto-generate a secure password."
        >
          <Input
            type="text"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="auto-generate"
            minLength={6}
          />
        </Field>
        <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-faint)] p-3 text-xs text-[var(--color-muted)]">
          You cannot view the current password — only replace it. After reset you'll see the new password once; copy it and pass it to the user.
        </div>
        {error && <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Resetting…' : 'Reset password'}</Button>
        </div>
      </form>
    </Modal>
  )
}
