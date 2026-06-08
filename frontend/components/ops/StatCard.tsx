import * as React from "react";

export type StatTone = "info" | "success" | "warning" | "danger" | "neutral";

const TONE = {
  info:    { strip: "#2563EB", iconBg: "rgba(37,99,235,0.08)",  iconColor: "#2563EB", ring: "rgba(37,99,235,0.12)" },
  success: { strip: "#059669", iconBg: "rgba(5,150,105,0.08)",  iconColor: "#059669", ring: "rgba(5,150,105,0.12)" },
  warning: { strip: "#D97706", iconBg: "rgba(217,119,6,0.10)",  iconColor: "#D97706", ring: "rgba(217,119,6,0.15)"  },
  danger:  { strip: "#DC2626", iconBg: "rgba(220,38,38,0.08)",  iconColor: "#DC2626", ring: "rgba(220,38,38,0.12)" },
  neutral: { strip: "#64748B", iconBg: "rgba(100,116,139,0.08)",iconColor: "#64748B", ring: "rgba(100,116,139,0.12)"},
} as const;

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = "info",
  hint,
}: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: StatTone;
  hint?: string;
}) {
  const t = TONE[tone];
  return (
    <div className="relative overflow-hidden rounded-2xl bg-card transition-all hover:-translate-y-0.5 hover:shadow-lg border border-border"
      style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
      {/* Accent strip */}
      <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl" style={{ background: t.strip }} />

      <div className="pl-5 pr-4 pt-4 pb-4">
        <div className="flex items-start justify-between mb-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground"
            style={{ fontFamily: 'var(--font-body)' }}>
            {label}
          </p>
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: t.iconBg, border: `1px solid ${t.ring}`, color: t.iconColor }}>
            <Icon className="h-4 w-4" />
          </div>
        </div>

        <div className="text-4xl font-bold tabular-nums text-foreground"
          style={{ fontFamily: 'var(--font-heading)', lineHeight: 1 }}>
          {value}
        </div>

        {hint && (
          <p className="mt-1.5 text-[11px] text-muted-foreground" style={{ fontFamily: 'var(--font-body)' }}>{hint}</p>
        )}
      </div>
    </div>
  );
}
