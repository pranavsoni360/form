"use client";

// Bank admin — users (design_handoff_finix §3). Seat meter, metrics, users
// table with status-aware row menu, filter pills, invite side panel, create
// modal (validation + credential panel), suspend confirmation. Empty / loading
// / error states all shipped.

import * as React from "react";
import { BankAdminShell } from "../shell";
import {
  PageTitle,
  FilterPills,
  Pill,
  Button,
  Table,
  TwoLine,
  RowMenu,
  PermissionGrid,
  Modal,
  SidePanel,
  OverlayHeader,
  EmptyState,
  LoadingState,
  ErrorState,
  formatDate,
  type Column,
  type MenuItem,
} from "@/components/finix";
import {
  listUsers,
  updateUser,
  listActivity,
  type ActivityEntry,
  createUser,
  suspendUser,
  restoreUser,
  deleteUser,
  inviteUser,
  resendInvite,
  revokeInvite,
  type UsersResponse,
  type BankUser,
  type PendingInvite,
  type CreatedUser,
  getPermissionCatalogue,
  getUserPermissions,
  setUserPermissions,
  type PermissionCatalogue,
  listCustomRoles,
  createCustomRole,
  updateCustomRole,
  deleteCustomRole,
  type CustomRole,
} from "@/lib/api/bankAdmin";
import { PERMISSION_MODULES, unmappedCodes } from "@/lib/utils/permissionModules";
import { UserSettingsPanel } from "./UserSettingsPanel";

type FilterKey = "all" | "active" | "invited" | "suspended";

const ROLE_LABEL: Record<string, string> = {
  bank_admin: "Bank admin",
  bank_officer: "Officer",
  bank_supervisor: "Supervisor",
  custom: "Custom",
};

// A users-table row is either a real user or a pending invite; we unify them.
type Row =
  | { kind: "user"; u: BankUser }
  | { kind: "invite"; i: PendingInvite };

