// Human-readable descriptions for audit entries.
//
// The audit stores keep raw, forensic data (HTTP method + endpoint, action codes
// like "bank.create"). Bank staff are not technical, so the dashboards render
// these through the describers below — plain-English sentences — while the raw
// values stay untouched in the database. Display-layer only.

/** Normalize an endpoint so ids/uuids/tokens collapse to ":id" for matching. */
function normPath(endpoint: string): string {
  return (endpoint || "")
    .split("?")[0]
    .replace(/\/+$/, "")
    .split("/")
    .map((seg) => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(seg)) return ":id"; // uuid
      if (/^\d+$/.test(seg)) return ":id"; // numeric id
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ":id"; // long hex / token
      return seg;
    })
    .join("/");
}

// Exact "METHOD /normalized/path" -> friendly sentence.
const ACTIVITY_MAP: Record<string, string> = {
  // Loan decisions
  "POST /api/bank/applications/:id/officer-approve": "Loan officer approved an application",
  "POST /api/bank/applications/:id/officer-reject": "Loan officer rejected an application",
  "POST /api/bank/applications/:id/supervisor-approve": "Supervisor approved an application",
  "POST /api/bank/applications/:id/supervisor-reject": "Supervisor rejected an application",
  "POST /api/bank/applications/:id/request-documents": "Requested additional documents from the customer",
  "POST /api/bank/applications/:id/disburse": "Initiated loan disbursement",
  "POST /api/bank/applications/:id/cancel": "Cancelled a loan application",
  "POST /api/bank/applications/:id/assign-vendor": "Assigned the application to a vendor",
  "POST /api/bank/applications/:id/withdraw-assignment": "Withdrew a vendor assignment",
  // Platform: banks & users
  "POST /api/admin/banks": "Created a new bank",
  "PUT /api/admin/banks/:id": "Updated bank details",
  "POST /api/admin/banks/:id/users": "Created a bank user",
  "PUT /api/admin/banks/:id/users/:id": "Updated a bank user",
  "DELETE /api/admin/banks/:id/users/:id": "Deactivated a bank user",
  // Platform: vendors & partnerships & scorecard
  "POST /api/admin/vendors": "Added a vendor",
  "PATCH /api/admin/vendors/:id": "Updated a vendor",
  "DELETE /api/admin/vendors/:id": "Deactivated a vendor",
  "POST /api/admin/vendors/:id/users": "Created a vendor user",
  "PATCH /api/admin/vendors/:id/users/:id": "Updated a vendor user",
  "POST /api/admin/partnerships": "Created a bank–vendor partnership",
  "PATCH /api/admin/partnerships/:id": "Updated a bank–vendor partnership",
  "DELETE /api/admin/partnerships/:id": "Ended a bank–vendor partnership",
  "PUT /api/lrs/config": "Updated the credit scorecard",
  "POST /api/lrs/rescore/:id": "Re-scored an application",
  "POST /api/lrs/rescore-pending": "Re-scored all pending applications",
  // Bank admin: users / roles / invites / settings
  "POST /api/bank/admin/users": "Created a user",
  "PATCH /api/bank/admin/users/:id": "Updated a user",
  "POST /api/bank/admin/users/:id/suspend": "Suspended a user",
  "POST /api/bank/admin/users/:id/restore": "Restored a user",
  "DELETE /api/bank/admin/users/:id": "Removed a user",
  "PUT /api/bank/admin/users/:id/permissions": "Changed a user's permissions",
  "POST /api/bank/admin/invites": "Sent a user invitation",
  "POST /api/bank/admin/invites/:id/resend": "Resent a user invitation",
  "DELETE /api/bank/admin/invites/:id": "Revoked a user invitation",
  "POST /api/bank/admin/custom-roles": "Created a role",
  "PUT /api/bank/admin/custom-roles/:id": "Updated a role",
  "DELETE /api/bank/admin/custom-roles/:id": "Deleted a role",
  "PUT /api/bank/admin/settings": "Updated bank settings",
  "POST /api/bank/admin/change-requests": "Submitted a configuration change request",
  // Auth
  "POST /api/admin/login": "Admin sign-in attempt",
  "POST /api/auth/admin-login": "Admin sign-in attempt",
  "POST /api/auth/bank-login": "User sign-in attempt",
  "POST /api/auth/logout": "Signed out",
  "POST /api/auth/admin-change-password": "Changed account password",
  // Customer application flow
  "POST /api/generate-form-links": "Generated a loan application link",
  "POST /api/send-otp": "Sent a one-time password (OTP)",
  "POST /api/request-otp": "Sent a one-time password (OTP)",
  "POST /api/verify-otp": "Verified a one-time password (OTP)",
  "POST /api/verify-otp-session": "Verified a one-time password (OTP)",
  "POST /api/verify-pan": "Verified PAN details",
  "POST /api/verify-pan-session": "Verified PAN details",
  "POST /api/verify-aadhaar": "Verified Aadhaar details",
  "POST /api/verify-aadhaar-session": "Verified Aadhaar details",
  "POST /api/upload-document": "Uploaded a document",
  "POST /api/upload-document-session": "Uploaded a document",
  "POST /api/submit-form": "Customer submitted the application form",
  "POST /api/submit-form-session": "Customer submitted the application form",
  "POST /api/withdraw-application": "Customer withdrew the application",
  "POST /api/autosave": "Saved application progress",
  "POST /api/autosave-session": "Saved application progress",
  // Calling / agent
  "POST /api/agent/upload-excel": "Uploaded a calling list",
  "POST /api/agent/batch-call": "Started a calling batch",
  "POST /api/agent/batch-retry": "Retried a calling batch",
  "POST /api/agent/emergency-stop": "Emergency-stopped all calling",
  "POST /api/agent/resume-calling": "Resumed calling",
  "POST /api/agent/stop-batch": "Stopped a calling batch",
  "PUT /api/agent/calls/:id/categorize": "Categorised a call",
  "POST /api/agent/schedule-callback-manual": "Scheduled a callback",
  // Vendor side
  "POST /api/vendor/assignments/:id/accept": "Vendor accepted an assignment",
  "POST /api/vendor/assignments/:id/reject": "Vendor rejected an assignment",
  "POST /api/vendor/assignments/:id/disburse": "Vendor disbursed a loan",
};

