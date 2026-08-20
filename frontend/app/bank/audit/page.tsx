"use client";

import { BankUserShell } from "../_shell/BankUserShell";
import { BankAuditView } from "@/components/audit/BankAuditView";

export default function BankBranchAuditPage() {
  return (
    <BankUserShell>
      <BankAuditView scopeLabel="your branch" />
    </BankUserShell>
  );
}
