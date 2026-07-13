"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Gauge, Loader2, RefreshCw, AlertTriangle, TrendingUp, CheckCircle2, ChevronDown } from "lucide-react";
import { toast } from "sonner";

import { getLRSScore, rescoreLRS } from "@/lib/api/bank";
import { formatCurrency } from "@/lib/api";

/**
 * LRS (Loan Recommendation System) panel on the application detail page.
 * Shows the credit score, decision, risk-based pricing (amount/tenure/EMI/ROI)
 * and the 5-pillar breakdown. Read-only + a supervisor "re-run" action.
 */

const DECISION_STYLE: Record<string, { label: string; badge: string; ring: string }> = {
  approve: { label: "Approve", badge: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300", ring: "text-green-500" },
  refer:   { label: "Refer",   badge: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300", ring: "text-yellow-500" },
  reject:  { label: "Reject",  badge: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300", ring: "text-red-500" },
};

function scoreColor(score: number): string {
  if (score >= 70) return "bg-emerald-500";
  if (score >= 50) return "bg-amber-500";
  return "bg-rose-500";
}

function ScoreRing({ score, decision }: { score: number; decision: string }) {
  const pct = Math.max(0, Math.min(100, score));
  const r = 42;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  const color = DECISION_STYLE[decision]?.ring ?? "text-slate-400";
  return (
    <div className="relative h-28 w-28 shrink-0">
      <svg viewBox="0 0 100 100" className="h-28 w-28 -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="8" className="stroke-slate-200 dark:stroke-gray-700" />
        <circle
          cx="50" cy="50" r={r} fill="none" strokeWidth="8" strokeLinecap="round"
          className={`${color} transition-all`} stroke="currentColor"
          strokeDasharray={`${dash} ${c}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold text-gray-900 dark:text-white">{score}</span>
        <span className="text-[10px] uppercase tracking-wider text-gray-400">/ 100</span>
      </div>
    </div>
  );
}

function PillarBar({ p }: { p: any }) {
  const present = p.present;
  const score = present && p.score != null ? Math.round(p.score) : null;
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-700 dark:text-gray-300">
          {p.title}
          <span className="ml-1 text-gray-400">· {p.effective_weight ?? p.weight}%</span>
        </span>
        {score != null ? (
          <span className="font-medium text-gray-900 dark:text-white">{score}</span>
        ) : (
          <span className="rounded bg-slate-100 px-1.5 text-[10px] text-slate-500 dark:bg-gray-700 dark:text-gray-400">no data</span>
        )}
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-gray-700">
        {score != null && (
          <div className={`h-full rounded-full ${scoreColor(score)}`} style={{ width: `${score}%` }} />
        )}
      </div>
    </div>
  );
}

function PillarParamTable({ pillar }: { pillar: any }) {
  const [open, setOpen] = React.useState(false);
  const params = Object.entries(pillar.children || {}) as [string, any][];
  const ew = pillar.effective_weight ?? pillar.weight;

  return (
    <div className="rounded-lg border border-slate-100 dark:border-gray-700/60">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-gray-700 hover:bg-slate-50 dark:text-gray-300 dark:hover:bg-gray-800/50 rounded-lg"
      >
        <span>{pillar.title} <span className="text-slate-400">· {ew}%</span></span>
        <span className="flex items-center gap-2">
          <span className="font-semibold text-gray-900 dark:text-white">{Math.round(pillar.score ?? 0)}/100</span>
          <ChevronDown className={`h-3.5 w-3.5 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-100 px-3 pb-3 pt-2 dark:border-gray-700/60">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[9px] uppercase tracking-wider text-slate-400">
                <th className="pb-1.5 font-medium">Parameter</th>
                <th className="pb-1.5 text-right font-medium">Value</th>
                <th className="pb-1.5 text-right font-medium">Score</th>
                <th className="pb-1.5 text-right font-medium">Weight</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-gray-800">
              {params.map(([key, param]) => (
                <tr key={key} className={param.present ? "text-gray-700 dark:text-gray-300" : "text-slate-400 dark:text-gray-500"}>
                  <td className="py-1.5 pr-2">
                    {param.title ?? key}
                    {param.children && <span className="ml-1 text-[9px] text-slate-400">(composite)</span>}
                  </td>
                  <td className="py-1.5 text-right">
                    {param.value != null
                      ? String(param.value)
                      : param.rating
                      ? param.rating
                      : "—"}
                  </td>
                  <td className="py-1.5 text-right">
                    {param.present && param.score != null ? Math.round(param.score) : "—"}
                  </td>
                  <td className="py-1.5 text-right text-slate-500 dark:text-gray-400">{param.weight}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function LRSScorePanel({
  token, applicationId, canRescore = false,
}: { token: string; applicationId: string; canRescore?: boolean }) {
  const qc = useQueryClient();

  const [showFormula, setShowFormula] = React.useState(false);

  const q = useQuery({
    queryKey: ["lrs", applicationId],
    queryFn: () => getLRSScore(token, applicationId),
    enabled: !!token && !!applicationId,
    retry: false,
    refetchInterval: (query) => {
      const d: any = query.state.data;
      // Poll while scoring is still in progress.
      return d && (d.status === "pending" || d.status === "fetching") ? 5000 : false;
    },
  });

  const rescore = useMutation({
    mutationFn: () => rescoreLRS(token, applicationId),
    onSuccess: () => {
      toast.success("Re-scoring triggered");
      qc.invalidateQueries({ queryKey: ["lrs", applicationId] });
    },
    onError: (e: any) => toast.error(e?.message || "Re-score failed"),
  });

  const Card = ({ children }: { children: React.ReactNode }) => (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-colors dark:border-gray-700/50 dark:bg-dark-card dark:shadow-gray-900/30">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-indigo-600" />
          <h3 className="font-semibold text-gray-900 dark:text-white">LRS Credit Assessment</h3>
        </div>
        {canRescore && (
          <button
            onClick={() => rescore.mutate()}
            disabled={rescore.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {rescore.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Re-run
          </button>
        )}
      </div>
      {children}
    </div>
  );

  // Loading
  if (q.isLoading) {
    return <Card><div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading assessment…</div></Card>;
  }

  const data: any = q.data;

  // Not scored yet / error (e.g. 404) → pending state.
  if (q.isError || !data || data.status !== "scored") {
    const pending = data && (data.status === "pending" || data.status === "fetching");
    const failed = data && data.status === "failed";
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <TrendingUp className="h-4 w-4" />}
          {pending
            ? "Credit assessment is being generated…"
            : failed
            ? "Assessment could not be completed."
            : "No credit assessment available yet."}
        </div>
      </Card>
    );
  }

  const decision = data.decision as string;
  const ds = DECISION_STYLE[decision] ?? DECISION_STYLE.refer;
  const pillars: any[] = Object.values(data.pillar_scores || {}).sort(
    (a: any, b: any) => (b.weight ?? 0) - (a.weight ?? 0)
  );

  return (
    <Card>
      {/* headline */}
      <div className="flex flex-wrap items-center gap-5">
        <ScoreRing score={Math.round(data.total_score)} decision={decision} />
        <div className="flex-1 min-w-[180px]">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ${ds.badge}`}>{ds.label}</span>
            <span className="text-sm text-gray-500 dark:text-gray-400">{data.rating}</span>
          </div>
          <p className="mt-1 text-xs text-gray-400">
            Risk band: {data.risk_band || "—"} · config {data.config_version}
          </p>
          {data.incomplete && (
            <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>Incomplete data — missing: {(data.missing_pillars || []).join(", ") || "some inputs"}. Weights re-normalised.</span>
            </div>
          )}
        </div>
      </div>

      {/* recommended offer */}
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["Recommended", formatCurrency(data.recommended_amount || 0)],
          ["Tenure", `${data.recommended_tenure_m || 0} mo`],
          ["EMI", formatCurrency(data.recommended_emi || 0)],
          ["Interest", `${data.interest_rate}%`],
        ].map(([label, val]) => (
          <div key={label} className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-gray-800/50">
            <div className="text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
            <div className="mt-0.5 text-sm font-semibold text-gray-900 dark:text-white">{val}</div>
          </div>
        ))}
      </div>

      {/* Why this score (explainability) */}
      {data.reasons?.summary && (
        <div className="mt-5 border-t border-slate-100 pt-4 dark:border-gray-700/50">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Why this score</div>
          <p className="text-sm text-gray-700 dark:text-gray-300">{data.reasons.summary}</p>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            {data.reasons.positives?.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium text-emerald-600">Strengths</div>
                <ul className="space-y-1">
                  {data.reasons.positives.map((f: any, i: number) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      <span>{f.factor}{f.value != null ? `: ${f.value}` : ""}{f.rating ? ` (${f.rating})` : ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.reasons.negatives?.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium text-rose-600">Watch-outs</div>
                <ul className="space-y-1">
                  {data.reasons.negatives.map((f: any, i: number) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
                      <span>{f.factor}{f.value != null ? `: ${f.value}` : ""}{f.rating ? ` (${f.rating})` : ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4-pillar breakdown */}
      <div className="mt-5 border-t border-slate-100 pt-4 dark:border-gray-700/50">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Pillar breakdown</div>
        {pillars.map((p, i) => <PillarBar key={i} p={p} />)}
      </div>

      {/* Score Formulation */}
      <div className="mt-4 border-t border-slate-100 pt-3 dark:border-gray-700/50">
        <button
          onClick={() => setShowFormula((v) => !v)}
          className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
        >
          <span>Score Formulation</span>
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showFormula ? "rotate-180" : ""}`} />
        </button>

        {showFormula && (
          <div className="mt-3 space-y-3">
            {/* Formula */}
            <p className="rounded-md bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600 dark:bg-gray-800 dark:text-slate-300">
              Total Score = Σ ( pillar_score × effective_weight / 100 )
            </p>

            {/* Contribution table */}
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-slate-400">
                  <th className="pb-1.5 font-medium">Pillar</th>
                  <th className="pb-1.5 text-right font-medium">Score</th>
                  <th className="pb-1.5 text-right font-medium">Weight</th>
                  <th className="pb-1.5 text-right font-medium">Contribution</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-gray-700/50">
                {pillars.filter((p) => p.present).map((p, i) => {
                  const ew = p.effective_weight ?? p.weight;
                  const contrib = ((p.score ?? 0) * ew) / 100;
                  return (
                    <tr key={i} className="text-gray-700 dark:text-gray-300">
                      <td className="py-1.5">{p.title}</td>
                      <td className="py-1.5 text-right">{Math.round(p.score ?? 0)}</td>
                      <td className="py-1.5 text-right">{ew}%</td>
                      <td className="py-1.5 text-right font-medium text-indigo-600 dark:text-indigo-400">
                        +{contrib.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 font-semibold text-gray-900 dark:border-gray-600 dark:text-white">
                  <td className="pt-2" colSpan={3}>Total Score</td>
                  <td className="pt-2 text-right text-indigo-600 dark:text-indigo-400">{data.total_score.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>

            {/* Per-pillar parameter drill-down */}
            <div className="space-y-2">
              {pillars.filter((p) => p.present && p.children).map((p, i) => (
                <PillarParamTable key={i} pillar={p} />
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
