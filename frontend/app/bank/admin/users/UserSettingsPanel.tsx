"use client";

// Settings for the Users page — the toolbar's "Settings" button.
//
// WHY IT EXISTS: managing custom roles used to hang off an 11px link buried
// inside the Invite panel, which meant an admin had to START AN INVITE to
// discover they could define roles at all. Roles govern the whole page, so they
// belong in a settings surface, not inside one task's form.
//
// Scope is deliberately "things that govern users on this page" — roles and
// invite behaviour. Bank-wide settings (quotas, retention, PII redaction) stay
// on the sidebar's own Settings page; duplicating them here would give two
// screens authority over the same values.

import * as React from "react";
import {
  SidePanel,
  OverlayHeader,
  Button,
  Field,
  Input,
  Textarea,
  Card,
  Pill,
  PermissionGrid,
  EmptyState,
  LoadingState,
} from "@/components/finix";
import {
  listCustomRoles,
  createCustomRole,
  updateCustomRole,
  deleteCustomRole,
  type CustomRole,
} from "@/lib/api/bankAdmin";
import { PERMISSION_MODULES, unmappedCodes } from "@/lib/utils/permissionModules";

type Draft = { id?: string; name: string; description: string; permissions: string[] };
const EMPTY_DRAFT: Draft = { name: "", description: "", permissions: [] };

