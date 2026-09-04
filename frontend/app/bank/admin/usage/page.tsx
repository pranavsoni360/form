"use client";

// Bank admin — usage & call statistics (design_handoff_finix §4). Quota panel
// with projection, credit card, metrics, call-outcomes segmented bar + legend,
// calls per branch (Decision B), paginated call log with Form/Rec columns, and
// the quota-exceeded screen state (derived when consumed >= quota).

import * as React from "react";
import { BankAdminShell } from "../shell";
import {
  PeriodChip,
  PageTitle,
  MetricCard,
  DeltaChip,
  Card,
  CardHeader,
  CardBody,
  Bar,
  SegmentedBar,
  RankBarList,
  Table,
  TwoLine,
  CallStatusPill,
  CallLegend,
  FormSentMark,
  callStatusMeta,
  Button,
  Modal,
  OverlayHeader,
  Field,
  EmptyState,
  LoadingState,
  ErrorState,
  formatINR,
  formatDuration,
  formatDateTime,
  formatPct,
  type Column,
  type Segment,
} from "@/components/finix";
import {
  getQuota,
  getUsageSummary,
  getByBranch,
  getUsageCalls,
  exportUsageCsv,
  type QuotaInfo,
  type UsageSummary,
  type BranchStat,
  type UsageCall,
  createChangeRequest,
} from "@/lib/api/bankAdmin";

const OUTCOME_TONE: Record<string, Segment["tone"] | "neutral"> = {
  "Called - Interested": "green",
  "Called - Callback Requested": "amber",
  "Wrong Contact": "orange",
  "Invalid Phone": "amber",
  Failed: "red",
  "Call Not Connected": "red",
};

