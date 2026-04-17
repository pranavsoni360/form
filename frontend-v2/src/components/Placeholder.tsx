export function Placeholder({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-[var(--color-line)] bg-[var(--color-elevated)] p-12 text-center">
      <h2 className="text-xl font-semibold text-[var(--color-heading)]">{title}</h2>
      {hint && <p className="mt-2 text-sm text-[var(--color-muted)]">{hint}</p>}
    </div>
  )
}