function titleCase(s: string): string {
  return s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

/** Plain-English sentence for a raw activity_log row (method + endpoint). */
export function describeActivity(method: string, endpoint: string): string {
  const key = `${(method || "").toUpperCase()} ${normPath(endpoint)}`;
  if (ACTIVITY_MAP[key]) return ACTIVITY_MAP[key];
  // Fallback: humanize from the path. Last non-:id segment is the verb/resource.
  const segs = normPath(endpoint).split("/").filter((s) => s && s !== "api" && s !== ":id");
  const last = segs[segs.length - 1] || "";
  const resource = segs.length > 1 ? segs[segs.length - 2] : segs[0] || "record";
  const verbByMethod: Record<string, string> = { POST: "Created", PUT: "Updated", PATCH: "Updated", DELETE: "Removed" };
  // If the last segment looks like an action verb (e.g. "officer-approve"), use it.
  if (last && !["applications", "banks", "users", "vendors", "partnerships"].includes(last)) {
    return `${titleCase(last)} — ${titleCase(resource)}`;
  }
  return `${verbByMethod[(method || "").toUpperCase()] || "Actioned"} — ${titleCase(last || resource)}`;
}

// Platform action codes (platform_audit_log.action) -> friendly sentence.
const PLATFORM_MAP: Record<string, string> = {
  "bank.create": "Created a new bank",
  "bank.update": "Updated bank details",
  "bank.suspend": "Suspended a bank",
  "bank_user.create": "Created a bank user",
  "bank_user.update": "Updated a bank user",
  "bank_user.deactivate": "Deactivated a bank user",
  "vendor.create": "Added a vendor",
  "vendor.update": "Updated a vendor",
  "vendor.deactivate": "Deactivated a vendor",
  "partnership.create": "Created a bank–vendor partnership",
  "partnership.update": "Updated a bank–vendor partnership",
  "scorecard.publish": "Published a new credit scorecard",
};
export function describePlatformAction(action: string): string {
  return PLATFORM_MAP[action] || titleCase(action || "");
}

// Officer decision codes (officer_action_log.action) -> friendly verb.
const OFFICER_MAP: Record<string, string> = {
  approve: "Approved the loan",
  reject: "Rejected the loan",
  request_documents: "Requested documents",
  documents_received: "Marked documents received",
  disburse: "Disbursed the loan",
  cancel: "Cancelled the loan",
  withdraw: "Withdrew the application",
  reassign: "Reassigned the application",
  note: "Added a note",
  reopen: "Reopened the application",
};
export function describeOfficerAction(action: string): string {
  return OFFICER_MAP[action] || titleCase(action || "");
}

// Security event types -> friendly label (titles are already descriptive; this
// is for the small "type" line).
const SECURITY_MAP: Record<string, string> = {
  new_device_login: "New device sign-in",
  new_location_login: "New location sign-in",
  off_hours_login: "Off-hours sign-in",
  failed_login_burst: "Repeated failed sign-ins",
  privilege_change: "Permission change",
  blocked_internal_path: "Blocked suspicious request",
  mass_sensitive_access: "Unusual volume of data access",
  system_error: "System error",
};
export function describeSecurityType(t: string): string {
  return SECURITY_MAP[t] || titleCase(t || "");
}

// Sensitive-access action codes (audit_logs.action) -> friendly label.
const SENSITIVE_MAP: Record<string, string> = {
  view_aadhaar: "Viewed a customer's Aadhaar number",
  view_recording: "Played a call recording",
  export_all_calls: "Exported the full call data",
  export_daily_report: "Exported the daily report",
  vendor_disburse: "Recorded a loan disbursement",
  guarantor_consent: "Recorded guarantor consent",
  whatsapp_campaign_sent: "Sent a WhatsApp message to a customer",
  whatsapp_campaign_bulk: "Sent a bulk WhatsApp campaign",
  call_completed: "AI call completed",
};
export function describeSensitive(action: string): string {
  return SENSITIVE_MAP[action] || titleCase(action || "");
}
