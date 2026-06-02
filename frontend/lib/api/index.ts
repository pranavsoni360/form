// lib/api/index.ts — central API config + barrel re-export for all role modules.
//
// Existing code uses flat imports like:
//   import { API_URL, adminLogin, getBanks, STATUS_LABELS, formatCurrency } from '@/lib/api';
// These continue to work via the barrel re-exports below.
//
// New code should prefer the modular imports:
//   import { adminLogin } from '@/lib/api/admin';
//   import { getBankApplications } from '@/lib/api/bank';
//   import { getVendorStats } from '@/lib/api/vendor';
//   import { aadhaarLink } from '@/lib/api/apply';

// ── Core config ──────────────────────────────────────────────

// Per-host API base so ONE build serves every domain correctly:
//  • finix.vgipl.com (and any nginx-fronted host) → same-origin; nginx routes /api → backend:8200
//  • virtualvaani.vgipl.com → direct backend on :8200 (legacy, no nginx front)
//  • localhost dev → local backend
// SSR (no window) falls back to NEXT_PUBLIC_API_URL or the finix origin.
export const API_URL = (() => {
  if (typeof window === "undefined") {
    return process.env.NEXT_PUBLIC_API_URL || "https://finix.vgipl.com";
  }
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return "http://localhost:8200";
  if (host === "virtualvaani.vgipl.com") return "https://virtualvaani.vgipl.com:8200";
  // finix.vgipl.com and any future nginx-fronted domain: same-origin.
  return `${window.location.protocol}//${window.location.host}`;
})();

// ── Fetch helpers used by every role module ──────────────────

export async function apiFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Request failed");
  return data;
}

export function authHeaders(token: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

// ── Barrel re-exports for backward compat ────────────────────

export {
  adminLogin,
  getAdminStats,
  seedMockData,
  getBanks,
  createBank,
  updateBank,
  getBankDetail,
  createBankUser,
  updateBankUser,
  deactivateBankUser,
  getAdminApplications,
  adminGetApplicationDetail,
  reviewApplication,
  getApplications,
} from "./admin";

export {
  bankLogin,
  getMe,
  authLogout,
  getBankApplications,
  getApplicationDetail,
  officerApprove,
  officerReject,
  getSupervisorApplications,
  supervisorApprove,
  supervisorReject,
  requestDocuments,
  initiateDisbursement,
} from "./bank";

export {
  requestOTP,
  verifyOTPSession,
  sendOTP,
  verifyOTP,
  getApplication,
  autoSaveSession,
  verifyPANSession,
  submitFormSession,
  uploadDocumentSession,
  aadhaarLink,
  aadhaarDocuments,
  aadhaarDownload,
  validateToken,
  autoSave,
  uploadDocument,
  verifyPAN,
  verifyAadhaar,
  submitForm,
  getCodeList,
} from "./apply";

export {
  // vendor self-serve
  vendorLogin,
  getVendorMe,
  getVendorApplications,
  getVendorApplicationDetail,
  vendorAccept,
  vendorReject,
  vendorDisburse,
  getVendorSettlements,
  // admin-facing vendor CRUD
  adminListVendors,
  adminGetVendor,
  adminCreateVendor,
  adminUpdateVendor,
  adminDeactivateVendor,
  adminCreateVendorUser,
  // partnerships
  adminListPartnerships,
  adminCreatePartnership,
  adminUpdatePartnership,
  adminTerminatePartnership,
  // bank-side
  bankListPartneredVendors,
  bankAssignVendor,
  bankWithdrawAssignment,
  bankGetAssignmentHistory,
} from "./vendor";

// ── Utility re-exports for backward compat ───────────────────
// Existing pages import STATUS_LABELS / formatCurrency / etc. directly from
// '@/lib/api'. We forward them from the new utils/ modules so those imports
// keep resolving. New code should import from '@/lib/utils/*' directly.

export {
  formatCurrency,
  formatDate,
  formatDateTime,
  maskPAN,
  maskAadhaar,
} from "../utils/formatters";

export {
  validatePANFormat,
  validateAadhaarFormat,
} from "../utils/validators";

export {
  STATUS_LABELS,
  STATUS_COLORS,
  SUGGESTION_COLORS,
} from "../utils/statusConfig";
