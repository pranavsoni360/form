"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Banknote,
  Building2,
  Handshake,
  Link2,
  Loader2,
  Plus,
  ShieldOff,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { AppShell } from "@/components/shared/AppShell";
import {
  adminCreatePartnership,
  adminCreateVendor,
  adminCreateVendorUser,
  adminDeactivateVendor,
  adminGetVendor,
  adminListPartnerships,
  adminListVendors,
  adminTerminatePartnership,
} from "@/lib/api/vendor";
import { getBanks } from "@/lib/api/admin";
import { getAccessToken } from "@/lib/auth";

export default function AdminVendorsPage() {
  const token = React.useMemo(() => getAccessToken("admin") || "", []);
  const qc = useQueryClient();

  const vendorsQ = useQuery({
    queryKey: ["admin", "vendors"],
    queryFn: () => adminListVendors(token),
  });
  const banksQ = useQuery({
    queryKey: ["admin", "banks"],
    queryFn: () => getBanks(token),
  });

  const vendors: any[] = vendorsQ.data?.vendors ?? [];
  const banks: any[] = banksQ.data?.banks ?? [];

  const [createOpen, setCreateOpen] = React.useState(false);
  const [drawer, setDrawer] = React.useState<string | null>(null); // vendor_id

  return (
    <AppShell title="Vendors" subtitle="NBFC partners — disbursement vendors managed by super-admin">
      <div className="mb-5 flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {vendors.length} vendor{vendors.length === 1 ? "" : "s"} on file
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700"
        >
          <Plus className="h-3.5 w-3.5" /> New vendor
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {vendorsQ.isLoading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
        ) : vendors.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No vendors yet. Click <em>New vendor</em> to onboard one.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Code</th>
                <th className="px-5 py-3 font-medium">Email</th>
                <th className="px-5 py-3 font-medium">PAN</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Created</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {vendors.map((v) => (
                <tr key={v.id} className="transition hover:bg-muted/30">
                  <td className="px-5 py-3 font-medium">
                    <button
                      onClick={() => setDrawer(v.id)}
                      className="text-left hover:text-emerald-700 dark:hover:text-emerald-400"
                    >
                      {v.name}
                    </button>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-muted-foreground">{v.code}</td>
                  <td className="px-5 py-3 text-muted-foreground">{v.contact_email || "—"}</td>
                  <td className="px-5 py-3 font-mono text-xs">{v.pan_number || "—"}</td>
                  <td className="px-5 py-3"><StatusBadge status={v.status} /></td>
                  <td className="px-5 py-3 text-xs text-muted-foreground">
                    {v.created_at ? new Date(v.created_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => setDrawer(v.id)}
                      className="text-xs font-medium text-emerald-600 hover:underline"
                    >
                      Manage →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {createOpen && (
        <CreateVendorModal
          token={token}
          onClose={() => setCreateOpen(false)}
          onDone={() => {
            setCreateOpen(false);
            qc.invalidateQueries({ queryKey: ["admin", "vendors"] });
          }}
        />
      )}

      {drawer && (
        <VendorDrawer
          token={token}
          vendorId={drawer}
          banks={banks}
          onClose={() => setDrawer(null)}
        />
      )}
    </AppShell>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-700",
    suspended: "bg-amber-100 text-amber-700",
    inactive: "bg-slate-200 text-slate-600",
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium ${map[status] || "bg-slate-100"}`}>
      {status}
    </span>
  );
}

// ── Create vendor modal ───────────────────────────────────────
function CreateVendorModal({
  token, onClose, onDone,
}: { token: string; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = React.useState({
    name: "", code: "", contact_email: "", contact_phone: "", pan_number: "",
  });
  const m = useMutation({
    mutationFn: () => adminCreateVendor(token, {
      name: form.name,
      code: form.code,
      contact_email: form.contact_email || undefined,
      contact_phone: form.contact_phone || undefined,
      pan_number: form.pan_number || undefined,
    }),
    onSuccess: () => { toast.success("Vendor created"); onDone(); },
    onError: (e: any) => toast.error(e?.message || "Create failed"),
  });
  const valid = form.name.trim().length >= 2 && form.code.trim().length >= 2;
  return (
    <Backdrop onClose={onClose}>
      <h3 className="text-lg font-bold">New vendor</h3>
      <p className="mt-1 text-sm text-muted-foreground">NBFC or private lender — onboard once, partner with banks later.</p>
      <div className="mt-4 space-y-3">
        <FormInput label="Name *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="e.g. Bajaj Finance Limited" />
        <FormInput label="Code *" value={form.code} onChange={(v) => setForm({ ...form, code: v.toUpperCase() })} placeholder="e.g. BFL" hint="Unique short code, uppercase" />
        <FormInput label="Contact email" value={form.contact_email} onChange={(v) => setForm({ ...form, contact_email: v })} placeholder="ops@bajaj.in" />
        <FormInput label="Contact phone" value={form.contact_phone} onChange={(v) => setForm({ ...form, contact_phone: v })} placeholder="9999999999" />
        <FormInput label="PAN number" value={form.pan_number} onChange={(v) => setForm({ ...form, pan_number: v.toUpperCase() })} placeholder="AAACA1234N" />
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted">Cancel</button>
        <button
          disabled={!valid || m.isPending}
          onClick={() => m.mutate()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
        >
          {m.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Create vendor
        </button>
      </div>
    </Backdrop>
  );
}

// ── Vendor drawer (users + partnerships) ──────────────────────
function VendorDrawer({
  token, vendorId, banks, onClose,
}: { token: string; vendorId: string; banks: any[]; onClose: () => void }) {
  const qc = useQueryClient();

  const vQ = useQuery({
    queryKey: ["admin", "vendor", vendorId],
    queryFn: () => adminGetVendor(token, vendorId),
  });
  const partQ = useQuery({
    queryKey: ["admin", "partnerships", vendorId],
    queryFn: () => adminListPartnerships(token, { vendor_id: vendorId }),
  });

  const v = vQ.data?.vendor;
  const users: any[] = vQ.data?.users ?? [];
  const partnerships: any[] = partQ.data?.partnerships ?? [];

  const [showAddUser, setShowAddUser] = React.useState(false);
  const [showAddPart, setShowAddPart] = React.useState(false);

  const deact = useMutation({
    mutationFn: () => adminDeactivateVendor(token, vendorId),
    onSuccess: () => { toast.success("Vendor deactivated"); qc.invalidateQueries({ queryKey: ["admin", "vendors"] }); onClose(); },
  });
  const termPart = useMutation({
    mutationFn: (pid: string) => adminTerminatePartnership(token, pid),
    onSuccess: () => { toast.success("Partnership terminated"); qc.invalidateQueries({ queryKey: ["admin", "partnerships", vendorId] }); },
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/60" onClick={onClose}>
      <div
        className="h-full w-full max-w-2xl overflow-y-auto border-l border-border bg-background p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold">{v?.name || "Vendor"}</h2>
            <p className="text-sm text-muted-foreground">
              {v?.code} · <StatusBadge status={v?.status || "—"} />
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        {vQ.isLoading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            {/* Metadata */}
            <section className="mb-6 rounded-xl border border-border bg-card p-4">
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">Contact</h3>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <Pair k="Email" v={v?.contact_email} />
                <Pair k="Phone" v={v?.contact_phone} />
                <Pair k="PAN" v={v?.pan_number} mono />
                <Pair k="GSTIN" v={v?.gstin} mono />
              </dl>
            </section>

            {/* Users */}
            <section className="mb-6 rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Vendor users ({users.length})</h3>
                <button
                  onClick={() => setShowAddUser((s) => !s)}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                >
                  <UserPlus className="h-3 w-3" /> Add user
                </button>
              </div>
              {users.length === 0 ? (
                <p className="text-sm text-muted-foreground">No users yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {users.map((u) => (
                    <li key={u.id} className="flex items-center justify-between py-2 text-sm">
                      <span>
                        <span className="font-medium">{u.full_name}</span>{" "}
                        <span className="font-mono text-xs text-muted-foreground">@{u.username}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">{u.role}</span>
                    </li>
                  ))}
                </ul>
              )}
              {showAddUser && (
                <AddVendorUserForm
                  token={token}
                  vendorId={vendorId}
                  onDone={() => {
                    setShowAddUser(false);
                    qc.invalidateQueries({ queryKey: ["admin", "vendor", vendorId] });
                  }}
                />
              )}
            </section>

            {/* Partnerships */}
            <section className="mb-6 rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Bank partnerships ({partnerships.length})
                </h3>
                <button
                  onClick={() => setShowAddPart((s) => !s)}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                >
                  <Link2 className="h-3 w-3" /> Add partnership
                </button>
              </div>
              {partnerships.length === 0 ? (
                <p className="text-sm text-muted-foreground">No partnerships yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {partnerships.map((p) => (
                    <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                      <span className="flex items-center gap-2">
                        <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium">{p.bank_name}</span>
                        <span className="text-xs text-muted-foreground">({p.bank_code})</span>
                        {p.commission_pct != null && (
                          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
                            {p.commission_pct}% commission
                          </span>
                        )}
                        <StatusBadge status={p.status} />
                      </span>
                      {p.status !== "terminated" && (
                        <button
                          onClick={() => termPart.mutate(p.id)}
                          disabled={termPart.isPending}
                          className="text-xs text-rose-600 hover:underline disabled:opacity-50"
                        >
                          Terminate
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {showAddPart && (
                <AddPartnershipForm
                  token={token}
                  vendorId={vendorId}
                  banks={banks}
                  existing={partnerships}
                  onDone={() => {
                    setShowAddPart(false);
                    qc.invalidateQueries({ queryKey: ["admin", "partnerships", vendorId] });
                  }}
                />
              )}
            </section>

            {/* Danger zone */}
            {v?.status === "active" && (
              <section className="rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-900/40 dark:bg-rose-950/20">
                <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-rose-700">Danger zone</h3>
                <p className="text-sm text-rose-800 dark:text-rose-300">
                  Deactivating soft-deletes this vendor (status=inactive). Existing
                  assignments and settlements are kept intact for audit.
                </p>
                <button
                  onClick={() => {
                    if (confirm(`Deactivate vendor "${v?.name}"?`)) deact.mutate();
                  }}
                  disabled={deact.isPending}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-600 hover:bg-rose-100 disabled:opacity-50"
                >
                  {deact.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
                  Deactivate vendor
                </button>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AddVendorUserForm({
  token, vendorId, onDone,
}: { token: string; vendorId: string; onDone: () => void }) {
  const [form, setForm] = React.useState({ full_name: "", username: "", password: "", role: "vendor" as "vendor" | "vendor_manager" });
  const m = useMutation({
    mutationFn: () => adminCreateVendorUser(token, vendorId, form),
    onSuccess: () => { toast.success("User created"); onDone(); },
    onError: (e: any) => toast.error(e?.message || "Create failed"),
  });
  const valid = form.full_name.length >= 2 && form.username.length >= 3 && form.password.length >= 8;
  return (
    <div className="mt-3 space-y-2 rounded-lg bg-muted/40 p-3">
      <FormInput label="Full name" value={form.full_name} onChange={(v) => setForm({ ...form, full_name: v })} small />
      <FormInput label="Username" value={form.username} onChange={(v) => setForm({ ...form, username: v })} small />
      <FormInput label="Password (min 8)" value={form.password} onChange={(v) => setForm({ ...form, password: v })} type="password" small />
      <div>
        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Role</label>
        <select
          value={form.role}
          onChange={(e) => setForm({ ...form, role: e.target.value as any })}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="vendor">vendor</option>
          <option value="vendor_manager">vendor_manager</option>
        </select>
      </div>
      <button
        disabled={!valid || m.isPending}
        onClick={() => m.mutate()}
        className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {m.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
        Create user
      </button>
    </div>
  );
}

function AddPartnershipForm({
  token, vendorId, banks, existing, onDone,
}: { token: string; vendorId: string; banks: any[]; existing: any[]; onDone: () => void }) {
  const usedBankIds = new Set(existing.filter((p) => p.status !== "terminated").map((p) => p.bank_id));
  const available = banks.filter((b) => !usedBankIds.has(b.id));
  const [bank, setBank] = React.useState("");
  const [comm, setComm] = React.useState<string>("");
  const m = useMutation({
    mutationFn: () => adminCreatePartnership(token, {
      bank_id: bank,
      vendor_id: vendorId,
      commission_pct: comm ? Number(comm) : undefined,
    }),
    onSuccess: () => { toast.success("Partnership created"); onDone(); },
    onError: (e: any) => toast.error(e?.message || "Create failed"),
  });
  if (available.length === 0) {
    return <p className="mt-3 rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">All banks already have a partnership with this vendor.</p>;
  }
  return (
    <div className="mt-3 space-y-2 rounded-lg bg-muted/40 p-3">
      <div>
        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Bank</label>
        <select
          value={bank}
          onChange={(e) => setBank(e.target.value)}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">— pick bank —</option>
          {available.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
        </select>
      </div>
      <FormInput label="Commission %" value={comm} onChange={setComm} type="number" small placeholder="e.g. 10" />
      <button
        disabled={!bank || m.isPending}
        onClick={() => m.mutate()}
        className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {m.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
        Create partnership
      </button>
    </div>
  );
}

function FormInput({
  label, value, onChange, placeholder, hint, type = "text", small,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; hint?: string; type?: string; small?: boolean;
}) {
  return (
    <label className="block">
      <span className={`mb-1 block ${small ? "text-[10px]" : "text-xs"} font-bold uppercase tracking-wider text-muted-foreground`}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-md border border-border bg-background px-2 py-1.5 ${small ? "text-sm" : "text-sm"}`}
      />
      {hint && <span className="mt-0.5 block text-[10px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

function Pair({ k, v, mono }: { k: string; v?: string | null; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{k}</dt>
      <dd className={`mt-0.5 ${mono ? "font-mono" : ""}`}>{v || "—"}</dd>
    </div>
  );
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
