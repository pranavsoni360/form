// lib/auth/roles.ts — role + permissions registry shared across all portals.

export const ROLES = {
  ADMIN: "admin",
  BANK_OFFICER: "officer",
  BANK_SUPERVISOR: "supervisor",
  VENDOR: "vendor",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

// Three auth contexts in the app. Each has its own localStorage keys + login
// page + dashboard landing. Customers (apply portal) use a separate session
// token system handled via lib/api/apply.ts (not via this auth type).
export type AuthType = "admin" | "bank" | "vendor";

export const TOKEN_KEYS: Record<AuthType, string> = {
  admin: "los_admin_token",
  bank: "los_bank_token",
  vendor: "los_vendor_token",
};

export const USER_KEYS: Record<AuthType, string> = {
  admin: "los_admin_user",
  bank: "los_bank_user",
  vendor: "los_vendor_user",
};

export const LOGIN_PATHS: Record<AuthType, string> = {
  admin: "/admin/login",
  bank: "/bank/login",
  vendor: "/vendor/login",
};

export const DASHBOARD_PATHS: Record<AuthType, string> = {
  admin: "/admin/dashboard",
  bank: "/bank/dashboard",
  vendor: "/vendor/dashboard",
};

// Permission matrix per role. Use hasPermission(user.role, 'action:disburse')
// to gate UI / actions. Centralising this means adding a new permission lands
// in one place across the whole codebase.
export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: [
    "view:all_applications",
    "manage:banks",
    "manage:vendors",
    "manage:users",
    "view:stats",
  ],
  officer: [
    "view:assigned_applications",
    "action:officer_approve",
    "action:officer_reject",
    "action:request_documents",
  ],
  supervisor: [
    "view:all_bank_applications",
    "action:officer_approve",
    "action:officer_reject",
    "action:supervisor_approve",
    "action:supervisor_reject",
    "action:request_documents",
    "action:disburse",
  ],
  vendor: [
    "view:assigned_applications",
    "action:disburse",
    "action:vendor_reject",
    "view:settlements",
  ],
};

export function hasPermission(role: Role, permission: string): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