export default function UsagePage() {
  const [quotaOpen, setQuotaOpen] = React.useState(false);
  const [quota, setQuota] = React.useState<QuotaInfo | null>(null);
  const [summary, setSummary] = React.useState<UsageSummary | null>(null);
  const [branches, setBranches] = React.useState<BranchStat[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [calls, setCalls] = React.useState<UsageCall[]>([]);
  const [callsMeta, setCallsMeta] = React.useState({ page: 1, total_pages: 1, total: 0 });
  const [callsLoading, setCallsLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([getQuota(), getUsageSummary(), getByBranch()])
      .then(([q, s, b]) => {
        setQuota(q);
        setSummary(s);
        setBranches(b.branches);
      })
      .catch((e) => setError(e?.message || "Could not load usage."))
      .finally(() => setLoading(false));
  }, []);

  const loadCalls = React.useCallback((page: number) => {
    setCallsLoading(true);
    getUsageCalls(page)
      .then((r) => {
        setCalls(r.calls);
        setCallsMeta({ page: r.page, total_pages: r.total_pages, total: r.total });
      })
      .catch(() => setCalls([]))
      .finally(() => setCallsLoading(false));
  }, []);

  React.useEffect(load, [load]);
  React.useEffect(() => loadCalls(1), [loadCalls]);

  const exceeded = quota?.exceeded ?? false;

  async function doExport() {
    try {
      const { blob, filename } = await exportUsageCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(e?.message || "Export failed");
    }
  }

  const outcomeSegments: Segment[] = (summary?.outcomes || []).map((o) => {
    const tone = OUTCOME_TONE[o.status];
    return { label: callStatusMeta(o.status).label, value: o.count, ...(tone === "neutral" || !tone ? { neutral: true } : { tone }) };
  });

  const callCols: Column<UsageCall>[] = [
    { key: "when", header: "When", render: (c) => <span className="fx-mono text-fx-text2">{formatDateTime(c.started_at || c.created_at)}</span> },
    { key: "cust", header: "Applicant", render: (c) => <TwoLine primary={c.customer_name || "Unknown"} secondary={<span className="fx-mono">{c.phone}</span>} /> },
    { key: "dur", header: "Duration", align: "right", render: (c) => <span className="fx-mono">{formatDuration(c.call_duration)}</span> },
    { key: "outcome", header: "Outcome", render: (c) => <CallStatusPill status={c.status} /> },
    { key: "result", header: "Result", render: (c) => <span className="text-fx-text2">{c.category || "—"}</span> },
    { key: "form", header: "Form", align: "center", width: 60, render: (c) => <FormSentMark sent={c.form_sent} /> },
    { key: "rec", header: "Rec", align: "center", width: 50, render: (c) => (c.recording_url ? <span style={{ color: "var(--fx-green)" }}>◉</span> : <span className="text-fx-text3">–</span>) },
  ];

  return (
    <BankAdminShell headerActions={<Button variant="primary" onClick={doExport}>Export CSV</Button>}>
      <div className="flex items-center gap-2 mb-1">
        <PeriodChip>{quota ? `${quota.period.from} – ${quota.period.to}` : "This month"}</PeriodChip>
      </div>
      <PageTitle title="Usage and call statistics" subtitle="Minutes, connect rate and call outcomes for your bank this period." />

      {loading ? (
        <Card><LoadingState label="Loading usage…" rows={5} /></Card>
      ) : error ? (
        <Card><ErrorState title="Could not load usage" detail={error} onRetry={load} /></Card>
      ) : (
        <>
          {exceeded && <QuotaExceededBanner quota={quota!} onRequestIncrease={() => setQuotaOpen(true)} />}

          {/* Quota + credit */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2.4fr_1fr]">
            <QuotaPanel quota={quota!} />
            <CreditCard quota={quota!} />
          </div>

          {/* Metrics */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="Calls placed" value={(summary?.calls_placed ?? 0).toLocaleString("en-IN")} note="this period" />
            <MetricCard label="Connect rate" value={formatPct(summary?.connect_rate ?? 0)} note="answered ÷ placed" />
            <MetricCard label="Average duration" value={<span className="fx-mono">{formatDuration(summary?.avg_duration_sec ?? 0)}</span>} note="per answered call" />
            <MetricCard label="Promise to pay" value={(summary?.promise_to_pay ?? 0).toLocaleString("en-IN")} note="callbacks requested" />
          </div>

          {/* Outcomes + branches */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader title="Call outcomes" qualifier={`${(summary?.calls_placed ?? 0).toLocaleString("en-IN")} calls`} />
              <CardBody className="space-y-3">
                {summary && summary.calls_placed > 0 ? (
                  <>
                    <SegmentedBar segments={outcomeSegments} />
                    <table className="w-full">
                      <tbody>
                        {summary.outcomes.map((o) => (
                          <tr key={o.status} className="text-[12px]">
                            <td className="py-1"><CallStatusPill status={o.status} /></td>
                            <td className="py-1 text-right fx-mono text-fx-text2">{o.count.toLocaleString("en-IN")}</td>
                            <td className="py-1 pl-3 text-right fx-mono text-fx-text3">{formatPct((o.count / summary.calls_placed) * 100)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="text-[11px] text-fx-text3">Invalid numbers are sent back to the branch for correction; failed calls are not billed.</p>
                  </>
                ) : (
                  <EmptyState title="No calls this period" description="Outcomes appear once calls are placed." />
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Calls per branch" />
              <CardBody>
                {branches.length ? (
                  <RankBarList items={branches.map((b) => ({
                    label: b.branch,
                    value: b.calls,
                    meta: `${b.calls.toLocaleString("en-IN")} calls · ${b.minutes.toLocaleString("en-IN")} min · ${b.connect_rate}% connected`,
                  }))} />
                ) : (
                  <EmptyState title="No branch activity" description="Calls attribute to a branch via the batch uploader." />
                )}
              </CardBody>
            </Card>
          </div>

          {/* Call log */}
          <Card>
            <CardHeader title="Call log" qualifier={callsMeta.total ? `${callsMeta.total.toLocaleString("en-IN")} calls` : undefined} />
            {callsLoading ? (
              <LoadingState label="Loading calls…" rows={6} />
            ) : calls.length === 0 ? (
              <EmptyState title="No calls yet" description="Calls placed this period will appear here." />
            ) : (
              <>
                <Table columns={callCols} rows={calls} rowKey={(c) => c.id} />
                <div className="flex items-center justify-between px-[14px] py-3">
                  <span className="text-[11px] text-fx-text3">
                    {((callsMeta.page - 1) * 10 + 1).toLocaleString("en-IN")}–{Math.min(callsMeta.page * 10, callsMeta.total).toLocaleString("en-IN")} of {callsMeta.total.toLocaleString("en-IN")} calls
                  </span>
                  <div className="flex items-center gap-1.5">
                    {Array.from({ length: Math.min(callsMeta.total_pages, 7) }).map((_, i) => {
                      const pageNo = i + 1;
                      const active = pageNo === callsMeta.page;
                      return (
                        <button
                          key={pageNo}
                          onClick={() => loadCalls(pageNo)}
                          className="fx-mono grid h-[26px] min-w-[26px] place-items-center rounded-[8px] px-1.5 text-[12px]"
                          style={active ? { background: "var(--fx-accent-grad)", color: "#fff" } : { background: "var(--fx-surface2)", color: "var(--fx-text2)" }}
                        >
                          {pageNo}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <CallLegend />
              </>
            )}
          </Card>
        </>
      )}
      {quotaOpen && (
        <QuotaRequestModal
          consumed={quota?.consumed ?? 0}
          quotaMinutes={quota?.quota ?? 0}
          onClose={() => setQuotaOpen(false)}
        />
      )}
    </BankAdminShell>
  );
}

// ── quota panel ──────────────────────────────────────────────────────────────
function QuotaPanel({ quota }: { quota: QuotaInfo }) {
  const exceeded = quota.exceeded;
  const projText = quota.projection
    ? `At the current rate — ${quota.rate_per_day.toLocaleString("en-IN")} minute${quota.rate_per_day === 1 ? "" : "s"} a day over the last 7 days — you will reach the quota around ${quota.projection.date}, ${quota.projection.days_before_end} day${quota.projection.days_before_end === 1 ? "" : "s"} before the period ends.`
    : quota.rate_per_day > 0
      ? `At the current rate — ${quota.rate_per_day.toLocaleString("en-IN")} minute${quota.rate_per_day === 1 ? "" : "s"} a day — you are on track to stay within the quota this period.`
      : "No calls in the last 7 days, so there is no run rate to project from.";

  return (
    <Card ring={exceeded ? "red" : "none"} className="p-[14px]">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-fx-text3">Minutes consumed</span>
        <span className="text-[11px] text-fx-text3">{quota.days_remaining} days remaining · {quota.days_elapsed} of {quota.days_total} elapsed</span>
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-[26px] font-medium leading-none text-fx-text" style={{ letterSpacing: "-0.02em" }}>
          {quota.consumed.toLocaleString("en-IN")}
        </span>
        <span className="text-[12px] text-fx-text2">of {quota.quota.toLocaleString("en-IN")}</span>
      </div>
      <div className="mt-3">
        {exceeded ? (
          <Bar value={1} height={10} tone="red" />
        ) : (
          <QuotaBar fraction={quota.fraction} pace={quota.pace_fraction} />
        )}
      </div>
      <p className="mt-3 text-[12px] text-fx-text2">{projText}</p>
    </Card>
  );
}

// Accent→amber gradient bar with a soft glow + a pace tick.
function QuotaBar({ fraction, pace }: { fraction: number; pace: number }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className="relative h-[10px] w-full overflow-hidden rounded-full" style={{ background: "var(--fx-border)" }}>
      <div
        className="h-full rounded-full"
        style={{ width: `${pct}%`, background: "linear-gradient(90deg, var(--fx-accent), var(--fx-amber))", boxShadow: "0 0 10px oklch(0.78 0.13 75 / 0.4)" }}
      />
      <div className="absolute top-0 h-full w-px" style={{ left: `${Math.max(0, Math.min(1, pace)) * 100}%`, background: "var(--fx-border-strong)" }} />
    </div>
  );
}

function CreditCard({ quota }: { quota: QuotaInfo }) {
  const belowFloor = quota.credit_balance < quota.credit_floor;
  return (
    <Card ring={belowFloor ? "amber" : "none"} className="p-[14px]">
      <div className="text-[11px] text-fx-text3">Credit balance</div>
      <div className="mt-1 text-[26px] font-medium leading-none" style={{ letterSpacing: "-0.02em", color: belowFloor ? "var(--fx-amber)" : "var(--fx-text)" }}>
        {formatINR(quota.credit_balance)}
      </div>
      <div className="mt-2 text-[11px] text-fx-text3">
        {belowFloor
          ? `Below the ${formatINR(quota.credit_floor)} floor · top-up recommended`
          : "Covers this period at the current rate"}
      </div>
    </Card>
  );
}

// ── quota-exceeded banner ────────────────────────────────────────────────────
function QuotaExceededBanner({ quota, onRequestIncrease }: { quota: QuotaInfo; onRequestIncrease: () => void }) {
  return (
    <div className="rounded-[14px] p-4" style={{ background: "var(--fx-red-tint)", boxShadow: "inset 0 0 0 1px var(--fx-red)" }}>
      <div className="text-[15px] font-medium" style={{ color: "var(--fx-red)" }}>
        Minute quota exceeded — outbound calling halted
      </div>
      <p className="mt-1 max-w-3xl text-[12px] text-fx-text2">
        {quota.quota.toLocaleString("en-IN")} of {quota.quota.toLocaleString("en-IN")} minutes used. Campaigns are paused and scheduled calls are waiting; inbound is unaffected. Overage billing is off, so calling resumes only on a quota raise or the next period rollover.
      </p>
      {/* No "View paused campaigns" button: there is no such view a bank ADMIN
          can reach. Batches live at /bank/batch, and BankUserShell bounces a
          bank_admin off that route back to /bank/admin/users, so the button
          could only ever bounce or 404. The paragraph above already states
          that campaigns are paused. */}
      <div className="mt-3 flex gap-2">
        <Button variant="danger" onClick={onRequestIncrease}>Request quota increase</Button>
      </div>
    </div>
  );
}

// ── Request a quota increase ─────────────────────────────────────────────────
// Seat cap, minute quota and retention are set by Virtual Galaxy under the
// bank's contract, so this cannot be self-served. It files a change request
// against the named item; VG applies it. The dialog says so plainly rather than
// implying the change takes effect on save.
function QuotaRequestModal({
  consumed,
  quotaMinutes,
  onClose,
}: {
  consumed: number;
  quotaMinutes: number;
  onClose: () => void;
}) {
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await createChangeRequest(
        "minute_quota",
        message.trim() ||
          `Quota exhausted: ${consumed} of ${quotaMinutes} minutes consumed. Requesting an increase.`,
      );
      setSent(true);
    } catch (e: any) {
      setErr(e?.message || "Could not file the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} width={460}>
      <OverlayHeader
        title="Request quota increase"
        subtitle="Virtual Galaxy sets the minute quota under your contract, so this is a request — not an immediate change."
        onClose={onClose}
      />
      {sent ? (
        <div className="p-5">
          <div
            className="rounded-[14px] p-4"
            style={{ background: "var(--fx-green-tint)", boxShadow: "inset 0 0 0 1px var(--fx-green)" }}
          >
            <div className="text-[13px] font-medium" style={{ color: "var(--fx-green)" }}>
              ✓ Request filed
            </div>
            <p className="mt-1 text-[12px] text-fx-text2">
              Virtual Galaxy has been notified. Calling stays halted until the quota is raised.
            </p>
          </div>
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-5">
          <div className="rounded-[10px] px-3 py-2.5 text-[12px]" style={{ background: "var(--fx-surface2)" }}>
            <span className="text-fx-text2">Consumed</span>{" "}
            <span className="fx-mono text-fx-text">{consumed.toLocaleString("en-IN")}</span>{" "}
            <span className="text-fx-text3">of</span>{" "}
            <span className="fx-mono text-fx-text">{quotaMinutes.toLocaleString("en-IN")}</span>{" "}
            <span className="text-fx-text3">minutes</span>
          </div>
          <Field label="Message" hint="Optional. Include how many extra minutes you need and by when.">
            <textarea
              rows={4}
              className="w-full rounded-[10px] bg-fx-surface2 px-3 py-2 text-[13px] text-fx-text outline-none placeholder:text-fx-text3 focus:shadow-[inset_0_0_0_1px_var(--fx-accent)]"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="We need another 50,000 minutes for the festive campaign starting 1 Sep."
            />
          </Field>
          {err && <p className="text-[12px]" style={{ color: "var(--fx-red)" }}>{err}</p>}
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="quiet" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={busy}>
              {busy ? "Filing…" : "File request"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
