"use client";

// Bank Statement Analysis panel — application detail page, officer-facing.
//
// WHY IT LOOKS LIKE A LIFECYCLE AND NOT A RESULT
// This is not a synchronous lookup. The officer issues an upload link, the
// borrower leaves and uploads a PDF at Digitap, and the analysed report arrives
// minutes-to-hours later. So the panel's job is to make the WAIT legible: whose
// turn it is, when the link dies, and what to do when nothing happens.
//
// THE FAILURE THAT LEAVES NO TRACE
// If a borrower uploads a statement from the wrong bank, Digitap rejects it
// inside their own UI (error 065). No callback fires and statuscheck keeps
// saying TxnNotFound, so the journey looks identical to "hasn't started yet"
// until the link expires. That is why the pending state names the expiry and
// offers Refresh — an officer must never be left guessing whether a silent hour
// means working or broken.
//
// COVERAGE IS SHOWN, NOT HIDDEN
// The derivation deliberately withholds inputs the statement cannot support, so
// the panel reports what was and was not derived. An officer reading a partial
// score needs to know it is partial: "we could not tell" and "healthy" must not
// look the same.

import * as React from "react";
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Field,
  Select,
  Pill,
  LoadingState,
  EmptyState,
} from "@/components/finix";
import {
  bsaInstitutions,
  bsaListFetches,
  bsaStartFetch,
  bsaAdvance,
  type BsaFetch,
  type BsaInstitution,
} from "@/lib/api/bank";

/** Human labels for the scorecard keys the derivation emits. */
const METRIC_LABEL: Record<string, string> = {
  net_cash_flow: "Net monthly cash flow",
  surplus_income_ratio: "Surplus vs income",
  otp_ratio_pct: "On-time payments",
  missed_payment_ratio: "Missed payments",
  penalty_count: "Cheque bounces",
  amb_pct_of_nmi: "Avg balance vs income",
  net_monthly_income: "Detected monthly income",
  employment_type: "Employment type",
};

/** Why an input could not be derived — plain language, not the raw key. */
const MISSING_REASON: Record<string, string> = {
  otp_ratio_pct: "The statement shows payments made but not payments due.",
  missed_payment_ratio: "The statement shows payments made but not payments due.",
  net_monthly_income_not_detected: "No salary credits were detected.",
  employment_type_unsupported_by_salary_data: "Employment type was reported without salary evidence to support it.",
  amb_pct_of_nmi: "Needs detected income, which this statement did not show.",
  surplus_income_ratio: "Needs detected income, which this statement did not show.",
  net_cash_flow: "Credit/debit totals were not present.",
  penalty_count: "Bounce counts were not present.",
};

const STATUS_TONE: Record<string, "green" | "amber" | "red" | "accent" | "neutral"> = {
  completed: "green",
  processing: "accent",
  pending: "amber",
  failed: "red",
  expired: "neutral",
};

function fmtMetric(key: string, value: number | string): string {
  if (typeof value === "string") return value.replace(/_/g, " ");
  if (key.endsWith("_pct") || key.endsWith("_ratio")) return `${value}%`;
  if (key === "net_cash_flow" || key === "net_monthly_income") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency", currency: "INR", maximumFractionDigits: 0,
    }).format(value);
  }
  return String(value);
}

function expiryLabel(iso?: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  return h >= 1 ? `expires in ${h}h` : `expires in ${Math.max(1, Math.round(ms / 60_000))}m`;
}

