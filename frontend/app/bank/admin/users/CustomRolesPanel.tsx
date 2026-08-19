"use client";

// "Manage custom roles" — where a bank admin defines their own role profiles.
//
// WHY: the console previously offered "Recovery caller" and "Auditor, read only"
// as two strings hard-coded in the frontend. They were not roles — choosing one
// stored a free-text label and granted nothing, and an admin could not add a
// third, say what it may do, or reuse it without re-ticking the whole permission
// grid per user. migration_v41 makes a profile a real per-bank object with its
// own default permission set; this is the screen that manages them.
//
// Editing a profile's permissions changes what EVERY holder inherits
// immediately — that is the point of a profile, and the reason the list shows a
// holder count next to each one. Individual grant/revoke exceptions survive the
// edit, because those are stored as deltas rather than a copy.

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

export function CustomRolesPanel({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  /** Refresh the caller's role picker — a new profile must appear there. */
  onChanged: () => void;
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
      if (draft.id) {
        await updateCustomRole(draft.id, {
          name: draft.name,
          description: draft.description || undefined,
          permissions: draft.permissions,
        });
      } else {
        await createCustomRole({
          name: draft.name,
          description: draft.description || undefined,
          permissions: draft.permissions,
        });
      }
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
    // The server refuses while anyone holds it; surface that rather than
    // pre-guessing, so the count and the rule can never disagree.
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

  // A new profile starts from NOTHING, not from an officer's rights: a profile
  // exists precisely because none of the built-in roles fit, so inheriting one
  // silently would grant more than the admin chose.
  const startNew = () => setDraft({ ...EMPTY_DRAFT });

  return (
    <SidePanel open onClose={onClose} width={560}>
      <OverlayHeader
        title={draft ? (draft.id ? "Edit role" : "New role") : "Custom roles"}
        subtitle={
          draft
            ? "Its permissions become the default for everyone assigned this role."
            : "Define a role once, then assign it when inviting or creating users."
        }
        onClose={draft ? () => setDraft(null) : onClose}
      />

      <div className="max-h-[70vh] overflow-y-auto p-5">
        {err && (
          <p className="mb-3 text-[12px]" style={{ color: "var(--fx-red)" }}>{err}</p>
        )}

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
            <Field
              label="Description"
              htmlFor="cr-desc"
              hint="Shown under the name in the role picker."
            >
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
                // A profile IS the baseline, so there is nothing to deviate from —
                // passing its own set keeps the "customised" banner quiet, which
                // would otherwise fire on every tick and mean nothing here.
                roleDefaults={draft.permissions}
                roleLabel={draft.name || "This role"}
                unmapped={unmappedCodes(PERMISSION_MODULES, draft.permissions)}
              />
            </div>
          </div>
        ) : roles === null ? (
          <LoadingState label="Loading roles…" rows={3} />
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
          <>
            <Button variant="quiet" onClick={onClose}>Close</Button>
            <Button variant="primary" onClick={startNew}>New role</Button>
          </>
        )}
      </div>
    </SidePanel>
  );
}
