// Module × level grid definition for the bank-admin permission matrix.
//
// WHY A SECOND LAYER EXISTS
// The backend stores 30 granular permission codes (migration_v40) because that
// is the granularity enforcement needs: revoking `application.disburse` without
// touching approve/reject is a real requirement, and the activity log should
// name the exact right that changed. But 30 checkboxes is the wrong thing to put
// in front of an admin who is onboarding a recovery caller.
//
// So the console renders a 7-row × 3-column grid (module × Read/Write/Edit) and
// this file is the ONLY place that translates a cell into codes. The grid is a
// VIEW; the codes stay the unit of storage, enforcement and audit.
//
// LEVEL SEMANTICS — deliberately narrow, so a cell's blast radius is obvious:
//   read   — see the data
//   write  — act within the normal workflow (create, send, request, run)
//   edit   — change configuration, or take an irreversible/financial action
//
// Consequential rights (disburse, emergency stop, delete user) sit at `edit`
// and their modules are marked `sensitiveLevels`, so the UI can badge them.
// They are never part of a `custom` role's defaults, so granting one is always
// an explicit act.
//
// `–` (not applicable) is FIXED PER MODULE: a level with no codes does not exist
// for that module and renders as a dash for every role. Keeping the grid shape
// stable means switching roles never looks like rights vanishing.

export type PermissionLevel = "read" | "write" | "edit";

export interface PermissionModule {
  key: string;
  label: string;
  /** Sub-caption naming the concrete data, so "Read" is never abstract. */
  caption: string;
  /**
   * Codes per level. A level absent from this map renders as `–`.
   * Order within a level does not matter; the set is what counts.
   */
  levels: Partial<Record<PermissionLevel, string[]>>;
  /** Levels whose codes move money or destroy records — badged in the UI. */
  sensitiveLevels?: PermissionLevel[];
}

export const PERMISSION_MODULES: PermissionModule[] = [
  {
    key: "applications",
    label: "Loan applications",
    caption: "Files in this user's branch scope",
    levels: {
      // ONE code, not all three view scopes.
      //
      // Collapsing view_assigned + view_branch + view_all into this cell was a
      // bug: an officer's default holds only view_assigned, so the cell was
      // permanently PARTIAL — it rendered as "off" while the user could in fact
      // see their queue, and clicking it granted bank-wide visibility instead of
      // clearing the row. Verified in the browser: clearing Read left Write
      // checked, because the click was actually turning Read *on*.
      //
      // `application.view_assigned` is the floor every role shares, so it is the
      // honest thing for this cell to own. The wider scopes (view_branch,
      // view_all) are a ROLE property — a supervisor sees the branch because they
      // are a supervisor — and are carried through as unmapped codes rather than
      // pretending the admin chooses them here.
      read: ["application.view_assigned"],
      // Ordinary workflow: move a file forward or back, ask for documents, void
      // it. `application.cancel` belongs HERE, not in Edit: it is an officer-level
      // right in the role defaults, and grouping it with the supervisor tier left
      // the officer's Edit cell permanently half-on ("mixed"), which reads as a
      // half-granted capability the admin never chose. Caught in the browser.
      write: [
        "application.officer_approve",
        "application.officer_reject",
        "application.request_documents",
        "application.cancel",
      ],
      // Supervisor tier: second-line sign-off, disbursement, vendor assignment.
      // Every code here is either financial or irreversible, which is what makes
      // the whole cell sensitive.
      edit: [
        "application.supervisor_approve",
        "application.supervisor_reject",
        "application.disburse",
        "application.assign_vendor",
      ],
    },
    // Write carries `application.cancel`, which voids a file irreversibly, so it
    // is badged too — a sensitive right must not lose its warning just because it
    // sits at a lower level than disbursement.
    sensitiveLevels: ["write", "edit"],
  },
  {
    key: "calls",
    label: "Calls and recordings",
    caption: "Call log, transcripts, recordings",
    levels: {
      read: ["calls.view"],
      // Recording playback is a privacy step beyond reading the log, so it is
      // its own level rather than being bundled into Read.
      write: ["calls.listen_recording"],
    },
  },
  {
    key: "campaigns",
    label: "Campaigns and dialler",
    caption: "Batch lists, schedules, retry rules",
    levels: {
      read: ["calls.view"],
      write: ["batch.upload", "batch.start"],
      edit: ["batch.emergency_stop"],
    },
    sensitiveLevels: ["edit"],
  },
  {
    key: "borrowers",
    label: "Borrower records",
    caption: "Contact details, KYC documents",
    levels: {
      // Borrower data is reached through the application file, so Read shares
      // `application.view_assigned` with Loan applications. Sharing a READ code
      // is harmless — both rows want the same visibility and neither can be on
      // without it.
      //
      // Write deliberately has NO code of its own. `application.request_documents`
      // belongs to Loan applications/Write, and mapping it here too made this
      // row silently change when that one was cleared: a testable invariant
      // ("clearing a row clears its Write") appeared to break because a second
      // row still legitimately held the code. Two cells owning one write-level
      // code means neither cell can be reasoned about alone, so Borrower records
      // is read-only until it has an endpoint of its own.
      read: ["application.view_assigned"],
    },
  },
  {
    key: "scorecard",
    label: "Scorecard",
    caption: "Weights, bands and thresholds",
    levels: {
      read: ["scorecard.view"],
      // No Write: there is no "use the scorecard" action distinct from viewing
      // it. Changing weights or re-scoring is configuration, so it is Edit.
      edit: ["scorecard.edit", "scorecard.rescore"],
    },
    sensitiveLevels: ["edit"],
  },
  {
    key: "reports",
    label: "Reports and exports",
    caption: "Branch statistics, CSV exports",
    levels: {
      read: ["usage.view", "activity.view"],
      // Exporting takes data out of the system; that is an action, not a view.
      write: ["usage.export"],
    },
  },
  {
    key: "users",
    label: "Users and roles",
    caption: "Invites, roles, branch assignment",
    levels: {
      read: ["user.view"],
      write: ["user.invite"],
      edit: ["user.edit", "user.suspend", "user.delete", "user.manage_permissions",
             "settings.view", "settings.edit"],
    },
    sensitiveLevels: ["edit"],
  },
];

