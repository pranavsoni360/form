import type { ChangeEvent, ReactNode } from 'react'

export function Field({
  label,
  hint,
  error,
  children,
  required,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
  required?: boolean
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted)]">
        {label}{required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      <div className="mt-1">{children}</div>
      {error ? (
        <p className="mt-1 text-xs text-red-500">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">{hint}</p>
      ) : null}
    </label>
  )
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-input)] px-3 py-2 text-sm text-[var(--color-heading)] placeholder:text-[var(--color-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] disabled:opacity-50 ${props.className || ''}`}
    />
  )
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-input)] px-3 py-2 text-sm text-[var(--color-heading)] placeholder:text-[var(--color-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] disabled:opacity-50 ${props.className || ''}`}
    />
  )
}

export function Select({
  value,
  onChange,
  children,
  ...rest
}: {
  value: string
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void
  children: ReactNode
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  return (
    <select
      value={value}
      onChange={onChange}
      {...rest}
      className={`w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-input)] px-3 py-2 text-sm text-[var(--color-heading)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] ${rest.className || ''}`}
    >
      {children}
    </select>
  )
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const sizes: Record<string, string> = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
  }
  const variants: Record<string, string> = {
    primary:   'bg-[var(--color-brand)] text-white hover:bg-[var(--color-brand-hover)]',
    secondary: 'border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-heading)] hover:bg-[var(--color-faint)]',
    ghost:     'text-[var(--color-muted)] hover:text-[var(--color-heading)] hover:bg-[var(--color-faint)]',
    danger:    'bg-red-500 text-white hover:bg-red-600',
  }
  return (
    <button
      {...rest}
      className={`rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${sizes[size]} ${variants[variant]} ${className}`}
    />
  )
}
