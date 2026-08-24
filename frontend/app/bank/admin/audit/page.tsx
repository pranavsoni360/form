"use client";

import { BankAdminShell } from "../shell";
import { BankAuditView } from "@/components/audit/BankAuditView";

export default function BankAdminAuditPage() {
  return (
    <BankAdminShell>
      <BankAuditView scopeLabel="your bank (all branches)" />
    </BankAdminShell>
  );
}