/** Level order for rendering; also the dependency order (read gates the rest). */
export const LEVELS: PermissionLevel[] = ["read", "write", "edit"];

export type CellState = "on" | "off" | "na";

/** Does this module offer this level at all? `false` renders as `–`. */
export function levelExists(m: PermissionModule, level: PermissionLevel): boolean {
  return (m.levels[level]?.length ?? 0) > 0;
}

/**
 * Cell state from the selected code set.
 *
 * A cell counts as ON when EVERY code behind it is selected. Partial coverage
 * reads as off rather than on: claiming a capability the user only half has
 * would be the more dangerous error on a screen like this. `partialCells` below
 * lets the UI surface those instead of hiding them.
 */
export function cellState(
  m: PermissionModule,
  level: PermissionLevel,
  selected: Set<string>,
): CellState {
  const codes = m.levels[level];
  if (!codes || codes.length === 0) return "na";
  return codes.every((c) => selected.has(c)) ? "on" : "off";
}

/** True when SOME but not all codes behind a cell are held. */
export function isPartial(
  m: PermissionModule,
  level: PermissionLevel,
  selected: Set<string>,
): boolean {
  const codes = m.levels[level];
  if (!codes || codes.length === 0) return false;
  const hits = codes.filter((c) => selected.has(c)).length;
  return hits > 0 && hits < codes.length;
}

/**
 * Apply a cell toggle, returning the new code set.
 *
 * Enforces the dependency the design calls for:
 *   - turning Read OFF clears Write and Edit for that module (no "can edit but
 *     not view" state, which the backend could not honour coherently)
 *   - turning Write or Edit ON turns Read on with it
 *
 * Codes shared between modules (calls.view, application.view_assigned) are only
 * removed when NO other still-enabled cell needs them — otherwise unticking one
 * module would silently break another.
 */
export function applyCellToggle(
  modules: PermissionModule[],
  selected: string[],
  moduleKey: string,
  level: PermissionLevel,
  next: boolean,
): string[] {
  const m = modules.find((x) => x.key === moduleKey);
  if (!m || !levelExists(m, level)) return selected;

  const set = new Set(selected);
  const add = (codes?: string[]) => codes?.forEach((c) => set.add(c));

  // Build the set of codes this module should hold after the toggle.
  const desiredLevels = new Set<PermissionLevel>(
    LEVELS.filter((l) => levelExists(m, l) && cellState(m, l, set) === "on"),
  );

  if (next) {
    desiredLevels.add(level);
    if (level !== "read" && levelExists(m, "read")) desiredLevels.add("read");
  } else {
    desiredLevels.delete(level);
    // Read is the gate: dropping it drops the whole row.
    if (level === "read") {
      desiredLevels.delete("write");
      desiredLevels.delete("edit");
    }
  }

  // Remove every code this module owns, then re-add what it should keep.
  const owned = new Set(LEVELS.flatMap((l) => m.levels[l] ?? []));
  for (const c of owned) set.delete(c);
  for (const l of desiredLevels) add(m.levels[l]);

  // Re-add any code another module still needs (shared codes).
  for (const other of modules) {
    if (other.key === m.key) continue;
    for (const l of LEVELS) {
      if (!levelExists(other, l)) continue;
      // Was this other cell on BEFORE the edit? If so it must stay on.
      const wasOn = (other.levels[l] ?? []).every((c) => selected.includes(c));
      if (wasOn) add(other.levels[l]);
    }
  }

  return Array.from(set);
}

/** Codes for a whole set of cells — used to seed the grid from role defaults. */
export function codesForCells(
  modules: PermissionModule[],
  cells: { moduleKey: string; level: PermissionLevel }[],
): string[] {
  const set = new Set<string>();
  for (const { moduleKey, level } of cells) {
    const m = modules.find((x) => x.key === moduleKey);
    m?.levels[level]?.forEach((c) => set.add(c));
  }
  return Array.from(set);
}

/**
 * Codes that no module cell can reach.
 *
 * The grid is a lossy view: if a role default (or a prior per-user grant) holds
 * a code no cell covers, saving the grid would silently drop it. The console
 * carries these through untouched and says so, rather than quietly narrowing
 * someone's access.
 */
export function unmappedCodes(modules: PermissionModule[], allCodes: string[]): string[] {
  const mapped = new Set(modules.flatMap((m) => LEVELS.flatMap((l) => m.levels[l] ?? [])));
  return allCodes.filter((c) => !mapped.has(c));
}
