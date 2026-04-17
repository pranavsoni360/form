import type { ReactNode } from 'react'
import { StatusBadge, SuggestionBadge } from './StatusBadge'

export function ApplicationBody({
  app,
  timeline,
  readOnly,
  actions,
}: {
  app: any
  timeline: any[]
  readOnly?: boolean
  actions?: ReactNode
}) {
  const fmtCurrency = (v: any) => v != null ? `₹${Number(v).toLocaleString('en-IN')}` : '—'
  const fmt = (v: any) => v || '—'

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left — data sections */}
      <div className="lg:col-span-2 space-y-4">
        <Section title="System recommendation">
          <div className="flex flex-wrap items-center gap-4">
            <SuggestionBadge suggestion={app.system_suggestion} score={app.system_score} />
            {app.system_suggestion_reason && <p className="text-sm text-[var(--color-muted)] flex-1">{app.system_suggestion_reason}</p>}
          </div>
        </Section>

        <Section title="Personal">
          <KV items={[
            ['Full name', fmt(app.full_name || app.customer_name)],
            ['Date of birth', app.date_of_birth ? new Date(app.date_of_birth).toLocaleDateString() : '—'],
            ['Gender', fmt(app.gender)],
            ['Marital status', fmt(app.marital_status)],
            ['Email', fmt(app.email)],
            ['Phone', fmt(app.phone)],
          ]} />
        </Section>

        <Section title="Address">
          <KV items={[
            ['Current', fmt(app.current_address || [app.current_house, app.current_street, app.current_locality, app.current_pincode].filter(Boolean).join(', '))],
            ['Permanent', fmt(app.permanent_address || [app.permanent_house, app.permanent_street, app.permanent_locality, app.permanent_pincode].filter(Boolean).join(', '))],
          ]} />
        </Section>

        <Section title="Employment">
          <KV items={[
            ['Type', fmt(app.employment_type)],
            ['Employer', fmt(app.employer_name)],
            ['Designation', fmt(app.designation)],
            ['Industry', fmt(app.industry_type)],
            ['Experience (total)', fmt(app.total_work_experience)],
            ['Experience (current org)', fmt(app.experience_current_org)],
          ]} />
        </Section>

        <Section title="Financial">
          <KV items={[
            ['Gross income', fmtCurrency(app.monthly_gross_income)],
            ['Net income', fmtCurrency(app.monthly_net_income)],
            ['Existing EMI', fmtCurrency(app.monthly_emi_existing)],
            ['Deductions', fmtCurrency(app.monthly_deductions)],
          ]} />
        </Section>

        <Section title="KYC">
          <KV items={[
            ['PAN', app.pan_number ? `${app.pan_number} ${app.pan_verified ? '✓' : '—'}` : '—'],
            ['Aadhaar (last 4)', app.aadhaar_last4 ? `XXXX-XXXX-${app.aadhaar_last4} ${app.aadhaar_verified ? '✓' : '—'}` : '—'],
          ]} />
        </Section>

        <Section title="Loan">
          <KV items={[
            ['Amount requested', fmtCurrency(app.loan_amount_requested)],
            ['Tenure (years)', fmt(app.repayment_period_years)],
            ['Purpose', fmt(app.purpose_of_loan || app.loan_purpose)],
            ['Scheme', fmt(app.scheme)],
          ]} />
        </Section>
      </div>

      {/* Right — timeline + actions */}
      <aside className="space-y-4">
        {actions && !readOnly && (
          <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-4">
            <h3 className="text-sm font-semibold text-[var(--color-heading)] mb-3">Actions</h3>
            {actions}
          </div>
        )}

        <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-4">
          <h3 className="text-sm font-semibold text-[var(--color-heading)] mb-3">Status timeline</h3>
          {timeline.length === 0 ? (
            <p className="text-xs text-[var(--color-muted)]">No transitions yet.</p>
          ) : (
            <ol className="space-y-3">
              {timeline.map((t) => (
                <li key={t.id} className="relative pl-5 text-sm">
                  <span className="absolute left-0 top-1.5 h-2 w-2 rounded-full bg-[var(--color-brand)]" />
                  <div className="flex items-center gap-2">
                    {t.from_status && <StatusBadge status={t.from_status} />}
                    <span className="text-[var(--color-muted)]">→</span>
                    <StatusBadge status={t.to_status} />
                  </div>
                  <div className="mt-1 text-xs text-[var(--color-muted)]">
                    {t.changed_by_role || 'system'} · {new Date(t.created_at).toLocaleString()}
                  </div>
                  {t.notes && <p className="mt-1 text-xs text-[var(--color-heading)]">{t.notes}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>

        {app.rejection_reason && (
          <div className="rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-500">
            <div className="font-semibold">Rejection reason</div>
            <p className="mt-1">{app.rejection_reason}</p>
          </div>
        )}
      </aside>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-elevated)] p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function KV({ items }: { items: [string, string][] }) {
  return (
    <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
          <dd className="mt-0.5 text-sm text-[var(--color-heading)]">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
