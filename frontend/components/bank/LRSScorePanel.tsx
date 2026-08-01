"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Gauge, Loader2, RefreshCw, AlertTriangle, TrendingUp, CheckCircle2, ChevronDown, Download } from "lucide-react";
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
                <th className="pb-1.5 text-right font-medium">Value · Band</th>
                <th className="pb-1.5 text-right font-medium">Score</th>
                <th className="pb-1.5 text-right font-medium">Weight</th>
                <th className="pb-1.5 text-right font-medium">Points</th>
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
                    {param.value != null ? <span>{String(param.value)}</span> : null}
                    {param.rating ? <span className="text-slate-400">{param.value != null ? " · " : ""}{param.rating}</span> : null}
                    {param.value == null && !param.rating ? "—" : null}
                  </td>
                  <td className="py-1.5 text-right">
                    {param.present && param.score != null ? Math.round(param.score) : "—"}
                  </td>
                  <td className="py-1.5 text-right text-slate-500 dark:text-gray-400">{Math.round((param.weight ?? 0) * 10) / 10}%</td>
                  <td className="py-1.5 text-right font-medium text-indigo-600 dark:text-indigo-400">
                    {param.present && param.score != null
                      ? `+${(((param.score ?? 0) * (param.weight ?? 0)) / 100).toFixed(1)}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-slate-400">
            Points = score × weight ÷ 100 — this parameter&apos;s contribution to the 100-point total.
          </p>
        </div>
      )}
    </div>
  );
}

export function LRSScorePanel({
  token, applicationId, canRescore = false, applicant,
}: {
  token: string; applicationId: string; canRescore?: boolean;
  applicant?: { name?: string; loanId?: string; phone?: string };
}) {
  const qc = useQueryClient();

  const [showFormula, setShowFormula] = React.useState(true);  // expanded by default — show the full "why" up front

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

  // Build a self-contained, print-ready credit-assessment report and open it for
  // "Save as PDF". Falls back to downloading the HTML if the popup is blocked.
  const downloadReport = React.useCallback(() => {
    const d: any = q.data;
    if (!d || d.status !== "scored") return;
    const inr = (n: number) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
    const pct = (n: number) => (Math.round((Number(n) || 0) * 10) / 10) + "%";
    const esc = (s: any) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c]);
    const gen = new Date().toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
    const DEC: Record<string, string> = { approve: "APPROVE", refer: "REFER", reject: "REJECT" };
    const decColor: Record<string, string> = { approve: "#15803D", refer: "#B45309", reject: "#BE123C" };

    const opts = d.offer_options?.options || [];
    const offerRows = opts.map((o: any) =>
      `<tr><td>${o.tenure_months} months</td><td class="r">${o.interest_rate}%</td><td class="r">${inr(o.recommended_amount)}</td><td class="r"><b>${inr(o.emi)}</b></td></tr>`).join("");

    const pillars: any[] = Object.values(d.pillar_scores || {}).filter((p: any) => p.present)
      .sort((a: any, b: any) => (b.effective_weight ?? b.weight ?? 0) - (a.effective_weight ?? a.weight ?? 0));
    const pillarRows = pillars.map((p: any) => {
      const ew = p.effective_weight ?? p.weight ?? 0;
      return `<tr><td>${esc(p.title)}</td><td class="r">${Math.round(p.score ?? 0)}</td><td class="r">${pct(ew)}</td><td class="r">+${(((p.score ?? 0) * ew) / 100).toFixed(2)}</td></tr>`;
    }).join("");

    const paramSections = pillars.map((p: any) => {
      const kids = Object.entries(p.children || {});
      if (!kids.length) return "";
      const rows = kids.map(([ck, c]: [string, any]) => {
        const val = c.value != null ? esc(c.value) : "";
        const band = c.rating ? (val ? " · " : "") + esc(c.rating) : "";
        const points = c.present && c.score != null ? "+" + (((c.score ?? 0) * (c.weight ?? 0)) / 100).toFixed(1) : "—";
        return `<tr><td>${esc(c.title || ck)}</td><td class="r">${(val + band) || "—"}</td><td class="r">${c.present && c.score != null ? Math.round(c.score) : "—"}</td><td class="r">${pct(c.weight ?? 0)}</td><td class="r">${points}</td></tr>`;
      }).join("");
      return `<h4>${esc(p.title)} · ${Math.round(p.score ?? 0)}/100</h4><table><thead><tr><th>Parameter</th><th class="r">Value · Band</th><th class="r">Score</th><th class="r">Weight</th><th class="r">Points</th></tr></thead><tbody>${rows}</tbody></table>`;
    }).join("");

    const mkList = (arr: any[]) => (arr || []).map((f: any) => `<li>${esc(f.factor)}${f.value != null ? ": " + esc(f.value) : ""}${f.rating ? " (" + esc(f.rating) + ")" : ""}</li>`).join("");
    const pos = mkList(d.reasons?.positives), neg = mkList(d.reasons?.negatives);

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Credit Assessment ${esc(applicant?.loanId || "")}</title><style>
*{box-sizing:border-box}body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1B2130;margin:0;padding:32px;line-height:1.5;font-size:13px}
.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #4F46E5;padding-bottom:14px;margin-bottom:14px}
.brand{font-size:22px;font-weight:800;letter-spacing:-.02em}.brand span{color:#4F46E5}.doc{font-size:10.5px;color:#5B647A;text-transform:uppercase;letter-spacing:.12em;margin-top:3px}
.meta{text-align:right;font-size:11px;color:#5B647A}.meta b{color:#1B2130}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#5B647A;margin:20px 0 6px;border-bottom:1px solid #E3E7F0;padding-bottom:5px}h4{font-size:12px;margin:12px 0 4px}
.hero{display:flex;gap:20px;align-items:center;background:#F4F6FB;border:1px solid #E3E7F0;border-radius:10px;padding:14px 18px}
.score{font-size:38px;font-weight:800;line-height:1}.score small{font-size:13px;color:#8A93A8;font-weight:600}
.dec{font-size:15px;font-weight:800;padding:3px 11px;border-radius:8px;display:inline-block}
.eligible{margin-left:auto;text-align:right}.eligible .lbl{font-size:9.5px;text-transform:uppercase;letter-spacing:.1em;color:#8A93A8}.eligible .amt{font-size:21px;font-weight:800;color:#15803D}
table{width:100%;border-collapse:collapse;font-size:11.5px;margin:5px 0}th,td{padding:6px 10px;text-align:left;border-bottom:1px solid #E7EAF0}thead th{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#8A93A8;background:#F4F6FB}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}tfoot td{font-weight:700;border-top:2px solid #cfd6e4}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}ul{margin:4px 0;padding-left:18px}li{margin:2px 0}
.foot{margin-top:22px;border-top:1px solid #E3E7F0;padding-top:12px;font-size:10px;color:#8A93A8}
.bar{position:fixed;top:12px;right:12px}.bar button{font:inherit;font-size:12px;font-weight:600;background:#4F46E5;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer}
@media print{.bar{display:none}body{padding:0}@page{margin:15mm}}
</style></head><body>
<div class="bar"><button onclick="window.print()">Save as PDF</button></div>
<div class="head"><div><div class="brand">Fin<span>ix</span></div><div class="doc">LRS Credit Assessment Report</div></div>
<div class="meta"><div><b>${esc(applicant?.name || "—")}</b></div><div>${esc(applicant?.loanId || "")}</div><div>${esc(applicant?.phone || "")}</div><div style="margin-top:4px">Generated ${esc(gen)}</div><div>Config ${esc(d.config_version || "")}</div></div></div>
<div class="hero"><div class="score">${Math.round(d.total_score)}<small>/100</small></div>
<div><span class="dec" style="background:${(decColor[d.decision] || "#888")}22;color:${decColor[d.decision] || "#333"}">${DEC[d.decision] || esc(d.decision)}</span><div style="margin-top:6px;color:#5B647A">${esc(d.rating || "")} · Risk band ${esc(d.risk_band || "—")}</div></div>
<div class="eligible"><div class="lbl">Eligible up to</div><div class="amt">${inr(d.max_eligible_amount ?? d.offer_options?.max_eligible_amount ?? 0)}</div></div></div>
${d.incomplete ? `<p style="color:#B45309;font-size:11px;margin-top:8px">Scored on partial data — missing: ${esc((d.missing_pillars || []).join(", ") || "some inputs")}.</p>` : ""}
<h2>Loan Offer — tenure options</h2><table><thead><tr><th>Tenure</th><th class="r">Interest</th><th class="r">Loan Amount</th><th class="r">Monthly EMI</th></tr></thead><tbody>${offerRows || `<tr><td colspan="4">No offer computed.</td></tr>`}</tbody></table>
<p style="font-size:10px;color:#8A93A8">Repayment capacity at FOIR ${d.offer_options?.foir_used != null ? Math.round(d.offer_options.foir_used * 100) + "%" : "—"} of net income.</p>
<h2>Score breakdown by pillar</h2><table><thead><tr><th>Pillar</th><th class="r">Score</th><th class="r">Weight</th><th class="r">Contribution</th></tr></thead><tbody>${pillarRows}</tbody><tfoot><tr><td colspan="3">Total score</td><td class="r">${Number(d.total_score).toFixed(2)}</td></tr></tfoot></table>
<p style="font-size:10px;color:#8A93A8">Total = &Sigma; ( pillar_score &times; weight &divide; 100 ).</p>
${(pos || neg) ? `<h2>Why this score</h2>${d.reasons?.summary ? `<p>${esc(d.reasons.summary)}</p>` : ""}<div class="cols"><div><h4 style="color:#15803D">Strengths</h4><ul>${pos || "<li>—</li>"}</ul></div><div><h4 style="color:#BE123C">Watch-outs</h4><ul>${neg || "<li>—</li>"}</ul></div></div>` : ""}
<h2>Parameter-level detail</h2>${paramSections || "<p>—</p>"}
<p style="font-size:10px;color:#8A93A8">Points = score &times; weight &divide; 100 (contribution to the 100-point total).</p>
<div class="foot">System-generated credit assessment by the Finix LRS engine (config ${esc(d.config_version || "")}). Decision-support recommendation, not a loan sanction letter. Figures depend on the data available at scoring time.</div>
<script>window.onload=function(){setTimeout(function(){window.print()},400)}</script></body></html>`;

    const w = window.open("", "_blank");
    if (!w) {
      const blob = new Blob([html], { type: "text/html" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `LRS-Report-${(applicant?.loanId || applicationId).slice(0, 24)}.html`;
      a.click(); URL.revokeObjectURL(a.href);
      toast.success("Report downloaded (popup blocked — open the file to print/save as PDF)");
      return;
    }
    w.document.open(); w.document.write(html); w.document.close();
  }, [q.data, applicant, applicationId]);

  const Card = ({ children }: { children: React.ReactNode }) => (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-colors dark:border-gray-700/50 dark:bg-dark-card dark:shadow-gray-900/30">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-indigo-600" />
          <h3 className="font-semibold text-gray-900 dark:text-white">LRS Credit Assessment</h3>
        </div>
        <div className="flex items-center gap-2">
          {q.data?.status === "scored" && (
            <button
              onClick={downloadReport}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <Download className="h-3 w-3" />
              Report
            </button>
          )}
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
  // Keep the headline ROI/EMI consistent with the tenure table: source them from
  // the offer option matching the recommended tenure (that row carries the
  // tenure-based ROI premium). Fall back to the stored figures for old scores.
  const recOpt = (data.offer_options?.options || []).find(
    (o: any) => o.tenure_months === data.recommended_tenure_m
  );
  const headlineRoi = recOpt?.interest_rate ?? data.interest_rate;
  const headlineEmi = recOpt?.emi ?? data.recommended_emi;
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
          ["EMI", formatCurrency(headlineEmi || 0)],
          ["Interest", `${headlineRoi}%`],
        ].map(([label, val]) => (
          <div key={label} className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-gray-800/50">
            <div className="text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
            <div className="mt-0.5 text-sm font-semibold text-gray-900 dark:text-white">{val}</div>
          </div>
        ))}
      </div>

      {/* Max eligible + Bajaj-style tenure options */}
      {data.offer_options?.options?.length > 0 && (
        <div className="mt-5 border-t border-slate-100 pt-4 dark:border-gray-700/50">
          <div className="mb-3 flex items-end justify-between">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Loan Offer</div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">Eligible up to</div>
              <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                {formatCurrency(data.offer_options.max_eligible_amount ?? data.max_eligible_amount ?? 0)}
              </div>
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-100 dark:border-gray-700/60">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-400 dark:bg-gray-800/50">
                  <th className="px-3 py-2 font-medium">Tenure</th>
                  <th className="px-3 py-2 text-right font-medium">Interest</th>
                  <th className="px-3 py-2 text-right font-medium">Loan Amount</th>
                  <th className="px-3 py-2 text-right font-medium">Monthly EMI</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-gray-700/50">
                {data.offer_options.options.map((o: any) => (
                  <tr key={o.tenure_months} className="text-gray-700 dark:text-gray-300">
                    <td className="px-3 py-2 font-medium">{o.tenure_months} months</td>
                    <td className="px-3 py-2 text-right">{o.interest_rate}%</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(o.recommended_amount)}</td>
                    <td className="px-3 py-2 text-right font-semibold text-gray-900 dark:text-white">{formatCurrency(o.emi)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[10px] text-slate-400">
            Longer tenure → lower EMI, slightly higher interest.
            {data.offer_options.foir_used != null && ` FOIR ${Math.round(data.offer_options.foir_used * 100)}% of net income.`}
          </p>
        </div>
      )}

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
