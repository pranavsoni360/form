// Shared status badge for vendor portal — colors match assignment lifecycle.
export function VendorStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-amber-100 text-amber-700",
    accepted: "bg-blue-100 text-blue-700",
    disbursed: "bg-emerald-100 text-emerald-700",
    vendor_rejected: "bg-rose-100 text-rose-700",
    withdrawn: "bg-slate-100 text-slate-700",
  };
  const cls = map[status] || "bg-slate-100 text-slate-700";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium ${cls}`}>
      {status.replace("_", " ")}
    </span>
  );
}
