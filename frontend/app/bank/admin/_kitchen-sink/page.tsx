"use client";

// Finix primitives demo (Step 3 review page). Renders every primitive inside
// the real shell so both themes can be checked with the sidebar theme pill.
// Dev-only reference — NOT part of the product. Delete before ship.

import * as React from "react";
import {
  FinixShell,
  Toolbar,
  PeriodChip,
  Breadcrumb,
  PageTitle,
  FilterPills,
  MetricCard,
  DeltaChip,
  Card,
  CardHeader,
  CardBody,
  Pill,
  Button,
  Toggle,
  Table,
  TwoLine,
  RowMenu,
  Bar,
  SplitBar,
  SegmentedBar,
  RankBarList,
  Modal,
  SidePanel,
  OverlayHeader,
  EmptyState,
  LoadingState,
  ErrorState,
  CallStatusPill,
  CallLegend,
  FormSentMark,
  formatINR,
  formatDateTime,
  formatDuration,
  type Column,
} from "@/components/finix";

const NAV = [
  { href: "/bank/admin/_kitchen-sink", label: "Primitives", glyph: "◆", count: 22 },
  { href: "/bank/admin/users", label: "Users", glyph: "◎", count: 14 },
  { href: "/bank/admin/usage", label: "Usage & call statistics", glyph: "∿" },
  { href: "/bank/admin/settings", label: "Settings", glyph: "⚙" },
];

type Row = { id: string; name: string; username: string; status: string; calls: number; when: string };
const ROWS: Row[] = [
  { id: "1", name: "Anjali Pawar", username: "anjali_pawar", status: "Called - Interested", calls: 612, when: "2026-08-20T14:31:00+05:30" },
  { id: "2", name: "Ganesh Bhoyar", username: "ganesh_bhoyar", status: "Called - Callback Requested", calls: 480, when: "2026-08-20T11:02:00+05:30" },
  { id: "3", name: "Rohit Kulkarni", username: "rohit_k", status: "Wrong Contact", calls: 305, when: "2026-08-19T16:44:00+05:30" },
  { id: "4", name: "Kavita Tayde", username: "kavita_t", status: "Failed", calls: 96, when: "2026-08-19T09:15:00+05:30" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody className="space-y-4">{children}</CardBody>
    </Card>
  );
}

