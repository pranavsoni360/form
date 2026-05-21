// lib/utils/constants.ts — app-wide constants

export const ROLES = {
  ADMIN: "admin",
  BANK_OFFICER: "officer",
  BANK_SUPERVISOR: "supervisor",
  VENDOR: "vendor",
} as const;

export const TOKEN_KEYS = {
  ADMIN: "los_admin_token",
  BANK: "los_bank_token",
  VENDOR: "los_vendor_token",
  APPLICANT: "loan_session",
} as const;

export const SESSION_KEYS = {
  LOAN_SESSION: "loan_session",
  SESSION_EXPIRY: "session_expiry",
} as const;

export const INACTIVITY_WARNING_MS = 4 * 60 * 1000; // 4 min
export const INACTIVITY_LOGOUT_MS = 5 * 60 * 1000; // 5 min
export const AUTOSAVE_DEBOUNCE_MS = 2000; // 2s
export const OTP_MAX_ATTEMPTS = 3;
export const OTP_BLOCK_MINUTES = 60;

export const CLOUDFRONT_URL = "https://d3jt6ku4g6z5l8.cloudfront.net";
