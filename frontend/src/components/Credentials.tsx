import { useState } from 'react'
import { Button } from './Field'

export function CredentialsPanel({
  title = 'Account created',
  username,
  password,
}: {
  title?: string
  username: string
  password: string
}) {
  const [copied, setCopied] = useState<'u' | 'p' | null>(null)
  const copy = (val: string, which: 'u' | 'p') => {
    void navigator.clipboard.writeText(val)
    setCopied(which)
    window.setTimeout(() => setCopied(null), 1500)
  }
  return (
    <div className="rounded-xl border border-[var(--color-brand)]/40 bg-[var(--color-brand-dim)] p-4">
      <div className="text-sm font-semibold text-[var(--color-brand)]">{title}</div>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Save these credentials — the password is shown only once.
      </p>
      <div className="mt-3 space-y-2 text-sm">
        <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-elevated)] px-3 py-2">
          <div>
            <div className="text-xs uppercase text-[var(--color-muted)]">Username</div>
            <div className="font-mono text-[var(--color-heading)]">{username}</div>
          </div>
          <Button variant="ghost" size="sm" type="button" onClick={() => copy(username, 'u')}>
            {copied === 'u' ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-[var(--color-line)] bg-[var(--color-elevated)] px-3 py-2">
          <div>
            <div className="text-xs uppercase text-[var(--color-muted)]">Password</div>
            <div className="font-mono text-[var(--color-heading)]">{password}</div>
          </div>
          <Button variant="ghost" size="sm" type="button" onClick={() => copy(password, 'p')}>
            {copied === 'p' ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
    </div>
  )
}
