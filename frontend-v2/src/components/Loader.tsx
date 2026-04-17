export function FullPageLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-page)]">
      <div className="flex flex-col items-center gap-4">
        <div className="h-10 w-10 rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-brand)] animate-spin" />
        <p className="text-sm text-[var(--color-muted)]">Loading…</p>
      </div>
    </div>
  )
}