export default function KitchenSink() {
  const [filter, setFilter] = React.useState<"all" | "active" | "invited">("all");
  const [toggleA, setToggleA] = React.useState(true);
  const [toggleB, setToggleB] = React.useState(false);
  const [modal, setModal] = React.useState(false);
  const [panel, setPanel] = React.useState(false);

  const cols: Column<Row>[] = [
    { key: "name", header: "Name", render: (r) => <TwoLine primary={r.name} secondary={<span className="fx-mono">{r.username}</span>} /> },
    { key: "status", header: "Status", render: (r) => <CallStatusPill status={r.status} /> },
    { key: "form", header: "Form", align: "center", render: (r) => <FormSentMark sent={r.calls > 300} /> },
    { key: "calls", header: "Calls", align: "right", render: (r) => r.calls.toLocaleString("en-IN") },
    { key: "when", header: "When", align: "right", render: (r) => <span className="fx-mono text-fx-text2">{formatDateTime(r.when)}</span> },
    { key: "menu", header: "", align: "center", width: 40, render: () => (
      <RowMenu items={[
        { label: "Change role", onClick: () => {} },
        { label: "View activity", onClick: () => {} },
        { label: "Suspend user", onClick: () => {}, warn: true },
        { label: "Delete user", onClick: () => {}, destructive: true },
      ]} />
    ) },
  ];

  return (
    <FinixShell
      nav={NAV}
      identity={{ name: "Anjali Pawar", initials: "AP", tenant: "AZSB", role: "Bank admin" }}
      action={{ title: "Invite user", subtitle: "6 free seats", onClick: () => setPanel(true) }}
    >
      <Toolbar
        left={<><PeriodChip>01 Aug – 31 Aug 2026</PeriodChip><Breadcrumb>AZSB / primitives</Breadcrumb></>}
        right={<><Button variant="quiet">Export</Button><Button variant="primary">Primary action</Button></>}
      />
      <PageTitle title="Primitives demo" subtitle="Every Finix primitive in both themes — use the sidebar pill to switch." />

      {/* Metric row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Minutes this month" value="155,830" unit="min" delta={<DeltaChip value={12.4} />} note="vs last period" />
        <MetricCard label="Billable value" value={formatINR(1248000)} delta={<DeltaChip value={8.1} />} note="metered" />
        <MetricCard label="Seats allocated" value="200" unit="of 295" delta={<DeltaChip value={-2.6} />} note="45 free" />
        <MetricCard label="Banks with low credit" value="2" ring="amber" note="needs attention" />
      </div>

      <Section title="Pills & call status vocabulary">
        <div className="flex flex-wrap gap-2">
          <Pill tone="accent">Accent</Pill>
          <Pill tone="green">Interested</Pill>
          <Pill tone="amber">Callback</Pill>
          <Pill tone="orange">Wrong contact</Pill>
          <Pill tone="red">Failed</Pill>
          <Pill tone="neutral">Not interested</Pill>
        </div>
        <div className="flex flex-wrap gap-2">
          {["Called - Interested", "Called - Callback Requested", "Wrong Contact", "Called - Not Interested", "Invalid Phone", "Failed"].map((s) => (
            <CallStatusPill key={s} status={s} />
          ))}
        </div>
      </Section>

      <Section title="Buttons & toggles">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Primary</Button>
          <Button variant="quiet">Quiet</Button>
          <Button variant="danger">Suspend user</Button>
          <Button variant="inert">Approve (maker/checker)</Button>
          <Button variant="quiet" onClick={() => setModal(true)}>Open modal</Button>
          <Button variant="quiet" onClick={() => setPanel(true)}>Open side panel</Button>
        </div>
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2 text-[13px] text-fx-text2"><Toggle checked={toggleA} onChange={setToggleA} label="A" /> on</label>
          <label className="flex items-center gap-2 text-[13px] text-fx-text2"><Toggle checked={toggleB} onChange={setToggleB} label="B" /> off</label>
          <label className="flex items-center gap-2 text-[13px] text-fx-text3"><Toggle checked={false} onChange={() => {}} disabled label="C" /> disabled</label>
        </div>
      </Section>

      <Section title="Bars & rankings">
        <div className="space-y-1">
          <div className="text-[11px] text-fx-text3">Quota — 81% with pace tick at 64.5%</div>
          <Bar value={0.81} height={10} tone="amber" tick={0.645} />
        </div>
        <div className="space-y-1">
          <div className="text-[11px] text-fx-text3">Seat meter — 13 active + 1 invited of 20</div>
          <SplitBar filled={13 / 20} outlined={1 / 20} />
        </div>
        <div className="space-y-1">
          <div className="text-[11px] text-fx-text3">Call outcomes</div>
          <SegmentedBar segments={[
            { label: "Interested", value: 8642, tone: "green" },
            { label: "Callback", value: 1200, tone: "amber" },
            { label: "Wrong contact", value: 241, tone: "orange" },
            { label: "Not interested", value: 3000, neutral: true },
            { label: "Failed", value: 500, tone: "red" },
          ]} />
        </div>
        <RankBarList items={[
          { label: "Camp road", value: 612, meta: "612 calls · 4,820 min · 82% connected" },
          { label: "MG road", value: 480, meta: "480 calls · 3,510 min · 79% connected" },
          { label: "Station", value: 305, meta: "305 calls · 2,140 min · 74% connected" },
        ]} />
      </Section>

      <Card>
        <CardHeader title="Users" qualifier="4 of 4" right={<FilterPills options={[
          { key: "all", label: "All", count: 4 },
          { key: "active", label: "Active", count: 3 },
          { key: "invited", label: "Invited", count: 1 },
        ]} value={filter} onChange={setFilter} />} onOpenFull={() => {}} />
        <Table columns={cols} rows={ROWS} rowKey={(r) => r.id} onRowClick={() => {}} />
        <CallLegend />
      </Card>

      <div className="grid gap-3 md:grid-cols-3">
        <Card><CardHeader title="Empty" /><EmptyState title="No users yet" description="Invite your first officer to get started." action={<Button variant="primary">Invite user</Button>} /></Card>
        <Card><CardHeader title="Loading" /><LoadingState label="Loading users…" rows={4} /></Card>
        <Card><CardHeader title="Error" /><ErrorState detail="User service returned 503 at 09:14 IST." onRetry={() => {}} /></Card>
      </div>

      <div className="text-[11px] text-fx-text3">
        Formatting check — {formatINR(461000)} · {formatINR(105000)} · {formatINR(24000000)} · {formatDuration(472)} · {formatDateTime("2026-08-20T14:31:00+05:30")}
      </div>

      <Modal open={modal} onClose={() => setModal(false)} width={520}>
        <OverlayHeader title="Create user" subtitle="Creates the account directly, no invite email." onClose={() => setModal(false)} />
        <div className="p-5 text-[13px] text-fx-text2">Modal body — form goes here in Step 4a.</div>
        <div className="flex justify-end gap-2 border-t border-fx-border p-4">
          <Button variant="quiet" onClick={() => setModal(false)}>Cancel</Button>
          <Button variant="primary">Create user</Button>
        </div>
      </Modal>

      <SidePanel open={panel} onClose={() => setPanel(false)} width={420}>
        <OverlayHeader title="Invite user" subtitle="This invite uses 1 of your 6 free seats." onClose={() => setPanel(false)} />
        <div className="p-5 text-[13px] text-fx-text2">Side-panel body — invite form goes here in Step 4a.</div>
      </SidePanel>
    </FinixShell>
  );
}