export function BankStatementPanel({ applicationId }: { applicationId: string }) {
  const [fetches, setFetches] = React.useState<BsaFetch[] | null>(null);
  const [institutions, setInstitutions] = React.useState<BsaInstitution[]>([]);
  const [institutionId, setInstitutionId] = React.useState("");
  const [months, setMonths] = React.useState("6");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const load = React.useCallback(() => {
    bsaListFetches(applicationId)
      .then((r) => setFetches(r.fetches ?? []))
      .catch((e: any) => setErr(e?.message || "Could not load bank statement fetches."));
  }, [applicationId]);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    bsaInstitutions()
      .then((r) => setInstitutions(r.institutions ?? []))
      .catch(() => setInstitutions([]));
  }, []);

  const latest = fetches?.[0] ?? null;
  // Starting another journey is ALWAYS allowed. Hiding the form while one is
  // pending looked tidy but stranded the officer: a borrower who uploads a
  // statement from the wrong bank fails silently inside Digitap's UI, so the
  // journey sits `pending` for the full 24h link life with no way to issue a
  // replacement. A borrower may also legitimately need a second bank.
  // The form is collapsed by default when something is already in flight, so the
  // common case stays quiet without being a dead end.
  const inFlight = !!latest && ["pending", "processing"].includes(latest.status);
  const [showForm, setShowForm] = React.useState(false);
  const formOpen = !inFlight || showForm;

  async function start() {
    if (!institutionId) { setErr("Pick the bank that issued the statement."); return; }
    setBusy(true);
    setErr(null);
    try {
      const inst = institutions.find((i) => String(i.digitap_id) === institutionId);
      await bsaStartFetch({
        application_id: applicationId,
        institution_id: Number(institutionId),
        institution_name: inst?.name,
        months: Number(months),
      });
      load();
    } catch (e: any) {
      setErr(e?.message || "Could not create the upload link.");
    } finally {
      setBusy(false);
    }
  }

  async function refresh(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await bsaAdvance(id);
      load();
    } catch (e: any) {
      setErr(e?.message || "Could not refresh.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Bank statements"
        qualifier="feeds the cash-flow score"
        right={latest ? <Pill tone={STATUS_TONE[latest.status] ?? "neutral"}>{latest.status}</Pill> : undefined}
      />
      <CardBody className="space-y-4">
        {err && <p className="text-[12px]" style={{ color: "var(--fx-red)" }}>{err}</p>}

        {fetches === null ? (
          <LoadingState label="Loading…" rows={2} />
        ) : (
          <>
            {/* ── start a new journey ── */}
            {inFlight && !showForm && (
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="fx-tap text-[12px] transition-colors hover:underline"
                style={{ color: "var(--fx-accent)" }}
              >
                Request another statement
              </button>
            )}
            {formOpen && (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Borrower's bank"
                    htmlFor="bsa-inst"
                    hint="Must match the statement they upload, or Digitap will reject it."
                  >
                    <Select
                      id="bsa-inst"
                      value={institutionId}
                      onChange={(e) => setInstitutionId(e.target.value)}
                    >
                      <option value="">Select a bank…</option>
                      {institutions.map((i) => (
                        <option key={i.digitap_id} value={i.digitap_id}>{i.name}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Statement period" htmlFor="bsa-months">
                    <Select id="bsa-months" value={months} onChange={(e) => setMonths(e.target.value)}>
                      <option value="3">Last 3 months</option>
                      <option value="6">Last 6 months</option>
                      <option value="12">Last 12 months</option>
                    </Select>
                  </Field>
                </div>
                <Button variant="primary" onClick={start} disabled={busy || !institutions.length}>
                  {busy ? "Creating link…" : "Request bank statements"}
                </Button>
                {!institutions.length && (
                  <p className="text-[11px] text-fx-text3">
                    The bank list could not be loaded, so a link cannot be created yet.
                  </p>
                )}
              </div>
            )}

            {/* ── the journeys ── */}
            {fetches.length === 0 ? (
              <EmptyState
                title="No statement requested yet"
                description="Request one to score the borrower's cash flow from their real bank statement."
              />
            ) : (
              <div className="space-y-3">
                {fetches.map((f) => (
                  <div key={f.id} className="rounded-[10px] p-3" style={{ background: "var(--fx-bg)" }}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={STATUS_TONE[f.status] ?? "neutral"}>{f.status}</Pill>
                      <span className="text-[13px] text-fx-text">{f.institution_name || `Bank #${f.institution_id}`}</span>
                      <span className="fx-mono text-[11px] text-fx-text3">
                        {f.start_month} → {f.end_month}
                      </span>
                      {(f.status === "pending" || f.status === "processing") && (
                        <span className="ml-auto">
                          <Button variant="quiet" onClick={() => refresh(f.id)} disabled={busy}>
                            Refresh
                          </Button>
                        </span>
                      )}
                    </div>

                    {/* Waiting on the borrower. Naming the expiry matters: a
                        wrong-bank upload fails silently inside Digitap, so the
                        link lapsing is often the only signal an officer gets. */}
                    {f.status === "pending" && f.upload_url && (
                      <div className="mt-2 space-y-2">
                        <p className="text-[12px] text-fx-text2">
                          Waiting for the borrower to upload
                          {expiryLabel(f.expires_at) ? ` — link ${expiryLabel(f.expires_at)}` : ""}.
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="fx-mono flex-1 truncate rounded-[8px] px-2 py-1 text-[11px] text-fx-text2"
                                style={{ background: "var(--fx-surface2)" }}>
                            {f.upload_url}
                          </code>
                          <Button
                            variant="quiet"
                            onClick={() => {
                              navigator.clipboard?.writeText(f.upload_url!);
                              setCopied(true);
                              setTimeout(() => setCopied(false), 2000);
                            }}
                          >
                            {copied ? "Copied" : "Copy link"}
                          </Button>
                        </div>
                      </div>
                    )}

                    {(f.status === "failed" || f.status === "expired") && (
                      <p className="mt-2 text-[12px]" style={{ color: "var(--fx-red)" }}>
                        {f.vendor_message || "The statement could not be analysed."}
                        {f.vendor_code ? ` (${f.vendor_code})` : ""}
                      </p>
                    )}

                    {/* ── the result ── */}
                    {f.status === "completed" && f.metrics && (
                      <div className="mt-3 space-y-3">
                        {Object.entries(f.metrics.inputs ?? {}).length > 0 ? (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {Object.entries(f.metrics.inputs ?? {}).map(([k, v]) => (
                              <div key={k} className="flex items-baseline gap-2">
                                <span className="text-[11px] text-fx-text3">
                                  {METRIC_LABEL[k] ?? k.replace(/_/g, " ")}
                                </span>
                                <span className="fx-mono ml-auto text-[13px] text-fx-text">
                                  {fmtMetric(k, v)}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[12px]" style={{ color: "var(--fx-amber)" }}>
                            The statement was analysed but produced no usable scoring inputs.
                          </p>
                        )}

                        {/* Not an error state — a statement legitimately may not
                            evidence everything. Shown so a partial score is never
                            mistaken for a complete one. */}
                        {(f.metrics.coverage?.missing?.length ?? 0) > 0 && (
                          <div className="rounded-[8px] p-2.5" style={{ background: "var(--fx-amber-tint)" }}>
                            <div className="text-[11px]" style={{ color: "var(--fx-amber)" }}>
                              Not derivable from this statement
                            </div>
                            <ul className="mt-1 space-y-0.5">
                              {f.metrics.coverage!.missing.map((m) => (
                                <li key={m} className="text-[11px] text-fx-text2">
                                  {METRIC_LABEL[m] ?? m.replace(/_/g, " ")}
                                  {MISSING_REASON[m] ? ` — ${MISSING_REASON[m]}` : ""}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
