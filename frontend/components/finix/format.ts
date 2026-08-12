// Finix data formatting (design_handoff_finix/README.md §Data formatting).
//
// Currency in Indian numbering (₹4.61L, ₹1,05,000, ₹2.4Cr); times 24-hour;
// dates DD MMM YYYY; durations m:ss. Kept dependency-free and pure so it can be
// used from both server and client components.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 2-2-3 comma grouping, e.g. 105000 → "1,05,000". Integer part only. */
export function groupIndian(n: number): string {
  const neg = n < 0;
  const s = Math.abs(Math.trunc(n)).toString();
  if (s.length <= 3) return (neg ? "-" : "") + s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + "," + last3;
}

/**
 * Indian currency. Above ₹1,00,00,000 → crore (₹2.4Cr); above ₹1,00,000 →
 * lakh (₹4.61L, ₹12.48L); otherwise grouped rupees (₹1,05,000). `compact`
 * (default true) uses L/Cr abbreviations; false always groups in full.
 */
export function formatINR(value: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (value == null || Number.isNaN(value)) return "—";
  const { compact = true } = opts;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (compact && abs >= 1_00_00_000) {
    return `${sign}₹${trimZeros(abs / 1_00_00_000)}Cr`;
  }
  if (compact && abs >= 1_00_000) {
    return `${sign}₹${trimZeros(abs / 1_00_000)}L`;
  }
  return `${sign}₹${groupIndian(abs)}`;
}

/** Two decimals, trailing zeros trimmed: 4.61 → "4.61", 12.5 → "12.5", 3 → "3". */
function trimZeros(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/** DD MMM YYYY — "18 Jul 2026". Accepts Date | ISO string | epoch ms. */
export function formatDate(input: Date | string | number | null | undefined): string {
  const d = toDate(input);
  if (!d) return "—";
  return `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** 24-hour HH:MM — "14:32". */
export function formatTime(input: Date | string | number | null | undefined): string {
  const d = toDate(input);
  if (!d) return "—";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "20 Aug 2026 14:31". */
export function formatDateTime(input: Date | string | number | null | undefined): string {
  const d = toDate(input);
  if (!d) return "—";
  return `${formatDate(d)} ${formatTime(d)}`;
}

/** Duration in seconds → m:ss (monospace at the call site). */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds) || seconds < 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${pad2(s)}`;
}

/** One decimal when derived (78.8%), whole when the value is already integral. */
export function formatPct(value: number | null | undefined, opts: { derived?: boolean } = {}): string {
  if (value == null || Number.isNaN(value)) return "—";
  const { derived = true } = opts;
  return derived && !Number.isInteger(value) ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function toDate(input: Date | string | number | null | undefined): Date | null {
  if (input == null) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}
