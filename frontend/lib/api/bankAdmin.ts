// lib/api/bankAdmin.ts — bank admin portal (design_handoff_finix Job 1).
// Every call is bank-scoped server-side via the JWT; nothing takes a bank_id.
import { authFetch } from "@/lib/auth";

// ── types ────────────────────────────────────────────────────────────────
export type BankRole = "bank_admin" | "bank_officer" | "bank_supervisor" | "custom";
export type UserStatus = "active" | "invited" | "suspended";

export interface BankUser {
  id: string;
  username: string;
  email: string | null;
  full_name: string;
  role: BankRole;
  custom_role_label: string | null;
  branch: string | null;
  employee_id: string | null;
  status: UserStatus;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface PendingInvite {
  id: string;
  email: string;
  full_name: string;
  role: BankRole;
  custom_role_label: string | null;
  branch: string | null;
  employee_id: string | null;
  expires_at: string;
  created_at: string;
}

export interface SeatUsage {
  cap: number;
  used: number;
  free: number;
  active: number;
  invited: number;
}

export interface UsersResponse {
  users: BankUser[];
  pending_invites: PendingInvite[];
  seats: SeatUsage;
  counts: { all: number; active: number; invited: number; suspended: number };
  self_id: string;
}

export interface CreatedUser extends BankUser {
  generated_password: string;
}

// ── users ────────────────────────────────────────────────────────────────
export async function listUsers(status?: UserStatus): Promise<UsersResponse> {
  const qs = status ? `?status=${status}` : "";
  return authFetch(`/api/bank/admin/users${qs}`, {}, "bank");
}

export async function createUser(body: {
  full_name: string;
  username: string;
  email?: string;
  role: "bank_officer" | "bank_supervisor" | "custom";
  branch?: string;
  employee_id?: string;
  /** Which bank_custom_roles profile, when role === "custom". */
  custom_role_id?: string;
  /** Full desired permission set. Omit to take the role default untouched. */
  permissions?: string[];
}): Promise<{ user: CreatedUser }> {
  return authFetch(`/api/bank/admin/users`, { method: "POST", body: JSON.stringify(body) }, "bank");
}

export async function updateUser(
  userId: string,
  body: Partial<{
    email: string;
    full_name: string;
    role: BankRole;
    custom_role_label: string;
    /** Which bank_custom_roles profile, when role === "custom". */
    custom_role_id: string;
    branch: string;
  }>,
): Promise<{ user: BankUser }> {
  return authFetch(`/api/bank/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(body) }, "bank");
}

export async function suspendUser(userId: string): Promise<{ status: string; seats: SeatUsage }> {
  return authFetch(`/api/bank/admin/users/${userId}/suspend`, { method: "POST" }, "bank");
}

export async function restoreUser(userId: string): Promise<{ status: string; seats: SeatUsage }> {
  return authFetch(`/api/bank/admin/users/${userId}/restore`, { method: "POST" }, "bank");
}

export async function deleteUser(userId: string): Promise<{ status: string; seats: SeatUsage }> {
  return authFetch(`/api/bank/admin/users/${userId}`, { method: "DELETE" }, "bank");
}

// ── invites ──────────────────────────────────────────────────────────────
export async function inviteUser(body: {
  email: string;
  full_name: string;
  role: BankRole;
  custom_role_label?: string;
  branch?: string;
  employee_id?: string;
  /** Which bank_custom_roles profile, when role === "custom". */
  custom_role_id?: string;
  /** Full desired permission set; stored on the invite and applied on acceptance. */
  permissions?: string[];
}): Promise<{ invite: PendingInvite; invite_url: string; email_sent: boolean }> {
  return authFetch(`/api/bank/admin/invites`, { method: "POST", body: JSON.stringify(body) }, "bank");
}

export async function resendInvite(inviteId: string): Promise<{ invite_url: string; email_sent: boolean }> {
  return authFetch(`/api/bank/admin/invites/${inviteId}/resend`, { method: "POST" }, "bank");
}

export async function revokeInvite(inviteId: string): Promise<{ status: string; seats: SeatUsage }> {
  return authFetch(`/api/bank/admin/invites/${inviteId}`, { method: "DELETE" }, "bank");
}

// ── activity ───────────────────────────────────────────────────────────────
export interface ActivityEntry {
  id: string;
  actor_name: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  target_user_id: string | null;
  created_at: string;
}

export async function listActivity(targetUserId?: string, limit = 50): Promise<{ entries: ActivityEntry[] }> {
  const p = new URLSearchParams({ limit: String(limit) });
  if (targetUserId) p.set("target_user_id", targetUserId);
  return authFetch(`/api/bank/admin/activity?${p.toString()}`, {}, "bank");
}

// ── usage & call statistics (Step 4b) ───────────────────────────────────────
export interface QuotaInfo {
  quota: number;
  consumed: number;
  remaining: number;
  fraction: number;
  pace_fraction: number;
  days_total: number;
  days_elapsed: number;
  days_remaining: number;
  rate_per_day: number;
  projection: { date: string; days_before_end: number; rate_per_day: number } | null;
  exceeded: boolean;
  credit_balance: number;
  credit_floor: number;
  period: { from: string; to: string };
}

export interface UsageSummary {
  calls_placed: number;
  answered: number;
  connect_rate: number;
  avg_duration_sec: number;
  promise_to_pay: number;
  wrong_contact: number;
  outcomes: { status: string; count: number }[];
  branch_note: string | null;
}

export interface BranchStat {
  branch: string;
  calls: number;
  minutes: number;
  answered: number;
  connect_rate: number;
}

export interface UsageCall {
  id: string;
  customer_name: string | null;
  phone: string | null;
  loan_type: string | null;
  loan_amount: number | null;
  status: string;
  category: string | null;
  call_duration: number | null;
  form_sent: boolean;
  recording_url: string | null;
  started_at: string | null;
  created_at: string;
}

export interface UsageCallsResponse {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  calls: UsageCall[];
}

type DateRange = { date_from?: string; date_to?: string };

function rangeQs(r?: DateRange, extra?: Record<string, string>): string {
  const p = new URLSearchParams();
  if (r?.date_from) p.set("date_from", r.date_from);
  if (r?.date_to) p.set("date_to", r.date_to);
  for (const [k, v] of Object.entries(extra || {})) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export async function getQuota(r?: DateRange): Promise<QuotaInfo> {
  return authFetch(`/api/bank/admin/usage/quota${rangeQs(r)}`, {}, "bank");
}

export async function getUsageSummary(r?: DateRange, branch?: string): Promise<UsageSummary> {
  return authFetch(`/api/bank/admin/usage/summary${rangeQs(r, branch ? { branch } : undefined)}`, {}, "bank");
}

export async function getByBranch(r?: DateRange): Promise<{ branches: BranchStat[] }> {
  return authFetch(`/api/bank/admin/usage/by-branch${rangeQs(r)}`, {}, "bank");
}

export async function getUsageCalls(
  page: number,
  r?: DateRange,
  status?: string,
  pageSize = 10,
): Promise<UsageCallsResponse> {
  const extra: Record<string, string> = { page: String(page), page_size: String(pageSize) };
  if (status) extra.status = status;
  return authFetch(`/api/bank/admin/usage/calls${rangeQs(r, extra)}`, {}, "bank");
}

// CSV export — returns the endpoint URL to open (the browser handles the download
// via the auth cookie). The token is sent as a header by authFetch, but for a
// direct download we hit the URL through fetch and build a blob.
export async function exportUsageCsv(r?: DateRange, status?: string): Promise<{ blob: Blob; filename: string }> {
  const { API_URL } = await import("@/lib/api");
  const { getAccessToken } = await import("@/lib/auth");
  const token = getAccessToken("bank");
  const res = await fetch(`${API_URL}/api/bank/admin/usage/export${rangeQs(r, status ? { status } : undefined)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  if (!res.ok) throw new Error("Export failed");
  // Use the server's range-based filename (calls_YYYYMMDD_YYYYMMDD.csv) rather
  // than a hardcoded "calls.csv", so the download reflects the exported period.
  const cd = res.headers.get("content-disposition") || "";
  const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  const filename = m ? decodeURIComponent(m[1].replace(/"$/, "")) : "usage_calls.csv";
  return { blob: await res.blob(), filename };
}

// ── settings (Step 4c) ───────────────────────────────────────────────────────
export interface NotificationRow {
  event: string;
  template: string | null;
  recipients: string;
}

export interface EditableSettings {
  bank_id: string;
  calling_window_start: string;
  calling_window_end: string;
  max_retries_per_day: number;
  caller_id_pool: string | null;
  pause_outbound: boolean;
  second_approver_threshold: number;
  maker_checker_differ: boolean;
  branch_scoping: boolean;
  auto_approve_score: number;
  weight_change_needs_approval: boolean;
  notifications: NotificationRow[];
  updated_at: string | null;
  updated_by_name: string | null;
}

export interface ManagedSettings {
  recording_retention_days: number;
  pii_redaction: boolean;
  seat_cap: number;
  minute_quota: number;
  account_manager: string;
}

export interface SettingsResponse {
  editable: EditableSettings;
  managed: ManagedSettings;
  scorecard_version: { updated_at: string | null } | null;
  changed_by: string | null;
  changed_at: string | null;
}

export type SettingsPatch = Partial<Omit<EditableSettings, "bank_id" | "updated_at" | "updated_by_name">>;

export async function getSettings(): Promise<SettingsResponse> {
  return authFetch(`/api/bank/admin/settings`, {}, "bank");
}

export async function saveSettings(patch: SettingsPatch): Promise<SettingsResponse> {
  return authFetch(`/api/bank/admin/settings`, { method: "PUT", body: JSON.stringify(patch) }, "bank");
}

export async function requestChange(item: string, message?: string): Promise<unknown> {
  return authFetch(`/api/bank/admin/change-requests`, { method: "POST", body: JSON.stringify({ item, message }) }, "bank");
}


// ── permissions ──────────────────────────────────────────────────────────────
// The console shows a matrix per user: every permission, whether the role grants
// it by default, and whether this person has an explicit exception. `source` is
// what lets the UI distinguish "inherited" from "deliberately changed".

export type PermissionSource = "role" | "granted" | "revoked" | "none";

export interface PermissionRow {
  permission_code: string;
  category: string;
  description: string;
  is_dangerous: boolean;
  role_default: boolean;
  allowed: boolean;
  source: PermissionSource;
  reason?: string | null;
}

export interface PermissionCatalogue {
  permissions: Omit<PermissionRow, "role_default" | "allowed" | "source" | "reason">[];
  /** role -> default permission codes. Prefills the grid before a user exists. */
  role_defaults: Record<string, string[]>;
}

export async function getPermissionCatalogue(): Promise<PermissionCatalogue> {
  return authFetch(`/api/bank/admin/permissions/catalogue`, {}, "bank");
}

export async function getUserPermissions(
  userId: string,
): Promise<{ user_id: string; role: string; permissions: PermissionRow[] }> {
  return authFetch(`/api/bank/admin/users/${userId}/permissions`, {}, "bank");
}

export async function setUserPermissions(
  userId: string,
  permissions: string[],
  reason?: string,
): Promise<{ user_id: string; role: string; permissions: PermissionRow[]; granted: string[]; revoked: string[] }> {
  return authFetch(
    `/api/bank/admin/users/${userId}/permissions`,
    { method: "PUT", body: JSON.stringify({ permissions, reason }) },
    "bank",
  );
}

// ── change requests ──────────────────────────────────────────────────────────
// Settings that Virtual Galaxy controls under the bank's contract (seat cap,
// minute quota, retention) cannot be self-served. This files a request against
// one; it never auto-applies.
export async function createChangeRequest(
  item: string,
  message?: string,
): Promise<{ request: { id: string; item: string; message: string | null; created_at: string } }> {
  return authFetch(
    `/api/bank/admin/change-requests`,
    { method: "POST", body: JSON.stringify({ item, message }) },
    "bank",
  );
}

export interface ChangeRequestRow {
  id: string;
  item: string;
  message: string | null;
  status: "open" | "resolved" | "declined";
  requested_by_name: string | null;
  created_at: string;
}

// The counterpart to createChangeRequest (BAD-11): so a filed request doesn't
// vanish after the "sent" toast — the admin can see its state and outcome.
export async function listChangeRequests(): Promise<{ change_requests: ChangeRequestRow[] }> {
  return authFetch(`/api/bank/admin/change-requests`, {}, "bank");
}

// ── custom roles ("profiles") ────────────────────────────────────────────────
// A bank-defined role: a name, a description, and its own default permission
// set. Replaces the two hard-coded ROLE_OPTIONS entries that carried no rights.

export interface CustomRole {
  id: string;
  name: string;
  description?: string | null;
  permissions: string[];
  /** How many active users hold it — delete is refused while non-zero. */
  user_count: number;
  created_at?: string;
}

export async function listCustomRoles(): Promise<{ roles: CustomRole[] }> {
  return authFetch(`/api/bank/admin/custom-roles`, {}, "bank");
}

export async function createCustomRole(body: {
  name: string;
  description?: string;
  permissions: string[];
}): Promise<{ role: CustomRole }> {
  return authFetch(
    `/api/bank/admin/custom-roles`,
    { method: "POST", body: JSON.stringify(body) },
    "bank",
  );
}

export async function updateCustomRole(
  roleId: string,
  body: { name: string; description?: string; permissions: string[] },
): Promise<{ roles: CustomRole[] }> {
  return authFetch(
    `/api/bank/admin/custom-roles/${roleId}`,
    { method: "PUT", body: JSON.stringify(body) },
    "bank",
  );
}

export async function deleteCustomRole(roleId: string): Promise<{ deleted: string }> {
  return authFetch(`/api/bank/admin/custom-roles/${roleId}`, { method: "DELETE" }, "bank");
}