export function UserSettingsPanel({
  onClose,
  onChanged,
  /** Seat cap context, so the read-only note can state the real number. */
  seatCap,
}: {
  onClose: () => void;
  onChanged: () => void;
  seatCap?: number;
}) {
  const [roles, setRoles] = React.useState<CustomRole[] | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    listCustomRoles()
      .then((r) => setRoles(r.roles ?? []))
      .catch((e: any) => setErr(e?.message || "Could not load roles."));
  }, []);

  React.useEffect(() => { load(); }, [load]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        name: draft.name,
        description: draft.description || undefined,
        permissions: draft.permissions,
      };
      if (draft.id) await updateCustomRole(draft.id, payload);
      else await createCustomRole(payload);
      setDraft(null);
      load();
      onChanged();
    } catch (e: any) {
      setErr(e?.message || "Could not save the role.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: CustomRole) {
    // The server refuses while anyone holds it. Surfacing its message rather
    // than pre-guessing means the count and the rule can never disagree.
    setBusy(true);
    setErr(null);
    try {
      await deleteCustomRole(r.id);
      load();
      onChanged();
    } catch (e: any) {
      setErr(e?.message || "Could not delete the role.");
    } finally {
      setBusy(false);
    }
  }

  // A new role starts from NOTHING, not from an officer's rights: a custom role
  // exists precisely because no built-in role fits, so inheriting one silently
  // would grant more than the admin chose.
  const startNew = () => setDraft({ ...EMPTY_DRAFT });

  return (
    <SidePanel open onClose={onClose} width={580}>
      <OverlayHeader
        title={draft ? (draft.id ? "Edit role" : "New role") : "User settings"}
        subtitle={
          draft
            ? "These permissions become the default for everyone assigned this role."
            : "Roles and defaults for the people on this page."
        }
        onClose={draft ? () => setDraft(null) : onClose}
      />

      <div className="max-h-[70vh] overflow-y-auto p-5">
        {err && <p className="mb-3 text-[12px]" style={{ color: "var(--fx-red)" }}>{err}</p>}

        {draft ? (
          <div className="flex flex-col gap-3">
            <Field label="Role name" htmlFor="cr-name" required>
              <Input
                id="cr-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Recovery caller"
              />
            </Field>
            <Field label="Description" htmlFor="cr-desc" hint="Shown under the name in the role picker.">
              <Textarea
                id="cr-desc"
                rows={2}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="Runs calling campaigns and sees outcomes. No lending decisions."
              />
            </Field>
            <div>
              <div className="mb-1.5 text-[11px] text-fx-text3">Default permissions</div>
              <PermissionGrid
                value={draft.permissions}
                onChange={(codes) => setDraft({ ...draft, permissions: codes })}
                // A role IS the baseline, so there is nothing to deviate from.
                // Passing its own set keeps the "customised" banner quiet, which
                // would otherwise fire on every tick and mean nothing here.
                roleDefaults={draft.permissions}
                roleLabel={draft.name || "This role"}
                unmapped={unmappedCodes(PERMISSION_MODULES, draft.permissions)}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {/* ── Custom roles ── */}
            <section>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[13px] text-fx-text">Custom roles</span>
                <span className="text-[11px] text-fx-text3">
                  Define a role once, then assign it when creating a user
                </span>
                <span className="ml-auto">
                  <Button variant="quiet" onClick={startNew}>New role</Button>
                </span>
              </div>

              {roles === null ? (
                <LoadingState label="Loading roles…" rows={2} />
              ) : roles.length === 0 ? (
                <EmptyState
                  title="No custom roles yet"
                  description="Create one for a job the built-in Officer, Supervisor and Bank admin roles do not cover."
                  action={<Button variant="primary" onClick={startNew}>New role</Button>}
                />
              ) : (
                <div className="flex flex-col gap-2">
                  {roles.map((r) => (
                    <Card key={r.id} className="p-3.5">
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-0 flex-1 leading-tight">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[13px] text-fx-text">{r.name}</span>
                            <Pill tone="neutral">{r.permissions.length} rights</Pill>
                            {r.user_count > 0 && (
                              <Pill tone="accent">
                                {r.user_count} user{r.user_count === 1 ? "" : "s"}
                              </Pill>
                            )}
                          </div>
                          {r.description && (
                            <p className="mt-1 text-[11px] text-fx-text3">{r.description}</p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            variant="quiet"
                            onClick={() =>
                              setDraft({
                                id: r.id,
                                name: r.name,
                                description: r.description ?? "",
                                permissions: r.permissions,
                              })
                            }
                          >
                            Edit
                          </Button>
                          <Button
                            variant="danger"
                            disabled={busy || r.user_count > 0}
                            title={
                              r.user_count > 0
                                ? "Move its users to another role before deleting it."
                                : undefined
                            }
                            onClick={() => remove(r)}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </section>

            {/* ── Read-only context ──
                Stated rather than hidden: an admin who cannot find where the seat
                cap or invite expiry is set will assume it is missing. These are
                VG-managed / fixed, so they are shown as facts, not controls. */}
            <section>
              <div className="mb-2 text-[13px] text-fx-text">Defaults</div>
              <Card className="p-3.5">
                <dl className="flex flex-col gap-2.5 text-[12px]">
                  <div className="flex items-baseline gap-3">
                    <dt className="text-fx-text3">Invite link expiry</dt>
                    <dd className="fx-mono ml-auto text-fx-text2">7 days</dd>
                  </div>
                  <div className="flex items-baseline gap-3">
                    <dt className="text-fx-text3">Seat cap</dt>
                    <dd className="fx-mono ml-auto text-fx-text2">{seatCap ?? "—"}</dd>
                  </div>
                  <div className="flex items-baseline gap-3">
                    <dt className="text-fx-text3">Idle sign-out</dt>
                    <dd className="fx-mono ml-auto text-fx-text2">15 min</dd>
                  </div>
                </dl>
                <p className="mt-3 text-[11px] text-fx-text3">
                  Set by Virtual Galaxy under your contract. Ask for a change from
                  Settings → Request a change.
                </p>
              </Card>
            </section>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-fx-border p-4">
        {draft ? (
          <>
            <Button variant="quiet" onClick={() => setDraft(null)}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={busy || !draft.name.trim()}>
              {busy ? "Saving…" : draft.id ? "Save role" : "Create role"}
            </Button>
          </>
        ) : (
          <Button variant="quiet" onClick={onClose}>Close</Button>
        )}
      </div>
    </SidePanel>
  );
}