function initials(name: string) {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

// Clean status indicator — dot + label, no filled background pill.
// Avoids the "AI-generated" look of large colored badge pills.
function StatusDot({
  tone,
  label,
  sub,
}: {
  tone: "green" | "amber" | "neutral" | "accent";
  label: string;
  sub?: string;
}) {
  const dotColor =
    tone === "green"  ? "var(--fx-green)"  :
    tone === "amber"  ? "var(--fx-amber)"  :
    tone === "accent" ? "var(--fx-accent)" :
    "var(--fx-text3)";
  return (
    <div>
      <div className="flex items-center gap-[7px]">
        <span
          className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
          style={{ background: dotColor, boxShadow: `0 0 0 2.5px color-mix(in srgb, ${dotColor} 18%, transparent)` }}
        />
        <span className="text-[13px] font-medium text-fx-text">{label}</span>
      </div>
      {sub && <p className="mt-[2px] pl-[14px] text-[11px] text-fx-text3">{sub}</p>}
    </div>
  );
}

function lastActive(u: BankUser): string {
  if (u.status === "suspended") return "suspended";
  if (!u.last_login_at) return "never signed in";
  return `last active ${formatDate(u.last_login_at)}`;
}

// ── Seat meter ────────────────────────────────────────────────────────────────
// Segmented tick strip — one tick per contracted seat, coloured by state.
// active = teal fill · invited = teal outline · free = faint border
function SeatMeter({ cap, active, invited }: { cap: number; active: number; invited: number }) {
  const free = Math.max(0, cap - active - invited);
  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: cap }).map((_, i) => {
          const state =
            i < active ? "active" : i < active + invited ? "invited" : "free";
          return (
            <div
              key={i}
              className="h-2 w-2 rounded-full"
              style={
                state === "active"
                  ? { background: "var(--fx-teal)" }
                  : state === "invited"
                  ? { border: "1.5px solid var(--fx-teal)", background: "transparent" }
                  : { background: "var(--fx-border)" }
              }
            />
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-fx-text3">
        {active} active · {invited} invited · {free} free
      </p>
    </div>
  );
}

export default function UsersPage() {
  const [data, setData] = React.useState<UsersResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<FilterKey>("all");
  const [search, setSearch] = React.useState("");

  const [invite, setInvite] = React.useState(false);
  const [create, setCreate] = React.useState(false);
  const [suspendTarget, setSuspendTarget] = React.useState<BankUser | null>(null);
  const [permTarget, setPermTarget] = React.useState<BankUser | null>(null);
  const [settings, setSettings] = React.useState(false);
  // Bumping this remounts the invite/create panels so their role pickers refetch
  // after a profile is added or edited — otherwise a freshly created role would
  // not appear until a full page reload.
  const [rolesVersion, setRolesVersion] = React.useState(0);
  const [roleTarget, setRoleTarget] = React.useState<BankUser | null>(null);
  const [branchTarget, setBranchTarget] = React.useState<BankUser | null>(null);
  const [activityTarget, setActivityTarget] = React.useState<BankUser | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    listUsers()
      .then(setData)
      .catch((e) => setError(e?.message || "Could not load users."))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(load, [load]);

  const rows: Row[] = React.useMemo(() => {
    if (!data) return [];
    const users: Row[] = data.users.map((u) => ({ kind: "user", u }));
    const invites: Row[] = data.pending_invites.map((i) => ({ kind: "invite", i }));
    let all = [...users, ...invites];
    if (filter !== "all") {
      if (filter === "invited") all = all.filter((r) => r.kind === "invite" || r.u?.status === "invited");
      else all = all.filter((r) => r.kind === "user" && r.u.status === filter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      all = all.filter((r) => {
        if (r.kind === "user") {
          return (
            r.u.full_name.toLowerCase().includes(q) ||
            r.u.username.toLowerCase().includes(q) ||
            (r.u.email ?? "").toLowerCase().includes(q)
          );
        }
        return (
          r.i.full_name.toLowerCase().includes(q) ||
          r.i.email.toLowerCase().includes(q)
        );
      });
    }
    return all;
  }, [data, filter, search]);

  const seats = data?.seats;
  const counts = data?.counts;

  async function act(p: Promise<unknown>, onErr = "Action failed") {
    try {
      await p;
      load();
    } catch (e: any) {
      alert(e?.message || onErr); // simple surfacing; inline toasts arrive with Job 2
    }
  }

  const userMenu = (u: BankUser): MenuItem[] => {
    if (u.status === "suspended") {
      return [
        { label: "Restore access", onClick: () => act(restoreUser(u.id)) },
        { label: "Delete user", onClick: () => act(deleteUser(u.id)), destructive: true },
      ];
    }
    return [
      { label: "Change role", onClick: () => setRoleTarget(u) },
      { label: "Change branch", onClick: () => setBranchTarget(u) },
      { label: "Edit permissions", onClick: () => setPermTarget(u) },
      { label: "View activity", onClick: () => setActivityTarget(u) },
      { label: "Suspend user", onClick: () => setSuspendTarget(u), warn: true },
      { label: "Delete user", onClick: () => act(deleteUser(u.id)), destructive: true },
    ];
  };

  const inviteMenu = (i: PendingInvite): MenuItem[] => [
    {
      label: "Resend invite",
      onClick: () =>
        act(
          resendInvite(i.id).then((r) => {
            if (!r.email_sent) navigator.clipboard?.writeText(r.invite_url);
          }),
        ),
    },
    { label: "Revoke invite", onClick: () => act(revokeInvite(i.id)), destructive: true },
  ];

  const cols: Column<Row>[] = [
    {
      key: "name",
      header: "Name",
      render: (r) =>
        r.kind === "user" ? (
          <div className="flex items-center gap-2.5">
            <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[8px] bg-fx-surface text-[11px] text-fx-text2">
              {initials(r.u.full_name)}
            </span>
            <TwoLine
              primary={
                <span className={r.u.status === "suspended" ? "text-fx-text3" : undefined}>
                  {r.u.full_name}
                  {r.u.id === data?.self_id && <span className="ml-1.5 text-[11px] text-fx-text3">you</span>}
                </span>
              }
              secondary={<span className="fx-mono">{r.u.username}</span>}
            />
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[8px] bg-fx-surface text-[11px] text-fx-text2">
              {initials(r.i.full_name)}
            </span>
            <TwoLine primary={r.i.full_name} secondary={<span className="fx-mono">{r.i.email}</span>} />
          </div>
        ),
    },
    {
      key: "role",
      header: "Role",
      render: (r) => {
        const role = r.kind === "user" ? r.u.role : r.i.role;
        const custom = r.kind === "user" ? r.u.custom_role_label : r.i.custom_role_label;
        return (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-[13px] text-fx-text2">{custom || ROLE_LABEL[role] || role}</span>
            {role === "custom" && <Pill tone="neutral" dot={false}>custom</Pill>}
          </span>
        );
      },
    },
    {
      key: "branch",
      header: "Branch",
      render: (r) => <span className="text-[13px] text-fx-text2">{(r.kind === "user" ? r.u.branch : r.i.branch) || "—"}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (r) =>
        r.kind === "invite" ? (
          <StatusDot tone="accent" label="Invited" sub={`expires ${formatDate(r.i.expires_at)}`} />
        ) : r.u.status === "active" && !r.u.last_login_at ? (
          <StatusDot tone="amber" label="Not signed in" sub="account ready" />
        ) : r.u.status === "active" ? (
          <StatusDot tone="green" label="Active" sub={lastActive(r.u)} />
        ) : r.u.status === "invited" ? (
          <StatusDot tone="accent" label="Invited" />
        ) : (
          <StatusDot tone="neutral" label="Suspended" sub="seat freed" />
        ),
    },
    {
      key: "menu",
      header: "",
      align: "center",
      width: 44,
      render: (r) => <RowMenu items={r.kind === "user" ? userMenu(r.u) : inviteMenu(r.i)} />,
    },
  ];

  const filterOptions: { key: FilterKey; label: string; count?: number }[] = [
    { key: "all", label: "All", count: counts?.all },
    { key: "active", label: "Active", count: counts?.active },
    { key: "invited", label: "Invited", count: counts?.invited },
    { key: "suspended", label: "Suspended", count: counts?.suspended },
  ];

  return (
    <BankAdminShell
      headerActions={
        <>
          <Button variant="quiet" onClick={() => setSettings(true)}>Settings</Button>
          <div className="flex items-center">
            <Button
              variant="primary"
              onClick={() => setCreate(true)}
              disabled={seats?.free === 0}
              className="rounded-r-none"
              title={seats?.free === 0 ? "No free seats — suspend a user or contact Virtual Galaxy" : undefined}
            >
              Create user
            </Button>
            <button
              type="button"
              onClick={() => setInvite(true)}
              disabled={seats?.free === 0}
              className="fx-btn fx-btn-primary flex h-[30px] w-7 shrink-0 items-center justify-center rounded-l-none border-l text-white"
              style={{ borderColor: "rgba(255,255,255,0.25)" }}
              aria-label="Invite by email"
              title="Invite by email"
            >
              <span className="text-[10px]">▾</span>
            </button>
          </div>
        </>
      }
    >
      <PageTitle
        title="Users"
        subtitle="Manage your bank's officers and supervisors. Suspending frees the seat immediately and keeps history; deleting removes access permanently but the audit record survives."
      />

      {/* ── Seat panel — replaces the four redundant metric cards ── */}
      {seats && (
        <div
          className="rounded-[14px] p-5"
          style={{ background: "var(--fx-surface2)", border: "1px solid var(--fx-border)" }}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span
                  className="text-[28px] font-semibold leading-none text-fx-text"
                  style={{ letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}
                >
                  {seats.used} of {seats.cap}
                </span>
                <span className="text-[13px] text-fx-text2">seats used</span>
              </div>
              <div className="mt-3">
                <SeatMeter cap={seats.cap} active={seats.active} invited={seats.invited} />
              </div>
            </div>
            {counts?.suspended != null && counts.suspended > 0 && (
              <div className="rounded-[10px] px-3 py-2" style={{ background: "var(--fx-amber-tint)" }}>
                <span className="text-[13px] font-medium" style={{ color: "var(--fx-amber)" }}>
                  {counts.suspended} suspended
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── User table ── */}
      <div>
        {/* Filter bar: search + status tabs */}
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <input
            type="search"
            placeholder="Search by name, username or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="fx-input fx-input-ok h-[30px] min-w-[220px] rounded-[10px] px-3 text-[13px]"
          />
          <div className="ml-auto flex items-center gap-2">
            {counts && (
              <span className="text-[12px] text-fx-text3">
                {counts.all} total
              </span>
            )}
            <FilterPills options={filterOptions} value={filter} onChange={setFilter} />
          </div>
        </div>

        {loading ? (
          <LoadingState label="Loading users…" rows={6} />
        ) : error ? (
          <ErrorState title="Could not load users" detail={error} onRetry={load} />
        ) : rows.length === 0 && search ? (
          <EmptyState
            title={`No users match "${search}"`}
            description=""
            action={<Button variant="quiet" onClick={() => setSearch("")}>Clear search</Button>}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No users yet"
            description="Create your first officer or supervisor. You can send an invite email or set a temporary password."
            action={<Button variant="primary" onClick={() => setCreate(true)}>Create user</Button>}
            secondary={<Button variant="quiet" onClick={() => setSettings(true)}>Settings</Button>}
          />
        ) : (
          <div
            className="overflow-hidden rounded-[12px]"
            style={{ border: "1px solid var(--fx-border)" }}
          >
            <Table columns={cols} rows={rows} rowKey={(r) => (r.kind === "user" ? r.u.id : `inv-${r.i.id}`)} />
          </div>
        )}
      </div>

      {invite && (
        <InvitePanel
          key={rolesVersion}
          freeSeats={seats?.free ?? 0}
          onClose={() => setInvite(false)}
          onDone={() => {
            setInvite(false);
            load();
          }}
        />
      )}
      {create && (
        <CreateUserModal
          key={rolesVersion}
          onClose={() => setCreate(false)}
          onCreated={() => load()}
          onSwitchToInvite={() => { setCreate(false); setInvite(true); }}
        />
      )}
      {roleTarget && (
        <ChangeRoleModal
          user={roleTarget}
          onClose={() => setRoleTarget(null)}
          onDone={() => { setRoleTarget(null); load(); }}
        />
      )}
      {branchTarget && (
        <ChangeBranchModal
          user={branchTarget}
          onClose={() => setBranchTarget(null)}
          onDone={() => { setBranchTarget(null); load(); }}
        />
      )}
      {activityTarget && (
        <UserActivityModal
          user={activityTarget}
          onClose={() => setActivityTarget(null)}
        />
      )}
      {settings && (
        <UserSettingsPanel
          onClose={() => setSettings(false)}
          onChanged={() => setRolesVersion((v) => v + 1)}
          seatCap={seats?.cap}
        />
      )}
      {permTarget && (
        <PermissionsModal
          user={permTarget}
          onClose={() => setPermTarget(null)}
          onDone={() => { setPermTarget(null); load(); }}
        />
      )}
      {suspendTarget && (
        <SuspendModal
          user={suspendTarget}
          onClose={() => setSuspendTarget(null)}
          onDone={() => {
            setSuspendTarget(null);
            load();
          }}
        />
      )}
    </BankAdminShell>
  );
}

// ── Invite side panel ────────────────────────────────────────────────────────
// The three BUILT-IN roles. The custom profiles that follow them in the picker
// come from the server (bank_custom_roles), so an admin can define their own.
// "Recovery caller" and "Auditor, read only" used to be hard-coded here and
// granted nothing; migration_v41 seeds them as real profiles with permission
// sets, and this list no longer pretends to know what a bank's roles are.
type RoleOption = {
  value: string;
  label: string;
  custom?: boolean;
  customRoleId?: string;
  description?: string | null;
};

const BUILTIN_ROLE_OPTIONS: RoleOption[] = [
  { value: "bank_officer", label: "Officer", description: "Own queue, approve and reject" },
  { value: "bank_supervisor", label: "Supervisor", description: "Branch approvals and disbursal" },
  { value: "bank_admin", label: "Bank admin", description: "Seats, settings and permissions" },
];

/** Built-ins plus this bank's profiles, refetchable after an edit. */
function useRoleOptions() {
  const [custom, setCustom] = React.useState<CustomRole[]>([]);
  const reload = React.useCallback(() => {
    listCustomRoles()
      .then((r) => setCustom(r.roles ?? []))
      .catch(() => setCustom([]));
  }, []);
  React.useEffect(() => { reload(); }, [reload]);

  const options = React.useMemo<RoleOption[]>(
    () => [
      ...BUILTIN_ROLE_OPTIONS,
      ...custom.map((c) => ({
        value: "custom",
        label: c.name,
        custom: true,
        customRoleId: c.id,
        description: c.description,
      })),
    ],
    [custom],
  );
  return { options, customRoles: custom, reload };
}


// ── permission grid state ────────────────────────────────────────────────────
// Loads the catalogue once and keeps a selection that RE-BASES when the role
// changes: picking a different role replaces the ticks with that role's default,
// because the admin's prior ticks were relative to the old default and silently
// carrying them over would grant rights they never chose for this role.
//
// `touched` records whether the admin has edited the grid at all. If they never
// open or change it we send `undefined` rather than an explicit list, so the
// backend stores no per-user deltas and the user simply inherits their role —
// which keeps the common case free of pointless override rows.
// `customRole` supplies the baseline when role='custom': the profile's own
// permission set. Without it the grid would prefill EMPTY for every custom
// role (bank_role_default_permissions has no 'custom' row by design), making
// each profile look like it granted nothing.
function usePermissionGrid(role: string, customRole?: CustomRole | null) {
  const [cat, setCat] = React.useState<PermissionCatalogue | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [touched, setTouched] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    getPermissionCatalogue().then(setCat).catch(() => setCat(null));
  }, []);

  const roleDefaults = React.useMemo(
    () => (customRole ? customRole.permissions : cat?.role_defaults?.[role] ?? []),
    [cat, role, customRole],
  );

  // Re-base on role change (and on first catalogue load).
  React.useEffect(() => {
    setSelected(roleDefaults);
    setTouched(false);
  }, [roleDefaults]);

  // Codes no grid cell can reach. The grid is a lossy view of the 30 codes, so
  // anything outside it is preserved verbatim on save rather than dropped.
  const unmapped = React.useMemo(
    () => unmappedCodes(PERMISSION_MODULES, roleDefaults),
    [roleDefaults],
  );

  return {
    cat, roleDefaults, open, setOpen, unmapped,
    selected,
    setSelected: (v: string[]) => { setSelected(v); setTouched(true); },
    /** What to send: undefined when untouched, so no deltas are stored. */
    payload: touched ? selected : undefined,
  };
}


/** Collapsible permissions block shared by the invite, create and edit forms. */
function PermissionSection({
  grid,
  roleLabel,
}: {
  grid: ReturnType<typeof usePermissionGrid>;
  roleLabel: string;
}) {
  return (
    <div className="rounded-[10px]" style={{ background: "var(--fx-surface2)" }}>
      <button
        type="button"
        onClick={() => grid.setOpen(!grid.open)}
        className="fx-tap flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <span className="text-[13px] text-fx-text">Permissions</span>
        <span className="text-[11px] text-fx-text3">
          {grid.payload ? `${grid.selected.length} rights · customised` : `${roleLabel} default`}
        </span>
        <span className="fx-mono ml-auto text-[10px] text-fx-text3">{grid.open ? "▲" : "▼"}</span>
      </button>
      {grid.open && (
        <div className="border-t border-fx-border p-3">
          {grid.cat ? (
            <PermissionGrid
              value={grid.selected}
              onChange={grid.setSelected}
              roleDefaults={grid.roleDefaults}
              roleLabel={roleLabel}
              unmapped={grid.unmapped}
            />
          ) : (
            <p className="text-[12px] text-fx-text3">Loading permissions…</p>
          )}
        </div>
      )}
    </div>
  );
}

function InvitePanel({ freeSeats, onClose, onDone }: { freeSeats: number; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = React.useState("");
  const [fullName, setFullName] = React.useState("");
  const [employeeId, setEmployeeId] = React.useState("");
  const [roleIdx, setRoleIdx] = React.useState(0);
  const [branch, setBranch] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ url: string; sent: boolean } | null>(null);
  const { options: roleOptions, customRoles } = useRoleOptions();
  const opt = roleOptions[roleIdx] ?? roleOptions[0];
  // Pass the chosen profile so the grid prefills with ITS permission set.
  const selectedCustom = opt?.customRoleId
    ? customRoles.find((c) => c.id === opt.customRoleId) ?? null
    : null;
  const grid = usePermissionGrid(opt?.value ?? "bank_officer", selectedCustom);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await inviteUser({
        email,
        full_name: fullName,
        role: opt.value as any,
        custom_role_label: opt.custom ? opt.label : undefined,
        custom_role_id: opt.customRoleId,
        branch: branch || undefined,
        employee_id: employeeId || undefined,
        permissions: grid.payload,
      });
      setResult({ url: r.invite_url, sent: r.email_sent });
    } catch (e: any) {
      setErr(e?.message || "Could not send the invite.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidePanel open onClose={onClose} width={420}>
      <OverlayHeader
        title="Invite user"
        subtitle={`This invite uses 1 of your ${freeSeats} free seats. The link expires in 7 days; the seat is held meanwhile.`}
        onClose={onClose}
      />
      {result ? (
        <div className="p-5">
          <div className="rounded-[14px] p-4" style={{ background: "var(--fx-green-tint)", boxShadow: "inset 0 0 0 1px var(--fx-green)" }}>
            <div className="text-[13px] font-medium" style={{ color: "var(--fx-green)" }}>
              ✓ Invite {result.sent ? "sent" : "created"}
            </div>
            <p className="mt-1 text-[12px] text-fx-text2">
              {result.sent
                ? `An email with the invite link was sent to ${email}.`
                : "Email isn't configured yet — copy the link below and hand it over."}
            </p>
            {!result.sent && (
              <div className="mt-2 break-all rounded-[10px] bg-fx-surface2 p-2 text-[11px] fx-mono text-fx-text2">{result.url}</div>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            {!result.sent && (
              <Button variant="quiet" onClick={() => navigator.clipboard?.writeText(result.url)}>Copy link</Button>
            )}
            <Button variant="primary" onClick={onDone}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-5">
          <Field label="Work email" note="Use the user's bank email domain.">
            <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@azsb.co.in" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Full name">
              <input className={inputCls} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Sneha Deshmukh" />
            </Field>
            <Field label="Employee ID">
              <input className={inputCls} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} placeholder="AZ-1187" />
            </Field>
          </div>
          <Field label="Role">
            <div className="flex flex-col gap-1.5">
              {roleOptions.map((o, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setRoleIdx(i)}
                  className="flex items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[13px]"
                  style={
                    roleIdx === i
                      ? { background: "var(--fx-accent-tint)", boxShadow: "inset 0 0 0 1px var(--fx-accent)", color: "var(--fx-text)" }
                      : { background: "var(--fx-surface2)", color: "var(--fx-text2)" }
                  }
                >
                  {o.label}
                  {o.custom && <Pill tone="neutral" dot={false}>custom</Pill>}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Branch">
            <input className={inputCls} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Camp road" />
          </Field>

          {/* Permissions — collapsed by default so the common "just use the role
              default" path stays a short form, but one click away when a specific
              right needs granting to this person. */}
          <PermissionSection grid={grid} roleLabel={opt?.label ?? "Role"} />

          {err && <p className="text-[12px]" style={{ color: "var(--fx-red)" }}>{err}</p>}
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="quiet" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={busy}>{busy ? "Sending…" : "Send invite"}</Button>
          </div>
        </div>
      )}
    </SidePanel>
  );
}

// ── Create user modal (validation + credential panel) ───────────────────────
const NAME_RE = /^[A-Za-z ]+$/;
const USERNAME_RE = /^[a-z0-9_]{3,50}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function CreateUserModal({
  onClose,
  onCreated,
  onSwitchToInvite,
}: {
  onClose: () => void;
  onCreated: () => void;
  /**
   * Hands off to the invite flow. The two paths differ enough — invite collects
   * an email and holds a seat for 7 days, direct creation mints a temp password
   * shown once — that merging their forms would mean a field set where half is
   * always irrelevant. A mode switch at the top keeps each form honest.
   */
  onSwitchToInvite: () => void;
}) {
  const [role, setRole] = React.useState<"bank_officer" | "bank_supervisor">("bank_officer");
  const grid = usePermissionGrid(role);
  const [fullName, setFullName] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [serverErr, setServerErr] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<CreatedUser | null>(null);
  // Tri-state, not a boolean: the clipboard write can genuinely fail (an
  // insecure context leaves navigator.clipboard undefined, and the permission
  // can be denied). It used to flip to "Copied" regardless, so an admin would
  // dismiss the one-time credential panel believing the password was saved.
  const [copied, setCopied] = React.useState<"idle" | "done" | "failed">("idle");

  const errs = {
    fullName: NAME_RE.test(fullName.trim()) ? null : "Letters and spaces only, no digits or symbols.",
    username: USERNAME_RE.test(username.trim()) ? null : "Lowercase letters, numbers and underscore only, 3 to 50 characters.",
    email: !email || EMAIL_RE.test(email.trim()) ? null : "Enter a valid email address, for example name@azsb.co.in.",
  };
  const valid = !errs.fullName && !errs.username && !errs.email;

  async function submit() {
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    setServerErr(null);
    try {
      const { user } = await createUser({ full_name: fullName.trim(), username: username.trim(), email: email.trim() || undefined, role, branch: branch || undefined, permissions: grid.payload });
      setCreated(user);
      onCreated();
    } catch (e: any) {
      setServerErr(e?.message || "Could not create the user.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setCreated(null);
    setFullName(""); setUsername(""); setEmail(""); setBranch(""); setTouched(false); setCopied("idle");
  }

  return (
    <Modal open onClose={onClose} width={520}>
      <OverlayHeader title="Create user" subtitle="Set a temporary password now, or send an invite email instead." onClose={onClose} />
      {created ? (
        <div className="p-5">
          <div className="rounded-[14px] p-4" style={{ background: "var(--fx-green-tint)", boxShadow: "inset 0 0 0 1px var(--fx-green)" }}>
            <div className="text-[13px] font-medium" style={{ color: "var(--fx-green)" }}>
              ✓ {created.full_name} created as {ROLE_LABEL[created.role].toLowerCase()}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <div className="text-[11px] text-fx-text3">Username</div>
                <div className="fx-mono text-[14px] text-fx-text">{created.username}</div>
              </div>
              <div>
                <div className="text-[11px] text-fx-text3">Temporary password</div>
                <div className="fx-mono text-[14px] text-fx-text">{created.generated_password}</div>
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                const text = `Username: ${created.username}\nPassword: ${created.generated_password}`;
                try {
                  if (!navigator.clipboard) throw new Error("clipboard unavailable");
                  await navigator.clipboard.writeText(text);
                  setCopied("done");
                } catch {
                  setCopied("failed");
                }
              }}
              className="mt-3 inline-flex h-[30px] items-center rounded-[10px] px-3 text-[13px] font-medium"
              style={{ background: "var(--fx-green-tint)", color: "var(--fx-green)" }}
            >
              {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy credentials"}
            </button>
            {copied === "failed" && (
              <p className="mt-2 text-[11px]" style={{ color: "var(--fx-red)" }}>
                Could not write to the clipboard. Copy the password above by hand
                before closing this panel &mdash; it is not shown again.
              </p>
            )}
            <p className="mt-3 text-[11px] text-fx-text3">
              The password is shown only once. Copy it now and hand it over in person; the user must change it at first sign-in.
            </p>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="quiet" onClick={reset}>Create another</Button>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-5">
          {/* How the account is handed over. Direct creation is the default
              because it is this modal's own path; choosing invite swaps to the
              panel that owns that flow rather than duplicating its fields. */}
          <div className="flex items-center gap-1.5 rounded-[10px] p-1" style={{ background: "var(--fx-surface2)" }}>
            <span
              className="flex-1 rounded-[8px] px-3 py-1.5 text-center text-[12px]"
              style={{ background: "var(--fx-surface)", color: "var(--fx-text)" }}
            >
              Temporary password
            </span>
            <button
              type="button"
              onClick={onSwitchToInvite}
              className="fx-tap flex-1 rounded-[8px] px-3 py-1.5 text-center text-[12px] text-fx-text3 hover:text-fx-text2"
            >
              Send invite email
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {(["bank_officer", "bank_supervisor"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className="rounded-[10px] px-3 py-3 text-left"
                style={
                  role === r
                    ? { background: "var(--fx-accent-tint)", boxShadow: "inset 0 0 0 1px var(--fx-accent)" }
                    : { background: "var(--fx-surface2)" }
                }
              >
                <div className="flex items-center gap-1.5 text-[13px] text-fx-text">
                  {role === r && <span style={{ color: "var(--fx-accent)" }}>◉</span>}
                  {ROLE_LABEL[r]}
                </div>
                <div className="mt-0.5 text-[11px] text-fx-text3">
                  {r === "bank_officer" ? "Own queue, approve and reject" : "Branch approvals and disbursal"}
                </div>
              </button>
            ))}
          </div>
          <Field label="Full name" error={touched ? errs.fullName : null}>
            <input className={inputCls} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Sneha Deshmukh" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username" error={touched ? errs.username : null}>
              <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="sneha_d" />
            </Field>
            <Field label="Branch">
              <input className={inputCls} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Camp road" />
            </Field>
          </div>
          <Field label="Email (optional)" error={touched ? errs.email : null}>
            <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="sneha@azsb.co.in" />
          </Field>
          {serverErr && <p className="text-[12px]" style={{ color: "var(--fx-red)" }}>{serverErr}</p>}
          <PermissionSection grid={grid} roleLabel={ROLE_LABEL[role]} />

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="quiet" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create user"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Suspend confirmation ─────────────────────────────────────────────────────

// ── Edit permissions for an existing user ────────────────────────────────────
// Loads this person's CURRENT effective set (role default plus any prior
// exceptions) rather than the plain role default, so opening the dialog shows
// what they actually have today and an edit is relative to reality.
function PermissionsModal({
  user,
  onClose,
  onDone,
}: {
  user: BankUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rows, setRows] = React.useState<Awaited<ReturnType<typeof getUserPermissions>> | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    getUserPermissions(user.id)
      .then((r) => {
        setRows(r);
        setSelected(r.permissions.filter((p) => p.allowed).map((p) => p.permission_code));
      })
      .catch((e: any) => setErr(e?.message || "Could not load permissions."));
  }, [user.id]);

  const roleDefaults = React.useMemo(
    () => (rows?.permissions ?? []).filter((p) => p.role_default).map((p) => p.permission_code),
    [rows],
  );

  // Rights this user holds that no grid cell can express. Saving the grid must
  // not silently strip them, so they are re-appended to the payload and the
  // count is surfaced under the grid.
  const unmapped = React.useMemo(
    () => unmappedCodes(PERMISSION_MODULES, selected),
    [selected],
  );

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      // `selected` already contains the unmapped codes (they were loaded into it
      // and the grid never removes what it cannot see), so it is sent as-is.
      await setUserPermissions(user.id, selected, reason || undefined);
      onDone();
    } catch (e: any) {
      setErr(e?.message || "Could not save permissions.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} width={620}>
      <OverlayHeader
        title="Edit permissions"
        subtitle={`${user.full_name} · ${ROLE_LABEL[user.role] ?? user.role}. Changes apply immediately.`}
        onClose={onClose}
      />
      <div className="max-h-[62vh] overflow-y-auto p-5">
        {err && <p className="mb-3 text-[12px]" style={{ color: "var(--fx-red)" }}>{err}</p>}
        {rows ? (
          <>
            <PermissionGrid
              value={selected}
              onChange={setSelected}
              roleDefaults={roleDefaults}
              roleLabel={ROLE_LABEL[user.role] ?? user.role}
              unmapped={unmapped}
            />
            <div className="mt-4">
              <Field label="Reason" note="Recorded in the activity log alongside the change.">
                <input
                  className={inputCls}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Handling recovery calls for Q3"
                />
              </Field>
            </div>
          </>
        ) : (
          <p className="text-[12px] text-fx-text3">Loading permissions…</p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-fx-border p-4">
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={busy || !rows}>
          {busy ? "Saving…" : "Save permissions"}
        </Button>
      </div>
    </Modal>
  );
}

// ── Change role ──────────────────────────────────────────────────────────────
// Changing role RE-BASES permissions: the backend stores per-user deltas against
// the role default, so a user moved from Officer to Supervisor picks up the
// supervisor defaults automatically. Deliberate per-person exceptions survive
// (they are deltas, not a snapshot), which is why this warns rather than
// silently reshaping someone's access.
function ChangeRoleModal({ user, onClose, onDone }: { user: BankUser; onClose: () => void; onDone: () => void }) {
  const { options: roleOptions } = useRoleOptions();
  const [role, setRole] = React.useState<string>(user.role);
  const [customLabel, setCustomLabel] = React.useState(user.custom_role_label ?? "");
  // Which profile is selected, when the chosen role is 'custom'. Tracked by id
  // rather than label so two profiles could share a display name without the
  // wrong one being assigned.
  const [customRoleId, setCustomRoleId] = React.useState<string | undefined>(
    (user as any).custom_role_id ?? undefined,
  );
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const changed = role !== user.role || (role === "custom" && customLabel !== (user.custom_role_label ?? ""));

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await updateUser(user.id, {
        role: role as any,
        custom_role_id: role === "custom" ? customRoleId : undefined,
        ...(role === "custom" ? { custom_role_label: customLabel.trim() } : {}),
      });
      onDone();
    } catch (e: any) {
      setErr(e?.message || "Could not change the role.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} width={460}>
      <OverlayHeader
        title="Change role"
        subtitle={`${user.full_name} is currently ${ROLE_LABEL[user.role] ?? user.role}.`}
        onClose={onClose}
      />
      <div className="flex flex-col gap-3 p-5">
        <div className="flex flex-col gap-1.5">
          {roleOptions.map((o, i) => {
            const active =
              role === o.value &&
              (!o.custom || (o.customRoleId ? customRoleId === o.customRoleId : customLabel === o.label));
            return (
              <button
                key={i}
                type="button"
                onClick={() => { setRole(o.value); if (o.custom) setCustomLabel(o.label); }}
                className="flex items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[13px]"
                style={
                  active
                    ? { background: "var(--fx-accent-tint)", boxShadow: "inset 0 0 0 1px var(--fx-accent)", color: "var(--fx-text)" }
                    : { background: "var(--fx-surface2)", color: "var(--fx-text2)" }
                }
              >
                {o.label}
                {o.custom && <Pill tone="neutral" dot={false}>custom</Pill>}
              </button>
            );
          })}
        </div>
        {changed && (
          <p className="rounded-[10px] px-3 py-2 text-[11px]" style={{ background: "var(--fx-amber-tint)", color: "var(--fx-amber)" }}>
            Permissions re-base to the new role default. Rights granted or removed for this person
            specifically are kept — review them under Edit permissions afterwards.
          </p>
        )}
        {err && <p className="text-[12px]" style={{ color: "var(--fx-red)" }}>{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !changed}>
            {busy ? "Saving…" : "Change role"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Change branch ────────────────────────────────────────────────────────────
function ChangeBranchModal({ user, onClose, onDone }: { user: BankUser; onClose: () => void; onDone: () => void }) {
  const [branch, setBranch] = React.useState(user.branch ?? "");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const changed = branch.trim() !== (user.branch ?? "");

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await updateUser(user.id, { branch: branch.trim() });
      onDone();
    } catch (e: any) {
      setErr(e?.message || "Could not change the branch.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} width={420}>
      <OverlayHeader
        title="Change branch"
        subtitle={`${user.full_name} · currently ${user.branch || "no branch set"}.`}
        onClose={onClose}
      />
      <div className="flex flex-col gap-3 p-5">
        <Field label="Branch" note="Branch scopes which applications and statistics this user sees.">
          <input
            className={inputCls}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="Camp road"
          />
        </Field>
        {err && <p className="text-[12px]" style={{ color: "var(--fx-red)" }}>{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !changed}>
            {busy ? "Saving…" : "Change branch"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Per-user activity ────────────────────────────────────────────────────────
// Uses the /activity endpoint's target_user_id filter, so this is that one
// user's audit trail rather than the whole bank's.
function UserActivityModal({ user, onClose }: { user: BankUser; onClose: () => void }) {
  const [entries, setEntries] = React.useState<ActivityEntry[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    listActivity(user.id, 100)
      .then((r) => setEntries(r.entries))
      .catch((e: any) => setErr(e?.message || "Could not load activity."));
  }, [user.id]);

  return (
    <Modal open onClose={onClose} width={560}>
      <OverlayHeader
        title="Activity"
        subtitle={`Everything recorded against ${user.full_name}.`}
        onClose={onClose}
      />
      <div className="max-h-[60vh] overflow-y-auto p-5">
        {err && <p className="text-[12px]" style={{ color: "var(--fx-red)" }}>{err}</p>}
        {!entries && !err && <p className="text-[12px] text-fx-text3">Loading activity…</p>}
        {entries && entries.length === 0 && (
          <p className="text-[12px] text-fx-text3">Nothing recorded for this user yet.</p>
        )}
        {entries && entries.length > 0 && (
          <div className="space-y-0">
            {entries.map((e) => (
              <div key={e.id} className="border-b border-fx-border py-2.5 last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] text-fx-text">{e.action.replace(/_/g, " ")}</span>
                  <span className="fx-mono text-[10px] text-fx-text3">
                    {new Date(e.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                  </span>
                </div>
                {e.actor_name && <div className="text-[11px] text-fx-text3">by {e.actor_name}</div>}
                {e.detail && Object.keys(e.detail).length > 0 && (
                  <div className="fx-mono mt-1 break-all text-[10px] text-fx-text3">
                    {JSON.stringify(e.detail)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex justify-end border-t border-fx-border p-4">
        <Button variant="primary" onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

function SuspendModal({ user, onClose, onDone }: { user: BankUser; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await suspendUser(user.id);
      onDone();
    } catch (e: any) {
      setErr(e?.message || "Could not suspend the user.");
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} width={440}>
      <OverlayHeader title={`Suspend ${user.full_name}?`} onClose={onClose} />
      <div className="p-5">
        <ul className="space-y-1.5 text-[13px] text-fx-text2">
          <li>· Immediate loss of access; any live call ends.</li>
          <li>· The seat is freed for another user.</li>
          <li>· Their files return to the branch queue.</li>
        </ul>
        <div className="mt-3 rounded-[10px] bg-fx-surface2 p-3 text-[12px] text-fx-text3">
          {ROLE_LABEL[user.role]} · {user.branch || "no branch"} · {lastActive(user)}. Suspending is reversible — you can restore access later.
        </div>
        {err && <p className="mt-2 text-[12px]" style={{ color: "var(--fx-red)" }}>{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>Keep active</Button>
          <Button variant="danger" onClick={go} disabled={busy}>{busy ? "Suspending…" : "Suspend user"}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── small form helpers ───────────────────────────────────────────────────────
const inputCls =
  "w-full rounded-[10px] bg-fx-surface2 px-3 py-2 text-[13px] text-fx-text outline-none placeholder:text-fx-text3 focus:shadow-[inset_0_0_0_1px_var(--fx-accent)]";

function Field({
  label,
  note,
  error,
  children,
}: {
  label: string;
  note?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] text-fx-text3">{label}</div>
      <div className={error ? "rounded-[10px] shadow-[inset_0_0_0_1px_var(--fx-red)]" : undefined}>{children}</div>
      {error ? (
        <div className="mt-1 text-[11px]" style={{ color: "var(--fx-red)" }}>{error}</div>
      ) : note ? (
        <div className="mt-1 text-[11px] text-fx-text3">{note}</div>
      ) : null}
    </label>
  );
}
