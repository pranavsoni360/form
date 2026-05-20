/**
 * PII redaction for Sentry events — mirrors backend/main.py::_scrub_pii so
 * frontend + backend events have consistent masking. Order matters: PAN's
 * 5-letter prefix can never collide with a phone, but the deterministic
 * order makes this trivial to reason about.
 */
const PII_PATTERNS: Array<[RegExp, string]> = [
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[PAN_REDACTED]"],
  [/\+?(?:91[-\s]?)?[6-9]\d{9}\b/g, "[PHONE_REDACTED]"],
  [/\b\d{12}\b/g, "[AADHAAR_REDACTED]"],
  [/\b\d{4}\b(?=.*(?:otp|OTP))/g, "[OTP_REDACTED]"],
];

function scrubString(s: string): string {
  let out = s;
  for (const [pat, repl] of PII_PATTERNS) out = out.replace(pat, repl);
  return out;
}

function scrubValue(v: unknown): unknown {
  if (typeof v === "string") return scrubString(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v)) out[k] = scrubValue(vv);
    return out;
  }
  return v;
}

/**
 * Sentry `beforeSend` hook — never throws (we'd rather ship a noisy event
 * than break the SDK pipeline). Safe to use on every event.
 */
export function scrubSentryEvent<T>(event: T): T {
  try {
    return scrubValue(event) as T;
  } catch {
    return event;
  }
}
