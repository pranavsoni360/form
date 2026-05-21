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

export const API_URL =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "http://localhost:8200"
    : process.env.NEXT_PUBLIC_API_URL || "https://virtualvaani.vgipl.com:8200";

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
  vendorLogin,
  getVendorApplications,
  getVendorApplicationDetail,
  vendorDisburse,
  vendorReject,
  getVendorSettlements,
  getVendorStats,
  getVendors,
  createVendor,
  updateVendor,
  assignApplicationToVendor,
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
