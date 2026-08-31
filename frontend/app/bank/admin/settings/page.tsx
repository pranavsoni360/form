"use client";

// Bank admin — settings (design_handoff_finix §5). Its whole job is making
// "yours vs ours" obvious: four editable cards (◆) on surface2, and one
// read-only "Managed by Virtual Galaxy" section (◇) on the page background with
// a borderStrong ring. A dirty-state save bar appears only when something
// changed. Empty / loading / error states shipped.

import * as React from "react";
import { BankAdminShell } from "../shell";
import {
  Toolbar,
  Breadcrumb,
  PageTitle,
  Card,
  CardHeader,
  CardBody,
  Toggle,
  Button,
  Pill,
  LoadingState,
  ErrorState,
  formatINR,
  formatDate,
} from "@/components/finix";
import {
  getSettings,
  saveSettings,
  requestChange,
  listChangeRequests,
  type SettingsResponse,
  type EditableSettings,
  type SettingsPatch,
  type ChangeRequestRow,
} from "@/lib/api/bankAdmin";

export default function SettingsPage() {
  const [data, setData] = React.useState<SettingsResponse | null>(null);
  const [draft, setDraft] = React.useState<EditableSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  // Bumped when a change request is filed so the list below re-fetches (BAD-11).
  const [crNonce, setCrNonce] = React.useState(0);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    getSettings()
      .then((d) => {
        setData(d);
        setDraft(d.editable);
      })
      .catch((e) => setError(e?.message || "Could not load settings."))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(load, [load]);

  // Compute the dirty diff against the loaded baseline.
  const dirty: SettingsPatch = React.useMemo(() => {
    if (!data || !draft) return {};
    const base = data.editable;
    const out: any = {};
    (Object.keys(base) as (keyof EditableSettings)[]).forEach((k) => {
      if (k === "updated_at" || k === "updated_by_name" || k === "bank_id") return;
      if (JSON.stringify(draft[k]) !== JSON.stringify(base[k])) out[k] = draft[k];
    });
    return out;
  }, [data, draft]);
  const dirtyCount = Object.keys(dirty).length;

  function set<K extends keyof EditableSettings>(key: K, val: EditableSettings[K]) {
    setDraft((d) => (d ? { ...d, [key]: val } : d));
  }

  async function save() {
    setSaving(true);
    try {
      const updated = await saveSettings(dirty);
      setData(updated);
      setDraft(updated.editable);
    } catch (e: any) {
      alert(e?.message || "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (data) setDraft(data.editable);
  }

  return (
    <BankAdminShell>
      <Toolbar left={<Breadcrumb>settings</Breadcrumb>} />
      <PageTitle
        title="Settings"
        subtitle="Four sections are yours to change. One is set by Virtual Galaxy under your contract. Every change is written to the activity log with your name and the time."
      />

      {loading ? (
        <Card><LoadingState label="Loading settings…" rows={5} /></Card>
      ) : error || !data || !draft ? (
        <Card><ErrorState title="Could not load settings" detail={error || undefined} onRetry={load} /></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <CallingCard draft={draft} set={set} changed={data} />
            <WorkflowCard draft={draft} set={set} changed={data} />
            <ScorecardCard draft={draft} set={set} changed={data} version={data.scorecard_version} />
            <NotificationsCard draft={draft} changed={data} />
          </div>

          <ManagedSection managed={data.managed} onFiled={() => setCrNonce((n) => n + 1)} />
          <ChangeRequestsList refreshKey={crNonce} />
        </>
      )}

      {dirtyCount > 0 && data && (
        <SaveBar
          count={dirtyCount}
          who={data.editable.updated_by_name}
          saving={saving}
          onSave={save}
          onDiscard={discard}
        />
      )}
    </BankAdminShell>
  );
}

// ── editable card header helper ──────────────────────────────────────────────
function OwnedHeader({ title, changedAt, changedBy }: { title: string; changedAt: string | null; changedBy: string | null }) {
  return (
    <CardHeader
      title={
        <span className="inline-flex items-center gap-1.5">
          <span style={{ color: "var(--fx-accent)" }}>◆</span> {title}
        </span>
      }
      qualifier={changedAt ? `changed ${formatDate(changedAt)}${changedBy ? ` by ${changedBy}` : ""}` : "not changed yet"}
    />
  );
}

type CardProps = {
  draft: EditableSettings;
  set: <K extends keyof EditableSettings>(k: K, v: EditableSettings[K]) => void;
  changed: SettingsResponse;
};

function Row({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-[13px] text-fx-text">{label}</div>
        {note && <div className="mt-0.5 text-[11px] text-fx-text3">{note}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const numInput =
  "w-[110px] rounded-[10px] bg-fx-surface2 px-2.5 py-1.5 text-right text-[13px] fx-mono text-fx-text outline-none focus:shadow-[inset_0_0_0_1px_var(--fx-accent)]";
const timeInput =
  "w-[80px] rounded-[10px] bg-fx-surface2 px-2.5 py-1.5 text-center text-[13px] fx-mono text-fx-text outline-none focus:shadow-[inset_0_0_0_1px_var(--fx-accent)]";

// 1. Calling
function CallingCard({ draft, set, changed }: CardProps) {
  return (
    <Card>
      <OwnedHeader title="Calling" changedAt={changed.changed_at} changedBy={changed.changed_by} />
      <CardBody className="divide-y divide-fx-border">
        <Row label="Calling window" note="Calls are barred before 08:00 and after 19:00 (RBI).">
          <div className="flex items-center gap-1.5">
            <input className={timeInput} value={draft.calling_window_start} onChange={(e) => set("calling_window_start", e.target.value)} />
            <span className="text-fx-text3">–</span>
            <input className={timeInput} value={draft.calling_window_end} onChange={(e) => set("calling_window_end", e.target.value)} />
          </div>
        </Row>
        <Row label="Max retries per borrower per day">
          <input type="number" className={numInput} value={draft.max_retries_per_day} onChange={(e) => set("max_retries_per_day", Number(e.target.value))} />
        </Row>
        <Row label="Caller ID pool">
          <input className={numInput + " text-left w-[150px]"} value={draft.caller_id_pool ?? ""} placeholder="default pool" onChange={(e) => set("caller_id_pool", e.target.value)} />
        </Row>
        <Row label="Pause all outbound calling" note="This bank only. Live calls finish; queued calls wait.">
          <Toggle checked={draft.pause_outbound} onChange={(v) => set("pause_outbound", v)} label="Pause outbound" />
        </Row>
      </CardBody>
    </Card>
  );
}

// 2. Workflow
function WorkflowCard({ draft, set, changed }: CardProps) {
  return (
    <Card>
      <OwnedHeader title="Workflow" changedAt={changed.changed_at} changedBy={changed.changed_by} />
      <CardBody className="divide-y divide-fx-border">
        <Row label="Second approver required above" note="Applies to sanction, not disbursal.">
          <div className="flex items-center gap-1.5">
            <span className="text-fx-text3">₹</span>
            <input type="number" className={numInput} value={draft.second_approver_threshold} onChange={(e) => set("second_approver_threshold", Number(e.target.value))} />
          </div>
        </Row>
        <Row label="Maker and checker must differ" note="Blocks self-approval, even for admins.">
          <Toggle checked={draft.maker_checker_differ} onChange={(v) => set("maker_checker_differ", v)} label="Maker checker differ" />
        </Row>
        <Row label="Branch scoping" note="Officers see only their branch's files.">
          <Toggle checked={draft.branch_scoping} onChange={(v) => set("branch_scoping", v)} label="Branch scoping" />
        </Row>
      </CardBody>
    </Card>
  );
}

// 3. Scorecard
function ScorecardCard({ draft, set, changed, version }: CardProps & { version: { updated_at: string | null } | null }) {
  return (
    <Card>
      <OwnedHeader title="Scorecard" changedAt={changed.changed_at} changedBy={changed.changed_by} />
      <CardBody className="divide-y divide-fx-border">
        <Row label="Auto-approve at score" note="Out of 100.">
          <input type="number" className={numInput} value={draft.auto_approve_score} onChange={(e) => set("auto_approve_score", Number(e.target.value))} />
        </Row>
        <Row label="Weight changes need a second admin's approval">
          <Toggle checked={draft.weight_change_needs_approval} onChange={(v) => set("weight_change_needs_approval", v)} label="Weight change approval" />
        </Row>
        <Row
          label="Active scorecard"
          note={version?.updated_at ? `last published ${formatDate(version.updated_at)}` : "shared across the bank"}
        >
          <a href="/bank/scorecard" className="text-[12px]" style={{ color: "var(--fx-accent)" }}>Edit weights</a>
        </Row>
      </CardBody>
    </Card>
  );
}

// 4. Notifications — read-only table for now (event → template → recipients).
function NotificationsCard({ draft, changed }: { draft: EditableSettings; changed: SettingsResponse }) {
  const rows = draft.notifications || [];
  return (
    <Card>
      <OwnedHeader title="Notifications" changedAt={changed.changed_at} changedBy={changed.changed_by} />
      <CardBody>
        {rows.length ? (
          <table className="w-full">
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-fx-border text-[12px] last:border-0">
                  <td className="py-2 text-fx-text">{r.event}</td>
                  <td className="py-2 text-center">
                    {r.template ? (
                      <span className="fx-mono rounded-full px-[9px] py-0.5 text-[11.5px]" style={{ background: "var(--fx-accent-tint)", color: "var(--fx-accent)" }}>{r.template}</span>
                    ) : (
                      <Pill tone="neutral" dot={false}>unmapped</Pill>
                    )}
                  </td>
                  <td className="py-2 text-right text-fx-text2">{r.recipients}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="py-2 text-[12px] text-fx-text3">No notification templates mapped yet.</p>
        )}
        <p className="mt-3 text-[11px] text-fx-text3">Quiet hours 21:00–08:00 hold messages; opt-outs are honoured.</p>
      </CardBody>
    </Card>
  );
}

// ── Managed by Virtual Galaxy (read-only, ◇) ─────────────────────────────────
function ManagedSection({ managed, onFiled }: { managed: SettingsResponse["managed"]; onFiled?: () => void }) {
  const [reqItem, setReqItem] = React.useState<string | null>(null);

  const items = [
    { label: "Call recording retention", value: `${managed.recording_retention_days} days`, why: "Set by your contract line item." },
    { label: "PII redaction", value: managed.pii_redaction ? "On" : "Off", why: "RBI outsourcing guidance — cannot be turned off." },
    { label: "Seat cap", value: String(managed.seat_cap), why: "Contract line item; raise it with your account manager." },
    { label: "Minute quota", value: `${managed.minute_quota.toLocaleString("en-IN")} / month`, why: "Contract line item." },
  ];

  return (
    <Card surface="page" ring="strong" className="p-[14px]">
      <div className="mb-3 flex items-center gap-1.5">
        <span className="text-fx-text3">◇</span>
        <span className="text-[15px] font-medium text-fx-text">Managed by Virtual Galaxy</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {items.map((it) => (
          <div key={it.label} className="rounded-[10px] bg-fx-bg p-3" style={{ boxShadow: "inset 0 0 0 1px var(--fx-border)" }}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12px] text-fx-text2">{it.label}</span>
              <span className="text-[13px] text-fx-text3">{it.value}</span>
            </div>
            <div className="mt-1 text-[11px] text-fx-text3">{it.why}</div>
            <button
              type="button"
              onClick={() => setReqItem(it.label)}
              className="mt-2 text-[11px]"
              style={{ color: "var(--fx-accent)" }}
            >
              Request a change
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 text-[11px] text-fx-text3">Account manager: {managed.account_manager}</div>

      {reqItem && <ChangeRequestModal item={reqItem} onClose={() => setReqItem(null)} onFiled={onFiled} />}
    </Card>
  );
}

function ChangeRequestModal({ item, onClose, onFiled }: { item: string; onClose: () => void; onFiled?: () => void }) {
  const [msg, setMsg] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  async function go() {
    setBusy(true);
    try {
      await requestChange(item, msg || undefined);
      setDone(true);
      onFiled?.();  // refresh the change-requests list (BAD-11)
    } catch (e: any) {
      alert(e?.message || "Could not file the request.");
      setBusy(false);
    }
  }
  // Lightweight inline modal (reusing overlay styling would pull the shell's
  // Modal; a small fixed panel is enough here).
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "oklch(0.1 0.02 265 / 0.5)" }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="finix-root w-full max-w-[460px] rounded-[18px] bg-fx-surface p-5" style={{ boxShadow: "var(--fx-elevation)" }}>
        <div className="text-[15px] font-medium text-fx-text">Request a change · {item}</div>
        {done ? (
          <>
            <p className="mt-2 text-[12px] text-fx-text2">Your request has been sent to your Virtual Galaxy account manager.</p>
            <div className="mt-4 flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
          </>
        ) : (
          <>
            <p className="mt-1 text-[12px] text-fx-text2">Tell your account manager what you need. This does not change the setting automatically.</p>
            <textarea
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              rows={4}
              placeholder={`e.g. Please raise our seat cap to 25.`}
              className="mt-3 w-full rounded-[10px] bg-fx-surface2 p-3 text-[13px] text-fx-text outline-none placeholder:text-fx-text3 focus:shadow-[inset_0_0_0_1px_var(--fx-accent)]"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="quiet" onClick={onClose}>Cancel</Button>
              <Button variant="primary" onClick={go} disabled={busy}>{busy ? "Sending…" : "Send request"}</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── change requests (BAD-11): show what was filed and its state ──────────────
function ChangeRequestsList({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = React.useState<ChangeRequestRow[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    listChangeRequests()
      .then((d) => { if (live) { setRows(d.change_requests); setErr(null); } })
      .catch((e) => { if (live) setErr(e?.message || "Could not load your change requests."); });
    return () => { live = false; };
  }, [refreshKey]);

  const tone = (s: ChangeRequestRow["status"]) =>
    s === "resolved" ? "green" : s === "declined" ? "red" : "amber";
  const label = (s: ChangeRequestRow["status"]) =>
    s === "resolved" ? "Resolved" : s === "declined" ? "Declined" : "Open";

  return (
    <Card className="mt-3">
      <CardHeader title="Your change requests" qualifier="requests to Virtual Galaxy · newest first" />
      <CardBody>
        {err ? (
          <p className="py-2 text-[12px]" style={{ color: "var(--fx-red)" }}>{err}</p>
        ) : rows === null ? (
          <p className="py-2 text-[12px] text-fx-text3">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="py-2 text-[12px] text-fx-text3">
            No change requests yet. Use “Request a change” on a managed setting above to file one.
          </p>
        ) : (
          <div className="divide-y divide-fx-border">
            {rows.map((r) => (
              <div key={r.id} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px] text-fx-text">{r.item}</div>
                  {r.message && <div className="mt-0.5 text-[12px] text-fx-text2">{r.message}</div>}
                  <div className="mt-1 text-[11px] text-fx-text3">
                    {r.requested_by_name ? `${r.requested_by_name} · ` : ""}{formatDate(r.created_at)}
                  </div>
                </div>
                <Pill tone={tone(r.status)}>{label(r.status)}</Pill>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ── dirty save bar ───────────────────────────────────────────────────────────
function SaveBar({ count, who, saving, onSave, onDiscard }: { count: number; who: string | null; saving: boolean; onSave: () => void; onDiscard: () => void }) {
  const now = new Date();
  return (
    <div className="sticky bottom-3 z-30 mt-2">
      <div className="flex items-center gap-3 rounded-[14px] bg-fx-surface2 px-4 py-3" style={{ boxShadow: "var(--fx-elevation)" }}>
        <span className="text-[12px] text-fx-text2">
          {count} unsaved change{count === 1 ? "" : "s"} · will be recorded to the activity log as {who || "you"}, {formatDate(now)} {now.getHours().toString().padStart(2, "0")}:{now.getMinutes().toString().padStart(2, "0")}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="quiet" onClick={onDiscard}>Discard</Button>
          <Button variant="primary" onClick={onSave} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
        </div>
      </div>
    </div>
  );
}
