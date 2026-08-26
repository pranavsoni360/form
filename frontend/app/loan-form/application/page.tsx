'use client';
import { Lock, CheckCircle2, Loader2, AlertTriangle, ShieldCheck, Eye, EyeOff, X, ExternalLink, User, Home, MapPin, Building2, Tag, ShoppingBag, CreditCard, Banknote, Users, RotateCcw, Clock } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import { FinixLogoMark } from '@/components/shared/FinixLogo';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';

import { API_URL, getCodeList } from '@/lib/api';
import { documentsFor, missingRequired, validateDocFile, wasAutoFilled, journeyState } from '@/lib/utils/loanDocuments';

// Absolute URL for a stored document/file path. Uploaded + DigiLocker files are
// served by the BACKEND. On the nginx-fronted host only /api/* is proxied to the
// backend, so a bare "/uploads/..." path resolves to the Next.js FRONTEND and
// 404s (the document-preview eye showed a 404 page). Route those through
// "/api/uploads" (also mounted on the backend) so previews work on every host.
// Absolute URLs and already-/api paths pass through unchanged.
const fileUrl = (p?: string | null): string => {
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  if (p.startsWith('/uploads/')) return `${API_URL}/api${p}`;
  return `${API_URL}${p}`;
};
// Server expires a loan session after LOAN_SESSION_INACTIVITY_SECONDS of
// inactivity (backend main.py; /api/get-application, /api/autosave-session and
// /api/session-keepalive all read the same constant).
//
// MUST match the backend. If this is shorter the customer sees a warning for an
// expiry that has not happened; if longer, the session dies with no warning at
// all and unsaved work is lost.
//
// Raised from 5 to 15 minutes: five minutes is punishing for a six-step form
// that asks people to find and upload a passport photo, salary slips and six
// months of bank statements. Switching to a banking app to download a PDF
// routinely takes longer than that.
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;  // 900s — MUST match backend
// Warn 2 minutes out rather than 1: with a longer window the customer is more
// likely to be away from the screen, so they need more time to come back.
const WARNING_WINDOW_MS = 2 * 60 * 1000;
const KEEPALIVE_THROTTLE_MS = 60 * 1000;    // at most one server ping per 60s of activity

// Format a save timestamp as full date + time, with a friendly Today/Yesterday
// prefix so an officer resuming days later can see WHEN they last worked.
// e.g. "Today, 12:10:59 PM" · "Yesterday, 12:10:59 PM" · "18 Jul 2026, 12:10:59 PM".
function formatSavedStamp(input: string | number | Date): string {
  const d = new Date(input);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
    .replace(/\b([ap])m\b/i, (m) => m.toUpperCase());   // "pm" → "PM" to match spec
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === yest.toDateString()) return `Yesterday, ${time}`;
  const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  return `${date}, ${time}`;
}

// ── Name similarity helpers ──────────────────────────────────────────────────
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function tokenSim(t1: string, t2: string): number {
  if (!t1 || !t2) return 0;
  const maxLen = Math.max(t1.length, t2.length);
  return maxLen === 0 ? 1 : (maxLen - levenshtein(t1, t2)) / maxLen;
}

function calcNameSimilarity(name1: string, name2: string): number {
  const norm = (s: string) => s.toLowerCase()
    .replace(/\b(mr|mrs|ms|dr|shri|smt|kumari)\b\.?/g, '')
    .replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  const n1 = norm(name1 || '');
  const n2 = norm(name2 || '');
  if (!n1 || !n2) return 100; // skip if either is missing
  if (n1 === n2) return 100;
  const t1 = n1.split(' ').filter(Boolean);
  const t2 = n2.split(' ').filter(Boolean);

  // Indian naming convention: middle name = father's name, should be ignored.
  // Only compare FIRST NAME + SURNAME (last token).
  // e.g. "Pranav Soni" vs "Pranav Nitin Soni" → first=Pranav, last=Soni → 100%
  const first1 = t1[0] || '';
  const last1  = t1.length > 1 ? t1[t1.length - 1] : '';
  const first2 = t2[0] || '';
  const last2  = t2.length > 1 ? t2[t2.length - 1] : '';

  const firstScore = tokenSim(first1, first2);

  // If one name has only a single token compare just first names
  if (!last1 || !last2) return Math.round(firstScore * 100);

  const lastScore = tokenSim(last1, last2);
  // Both first and last must match — weight them equally
  return Math.round((firstScore + lastScore) / 2 * 100);
}

export default function LoanApplication() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [appData, setAppData] = useState<any>(null);
  const [formData, setFormData] = useState<any>({});
  const [currentStep, setCurrentStep] = useState(1);
  const [highestStep, setHighestStep] = useState(1);
  const [panVerifying, setPanVerifying] = useState(false);
  const [showPan, setShowPan] = useState(false);
  const [aadhaarVerifying, setAadhaarVerifying] = useState(false);
  const [codeLists, setCodeLists] = useState<Record<number, {code_mst_id: string, code_desc: string}[]>>({});
  const [cityOptions, setCityOptions] = useState<{code_mst_id: string, code_desc: string}[]>([]);
  const [permCityOptions, setPermCityOptions] = useState<{code_mst_id: string, code_desc: string}[]>([]);
  const [nameMatchError, setNameMatchError] = useState<{source: string; callName: string; verifiedName: string; score: number} | null>(null);
  const [nameMatchDetail, setNameMatchDetail] = useState<{source: string; callName: string; verifiedName: string; score: number} | null>(null);
  const [nameMatchLocked, setNameMatchLocked] = useState(false);
  const [panMismatchWarning, setPanMismatchWarning] = useState<{callName: string; verifiedName: string; attemptsRemaining: number} | null>(null);
  const [pincodeLookingUp, setPincodeLookingUp] = useState<{ current: boolean; permanent: boolean }>({ current: false, permanent: false });
  const [pincodeValid, setPincodeValid] = useState<{ current: boolean; permanent: boolean }>({ current: true, permanent: true });
  // Per-document upload in flight — without this the customer can tap Upload
  // repeatedly on a slow connection and race several writes to the same column.
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  // The REAL inactivity window, learned from the server on load.
  // SESSION_TIMEOUT_MS is only a first-paint default: the backend reads
  // LOAN_SESSION_INACTIVITY_SECONDS from the environment, so if that is ever
  // tuned in a deployment the hardcoded 15 minutes would be wrong in the
  // dangerous direction — the client would promise time the server will not
  // honour and the session would die with no warning at all.
  const timeoutMsRef = useRef<number>(SESSION_TIMEOUT_MS);
  // Seconds left in the session, shown continuously in the header. The customer
  // is asked to leave the page to fetch a bank PDF; a visible clock is the only
  // way they can judge whether they have time before it expires.
  const [secondsLeft, setSecondsLeft] = useState<number>(Math.floor(SESSION_TIMEOUT_MS / 1000));

  const handleVerifyPAN = async () => {
    const pan = (formData.pan_number || '').trim();
    // Check mandatory FIRST, then format — an empty field should say "required",
    // not "invalid format".
    if (!pan) {
      setErrors((p: any) => ({ ...p, pan_number: 'PAN Number is required.' }));
      return;
    }
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan)) {
      setErrors((p: any) => ({ ...p, pan_number: 'Invalid PAN format (e.g. ABCDE1234F)' }));
      return;
    }
    setPanVerifying(true);
    try {
      const session = sessionStorage.getItem('loan_session');
      const res = await fetch(`${API_URL}/api/verify-pan-session?session_token=${session}&pan_number=${pan}`, { method: 'POST' });
      if (res.status === 423) {
        // Already locked by a previous session
        setNameMatchLocked(true);
        setPanMismatchWarning(null);
        setErrors((p: any) => ({ ...p, pan_number: '' }));
        return;
      }
      if (!res.ok) {
        // Surface the ACTUAL reason from the backend (e.g. "PAN not found in
        // government records", "service temporarily unavailable") instead of a
        // generic "Verification failed", so the customer knows what to do.
        const errData = await res.json().catch(() => ({}));
        const d = errData?.detail;
        const reason = typeof d === 'string' && d.trim()
          ? d
          : (typeof errData?.error === 'string' && errData.error.trim()
              ? errData.error
              : `Verification failed (error ${res.status})`);
        throw new Error(reason);
      }
      const data = await res.json();
      onChange('pan_verified', true);
      onChange('pan_verification_timestamp', new Date().toISOString());
      if (data.name) {
        const nameParts = data.name.trim().split(/\s+/);
        onChange('full_name', data.name);
        onChange('pan_name', data.name);
        if (nameParts.length >= 3) {
          onChange('first_name', nameParts[0]);
          onChange('middle_name', nameParts.slice(1, -1).join(' '));
          onChange('last_name', nameParts[nameParts.length - 1]);
        } else if (nameParts.length === 2) {
          onChange('first_name', nameParts[0]);
          onChange('last_name', nameParts[1]);
        } else {
          onChange('first_name', data.name);
        }
        // Set field_sources in React state so badges show immediately
        const panSources: Record<string, any> = {};
        if (nameParts[0]) panSources.first_name = { source: 'pan', original: nameParts[0], modified: false };
        if (nameParts.length > 2) panSources.middle_name = { source: 'pan', original: nameParts.slice(1, -1).join(' '), modified: false };
        if (nameParts.length > 1) panSources.last_name = { source: 'pan', original: nameParts[nameParts.length - 1], modified: false };
        panSources.full_name = { source: 'pan', original: data.name, modified: false };
        if (data.dob) panSources.date_of_birth = { source: 'pan', original: data.dob, modified: false };
        setFormData((p: any) => ({ ...p, field_sources: { ...(p.field_sources || {}), ...panSources } }));
      }
      // Auto-fill DOB from PAN (only if not already set by Aadhaar or user)
      if (data.dob && !formData.date_of_birth) {
        onChange('date_of_birth', data.dob);
      }
      if (data.name) {
        // Name match check: PAN name vs call-collected name
        const callName = appData?.customer_name || appData?.full_name || '';
        if (callName && data.name) {
          const score = calcNameSimilarity(callName, data.name);
          if (score < 85) {
            // Report mismatch to backend — it will track attempts and lock if needed
            const mismatchRes = await fetch(`${API_URL}/api/pan-mismatch?session_token=${session}`, { method: 'POST' });
            const mismatchData = mismatchRes.ok ? await mismatchRes.json() : { locked: true, attempts_remaining: 0 };
            // Reset pan_verified in local state so the field is editable again
            onChange('pan_verified', false);
            if (mismatchData.locked) {
              // Max retries exceeded — hard lock
              const err = { source: 'PAN Card', callName, verifiedName: data.name, score };
              setNameMatchError(err); setNameMatchDetail(err); setNameMatchLocked(true);
              setPanMismatchWarning(null);
            } else {
              // First mismatch — show retryable warning, keep field editable
              setPanMismatchWarning({ callName, verifiedName: data.name, attemptsRemaining: mismatchData.attempts_remaining });
              setNameMatchLocked(false);
              setNameMatchError(null);
            }
            return;
          } else {
            setNameMatchError(null); setNameMatchDetail(null); setNameMatchLocked(false);
            setPanMismatchWarning(null);
          }
        }
      }
      setErrors((p: any) => ({ ...p, pan_number: '' }));
    } catch (err: any) {
      setErrors((p: any) => ({ ...p, pan_number: err.message || 'PAN verification failed' }));
    } finally { setPanVerifying(false); }
  };

  const [digilockerStep, setDigilockerStep] = useState<'idle' | 'linking' | 'waiting' | 'fetching' | 'done'>('idle');
  const [aaUploadState, setAaUploadState] = useState<'idle' | 'initiating' | 'polling' | 'complete' | 'failed'>('idle');
  const [aaUploadError, setAaUploadError] = useState('');

  const handleAAStatementInitiate = async () => {
    setAaUploadState('initiating');
    setAaUploadError('');
    try {
      const session = getSession();
      const res = await fetch(`${API_URL}/api/aa-statement-initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: session }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Could not generate upload link');
      localStorage.setItem('aa_session_backup', session || '');
      window.location.href = data.url;
    } catch (err: any) {
      setAaUploadError(err.message || 'Could not generate upload link. Please try again.');
      setAaUploadState('idle');
    }
  };

  const handleVerifyAadhaar = async () => {
    setAadhaarVerifying(true);
    setDigilockerStep('linking');
    setErrors((p: any) => ({ ...p, aadhaar_number: '' }));
    try {
      const session = sessionStorage.getItem('loan_session');
      // Step 1: Get DigiLocker OAuth link — VG server contacts DigiLocker (can be slow)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 65000); // 65s client-side timeout
      const linkRes = await fetch(`${API_URL}/api/aadhaar-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: session }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const linkData = await linkRes.json();
      if (!linkRes.ok) throw new Error(linkData.detail || 'Failed to generate DigiLocker link');

      // Save state before redirecting to DigiLocker.
      // Store in both sessionStorage (same-tab) and localStorage (cross-tab fallback
      // for mobile browsers that open DigiLocker in a new tab).
      sessionStorage.setItem('digilocker_request_id', linkData.request_id);
      localStorage.setItem('digilocker_request_id', linkData.request_id);
      localStorage.setItem('digilocker_session_backup', session || '');

      // Redirect user to DigiLocker (not popup — popups get blocked)
      window.location.href = linkData.link;
    } catch (err: any) {
      const msg = err.name === 'AbortError'
        ? 'DigiLocker is taking too long to respond. Please try again.'
        : (err.message || 'Aadhaar verification failed');
      setErrors((p: any) => ({ ...p, aadhaar_number: msg }));
      setDigilockerStep('idle');
      setAadhaarVerifying(false);
    }
  };
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState('');
  const [resuming, setResuming] = useState(false);
  const [resumeStep, setResumeStep] = useState(1);
  const [previewDoc, setPreviewDoc] = useState<{ url: string; label: string } | null>(null);
  const [previewDisclaimer, setPreviewDisclaimer] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [agreed, setAgreed] = useState(false);
  // Summary of which required documents are still outstanding. Kept separate
  // from `errors` so it can name them all in one sentence at the top of the
  // step, rather than only marking each row.
  const [docError, setDocError] = useState('');
  const [errors, setErrors] = useState<any>({});
  const [inactivityWarning, setInactivityWarning] = useState(false);
  const [countdown, setCountdown] = useState(Math.floor(WARNING_WINDOW_MS / 1000));
  // Loan amount cap (₹1 lakh) — shows a small popup above the field when exceeded
  const [loanCapWarn, setLoanCapWarn] = useState(false);
  const loanCapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Inactivity tracking (refs so the 1s ticker + event handlers never go stale).
  const lastActivityRef = useRef<number>(Date.now());
  const lastKeepAliveRef = useRef<number>(Date.now());
  const warningShownRef = useRef<boolean>(false);

  const getSession = () => sessionStorage.getItem('loan_session');

  const logout = useCallback(() => {
    sessionStorage.removeItem('loan_session');
    sessionStorage.removeItem('session_expiry');
    warningShownRef.current = false;
    setInactivityWarning(false);
    setSessionExpired(true);   // → Re-Verify with OTP screen
  }, []);

  // Refresh the server's inactivity timer without pulling application data
  // (so unsaved form fields are never clobbered). A 401 means the session is
  // genuinely gone → send the user to re-verify.
  const pingKeepAlive = useCallback(async (): Promise<boolean> => {
    const s = getSession();
    if (!s) return false;
    try {
      const res = await fetch(`${API_URL}/api/session-keepalive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: s }),
      });
      if (res.status === 401) { logout(); return false; }
      return res.ok;
    } catch {
      return false;   // transient network blip — keep the client session, tick will retry
    }
  }, [logout]);

  // "Continue Session" — extend on the server, then reset the client counters.
  const continueSession = useCallback(async () => {
    const ok = await pingKeepAlive();
    if (!ok) return;   // logout() already fired on a hard 401
    lastActivityRef.current = Date.now();
    lastKeepAliveRef.current = Date.now();
    warningShownRef.current = false;
    setInactivityWarning(false);
  }, [pingKeepAlive]);

  // Explicit "Logout" from the warning — end the session and go to the start.
  const sessionLogout = useCallback(() => {
    sessionStorage.removeItem('loan_session');
    sessionStorage.removeItem('session_expiry');
    router.push('/');
  }, [router]);

  useEffect(() => {
    let session = getSession();
    // If DigiLocker opened a new tab and redirected back, sessionStorage is empty in the new tab.
    // Restore session from the localStorage backup we set before redirecting.
    if (!session) {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('digilocker') === 'success') {
        const backup = localStorage.getItem('digilocker_session_backup');
        if (backup) {
          sessionStorage.setItem('loan_session', backup);
          session = backup;
        }
      }
      if (!session && urlParams.get('aa_complete') === '1') {
        const backup = localStorage.getItem('aa_session_backup');
        if (backup) {
          sessionStorage.setItem('loan_session', backup);
          session = backup;
        }
      }
    }
    if (!session) { router.push('/loan-form'); return; }
    loadApplication();

    // Real user activity resets the idle clock. While the warning modal is up we
    // IGNORE passive activity — only the "Continue Session" button may extend, so
    // the countdown stays honest. A throttled server ping keeps the backend's
    // inactivity timer in sync with the client (prevents a sudden 401 with no warning).
    const bump = () => {
      if (warningShownRef.current) return;
      lastActivityRef.current = Date.now();
      const now = Date.now();
      if (now - lastKeepAliveRef.current > KEEPALIVE_THROTTLE_MS) {
        lastKeepAliveRef.current = now;
        pingKeepAlive();
      }
    };
    const events = ['mousedown', 'keypress', 'scroll', 'touchstart'];
    events.forEach(e => window.addEventListener(e, bump));

    // Single 1s ticker: drives the warning modal + live countdown + auto-expiry.
    const ticker = setInterval(() => {
      const remainingMs = timeoutMsRef.current - (Date.now() - lastActivityRef.current);
      setSecondsLeft(Math.max(0, Math.ceil(remainingMs / 1000)));
      if (remainingMs <= 0) { logout(); return; }
      if (remainingMs <= WARNING_WINDOW_MS) {
        warningShownRef.current = true;
        setInactivityWarning(true);
        setCountdown(Math.ceil(remainingMs / 1000));
      }
    }, 1000);

    return () => {
      events.forEach(e => window.removeEventListener(e, bump));
      clearInterval(ticker);
    };
  }, []);

  // Detect return from DigiLocker redirect
  useEffect(() => {
    // Support both same-tab (sessionStorage) and new-tab (localStorage) flows
    const requestId = sessionStorage.getItem('digilocker_request_id')
                   || localStorage.getItem('digilocker_request_id');
    if (!requestId || !appData) return;
    const session = getSession();
    if (!session) return;

    // Clear the flag immediately to prevent re-running
    sessionStorage.removeItem('digilocker_request_id');
    sessionStorage.removeItem('digilocker_aadhaar');
    localStorage.removeItem('digilocker_request_id');
    localStorage.removeItem('digilocker_session_backup');

    setDigilockerStep('fetching');
    setAadhaarVerifying(true);

    (async () => {
      try {
        // Step 2: Fetch available documents
        const docsRes = await fetch(`${API_URL}/api/aadhaar-documents`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_token: session, request_id: requestId }),
        });
        const docsData = await docsRes.json();
        if (!docsRes.ok) throw new Error(docsData.detail || 'Failed to fetch documents');

        // Step 3: Download and parse Aadhaar
        const dlRes = await fetch(`${API_URL}/api/aadhaar-download`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_token: session, request_id: requestId, uri: docsData.uri }),
        });
        const dlData = await dlRes.json();
        if (!dlRes.ok) throw new Error(dlData.detail || 'Failed to download Aadhaar');

        // Auto-fill form with DigiLocker verified data
        if (dlData.data) {
          const d = dlData.data;
          onChange('aadhaar_verified', true);
          onChange('aadhaar_last4', d.last4);
          onChange('aadhaar_verification_timestamp', new Date().toISOString());
          // Only fill name from Aadhaar if PAN hasn't already filled it
          if (d.name && !formData.pan_name) {
            onChange('full_name', d.name);
            const np = d.name.trim().split(/\s+/);
            if (np.length >= 3) { onChange('first_name', np[0]); onChange('middle_name', np.slice(1,-1).join(' ')); onChange('last_name', np[np.length-1]); }
            else if (np.length === 2) { onChange('first_name', np[0]); onChange('last_name', np[1]); }
            else { onChange('first_name', d.name); }
          }
          if (d.dob) onChange('date_of_birth', d.dob);
          if (d.gender) onChange('gender', d.gender);
          // Aadhaar address == permanent address, so fill the permanent_* fields.
          if (d.address) onChange('permanent_address', d.address);
          if (d.house) onChange('permanent_house', d.house);
          if (d.street) onChange('permanent_street', d.street);
          if (d.landmark) onChange('permanent_landmark', d.landmark);
          if (d.locality) onChange('permanent_locality', d.locality);
          if (d.pin) onChange('permanent_pincode', d.pin);
          if (d.state_code) { onChange('permanent_state_code', d.state_code); fetchCities(d.state_code, 'permanent'); }
          if (d.city_code) onChange('permanent_city_code', d.city_code);
          if (d.marital_status) onChange('marital_status', d.marital_status);
          // Set field_sources for Aadhaar badges
          const aadhaarSources: Record<string, any> = {};
          if (d.dob) aadhaarSources.date_of_birth = { source: 'aadhaar', original: d.dob, modified: false };
          if (d.gender) aadhaarSources.gender = { source: 'aadhaar', original: d.gender, modified: false };
          if (d.house) aadhaarSources.permanent_house = { source: 'aadhaar', original: d.house, modified: false };
          if (d.street) aadhaarSources.permanent_street = { source: 'aadhaar', original: d.street, modified: false };
          if (d.landmark) aadhaarSources.permanent_landmark = { source: 'aadhaar', original: d.landmark, modified: false };
          if (d.locality) aadhaarSources.permanent_locality = { source: 'aadhaar', original: d.locality, modified: false };
          if (d.pin) aadhaarSources.permanent_pincode = { source: 'aadhaar', original: d.pin, modified: false };
          if (d.state_code || d.state) aadhaarSources.permanent_state_code = { source: 'aadhaar', original: d.state || d.state_code, modified: false };
          if (d.city_code || d.district) aadhaarSources.permanent_city_code = { source: 'aadhaar', original: d.district || d.city_code, modified: false };
          if (d.marital_status) aadhaarSources.marital_status = { source: 'aadhaar', original: d.marital_status, modified: false };
          // Auto-insert passport photo and Aadhaar document from DigiLocker
          if (d.photo_url) {
            onChange('photo_url', d.photo_url);
            aadhaarSources.photo_url = { source: 'aadhaar', original: 'digilocker_photo', modified: false };
          }
          if (d.aadhaar_front_url) {
            onChange('aadhaar_front_url', d.aadhaar_front_url);
            aadhaarSources.aadhaar_front_url = { source: 'aadhaar', original: 'digilocker_xml', modified: false };
          }
          // ── Auto-fill CURRENT address from Aadhaar (the permanent address IS
          // the Aadhaar address). Default "Same as permanent" so the customer
          // doesn't re-type ~7 fields; they can untick it if their current
          // address differs. Also mirror into current_* so the value is present
          // even if they later untick and edit.
          if (!formData.current_house && !formData.current_pincode) {
            onChange('same_as_current', true);
            if (d.house) onChange('current_house', d.house);
            if (d.street) onChange('current_street', d.street);
            if (d.landmark) onChange('current_landmark', d.landmark);
            if (d.locality) onChange('current_locality', d.locality);
            if (d.pin) onChange('current_pincode', d.pin);
            if (d.state_code) { onChange('current_state_code', d.state_code); fetchCities(d.state_code, 'current'); }
            if (d.city_code) onChange('current_city_code', d.city_code);
            if (d.house) aadhaarSources.current_house = { source: 'aadhaar', original: d.house, modified: false };
            if (d.street) aadhaarSources.current_street = { source: 'aadhaar', original: d.street, modified: false };
            if (d.landmark) aadhaarSources.current_landmark = { source: 'aadhaar', original: d.landmark, modified: false };
            if (d.locality) aadhaarSources.current_locality = { source: 'aadhaar', original: d.locality, modified: false };
            if (d.pin) aadhaarSources.current_pincode = { source: 'aadhaar', original: d.pin, modified: false };
            if (d.state_code || d.state) aadhaarSources.current_state_code = { source: 'aadhaar', original: d.state || d.state_code, modified: false };
            if (d.city_code || d.district) aadhaarSources.current_city_code = { source: 'aadhaar', original: d.district || d.city_code, modified: false };
          }
          // ── A verified DigiLocker Aadhaar legally serves as BOTH proof of
          // identity and proof of residence — auto-satisfy both uploads so the
          // customer skips them (same pattern as photo_url / aadhaar_front_url).
          if (d.aadhaar_front_url) {
            if (!formData.proof_of_identification_url) {
              onChange('proof_of_identification_url', d.aadhaar_front_url);
              aadhaarSources.proof_of_identification_url = { source: 'aadhaar', original: 'digilocker_xml', modified: false };
            }
            if (!formData.proof_of_residence_url) {
              onChange('proof_of_residence_url', d.aadhaar_front_url);
              aadhaarSources.proof_of_residence_url = { source: 'aadhaar', original: 'digilocker_xml', modified: false };
            }
          }
          setFormData((p: any) => ({ ...p, field_sources: { ...(p.field_sources || {}), ...aadhaarSources } }));
          // Name match check: Aadhaar name vs call-collected name
          const callName = appData?.customer_name || appData?.full_name || '';
          const aadhaarName = d.name || '';
          if (callName && aadhaarName) {
            const score = calcNameSimilarity(callName, aadhaarName);
            if (score < 85) {
              const err = { source: 'Aadhaar Card', callName, verifiedName: aadhaarName, score };
              setNameMatchError(err); setNameMatchDetail(err); setNameMatchLocked(true);
            } else {
              setNameMatchError(null); setNameMatchDetail(null); setNameMatchLocked(false);
            }
          }
        }
        setDigilockerStep('done');
        setErrors((p: any) => ({ ...p, aadhaar_number: '' }));
      } catch (err: any) {
        setErrors((p: any) => ({ ...p, aadhaar_number: err.message || 'DigiLocker verification failed' }));
        setDigilockerStep('idle');
      } finally {
        setAadhaarVerifying(false);
      }
    })();
  }, [appData]);

  // Detect return from AA statement upload redirect
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('aa_complete') !== '1' || !appData) return;
    const session = getSession();
    if (!session) return;

    localStorage.removeItem('aa_session_backup');

    setAaUploadState('polling');
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/aa-statement-status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_token: session }),
        });
        const data = await res.json();
        if (data.status === 'complete') {
          onChange('bank_statements_url', 'verified_via_aa');
          setAaUploadState('complete');
        } else if (data.status === 'failed') {
          setAaUploadState('failed');
          setAaUploadError('Bank statement processing failed. Please try again.');
        } else {
          setAaUploadState('idle');
        }
      } catch {
        setAaUploadState('idle');
      }
    })();
  }, [appData]);

  useEffect(() => {
    if (!appData) return;
    const timer = setTimeout(() => autoSave(), 2000);
    return () => clearTimeout(timer);
  }, [formData]);

  // Fetch dropdown code lists on mount (state, qualification, occupation, etc.)
  useEffect(() => {
    [5, 7, 8, 9, 10, 11, 12, 13].forEach(id => {
      getCodeList(id).then(res => {
        if (res?.data) setCodeLists(prev => ({ ...prev, [id]: res.data }));
      }).catch(() => {});
    });
  }, []);

  const fetchCities = async (stateCode: string, type: 'current' | 'permanent') => {
    try {
      const res = await getCodeList(6, stateCode);
      if (res?.data) {
        if (type === 'current') setCityOptions(res.data);
        else setPermCityOptions(res.data);
      }
    } catch {}
  };

  const lookupPincode = async (pincode: string, type: 'current' | 'permanent') => {
    if (pincode.length !== 6) return;
    setPincodeLookingUp(p => ({ ...p, [type]: true }));
    setPincodeValid(p => ({ ...p, [type]: false }));
    setErrors((p: any) => ({ ...p, [`${type}_pincode`]: '' }));
    try {
      const res = await fetch(`https://api.postalpincode.in/pincode/${pincode}`);
      const data = await res.json();
      if (!data?.[0] || data[0].Status !== 'Success' || !data[0].PostOffice?.length) {
        setErrors((p: any) => ({ ...p, [`${type}_pincode`]: 'Invalid pincode — no location found' }));
        return;
      }
      const po = data[0].PostOffice[0];
      const stateName: string = (po.State || '').toLowerCase();
      const districtName: string = (po.District || '').toLowerCase();

      const states = codeLists[5] || [];
      const matchedState = states.find(s =>
        s.code_desc.toLowerCase() === stateName ||
        s.code_desc.toLowerCase().includes(stateName) ||
        stateName.includes(s.code_desc.toLowerCase())
      );
      if (!matchedState) { setPincodeValid(p => ({ ...p, [type]: true })); return; }

      onChange(`${type}_state_code`, matchedState.code_mst_id);
      onChange(`${type}_city_code`, '');
      const cityRes = await getCodeList(6, matchedState.code_mst_id);
      const cities: { code_mst_id: string; code_desc: string }[] = cityRes?.data || [];
      if (type === 'current') setCityOptions(cities);
      else setPermCityOptions(cities);

      const matchedCity = cities.find(c =>
        c.code_desc.toLowerCase() === districtName ||
        c.code_desc.toLowerCase().includes(districtName) ||
        districtName.includes(c.code_desc.toLowerCase())
      );
      if (matchedCity) onChange(`${type}_city_code`, matchedCity.code_mst_id);

      // The District dropdown is district-level (VG DocVerify master), so a
      // taluka/town like Hinganghat (which sits inside Wardha) has no option.
      // Preserve it by dropping the postal Block/town into Locality/Area when
      // the applicant hasn't already filled it — so the town isn't lost even
      // though the dropdown can only carry the district.
      const block = (po.Block || '').trim();
      if (block && block.toLowerCase() !== districtName) {
        const localityField = `${type}_locality`;
        setFormData((prev: any) => prev[localityField] ? prev : { ...prev, [localityField]: block });
      }

      setPincodeValid(p => ({ ...p, [type]: true }));
    } catch {
      setPincodeValid(p => ({ ...p, [type]: true })); // network error — don't block user
    } finally {
      setPincodeLookingUp(p => ({ ...p, [type]: false }));
    }
  };

  // Helper: resolve code_desc from code_mst_id for review display
  const codeLabel = (sqlMstId: number, code: string) => {
    if (!code) return '—';
    const list = codeLists[sqlMstId] || [];
    return list.find(o => o.code_mst_id === code)?.code_desc || code;
  };

  const loadApplication = async () => {
    const session = getSession();
    if (!session) { router.push('/loan-form'); return; }
    try {
      const res = await fetch(`${API_URL}/api/get-application?session_token=${session}`);
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      if (data.status === 'success') {
        // Derive the true idle window from the server's own expiry stamp.
        // Guarded: only accept a sane value (1–120 min) so a clock skew or a
        // malformed timestamp can never shorten the session to nothing.
        if (data.session_valid_until) {
          const ms = new Date(data.session_valid_until).getTime() - Date.now();
          if (Number.isFinite(ms) && ms > 60_000 && ms < 120 * 60_000) {
            timeoutMsRef.current = ms;
          }
        }
        const d = data.data;
        // Split full_name → first/last if not already set (pre-filled from voice call)
        if (d.full_name && !d.first_name) {
          const parts = d.full_name.trim().split(/\s+/);
          if (parts.length >= 2) {
            d.first_name = parts[0];
            d.last_name = parts.slice(1).join(' ');
          } else {
            d.first_name = d.full_name;
          }
        }
        setAppData(d);
        setFormData(d);
        const savedStep = d.current_step || 1; setCurrentStep(savedStep); setHighestStep(Math.max(savedStep, d.highest_step || 1));
        // Show the DB's last-saved date+time on resume (not just this session's),
        // and flag a resume when the applicant had already progressed before.
        if (d.last_saved_at) setLastSaved(formatSavedStamp(d.last_saved_at));
        if (savedStep > 1 || (d.highest_step || 1) > 1) { setResuming(true); setResumeStep(savedStep); }
        // On-load: restore PAN mismatch lock/warning state from DB
        const callName = d.customer_name || '';
        if (d.pan_mismatch_locked) {
          // Hard lock persisted in DB — restore immediately
          const err = { source: 'PAN Card', callName, verifiedName: d.pan_name || '', score: 0 };
          setNameMatchError(err); setNameMatchDetail(err); setNameMatchLocked(true);
        } else if ((d.pan_verification_attempts || 0) > 0) {
          // Had a mismatch but not yet locked — restore the retryable warning
          setPanMismatchWarning({ callName, verifiedName: d.pan_name || '', attemptsRemaining: Math.max(0, 2 - (d.pan_verification_attempts || 0)) });
        } else if (callName) {
          if (d.pan_verified && d.pan_name) {
            const score = calcNameSimilarity(callName, d.pan_name);
            if (score < 85) {
              const err = { source: 'PAN Card', callName, verifiedName: d.pan_name, score };
              setNameMatchError(err); setNameMatchDetail(err); setNameMatchLocked(true);
            }
          } else if (d.aadhaar_verified && d.full_name && d.full_name !== callName) {
            const score = calcNameSimilarity(callName, d.full_name);
            if (score < 85) {
              const err = { source: 'Aadhaar Card', callName, verifiedName: d.full_name, score };
              setNameMatchError(err); setNameMatchDetail(err); setNameMatchLocked(true);
            }
          }
        }
        // Pre-load city options if state is already set (resuming saved form)
        if (data.data.current_state_code) fetchCities(data.data.current_state_code, 'current');
        if (data.data.permanent_state_code) fetchCities(data.data.permanent_state_code, 'permanent');
      }
    } catch { logout(); }
    finally { setLoading(false); }
  };

  const autoSave = async () => {
    const session = getSession();
    if (!session || !appData) return;
    setSaving(true);
    try {
      // `same_as_current` column name is historical; it now means
      // "current address is the same as permanent" (permanent is always the
      // source-of-truth, auto-filled from Aadhaar).
      const isSame = formData.same_as_current;
      const cleanData = {
        customer_name: formData.customer_name,
        first_name: formData.first_name,
        middle_name: formData.middle_name,
        last_name: formData.last_name,
        full_name: formData.full_name,
        date_of_birth: formData.date_of_birth,
        gender: formData.gender,
        marital_status: formData.marital_status,
        // Build concatenated address for backward compat
        permanent_address: [formData.permanent_house, formData.permanent_street, formData.permanent_landmark, formData.permanent_locality].filter(Boolean).join(', '),
        current_address: isSame
          ? [formData.permanent_house, formData.permanent_street, formData.permanent_landmark, formData.permanent_locality].filter(Boolean).join(', ')
          : [formData.current_house, formData.current_street, formData.current_landmark, formData.current_locality].filter(Boolean).join(', '),
        same_as_current: formData.same_as_current,
        // Permanent address — always the Aadhaar-sourced address
        permanent_house: formData.permanent_house,
        permanent_street: formData.permanent_street,
        permanent_landmark: formData.permanent_landmark,
        permanent_locality: formData.permanent_locality,
        permanent_pincode: formData.permanent_pincode,
        permanent_state_code: formData.permanent_state_code,
        permanent_city_code: formData.permanent_city_code,
        // Current address — copied from permanent when `isSame`, else user-entered
        current_house: isSame ? formData.permanent_house : formData.current_house,
        current_street: isSame ? formData.permanent_street : formData.current_street,
        current_landmark: isSame ? formData.permanent_landmark : formData.current_landmark,
        current_locality: isSame ? formData.permanent_locality : formData.current_locality,
        current_pincode: isSame ? formData.permanent_pincode : formData.current_pincode,
        current_state_code: isSame ? formData.permanent_state_code : formData.current_state_code,
        current_city_code: isSame ? formData.permanent_city_code : formData.current_city_code,
        pan_number: formData.pan_number,
        aadhaar_last4: formData.aadhaar_number ? String(formData.aadhaar_number).slice(-4) : undefined,
        aadhaar_number_encrypted: formData.aadhaar_number,
        qualification: formData.qualification,
        occupation: formData.occupation,
        industry_type: formData.industry_type,
        employment_type: formData.employment_type,
        employer_name: formData.employer_name,
        designation: formData.designation,
        total_work_experience: formData.total_work_experience,
        experience_current_org: formData.experience_current_org,
        residential_status: formData.residential_status,
        tenure_stability: formData.tenure_stability,
        employer_address: formData.employer_address,
        loan_amount_requested: formData.loan_amount_requested,
        repayment_period_years: formData.repayment_period_years,
        purpose_of_loan: formData.purpose_of_loan,
        scheme: formData.scheme,
        monthly_gross_income: formData.monthly_gross_income,
        monthly_deductions: formData.monthly_deductions,
        monthly_emi_existing: formData.monthly_emi_existing,
        monthly_net_income: formData.monthly_net_income,
        criminal_records: formData.criminal_records,
      };
      const filtered = Object.fromEntries(Object.entries(cleanData).filter(([_, v]) => v !== undefined && v !== null && v !== ''));
      const res = await fetch(`${API_URL}/api/autosave-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: session, step: currentStep, data: { ...filtered, highest_step: highestStep } }),
      });
      if (res.status === 401) { logout(); return; }
      setLastSaved(formatSavedStamp(new Date()));
    } catch {}
    setSaving(false);
  };

  const onChange = (field: string, value: any) => {
    setFormData((p: any) => {
      const updated = { ...p, [field]: value };
      // Track modifications to auto-filled fields
      const sources = updated.field_sources || {};
      if (sources[field] && !sources[field].modified) {
        if (String(value).trim() !== String(sources[field].original).trim()) {
          sources[field] = { ...sources[field], modified: true };
          updated.field_sources = { ...sources };
        }
      }
      return updated;
    });
    // Live validation: clear error when user types valid data
    if (errors[field]) {
      setErrors((p: any) => ({ ...p, [field]: '' }));
    }
  };

  // Live validation on blur (called from inputs as needed)
  // eslint-disable-next-line no-unused-vars
  const onBlur = (field: string, required?: boolean) => {
    if (required && (!formData[field] || String(formData[field]).trim() === '')) {
      setErrors((p: any) => ({ ...p, [field]: 'This field is required' }));
    }
    // Email validation
    if (field === 'email' && formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      setErrors((p: any) => ({ ...p, email: 'Enter a valid email address' }));
    }
    // PAN validation
    if (field === 'pan_number' && formData.pan_number && !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(formData.pan_number)) {
      setErrors((p: any) => ({ ...p, pan_number: 'Invalid PAN format (e.g. ABCDE1234F)' }));
    }
    // Aadhaar validation
    if (field === 'aadhaar_number' && formData.aadhaar_number && !/^\d{12}$/.test(formData.aadhaar_number)) {
      setErrors((p: any) => ({ ...p, aadhaar_number: 'Enter 12-digit Aadhaar number' }));
    }
  };

  const validate = (fields: any) => {
    const e: any = {};
    Object.entries(fields).forEach(([key, msg]) => {
      if (!formData[key] || String(formData[key]).trim() === '') e[key] = msg;
    });
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // QA-only: let testers walk the whole form without live PAN/Aadhaar
  // verification (VG DocVerify may be unreachable on QA). Gated on the QA host
  // (finix.vgipl.com:8445) or NEXT_PUBLIC_LOS_ENV='qa' — can NEVER trigger on
  // production, which runs on the default port with LOS_ENV != 'qa'.
  const isQaEnv = () => {
    if (process.env.NEXT_PUBLIC_LOS_ENV === 'qa') return true;
    if (typeof window !== 'undefined' && window.location.port === '8445') return true;
    return false;
  };

  const step1Valid = () => {
    const qaBypass = isQaEnv();
    if (!qaBypass && !formData.pan_verified) {
      setErrors((p: any) => ({ ...p, pan_number: 'Please verify your PAN before proceeding' }));
      return false;
    }
    if (!qaBypass && !formData.aadhaar_verified) {
      setErrors((p: any) => ({ ...p, aadhaar_number: 'Please complete Aadhaar verification before proceeding' }));
      return false;
    }
    if (qaBypass && (!formData.pan_verified || !formData.aadhaar_verified)) {
      console.warn('[QA] KYC verification gate bypassed — QA environment only.');
    }
    const base = validate({ full_name: 'Required', last_name: 'Required', date_of_birth: 'Required', gender: 'Required' });
    // Name character check: letters + spaces, plus the punctuation real names
    // use (apostrophe/hyphen/period). Rejects numbers/symbols like "998u8808&&"
    // that would corrupt KYC name matching. Mirrors backend _validate_name.
    const NAME_RE = /^[A-Za-z][A-Za-z .'-]*$/;
    const nameMsg = 'Name must contain only letters (no numbers or special symbols).';
    const extra: any = {};
    (['first_name', 'middle_name', 'last_name'] as const).forEach(f => {
      const v = String(formData[f] || '').trim();
      if (v && !NAME_RE.test(v)) extra[f] = nameMsg;
    });
    // Date of Birth: must be a real past date and the applicant at least 18.
    // Mirrors backend _validate_dob. (The picker's max=today only limits the UI
    // and still allows today — a hard check is required.)
    const dobStr = String(formData.date_of_birth || '').slice(0, 10);
    if (dobStr) {
      const todayStr = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dobStr) || isNaN(Date.parse(dobStr))) {
        extra.date_of_birth = 'Please enter a valid Date of Birth.';
      } else if (dobStr >= todayStr) {
        extra.date_of_birth = "Date of Birth cannot be today's date or a future date.";
      } else {
        const [y, mo, da] = dobStr.split('-').map(Number);
        const t = new Date();
        let age = t.getFullYear() - y;
        if (t.getMonth() + 1 < mo || (t.getMonth() + 1 === mo && t.getDate() < da)) age--;
        if (age < 18) extra.date_of_birth = 'Applicant must be at least 18 years old.';
        else if (age > 100) extra.date_of_birth = 'Please enter a valid Date of Birth.';
      }
    }
    if (Object.keys(extra).length) setErrors((p: any) => ({ ...p, ...extra }));
    return base && Object.keys(extra).length === 0;
  };
  const step2AddressValid = () => {
    // Permanent address is always required (Aadhaar-sourced). Current address
    // is required only when the user doesn't check "Same as permanent".
    const base: any = { permanent_house: 'Required', permanent_street: 'Required', permanent_pincode: 'Required', permanent_state_code: 'Required', permanent_city_code: 'Required' };
    if (!formData.same_as_current) {
      base.current_house = 'Required'; base.current_street = 'Required';
      base.current_pincode = 'Required'; base.current_state_code = 'Required'; base.current_city_code = 'Required';
    }
    const ok = validate(base);
    if (ok && formData.permanent_pincode && !/^\d{6}$/.test(formData.permanent_pincode)) {
      setErrors((p: any) => ({ ...p, permanent_pincode: 'Enter valid 6-digit pincode' })); return false;
    }
    if (ok && !pincodeValid.permanent) {
      setErrors((p: any) => ({ ...p, permanent_pincode: 'Invalid pincode — no location found' })); return false;
    }
    if (ok && !formData.same_as_current && formData.current_pincode && !/^\d{6}$/.test(formData.current_pincode)) {
      setErrors((p: any) => ({ ...p, current_pincode: 'Enter valid 6-digit pincode' })); return false;
    }
    if (ok && !formData.same_as_current && !pincodeValid.current) {
      setErrors((p: any) => ({ ...p, current_pincode: 'Invalid pincode — no location found' })); return false;
    }
    // Address character validation. Whitelist letters/digits/space and , . - / #
    // (rejects "&&&&&"). Name-like parts (street/landmark/locality) must contain
    // at least one letter so pure-numeric junk like "0000"/"324235" is rejected;
    // House/Flat No may be numeric.
    const ADDR_RE = /^[A-Za-z0-9\s,.\-/#]+$/;
    const addrErrs: any = {};
    const checkAddr = (field: string, needsLetter: boolean) => {
      const v = String(formData[field] || '').trim();
      if (!v) return; // empties handled by the Required check where applicable
      if (!ADDR_RE.test(v) || (needsLetter && !/[A-Za-z]/.test(v))) {
        addrErrs[field] = 'Invalid characters entered. Please enter a valid address.';
      }
    };
    for (const s of (formData.same_as_current ? ['permanent'] : ['permanent', 'current'])) {
      checkAddr(`${s}_house`, false);
      checkAddr(`${s}_street`, true);
      checkAddr(`${s}_landmark`, true);
      checkAddr(`${s}_locality`, true);
    }
    if (Object.keys(addrErrs).length) {
      setErrors((p: any) => ({ ...p, ...addrErrs }));
      return false;
    }
    return ok;
  };
  const step3Valid = () => {
    const base = validate({ qualification: 'Required', occupation: 'Required', industry_type: 'Required', employment_type: 'Required', designation: 'Required', total_work_experience: 'Required', residential_status: 'Required', tenure_stability: 'Required', employer_address: 'Required' });
    // Experience sanity: total must be > 0 for an employed applicant, and current-org
    // experience can't exceed total. (These are salaried-only loans, so 0 is invalid.)
    const totalExp = parseFloat(formData.total_work_experience);
    const orgExp = parseFloat(formData.experience_current_org);
    const extra: any = {};
    if (formData.total_work_experience && !isNaN(totalExp) && totalExp <= 0) {
      extra.total_work_experience = 'Experience cannot be zero for employed users.';
    }
    if (!isNaN(orgExp) && !isNaN(totalExp) && orgExp > totalExp) {
      extra.experience_current_org = 'Current-org experience cannot exceed total experience.';
    }
    // Salaried-only eligibility. Dropdowns store code_mst_id (see the Code List
    // API in backend/main.py): Employment Type must be a Salaried option
    // (260492/260493/260494); non-earning occupations (Unemployed/Student/
    // House Wife/Retired/Pensioner) are ineligible.
    const SALARIED_EMPLOYMENT = ['260492', '260493', '260494'];
    const INELIGIBLE_OCCUPATION = ['940', '136', '133', '135', '938'];
    const salariedMsg = 'This loan product is available only for salaried applicants.';
    if (formData.employment_type && !SALARIED_EMPLOYMENT.includes(String(formData.employment_type))) {
      extra.employment_type = salariedMsg;
    }
    if (formData.occupation && INELIGIBLE_OCCUPATION.includes(String(formData.occupation))) {
      extra.occupation = salariedMsg;
    }
    if (Object.keys(extra).length) setErrors((p: any) => ({ ...p, ...extra }));
    return base && Object.keys(extra).length === 0;
  };

  // Product-wise loan amount limits (max also enforced live by the ₹1 lakh cap).
  const LOAN_LIMITS: Record<string, { min: number; max: number; label: string }> = {
    personal: { min: 20000, max: 100000, label: 'Personal Loan' },
    consumer_durable: { min: 20000, max: 100000, label: 'Consumer Durable Loan' },
  };
  // Returns a validation message if the entered loan amount is outside the
  // selected product's permitted range, else '' (empties are left to the
  // Required check). Used both live (onBlur) and on Continue (step4Valid).
  const loanAmountError = (): string => {
    const key = (formData.consumer_loan_type || 'personal') === 'consumer_durable' ? 'consumer_durable' : 'personal';
    const { min, max, label } = LOAN_LIMITS[key];
    const raw = formData.loan_amount_requested;
    if (raw === undefined || raw === null || String(raw).trim() === '') return '';
    const amt = parseFloat(raw);
    if (isNaN(amt)) return 'Enter a valid loan amount.';
    if (amt < min || amt > max) {
      return `Loan Amount must be between ₹${min.toLocaleString('en-IN')} and ₹${max.toLocaleString('en-IN')} for the selected ${label}.`;
    }
    return '';
  };

  // Guarantor field validation (only enforced when a guarantor is required,
  // i.e. loan amount > ₹1 lakh). Empty is left to the Required check.
  const guarantorNameError = (raw: string): string => {
    const v = (raw || '').trim();
    if (!v) return '';
    if (!/^[A-Za-z][A-Za-z .'-]*$/.test(v)) return 'Name can only contain letters (no numbers or symbols).';
    if (v.replace(/[^A-Za-z]/g, '').length < 2) return 'Enter the full name of the guarantor.';
    return '';
  };
  const guarantorPhoneError = (raw: string): string => {
    const d = (raw || '').replace(/\D/g, '');
    if (!d) return '';
    if (!/^[6-9]\d{9}$/.test(d)) return 'Enter a valid 10-digit mobile number starting with 6-9.';
    if (/^(\d)\1{9}$/.test(d)) return 'Enter a valid mobile number.';
    return '';
  };

  // ── Required documents ──────────────────────────────────────────────────
  // Defined in lib/utils/loanDocuments.ts so the gate, the render and the
  // per-document file-type rules all read ONE definition. While the list lived
  // inline in the JSX nothing could validate it, and an application could be
  // submitted with nothing attached.

  /**
   * Step 2 gate. Names the missing documents rather than saying "upload the
   * required documents" — the customer is looking at several upload rows and
   * needs to know which are outstanding.
   *
   * Aadhaar, photo and both proofs are usually satisfied automatically by
   * DigiLocker during KYC (step 1), so most customers reach this step with only
   * the bank statement left to do.
   */
  const step2Valid = () => {
    // QA-only: let testers/demos walk past the Documents step WITHOUT uploading
    // the required files. Gated to the QA host (finix.vgipl.com:8445 /
    // NEXT_PUBLIC_LOS_ENV='qa') via isQaEnv() — it can NEVER trigger on
    // production, which keeps enforcing document uploads. Clears any lingering
    // per-document errors so the step passes cleanly.
    if (isQaEnv()) {
      setErrors((p: any) => {
        const next = { ...p };
        documentsFor(formData.consumer_loan_type).forEach(d => { delete next[d.key]; });
        return next;
      });
      setDocError('');
      console.warn('[QA] Documents step gate bypassed — QA environment only.');
      return true;
    }
    const missing = missingRequired(formData.consumer_loan_type, formData);
    setErrors((p: any) => {
      const next = { ...p };
      documentsFor(formData.consumer_loan_type).forEach(d => { delete next[d.key]; });
      missing.forEach(d => { next[d.key] = 'This document is required'; });
      return next;
    });
    if (missing.length) {
      setDocError(
        missing.length === 1
          ? `${missing[0].label} is still required.`
          : `${missing.length} required documents are still missing: ${missing.map(d => d.label).join(', ')}.`
      );
      return false;
    }
    setDocError('');
    return true;
  };

  const step4Valid = () => {
    const isCD = (formData.consumer_loan_type || 'personal') === 'consumer_durable';
    // Single validate() call so its setErrors doesn't wipe the merged errors below.
    const reqFields: any = { loan_amount_requested: 'Required', monthly_gross_income: 'Required', monthly_net_income: 'Required' };
    if (isCD) Object.assign(reqFields, { product_name: 'Required', brand: 'Required', quotation_amount: 'Required', dealer_name: 'Required' });
    const base = validate(reqFields);
    const loanAmt = parseFloat(formData.loan_amount_requested || '0');
    const amtErr = loanAmountError();
    const criminalValid = formData.criminal_records === true;

    // Guarantor: required + format, only when the loan exceeds ₹1 lakh.
    let gnErr = '', gpErr = '';
    if (loanAmt > 100000) {
      gnErr = !String(formData.guarantor_name || '').trim() ? 'Required' : guarantorNameError(formData.guarantor_name);
      gpErr = !String(formData.guarantor_phone || '').trim() ? 'Required' : guarantorPhoneError(formData.guarantor_phone);
    }
    const guarantorValid = !gnErr && !gpErr;

    // Merge every non-required-field error on top of the base required errors.
    setErrors((p: any) => ({
      ...p,
      ...(amtErr ? { loan_amount_requested: amtErr } : {}),
      ...(gnErr ? { guarantor_name: gnErr } : {}),
      ...(gpErr ? { guarantor_phone: gpErr } : {}),
      ...(!criminalValid ? { criminal_records: 'You must confirm you have no pending criminal cases to proceed' } : {}),
    }));
    return base && !amtErr && guarantorValid && criminalValid;
  };

  const handleNext = () => {
    if (nameMatchLocked) {
      setNameMatchError(e => e); // re-show popup if dismissed
      return;
    }
    let valid = false;
    // Step order: 1 KYC · 2 Documents · 3 Address · 4 Occupation ·
    // 5 Loan & Financial · 6 Review. Documents sits at 2 — right after the
    // DigiLocker KYC that auto-satisfies four of them, and BEFORE the
    // financial questions the bank statement is meant to prefill.
    if (currentStep === 1) valid = step1Valid();
    else if (currentStep === 2) valid = step2Valid();
    else if (currentStep === 3) valid = step2AddressValid();
    else if (currentStep === 4) valid = step3Valid();
    else if (currentStep === 5) valid = step4Valid();
    else valid = true;

    if (valid) {
      autoSave();
      setCurrentStep(prev => { const next = prev + 1; setHighestStep(h => Math.max(h, next)); return next; });
      setErrors({});
      window.scrollTo(0, 0);
    }
  };

  const handleSubmit = async () => {
    if (nameMatchLocked) {
      alert('Application is locked due to identity verification failure. Please contact your bank branch to unlock or re-verify your identity before submitting.');
      return;
    }
    if (!agreed) { alert('Please agree to the declaration'); return; }
    // Re-check here as well as in step 5: a resumed session can land directly on
    // Review (the resume banner does exactly that), bypassing the step gate.
    const missingDocs = missingRequired(formData.consumer_loan_type, formData);
    if (missingDocs.length) {
      setCurrentStep(2);
      setDocError(
        `Cannot submit — still missing: ${missingDocs.map(d => d.label).join(', ')}.`
      );
      window.scrollTo(0, 0);
      return;
    }
    setSubmitting(true);
    const session = getSession();
    try {
      await autoSave();
      const res = await fetch(`${API_URL}/api/submit-form-session?session_token=${session}`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'submitted') {
        sessionStorage.removeItem('loan_session');
        router.push(`/success?loan_id=${appData.loan_id}`);
      } else { alert(data.detail || 'Submission failed'); }
    } catch { alert('Submission failed. Try again.'); }
    finally { setSubmitting(false); }
  };

  if (sessionExpired) return (
    <div className="finix-root min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--fx-bg)' }}>
      <div className="rounded-2xl p-8 max-w-md w-full text-center" style={{ background: 'var(--fx-surface)', border: '1px solid var(--fx-border)', boxShadow: 'var(--fx-elevation)' }}>
        <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: 'var(--fx-amber-tint)' }}>
          <AlertTriangle className="w-8 h-8" style={{ color: 'var(--fx-amber)' }} />
        </div>
        <h2 className="text-2xl font-bold mb-2" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>Session Expired</h2>
        <p className="mb-6 text-sm" style={{ color: 'var(--fx-text2)', fontFamily: 'var(--font-body)' }}>Your session has expired due to inactivity. Please verify again to continue.</p>
        <button onClick={() => router.push('/loan-form')}
          className="w-full py-4 rounded-xl font-semibold text-white transition hover:opacity-90"
          style={{ background: 'var(--fx-accent-grad)', fontFamily: 'var(--font-heading)' }}>
          Re-verify with OTP →
        </button>
        <p className="text-xs mt-4" style={{ color: 'var(--fx-text3)', fontFamily: 'var(--font-body)' }}>Your progress has been saved automatically</p>
      </div>
    </div>
  );

  if (loading) return (
    <div className="finix-root min-h-screen flex items-center justify-center" style={{ background: 'var(--fx-bg)' }}>
      <div className="text-center">
        <div className="animate-spin rounded-full h-14 w-14 border-b-2 mx-auto" style={{ borderColor: 'var(--fx-accent)' }}></div>
        <p className="mt-4 text-sm" style={{ color: 'var(--fx-text2)', fontFamily: 'var(--font-body)' }}>Loading your application...</p>
      </div>
    </div>
  );

  // Documents second: the customer uploads while they still have their papers
  // to hand, and the bank statement is captured before the income questions
  // it is meant to prefill.
  const steps = ['KYC & Identity', 'Documents', 'Address', 'Occupation', 'Loan & Financial', 'Review'];

  return (
    <div className="finix-root min-h-screen" style={{ background: 'var(--fx-bg)' }}>

      {/* ── Name mismatch popup ── */}
      {nameMatchError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
          <div className="rounded-2xl shadow-2xl max-w-md w-full p-6" style={{ background: 'var(--fx-surface)', border: '1px solid var(--fx-red-tint)' }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--fx-red-tint)' }}>
                <AlertTriangle className="w-5 h-5" style={{ color: 'var(--fx-red)' }} />
              </div>
              <div>
                <h3 className="font-bold text-lg" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>Identity Mismatch Detected</h3>
                <p className="text-sm" style={{ color: 'var(--fx-red)', fontFamily: 'var(--font-body)' }}>{nameMatchError.score}% match — minimum required is 85%</p>
              </div>
            </div>
            <div className="space-y-3 mb-5">
              <div className="rounded-xl p-3" style={{ background: 'var(--fx-surface2)' }}>
                <p className="text-xs mb-1" style={{ color: 'var(--fx-text3)', fontFamily: 'var(--font-body)' }}>Name from voice call</p>
                <p className="font-semibold" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-body)' }}>{nameMatchError.callName}</p>
              </div>
              <div className="rounded-xl p-3" style={{ background: 'var(--fx-red-tint)', border: '1px solid var(--fx-red-tint)' }}>
                <p className="text-xs mb-1" style={{ color: 'var(--fx-red)', fontFamily: 'var(--font-body)' }}>Name from {nameMatchError.source}</p>
                <p className="font-semibold" style={{ color: 'var(--fx-red)', fontFamily: 'var(--font-body)' }}>{nameMatchError.verifiedName}</p>
              </div>
            </div>
            <p className="text-sm mb-5" style={{ color: 'var(--fx-text2)', fontFamily: 'var(--font-body)' }}>
              The name on your <strong>{nameMatchError.source}</strong> does not sufficiently match the name recorded during your voice call. Please contact your bank branch.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setNameMatchError(null)}
                className="flex-1 py-3 rounded-xl font-medium transition hover:opacity-80"
                style={{ border: '1px solid var(--fx-border)', color: 'var(--fx-text2)', fontFamily: 'var(--font-body)' }}>
                Dismiss
              </button>
              <button disabled className="flex-1 py-3 rounded-xl font-medium cursor-not-allowed"
                style={{ background: 'var(--fx-red-tint)', color: 'var(--fx-red)', fontFamily: 'var(--font-body)' }}>
                Form Locked
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inactivity warning — countdown + Continue / Logout */}
      {inactivityWarning && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center px-4" style={{ background: 'rgba(15,23,42,0.45)' }}>
          <div className="shadow-2xl rounded-2xl px-6 py-6 max-w-sm w-full text-center animate-[slideDown_0.3s_ease-out]"
            style={{ background: 'var(--fx-surface)', border: '1px solid var(--fx-amber-tint)' }}>
            <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3" style={{ background: 'var(--fx-amber-tint)' }}>
              <AlertTriangle className="w-6 h-6" style={{ color: 'var(--fx-amber)' }} />
            </div>
            <p className="text-base font-semibold" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>Session about to expire</p>
            <p className="text-sm mt-1" style={{ color: 'var(--fx-text2)', fontFamily: 'var(--font-body)' }}>
              Your session will expire due to inactivity. Click &ldquo;Continue Session&rdquo; to keep working.
            </p>
            <div className="my-4">
              <div className="text-4xl font-bold tabular-nums" style={{ color: 'var(--fx-amber)', fontFamily: 'var(--font-heading)' }}>
                {countdown}s
              </div>
              <div className="mt-2 mx-auto h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--fx-border)', width: '80%' }}>
                <div className="h-full rounded-full transition-[width] duration-1000 ease-linear"
                  style={{ background: 'var(--fx-amber)', width: `${Math.max(0, (countdown / (WARNING_WINDOW_MS / 1000)) * 100)}%` }} />
              </div>
            </div>
            <div className="flex gap-3 mt-2">
              <button onClick={continueSession}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white transition active:scale-[0.98]"
                style={{ background: 'var(--fx-accent)', fontFamily: 'var(--font-heading)' }}>
                Continue Session
              </button>
              <button onClick={sessionLogout}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition active:scale-[0.98]"
                style={{ background: 'var(--fx-surface2)', color: 'var(--fx-text2)', fontFamily: 'var(--font-heading)' }}>
                Logout
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-5xl mx-auto w-full px-3 sm:px-6 pb-10">

        {/* ── HEADER CARD — sticky ── */}
        <div className="sticky top-0 z-20 mb-3 sm:mb-4 sm:mt-4 rounded-none sm:rounded-2xl px-4 sm:px-5 py-3 sm:py-4"
          style={{ background: 'var(--fx-surface)', borderBottom: '1px solid var(--fx-border)', boxShadow: 'var(--fx-elevation)' }}>
          {/* Top row: logo + name + autosave */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 sm:w-[52px] sm:h-[52px] rounded-2xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'var(--fx-surface2)', border: '1px solid var(--fx-border)', color: 'var(--fx-text)' }}>
                <FinixLogoMark size={34} />
              </div>
              <div>
                <h1 className="font-bold leading-tight" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)', fontSize: '18px' }}>
                  Loan Application
                </h1>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className="text-sm" style={{ color: 'var(--fx-text2)', fontFamily: 'var(--font-body)' }}>
                    {appData?.customer_name}
                  </span>
                  {appData?.loan_id && (
                    <span className="text-xs px-2 py-0.5 rounded-full" style={{ color: 'var(--fx-text3)', fontFamily: 'var(--font-mono-loan)', background: 'var(--fx-surface2)', border: '1px solid var(--fx-border)' }}>
                      {appData.loan_id}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Always-visible session countdown. Turns amber inside the last
                  two minutes — the same threshold that raises the warning modal,
                  so the colour change and the modal never disagree. */}
              <span
                className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full tabular-nums"
                title="Time left before this session expires from inactivity"
                style={{
                  color: secondsLeft <= WARNING_WINDOW_MS / 1000 ? 'var(--fx-amber)' : 'var(--fx-text2)',
                  background: secondsLeft <= WARNING_WINDOW_MS / 1000 ? 'var(--fx-amber-tint)' : 'var(--fx-surface2)',
                  border: '1px solid var(--fx-border)',
                  fontFamily: 'var(--font-body)',
                }}>
                <Clock className="w-3 h-3 flex-shrink-0" />
                <span className="hidden sm:inline">Session&nbsp;</span>
                {String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:{String(secondsLeft % 60).padStart(2, '0')}
              </span>
              {saving ? (
                <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full" style={{ color: 'var(--fx-accent)', background: 'var(--fx-accent-tint)', fontFamily: 'var(--font-body)' }}>
                  <Loader2 className="w-3 h-3 animate-spin" /><span className="hidden sm:inline">Saving</span>
                </span>
              ) : lastSaved ? (
                <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full whitespace-nowrap" title={`Last saved ${lastSaved}`} style={{ color: 'var(--fx-green)', background: 'var(--fx-green-tint)', fontFamily: 'var(--font-body)' }}>
                  <span className="w-1.5 h-1.5 rounded-full animate-pulse inline-block flex-shrink-0" style={{ background: 'var(--fx-green)' }} />
                  <span className="hidden md:inline">Saved</span>
                </span>
              ) : null}
              <ThemeToggle />
            </div>
          </div>

          {/* ── RESUME BANNER — shown when continuing a previously-saved application ── */}
          {resuming && (
            <div className="mt-3 flex items-start gap-2 rounded-xl px-3 py-2" style={{ background: 'var(--fx-accent-tint)', border: '1px solid color-mix(in oklch, var(--fx-accent) 35%, var(--fx-border))' }}>
              <RotateCcw className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--fx-accent)' }} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold" style={{ color: 'var(--fx-accent)', fontFamily: 'var(--font-heading)' }}>
                  You&apos;re resuming your previously saved loan application
                </p>
                <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'var(--fx-text2)', fontFamily: 'var(--font-body)' }}>
                  Resume point: <b>{steps[Math.min(Math.max(resumeStep, 1), steps.length) - 1]}</b> (Step {resumeStep} of {steps.length}). Continue from where you left off.
                  {lastSaved ? <><br />Last saved: {lastSaved}</> : null}
                </p>
              </div>
              <button onClick={() => setResuming(false)} className="flex-shrink-0 p-0.5" style={{ color: 'var(--fx-text3)' }} aria-label="Dismiss">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* ── STEP PROGRESS BAR (40px circles) ── */}
          <div className="relative">
            {/* Grey track */}
            <div className="absolute h-0.5 z-0"
              style={{ background: 'var(--fx-border)', top: '15px', left: `${100 / steps.length / 2}%`, right: `${100 / steps.length / 2}%` }} />
            {/* Green progress */}
            <div className="absolute h-0.5 z-0 transition-all duration-500"
              style={{
                background: 'var(--fx-green)',
                top: '15px',
                left: `${100 / steps.length / 2}%`,
                width: `${Math.max(0, (Math.max(highestStep, currentStep) - 1)) / (steps.length - 1) * (100 - 100 / steps.length)}%`,
              }} />
            {/* Mobile-only: name the current step, since the per-circle
                labels below are hidden under `sm`. */}
            <p className="sm:hidden text-center text-xs font-semibold mb-2"
              style={{ color: 'var(--fx-text2)', fontFamily: 'var(--font-body)' }}>
              Step {currentStep} of {steps.length} · {steps[currentStep - 1]}
            </p>
            <div className="relative flex">
              {steps.map((s, i) => {
                const stepNum  = i + 1;
                const isActive    = currentStep === stepNum;
                const isCompleted = highestStep > stepNum;
                const isReachable = stepNum <= highestStep;
                return (
                  <div key={i} className="flex flex-col items-center" style={{ width: `${100 / steps.length}%` }}>
                    <div
                      onClick={() => { if (isReachable && !(nameMatchLocked && stepNum > 1)) { autoSave(); setCurrentStep(stepNum); window.scrollTo(0, 0); } }}
                      className="w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center font-bold z-10 transition-all duration-200 select-none"
                      style={{
                        background: isActive ? 'var(--fx-accent)' : isCompleted ? 'var(--fx-green)' : 'var(--fx-surface2)',
                        color: isActive || isCompleted ? '#fff' : 'var(--fx-text3)',
                        border: isActive ? '2px solid var(--fx-accent)' : isCompleted ? '2px solid var(--fx-green)' : '2px solid var(--fx-border)',
                        cursor: isReachable ? 'pointer' : 'default',
                        boxShadow: isActive ? 'var(--fx-focus)' : 'none',
                        fontFamily: 'var(--font-heading)',
                        fontSize: '13px',
                      }}>
                      {isCompleted ? <span style={{ fontSize: '16px' }}>✓</span> : stepNum}
                    </div>
                    <span className="text-[10px] mt-2 text-center leading-tight hidden sm:block"
                      style={{
                        color: isActive ? 'var(--fx-accent)' : isCompleted ? 'var(--fx-green)' : 'var(--fx-text3)',
                        fontFamily: 'var(--font-body)',
                        fontWeight: isActive ? 700 : 400,
                        maxWidth: '60px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                      {s}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── FORM CONTENT — one rounded surface panel (Finix nested-panel shell) ── */}
        <div className="space-y-3 sm:space-y-4 rounded-2xl px-4 sm:px-6 py-5 sm:py-7 mb-10"
          style={{ background: 'var(--fx-surface)', border: '1px solid var(--fx-border)', boxShadow: 'var(--fx-elevation)' }}>

          {currentStep === 1 && (
            <div className="space-y-4 animate-[fadeIn_0.3s_ease-out]">
              <SectionTitle icon="KYC" color="var(--fx-accent)" title="KYC & Personal Details" />
              {/* PAN mismatch — retryable warning (first failure) */}
              {!nameMatchLocked && panMismatchWarning && (
                <div className="rounded-xl px-4 py-3 space-y-1" style={{ background: 'var(--fx-amber-tint)', border: '1px solid var(--fx-amber-tint)' }}>
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--fx-amber)' }} />
                    <div className="flex-1">
                      <p className="text-sm font-semibold" style={{ color: 'var(--fx-amber)', fontFamily: 'var(--font-body)' }}>PAN verification failed — name mismatch</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--fx-amber)', fontFamily: 'var(--font-body)' }}>
                        The name on your PAN card (<strong>{panMismatchWarning.verifiedName}</strong>) does not match the name on file (<strong>{panMismatchWarning.callName}</strong>).
                        Please verify the PAN number entered and try again.
                      </p>
                      <p className="text-xs mt-1 font-medium" style={{ color: 'var(--fx-amber)', fontFamily: 'var(--font-body)' }}>
                        {panMismatchWarning.attemptsRemaining} retry attempt{panMismatchWarning.attemptsRemaining !== 1 ? 's' : ''} remaining.
                      </p>
                    </div>
                  </div>
                </div>
              )}
              {/* PAN mismatch — hard lock (max retries exceeded) */}
              {nameMatchLocked && (
                <div className="flex items-center gap-3 rounded-xl px-4 py-3" style={{ background: 'var(--fx-red-tint)', border: '1px solid var(--fx-red-tint)' }}>
                  <AlertTriangle className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--fx-red)' }} />
                  <div className="flex-1">
                    <p className="text-sm font-semibold" style={{ color: 'var(--fx-red)', fontFamily: 'var(--font-body)' }}>Application locked — identity verification failed</p>
                    <p className="text-xs" style={{ color: 'var(--fx-red)', fontFamily: 'var(--font-body)' }}>Identity verification failed after maximum retry attempts. Please contact your bank branch to resolve this.</p>
                  </div>
                  <button onClick={() => setNameMatchError(nameMatchDetail)} className="text-xs underline whitespace-nowrap" style={{ color: 'var(--fx-red)', fontFamily: 'var(--font-body)' }}>View details</button>
                </div>
              )}
              <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--fx-border)', boxShadow: 'var(--fx-elevation)' }}>
                <div className="px-5 py-3.5 flex items-center gap-2" style={{ background: 'var(--fx-surface2)', borderBottom: '1px solid var(--fx-border)' }}>
                  <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'color-mix(in oklch, var(--fx-accent) 12%, transparent)' }}>
                    <Lock className="w-3.5 h-3.5" style={{ color: 'var(--fx-accent)' }} />
                  </div>
                  <p className="font-semibold text-sm" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>Identity Verification</p>
                </div>
                <div className="p-5 space-y-4">
                <F label="PAN Number" required error={errors.pan_number}>
                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <input type="text"
                        value={formData.pan_verified
                          ? (formData.pan_number ? formData.pan_number.replace(/./g, '\u2022') : '')
                          : (showPan ? (formData.pan_number || '') : (formData.pan_number ? formData.pan_number.replace(/./g, '\u2022') : ''))
                        }
                        onChange={e => onChange('pan_number', e.target.value.toUpperCase())}
                        onClick={() => { if (!formData.pan_verified && !showPan) setShowPan(true); }}
                        disabled={formData.pan_verified || nameMatchLocked}
                        readOnly={false}
                        className={`w-full pr-16 ${formData.pan_verified ? '' : 'cursor-text'} ${inp(errors.pan_number)}`}
                        style={{ fontFamily: 'var(--font-mono-loan)', fontSize: '1rem', letterSpacing: formData.pan_number && !showPan ? '0.3em' : '0.05em', background: formData.pan_verified ? 'var(--fx-green-tint)' : nameMatchLocked ? 'var(--fx-red-tint)' : undefined, borderColor: formData.pan_verified ? 'var(--fx-green)' : nameMatchLocked ? 'var(--fx-red-tint)' : panMismatchWarning ? 'var(--fx-amber-tint)' : undefined }}
                        placeholder="ABCDE1234F" maxLength={10} />
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                        {!formData.pan_verified && (
                          <button type="button" onClick={() => setShowPan(p => !p)}
                            className="text-gray-400 hover:text-blue-500 transition p-1" title={showPan ? 'Hide PAN' : 'Show PAN'}>
                            {showPan ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        )}
                        {formData.pan_number && !formData.pan_verified && (
                          <button type="button" onClick={() => { onChange('pan_number', ''); setShowPan(false); }}
                            className="text-gray-400 hover:text-red-500 transition p-1" title="Clear & re-enter">
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                    <button type="button" onClick={handleVerifyPAN} disabled={formData.pan_verified || panVerifying || nameMatchLocked}
                      className="px-3 sm:px-4 py-2 rounded-xl text-sm font-semibold whitespace-nowrap transition flex items-center justify-center gap-1 sm:gap-2 min-w-[76px] sm:min-w-[100px] disabled:opacity-70"
                      style={{
                        background: formData.pan_verified ? 'var(--fx-green)' : nameMatchLocked ? 'var(--fx-red)' : 'var(--fx-accent)',
                        color: '#fff',
                        fontFamily: 'var(--font-heading)',
                        cursor: (formData.pan_verified || nameMatchLocked) ? 'default' : 'pointer',
                      }}>
                      {panVerifying ? <><Loader2 className="w-4 h-4 animate-spin" /><span>Verifying...</span></> : formData.pan_verified ? '✓ Verified' : nameMatchLocked ? '🔒 Locked' : 'Verify'}
                    </button>
                  </div>
                  {formData.pan_verified && <p className="text-[10px] sm:text-xs text-green-600 mt-1 flex items-center gap-1"><ShieldCheck className="w-3 h-3 flex-shrink-0" /><span>PAN verified{formData.pan_name ? ` — ${formData.pan_name}` : ''}{formData.pan_verification_timestamp ? ` on ${new Date(formData.pan_verification_timestamp).toLocaleString()}` : ''}</span></p>}
                </F>
                <F label="Aadhaar Verification" required error={errors.aadhaar_number}>
                  {formData.aadhaar_verified ? (
                    <div className={`p-2.5 sm:p-3 rounded-lg border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20`}>
                      <p className="text-xs sm:text-sm text-green-700 dark:text-green-300 flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 flex-shrink-0" />
                        <span>Verified via DigiLocker (XXXX XXXX {formData.aadhaar_last4})</span>
                      </p>
                      {formData.aadhaar_verification_timestamp && <p className="text-[10px] sm:text-xs text-green-600 dark:text-green-400 mt-1 ml-6">Verified on {new Date(formData.aadhaar_verification_timestamp).toLocaleString()}</p>}
                    </div>
                  ) : !formData.pan_verified ? (
                    <div className="w-full rounded-xl flex items-center justify-center gap-3 opacity-60 cursor-not-allowed"
                      style={{ background: 'var(--fx-border)', color: 'var(--fx-text2)', fontFamily: 'var(--font-heading)', height: '52px' }}>
                      <Lock className="w-4 h-4" />
                      <span className="text-sm font-semibold">Verify PAN first to unlock Aadhaar</span>
                    </div>
                  ) : (
                    <button type="button" onClick={handleVerifyAadhaar} disabled={aadhaarVerifying}
                      className="w-full rounded-xl font-semibold transition disabled:opacity-50 flex items-center justify-center gap-3 active:scale-[0.99]"
                      style={{ background: 'linear-gradient(135deg, var(--fx-orange) 0%, var(--fx-red) 100%)', color: '#fff', fontFamily: 'var(--font-heading)', height: '52px', boxShadow: 'var(--fx-elevation)' }}>
                      {digilockerStep === 'linking' || digilockerStep === 'fetching' ? (
                        <><Loader2 className="w-5 h-5 animate-spin" /><span>{digilockerStep === 'linking' ? 'Opening DigiLocker...' : 'Fetching data...'}</span></>
                      ) : (
                        <>
                          <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,255,255,0.2)' }}>
                            <ShieldCheck className="w-4 h-4" />
                          </div>
                          <span>Verify Aadhaar via DigiLocker</span>
                          <ExternalLink className="w-4 h-4 opacity-60 ml-auto" />
                        </>
                      )}
                    </button>
                  )}
                  {digilockerStep === 'waiting' && <p className="text-xs text-orange-600 dark:text-orange-400 mt-1 animate-pulse">Please complete authentication on the DigiLocker window...</p>}
                  {digilockerStep === 'fetching' && <p className="text-xs text-blue-600 dark:text-blue-400 mt-1 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Fetching your Aadhaar data from DigiLocker...</p>}
                  <p className="text-xs mt-1 flex items-center gap-1" style={{ color: 'var(--fx-text3)', fontFamily: 'var(--font-body)' }}><Lock className="w-3 h-3" />Only last 4 digits stored</p>
                </F>
                </div>{/* end p-5 */}
              </div>{/* end identity card */}

              {/* Personal Details card */}
              <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--fx-border)', boxShadow: 'var(--fx-elevation)' }}>
                <div className="px-5 py-3.5 flex items-center gap-2" style={{ background: 'var(--fx-surface2)', borderBottom: '1px solid var(--fx-border)' }}>
                  <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'color-mix(in oklch, var(--fx-accent) 12%, transparent)' }}>
                    <User className="w-3.5 h-3.5" style={{ color: 'var(--fx-accent)' }} />
                  </div>
                  <p className="font-semibold text-sm" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>Personal Details</p>
                </div>
                <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                <F label="First Name" required error={errors.full_name || errors.first_name} fieldName="first_name" fieldSources={formData.field_sources}>
                  <input type="text" value={formData.first_name || ''} onChange={e => { onChange('first_name', e.target.value); onChange('full_name', `${e.target.value} ${formData.middle_name||''} ${formData.last_name||''}`.trim()); }} className={inp(errors.full_name || errors.first_name)} placeholder="First name" />
                </F>
                <F label="Middle Name" error={errors.middle_name} fieldName="middle_name" fieldSources={formData.field_sources}><input type="text" value={formData.middle_name || ''} onChange={e => onChange('middle_name', e.target.value)} className={inp(errors.middle_name)} placeholder="Optional" /></F>
                <F label="Last Name" required error={errors.last_name} fieldName="last_name" fieldSources={formData.field_sources}><input type="text" value={formData.last_name || ''} onChange={e => onChange('last_name', e.target.value)} className={inp(errors.last_name)} placeholder="Last name" /></F>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                <F label="Date of Birth" required error={errors.date_of_birth} fieldName="date_of_birth" fieldSources={formData.field_sources}>
                  <input type="date" value={formData.date_of_birth || ''} onChange={e => onChange('date_of_birth', e.target.value)} className={inp(errors.date_of_birth)} max={new Date().toISOString().split('T')[0]} />
                </F>
                <F label="Gender" required error={errors.gender} fieldName="gender" fieldSources={formData.field_sources}>
                  <select value={formData.gender || ''} onChange={e => onChange('gender', e.target.value)} className={inp(errors.gender)}>
                    <option value="">Select</option>
                    {['Male','Female','Other'].map(g => <option key={g}>{g}</option>)}
                  </select>
                </F>
                <F label="Marital Status" fieldName="marital_status" fieldSources={formData.field_sources}>
                  <select value={formData.marital_status || ''} onChange={e => onChange('marital_status', e.target.value)} className={inp('')}>
                    <option value="">Select</option>
                    {['Single','Married','Divorced','Widowed'].map(s => <option key={s}>{s}</option>)}
                  </select>
                </F>
              </div>
              </div>{/* end p-5 */}
              </div>{/* end personal card */}
              <Nav onNext={handleNext} />
            </div>
          )}

          {currentStep === 3 && (
            <div className="space-y-4 animate-[fadeIn_0.3s_ease-out]">
              <SectionTitle icon="ADR" color="var(--fx-green)" title="Address Details" />
              <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--fx-border)', boxShadow: 'var(--fx-elevation)' }}>
                <div className="px-5 py-3.5 flex items-center justify-between" style={{ background: 'var(--fx-green-tint)', borderBottom: '1px solid color-mix(in oklch, var(--fx-green) 35%, var(--fx-border))' }}>
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in oklch, var(--fx-green) 12%, transparent)' }}><Home className="w-3.5 h-3.5" style={{ color: 'var(--fx-green)' }} /></div>
                    <p className="font-semibold text-sm" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>Current Address</p>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={formData.same_as_current || false} onChange={e => onChange('same_as_current', e.target.checked)} className="w-4 h-4 cursor-pointer" style={{ accentColor: 'var(--fx-accent)' }} />
                    <span className="text-xs sm:text-sm text-gray-600 dark:text-gray-400">Same as permanent</span>
                  </label>
                </div>
                {formData.same_as_current ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400 italic">Current address will be the same as permanent address.</p>
                ) : (<>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="House / Flat No" required error={errors.current_house}>
                    <input type="text" value={formData.current_house || ''} onChange={e => onChange('current_house', e.target.value)} className={inp(errors.current_house)} placeholder="e.g. 123, Flat B-2" />
                  </F>
                  <F label="Street / Road" required error={errors.current_street}>
                    <input type="text" value={formData.current_street || ''} onChange={e => onChange('current_street', e.target.value)} className={inp(errors.current_street)} placeholder="e.g. MG Road" />
                  </F>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="Landmark" error={errors.current_landmark}><input type="text" value={formData.current_landmark || ''} onChange={e => onChange('current_landmark', e.target.value)} className={inp(errors.current_landmark)} placeholder="e.g. Near Railway Station" /></F>
                  <F label="Locality / Area" error={errors.current_locality}><input type="text" value={formData.current_locality || ''} onChange={e => onChange('current_locality', e.target.value)} className={inp(errors.current_locality)} placeholder="e.g. Andheri West" /></F>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                  <F label="Pincode" required error={errors.current_pincode}>
                    <div className="relative">
                      <input type="text" value={formData.current_pincode || ''} onChange={e => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); onChange('current_pincode', v); if (v.length === 6) lookupPincode(v, 'current'); }} className={inp(errors.current_pincode)} placeholder="6-digit pincode" maxLength={6} inputMode="numeric" />
                      {pincodeLookingUp.current && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-blue-500" />}
                    </div>
                  </F>
                  <F label="State" required error={errors.current_state_code}>
                    <select value={formData.current_state_code || ''} onChange={e => { onChange('current_state_code', e.target.value); onChange('current_city_code', ''); if (e.target.value) fetchCities(e.target.value, 'current'); else setCityOptions([]); }} className={inp(errors.current_state_code)}>
                      <option value="">Select State</option>
                      {(codeLists[5] || []).map(s => <option key={s.code_mst_id} value={s.code_mst_id}>{s.code_desc}</option>)}
                    </select>
                  </F>
                  <F label="District" required error={errors.current_city_code}>
                    <select value={formData.current_city_code || ''} onChange={e => onChange('current_city_code', e.target.value)} disabled={!formData.current_state_code} className={inp(errors.current_city_code)}>
                      <option value="">{formData.current_state_code ? 'Select District' : 'Select state first'}</option>
                      {cityOptions.map(c => <option key={c.code_mst_id} value={c.code_mst_id}>{c.code_desc}</option>)}
                    </select>
                  </F>
                </div>
                </>)}
              </div>
              <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--fx-border)', boxShadow: 'var(--fx-elevation)' }}>
                <div className="px-5 py-3.5 flex items-center gap-2" style={{ background: 'var(--fx-green-tint)', borderBottom: '1px solid color-mix(in oklch, var(--fx-green) 35%, var(--fx-border))' }}>
                  <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in oklch, var(--fx-green) 12%, transparent)' }}><MapPin className="w-3.5 h-3.5" style={{ color: 'var(--fx-green)' }} /></div>
                  <p className="font-semibold text-sm" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>Permanent Address</p>
                </div>
                <div className="p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="House / Flat No" required error={errors.permanent_house} fieldName="permanent_house" fieldSources={formData.field_sources}>
                    <input type="text" value={formData.permanent_house || ''} onChange={e => onChange('permanent_house', e.target.value)} className={inp(errors.permanent_house)} placeholder="e.g. 456, Block C" />
                  </F>
                  <F label="Street / Road" required error={errors.permanent_street} fieldName="permanent_street" fieldSources={formData.field_sources}>
                    <input type="text" value={formData.permanent_street || ''} onChange={e => onChange('permanent_street', e.target.value)} className={inp(errors.permanent_street)} placeholder="e.g. Station Road" />
                  </F>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="Landmark" error={errors.permanent_landmark} fieldName="permanent_landmark" fieldSources={formData.field_sources}>
                    <input type="text" value={formData.permanent_landmark || ''} onChange={e => onChange('permanent_landmark', e.target.value)} className={inp(errors.permanent_landmark)} placeholder="Optional" />
                  </F>
                  <F label="Locality / Area" error={errors.permanent_locality} fieldName="permanent_locality" fieldSources={formData.field_sources}>
                    <input type="text" value={formData.permanent_locality || ''} onChange={e => onChange('permanent_locality', e.target.value)} className={inp(errors.permanent_locality)} placeholder="Optional" />
                  </F>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                  <F label="Pincode" required error={errors.permanent_pincode} fieldName="permanent_pincode" fieldSources={formData.field_sources}>
                    <div className="relative">
                      <input type="text" value={formData.permanent_pincode || ''} onChange={e => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); onChange('permanent_pincode', v); if (v.length === 6) lookupPincode(v, 'permanent'); }} className={inp(errors.permanent_pincode)} placeholder="6-digit pincode" maxLength={6} inputMode="numeric" />
                      {pincodeLookingUp.permanent && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-blue-500" />}
                    </div>
                  </F>
                  <F label="State" required error={errors.permanent_state_code} fieldName="permanent_state_code" fieldSources={formData.field_sources}>
                    <select value={formData.permanent_state_code || ''} onChange={e => { onChange('permanent_state_code', e.target.value); onChange('permanent_city_code', ''); if (e.target.value) fetchCities(e.target.value, 'permanent'); else setPermCityOptions([]); }} className={inp(errors.permanent_state_code)}>
                      <option value="">Select State</option>
                      {(codeLists[5] || []).map(s => <option key={s.code_mst_id} value={s.code_mst_id}>{s.code_desc}</option>)}
                    </select>
                  </F>
                  <F label="District" required error={errors.permanent_city_code} fieldName="permanent_city_code" fieldSources={formData.field_sources}>
                    <select value={formData.permanent_city_code || ''} onChange={e => onChange('permanent_city_code', e.target.value)} disabled={!formData.permanent_state_code} className={inp(errors.permanent_city_code)}>
                      <option value="">{formData.permanent_state_code ? 'Select District' : 'Select state first'}</option>
                      {permCityOptions.map(c => <option key={c.code_mst_id} value={c.code_mst_id}>{c.code_desc}</option>)}
                    </select>
                  </F>
                </div>
                </div>{/* p-5 */}
              </div>{/* permanent card */}
              <Nav onPrev={() => setCurrentStep(1)} onNext={handleNext} />
            </div>
          )}

          {currentStep === 4 && (
            <div className="space-y-4 animate-[fadeIn_0.3s_ease-out]">
              <SectionTitle icon="WRK" color="var(--fx-amber)" title="Occupation Details" />
              <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--fx-border)', boxShadow: 'var(--fx-elevation)' }}>
                <div className="px-5 py-3.5 flex items-center gap-2" style={{ background: 'var(--fx-amber-tint)', borderBottom: '1px solid var(--fx-amber-tint)' }}>
                  <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in oklch, var(--fx-amber) 12%, transparent)' }}><Building2 className="w-3.5 h-3.5" style={{ color: 'var(--fx-amber)' }} /></div>
                  <p className="font-semibold text-sm" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>Employment Details</p>
                </div>
              <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <F label="Qualification" required error={errors.qualification}>
                  <select value={formData.qualification || ''} onChange={e => onChange('qualification', e.target.value)} className={inp(errors.qualification)}>
                    <option value="">Select</option>
                    {(codeLists[7] || []).map(o => <option key={o.code_mst_id} value={o.code_mst_id}>{o.code_desc}</option>)}
                  </select>
                </F>
                <F label="Occupation" required error={errors.occupation} fieldName="occupation" fieldSources={formData.field_sources}>
                  <select value={formData.occupation || ''} onChange={e => onChange('occupation', e.target.value)} className={inp(errors.occupation)}>
                    <option value="">Select</option>
                    {(codeLists[8] || []).map(o => <option key={o.code_mst_id} value={o.code_mst_id}>{o.code_desc}</option>)}
                  </select>
                </F>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <F label="Industry Type" required error={errors.industry_type} fieldName="industry_type" fieldSources={formData.field_sources}>
                  <select value={formData.industry_type || ''} onChange={e => onChange('industry_type', e.target.value)} className={inp(errors.industry_type)}>
                    <option value="">Select</option>
                    {(codeLists[10] || []).map(o => <option key={o.code_mst_id} value={o.code_mst_id}>{o.code_desc}</option>)}
                  </select>
                </F>
                <F label="Employment Type" required error={errors.employment_type} fieldName="employment_type" fieldSources={formData.field_sources}>
                  <select value={formData.employment_type || ''} onChange={e => onChange('employment_type', e.target.value)} className={inp(errors.employment_type)}>
                    <option value="">Select</option>
                    {(codeLists[9] || []).map(o => <option key={o.code_mst_id} value={o.code_mst_id}>{o.code_desc}</option>)}
                  </select>
                </F>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <F label="Employer Name" fieldName="employer_name" fieldSources={formData.field_sources}><input type="text" value={formData.employer_name || ''} onChange={e => onChange('employer_name', e.target.value)} className={inp('')} placeholder="Company / Business name" /></F>
                <F label="Designation" required error={errors.designation} fieldName="designation" fieldSources={formData.field_sources}><input type="text" value={formData.designation || ''} onChange={e => onChange('designation', e.target.value)} className={inp(errors.designation)} placeholder="e.g. Senior Manager" /></F>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <F label="Total Experience (yrs)" required error={errors.total_work_experience} fieldName="total_work_experience" fieldSources={formData.field_sources}><input type="number" step="0.5" min="0.5" value={formData.total_work_experience || ''} onChange={e => onChange('total_work_experience', e.target.value)} className={inp(errors.total_work_experience)} placeholder="e.g. 5.5" /></F>
                <F label="Experience at Current Org (yrs)" error={errors.experience_current_org} fieldName="experience_current_org" fieldSources={formData.field_sources}><input type="number" step="0.5" min="0" value={formData.experience_current_org || ''} onChange={e => onChange('experience_current_org', e.target.value)} className={inp(errors.experience_current_org)} placeholder="e.g. 2" /></F>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <F label="Residential Status" required error={errors.residential_status}>
                  <select value={formData.residential_status || ''} onChange={e => onChange('residential_status', e.target.value)} className={inp(errors.residential_status)}>
                    <option value="">Select</option>
                    {(codeLists[11] || []).map(o => <option key={o.code_mst_id} value={o.code_mst_id}>{o.code_desc}</option>)}
                  </select>
                </F>
                <F label="Tenure Stability" required error={errors.tenure_stability}>
                  <select value={formData.tenure_stability || ''} onChange={e => onChange('tenure_stability', e.target.value)} className={inp(errors.tenure_stability)}>
                    <option value="">Select</option>
                    {[...(codeLists[12] || [])].reverse().map(o => <option key={o.code_mst_id} value={o.code_mst_id}>{o.code_desc}</option>)}
                  </select>
                </F>
              </div>
              <F label="Employer Address" required error={errors.employer_address}>
                <textarea rows={2} value={formData.employer_address || ''} onChange={e => onChange('employer_address', e.target.value)} className={inp(errors.employer_address)} placeholder="Full employer / business address" />
              </F>
              </div>{/* p-5 */}
              </div>{/* card */}
              <Nav onPrev={() => setCurrentStep(2)} onNext={handleNext} />
            </div>
          )}

          {currentStep === 5 && (
            <div className="space-y-4 animate-[fadeIn_0.3s_ease-out]">
              <SectionTitle icon="₹" color="var(--fx-accent)" title="Loan & Financial Details" />

              {/* ── Loan Type Selector ── */}
              <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--fx-border)', boxShadow: 'var(--fx-elevation)' }}>
                <div className="px-5 py-3.5 flex items-center gap-2" style={{ background: 'var(--fx-accent-tint)', borderBottom: '1px solid color-mix(in oklch, var(--fx-accent) 35%, var(--fx-border))' }}>
                  <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in oklch, var(--fx-accent) 12%, transparent)' }}><Tag className="w-3.5 h-3.5" style={{ color: 'var(--fx-accent)' }} /></div>
                  <p className="font-semibold text-sm" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>Loan Type</p>
                  {(() => {
                    const src = formData.field_sources?.consumer_loan_type;
                    if (!src) return null;
                    return src.modified
                      ? <span className="ml-2 px-1.5 py-0.5 text-[9px] font-medium rounded bg-orange-100 text-orange-700">Modified</span>
                      : <span className="ml-2 px-1.5 py-0.5 text-[9px] font-medium rounded bg-green-100 text-green-700">Voice Call</span>;
                  })()}
                </div>
                <div className="p-5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {[
                      { value: 'personal', label: 'Personal Loan', desc: 'For any personal need — medical, travel, wedding, etc.' },
                      { value: 'consumer_durable', label: 'Consumer Durable Loan', desc: 'For buying electronics or home appliances with a dealer quotation.' },
                    ].map(opt => (
                      <button key={opt.value} type="button"
                        onClick={() => onChange('consumer_loan_type', opt.value)}
                        className="text-left p-4 rounded-xl border-2 transition-all"
                        style={{
                          borderColor: (formData.consumer_loan_type || 'personal') === opt.value ? 'var(--fx-accent)' : 'var(--fx-border)',
                          background: (formData.consumer_loan_type || 'personal') === opt.value ? 'var(--fx-accent-tint)' : 'var(--fx-surface)',
                        }}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-semibold text-sm" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>{opt.label}</span>
                          {(formData.consumer_loan_type || 'personal') === opt.value && (
                            <span className="ml-auto text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--fx-accent)', color: '#fff' }}>Selected</span>
                          )}
                        </div>
                        <p className="text-xs" style={{ color: 'var(--fx-text2)', fontFamily: 'var(--font-body)' }}>{opt.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* ── Consumer Durable Fields (conditional) ── */}
              {(formData.consumer_loan_type || 'personal') === 'consumer_durable' && (
                <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid color-mix(in oklch, var(--fx-orange) 35%, var(--fx-border))', boxShadow: 'var(--fx-elevation)' }}>
                  <div className="px-5 py-3.5 flex items-center gap-2" style={{ background: 'var(--fx-orange-tint)', borderBottom: '1px solid color-mix(in oklch, var(--fx-orange) 35%, var(--fx-border))' }}>
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in oklch, var(--fx-orange) 12%, transparent)' }}><ShoppingBag className="w-3.5 h-3.5" style={{ color: 'var(--fx-orange)' }} /></div>
                    <p className="font-semibold text-sm" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>Product & Dealer Details</p>
                  </div>
                  <div className="p-5 space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                      <F label="Product Name" required error={errors.product_name}>
                        <input type="text" value={formData.product_name || ''} onChange={e => onChange('product_name', e.target.value)}
                          className={inp(errors.product_name)} placeholder="e.g. LG 1.5 Ton Split AC" />
                      </F>
                      <F label="Brand" required error={errors.brand}>
                        <input type="text" value={formData.brand || ''} onChange={e => onChange('brand', e.target.value)}
                          className={inp(errors.brand)} placeholder="e.g. LG, Samsung, Dell" />
                      </F>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                      <F label="Model Number">
                        <input type="text" value={formData.model_number || ''} onChange={e => onChange('model_number', e.target.value)}
                          className={inp('')} placeholder="e.g. KS-Q18YNZA" />
                      </F>
                      <F label="Quotation Amount (₹)" required error={errors.quotation_amount}>
                        <input type="number" value={formData.quotation_amount || ''} onChange={e => {
                          const v = e.target.value;
                          onChange('quotation_amount', v);
                          onChange('loan_amount_requested', v);
                        }} className={inp(errors.quotation_amount)} placeholder="As per dealer quotation" />
                      </F>
                    </div>
                    <F label="Dealer Name" required error={errors.dealer_name}>
                      <input type="text" value={formData.dealer_name || ''} onChange={e => onChange('dealer_name', e.target.value)}
                        className={inp(errors.dealer_name)} placeholder="e.g. Vijay Sales, Croma" />
                    </F>
                    <F label="Dealer Shop Address">
                      <input type="text" value={formData.dealer_address || ''} onChange={e => onChange('dealer_address', e.target.value)}
                        className={inp('')} placeholder="Shop address" />
                    </F>
                    {/* Quotation upload — inline on Step 4 */}
                    <div>
                      <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--fx-text2)', fontFamily: 'var(--font-body)' }}>
                        Dealer Quotation (PDF / Image) <span style={{ color: 'var(--fx-red)' }}>*</span>
                      </label>
                      <div className={`flex items-center justify-between p-4 rounded-xl border-2 ${formData.quotation_url ? 'border-green-400/50 bg-green-50' : 'border-dashed border-orange-300 bg-orange-50/40'}`}>
                        <div>
                          {formData.quotation_url ? (
                            <div className="flex items-center gap-2">
                              <CheckCircle2 className="w-4 h-4 text-green-600" />
                              <span className="text-sm font-medium" style={{ color: 'var(--fx-green)' }}>Quotation uploaded</span>
                              <a href={fileUrl(formData.quotation_url)} target="_blank" rel="noopener noreferrer">
                                <Eye className="w-4 h-4 text-blue-500 hover:text-blue-700" />
                              </a>
                            </div>
                          ) : (
                            <div>
                              <p className="text-sm font-medium" style={{ color: 'var(--fx-amber)' }}>Upload dealer quotation</p>
                              <p className="text-xs mt-0.5" style={{ color: 'var(--fx-amber)' }}>PDF, JPG or PNG · Max 5MB</p>
                            </div>
                          )}
                          {errors.quotation_url && <p className="text-xs text-red-500 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{errors.quotation_url}</p>}
                        </div>
                        <label className="cursor-pointer">
                          <input type="file" accept=".jpg,.jpeg,.png,.pdf" className="hidden"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              if (!['image/jpeg','image/jpg','image/png','application/pdf'].includes(file.type)) {
                                setErrors((p: any) => ({ ...p, quotation_url: 'Only JPG, PNG or PDF allowed' }));
                                e.target.value = ''; return;
                              }
                              if (file.size > 5 * 1024 * 1024) {
                                setErrors((p: any) => ({ ...p, quotation_url: 'File too large. Max 5MB allowed' }));
                                e.target.value = ''; return;
                              }
                              setErrors((p: any) => ({ ...p, quotation_url: '' }));
                              const fd = new FormData();
                              fd.append('session_token', getSession() || '');
                              fd.append('document_type', 'quotation');
                              fd.append('file', file);
                              try {
                                const res = await fetch(`${API_URL}/api/upload-document-session`, { method: 'POST', body: fd });
                                const data = await res.json().catch(() => ({}));
                                if (res.ok && data.url) onChange('quotation_url', data.url);
                                else setErrors((p: any) => ({ ...p, quotation_url: data.detail || 'Upload failed. Please try again.' }));
                              } catch { setErrors((p: any) => ({ ...p, quotation_url: 'Could not reach the server. Check your connection and try again.' })); }
                            }}
                          />
                          <span className={`px-4 py-2 rounded-lg text-sm font-medium transition ${formData.quotation_url ? 'bg-green-600 text-white' : 'bg-orange-500 text-white hover:bg-orange-600'}`}>
                            {formData.quotation_url ? 'Replace' : 'Upload'}
                          </span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--fx-border)', boxShadow: 'var(--fx-elevation)' }}>
                <div className="px-5 py-3.5 flex items-center gap-2" style={{ background: 'var(--fx-accent-tint)', borderBottom: '1px solid color-mix(in oklch, var(--fx-accent) 35%, var(--fx-border))' }}>
                  <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in oklch, var(--fx-accent) 12%, transparent)' }}><CreditCard className="w-3.5 h-3.5" style={{ color: 'var(--fx-accent)' }} /></div>
                  <p className="font-semibold text-sm" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>Loan Details</p>
                </div>
              <div className="p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="Loan Amount (₹)" required error={errors.loan_amount_requested} fieldName="loan_amount_requested" fieldSources={formData.field_sources}>
                    <div className="relative">
                      {loanCapWarn && (
                        <div className="absolute bottom-full left-0 mb-1.5 z-50 animate-[fadeIn_0.15s]">
                          <div className="relative bg-red-600 text-white text-[11px] font-medium px-2.5 py-1.5 rounded-lg shadow-lg whitespace-nowrap">
                            Maximum limit is ₹1,00,000 (1 lakh)
                            <span className="absolute left-4 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-red-600" />
                          </div>
                        </div>
                      )}
                      <input
                        type="number"
                        max={100000}
                        value={formData.loan_amount_requested || ''}
                        onChange={e => {
                          const raw = e.target.value.slice(0, 16);
                          const num = parseFloat(raw);
                          if (!isNaN(num) && num > 100000) {
                            onChange('loan_amount_requested', '100000');
                            setLoanCapWarn(true);
                            if (loanCapTimer.current) clearTimeout(loanCapTimer.current);
                            loanCapTimer.current = setTimeout(() => setLoanCapWarn(false), 3000);
                          } else {
                            onChange('loan_amount_requested', raw);
                            setLoanCapWarn(false);
                          }
                        }}
                        onBlur={() => setErrors((p: any) => ({ ...p, loan_amount_requested: loanAmountError() }))}
                        className={inp(errors.loan_amount_requested)}
                        placeholder="₹20,000 – ₹1,00,000"
                      />
                    </div>
                  </F>
                  <F label="Repayment Period (Years)">
                    <select value={formData.repayment_period_years || ''} onChange={e => onChange('repayment_period_years', e.target.value)} className={inp('')}>
                      <option value="">Select</option>
                      {[1,2,3,5,7,10,15,20,25,30].map(y => <option key={y} value={y}>{y} {y===1?'year':'years'}</option>)}
                    </select>
                  </F>
                </div>
                <F label="Purpose of Loan" fieldName="purpose_of_loan" fieldSources={formData.field_sources}>
                  <input type="text" value={formData.purpose_of_loan || ''} onChange={e => onChange('purpose_of_loan', e.target.value)} className={inp('')} placeholder="e.g. Medical, Travel, Wedding..." />
                </F>
                <F label="Scheme"><input type="text" value={formData.scheme || ''} onChange={e => onChange('scheme', e.target.value)} className={inp('')} placeholder="Optional" /></F>
              </div>{/* p-5 */}
              </div>{/* loan card */}

              <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--fx-border)', boxShadow: 'var(--fx-elevation)' }}>
                <div className="px-5 py-3.5 flex items-center gap-2" style={{ background: 'var(--fx-green-tint)', borderBottom: '1px solid color-mix(in oklch, var(--fx-green) 35%, var(--fx-border))' }}>
                  <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in oklch, var(--fx-green) 12%, transparent)' }}><Banknote className="w-3.5 h-3.5" style={{ color: 'var(--fx-green)' }} /></div>
                  <p className="font-semibold text-sm" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>Financial Details</p>
                </div>
              <div className="p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="Monthly Gross Income (₹)" required error={errors.monthly_gross_income} fieldName="monthly_gross_income" fieldSources={formData.field_sources}>
                    <input type="number" max={9999999999999} value={formData.monthly_gross_income || ''} onChange={e => { const v = e.target.value.slice(0, 16); setFormData((p: any) => ({ ...p, monthly_gross_income: v, monthly_net_income: String(Math.max(0, (parseFloat(v) || 0) - (parseFloat(p.monthly_deductions) || 0) - (parseFloat(p.monthly_emi_existing) || 0))) })); }} className={inp(errors.monthly_gross_income)} placeholder="Before deductions" />
                  </F>
                  <F label="Monthly Deductions (₹)">
                    <input type="number" max={9999999999999} value={formData.monthly_deductions || ''} onChange={e => { const v = e.target.value.slice(0, 16); setFormData((p: any) => ({ ...p, monthly_deductions: v, monthly_net_income: String(Math.max(0, (parseFloat(p.monthly_gross_income) || 0) - (parseFloat(v) || 0) - (parseFloat(p.monthly_emi_existing) || 0))) })); }} className={inp('')} placeholder="Tax, PF etc." />
                  </F>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="Existing Monthly EMIs (₹)" fieldName="monthly_emi_existing" fieldSources={formData.field_sources}>
                    <input type="number" max={9999999999999} value={formData.monthly_emi_existing || ''} onChange={e => { const v = e.target.value.slice(0, 16); setFormData((p: any) => ({ ...p, monthly_emi_existing: v, monthly_net_income: String(Math.max(0, (parseFloat(p.monthly_gross_income) || 0) - (parseFloat(p.monthly_deductions) || 0) - (parseFloat(v) || 0))) })); }} className={inp('')} placeholder="0 if none" />
                  </F>
                  <F label="Monthly Net Income (₹)" required error={errors.monthly_net_income}>
                    <input type="number" value={formData.monthly_net_income || ''} readOnly className={`${inp(errors.monthly_net_income)} bg-gray-100 dark:bg-gray-800 cursor-not-allowed`} placeholder="Auto: Gross − Deductions − EMIs" title="Auto-calculated from Gross − Deductions − Existing EMIs" />
                  </F>
                </div>
              </div>{/* p-5 */}
              </div>{/* financial card */}
              {/* ── Guarantor Details ── */}
              {(() => {
                const loanAmt = parseFloat(formData.loan_amount_requested || '0');
                const required = loanAmt > 100000;
                const disabled = !required;
                return (
                <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--fx-border)', boxShadow: 'var(--fx-elevation)', opacity: disabled ? 0.5 : 1 }}>
                  <div className="px-5 py-3.5 flex items-center gap-2" style={{ background: 'var(--fx-accent-tint)', borderBottom: '1px solid color-mix(in oklch, var(--fx-accent) 35%, var(--fx-border))' }}>
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in oklch, var(--fx-accent) 12%, transparent)' }}><Users className="w-3.5 h-3.5" style={{ color: 'var(--fx-accent)' }} /></div>
                    <p className="font-semibold text-sm" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>Guarantor Details</p>
                    {required
                      ? <span className="ml-auto text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--fx-red-tint)', color: 'var(--fx-red)', fontFamily: 'var(--font-body)' }}>Required for loans &gt; ₹1 lakh</span>
                      : <span className="ml-auto text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--fx-surface2)', color: 'var(--fx-text2)', fontFamily: 'var(--font-body)' }}>Required only for loans &gt; ₹1 lakh</span>
                    }
                  </div>
                  <div className="p-5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                      <F label="Guarantor Name" required={required} error={errors.guarantor_name} fieldName="guarantor_name" fieldSources={formData.field_sources}>
                        <input type="text" value={formData.guarantor_name || ''}
                          onChange={e => onChange('guarantor_name', e.target.value.replace(/[^A-Za-z .'-]/g, ''))}
                          onBlur={() => setErrors((p: any) => ({ ...p, guarantor_name: guarantorNameError(formData.guarantor_name) }))}
                          className={inp(errors.guarantor_name)} placeholder="Full name of guarantor" disabled={disabled} />
                      </F>
                      <F label="Guarantor Phone Number" required={required} error={errors.guarantor_phone} fieldName="guarantor_phone" fieldSources={formData.field_sources}>
                        <input type="tel" value={formData.guarantor_phone || ''}
                          onChange={e => onChange('guarantor_phone', e.target.value.replace(/\D/g, '').slice(0, 10))}
                          onBlur={() => setErrors((p: any) => ({ ...p, guarantor_phone: guarantorPhoneError(formData.guarantor_phone) }))}
                          className={inp(errors.guarantor_phone)} placeholder="10-digit mobile number" maxLength={10} inputMode="numeric" disabled={disabled} />
                      </F>
                    </div>
                  </div>
                </div>
                );
              })()}

              <div className="rounded-xl p-4" style={{ background: 'var(--fx-amber-tint)', border: '1px solid var(--fx-amber-tint)' }}>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={formData.criminal_records || false} onChange={e => { onChange('criminal_records', e.target.checked); if (e.target.checked) setErrors((p: any) => ({ ...p, criminal_records: undefined })); }} className="mt-1 w-5 h-5 flex-shrink-0 cursor-pointer" style={{ accentColor: 'var(--fx-accent)' }} />
                  <span className="text-sm" style={{ color: 'var(--fx-amber)', fontFamily: 'var(--font-body)' }}>I do not have any pending criminal cases or criminal records</span>
                </label>
                {errors.criminal_records && <p className="mt-2 text-xs text-red-600">{errors.criminal_records}</p>}
              </div>
              <Nav onPrev={() => setCurrentStep(3)} onNext={handleNext} />
            </div>
          )}

          {currentStep === 2 && (
            <div className="space-y-5 animate-[fadeIn_0.3s_ease-out]">
              <SectionTitle icon="DOC" color="var(--fx-orange)" title="Documents" />
              {/* Deliberately NOT listing file types here any more: they now differ per
                  document (photo is images-only, bank statement is PDF-only), so a
                  blanket "PDF / JPG / PNG accepted" would contradict the per-row hints
                  and mislead exactly where the rules matter most. */}
              <p className="text-sm" style={{ color: 'var(--fx-text3)', fontFamily: 'var(--font-body)' }}>Anything we could fetch for you is already filled in. Max 5MB per file · accepted formats are listed under each document.</p>
              {docError && (
                <div className="flex items-start gap-2.5 rounded-xl p-3.5"
                  style={{ background: 'var(--fx-red-tint)', border: '1px solid var(--fx-red-tint)' }}>
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--fx-red)' }} />
                  <p className="text-sm" style={{ color: 'var(--fx-red)', fontFamily: 'var(--font-body)' }}>{docError}</p>
                </div>
              )}
              <div className="space-y-3">
                {documentsFor(formData.consumer_loan_type).map(doc => {
                  // The row renders by JOURNEY, not by "has a file yet". A
                  // DigiLocker-fetched Aadhaar and a hand-picked salary slip are
                  // both "done", but they got there differently and the customer
                  // should be able to see which.
                  const auto = wasAutoFilled(doc, formData);
                  const state = journeyState(doc, formData);
                  const isDigilocker = auto;
                  return (
                  <div key={doc.key}>
                  <div className="flex items-center justify-between gap-3 p-4 rounded-xl"
                    style={{
                      background: 'var(--fx-surface)',
                      // The border carries the state; the surface stays neutral so
                      // badge text is always legible against it.
                      border: `1.5px solid ${
                        !formData[doc.key]
                          ? 'var(--fx-border)'
                          : isDigilocker
                            ? 'color-mix(in oklch, var(--fx-accent) 45%, var(--fx-border))'
                            : 'color-mix(in oklch, var(--fx-green) 45%, var(--fx-border))'
                      }`,
                    }}>
                    <div>
                      <p className="text-sm font-medium" style={{ color: 'var(--fx-text)' }}>{doc.label} {doc.required && <span style={{ color: 'var(--fx-red)' }}>*</span>}</p>
                      {/* What a valid file looks like for THIS document — the
                          single most effective way to prevent a wrong upload. */}
                      {!formData[doc.key] && doc.hint && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--fx-text3)' }}>{doc.hint}</p>
                      )}
                      {/* A `fetch` row whose source has not run yet: tell the
                          customer the automatic route exists and where it is,
                          instead of silently demanding a file. */}
                      {state === 'awaiting' && (
                        <button type="button"
                          onClick={() => { autoSave(); setCurrentStep(1); window.scrollTo(0, 0); }}
                          className="text-xs mt-1 underline underline-offset-2"
                          style={{ color: 'var(--fx-accent)', fontFamily: 'var(--font-body)' }}>
                          Verify with DigiLocker to fill this automatically
                        </button>
                      )}
                      {/* A journey that WOULD be automatic but is not wired yet.
                          Stated plainly rather than dressed up as a choice. */}
                      {state !== 'done' && doc.automationPending && (
                        <p className="text-xs mt-1" style={{ color: 'var(--fx-amber)' }}>{doc.automationPending}</p>
                      )}
                      {/* What we will DO with the file, for journeys where
                          storing it is not the end of the story. */}
                      {state !== 'done' && doc.journey === 'parse' && doc.journeyNote && (
                        <p className="text-xs mt-1" style={{ color: 'var(--fx-text3)' }}>{doc.journeyNote}</p>
                      )}
                      {doc.journey === 'vendor' && aaUploadState === 'initiating' && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--fx-text3)' }}>Generating secure upload link…</p>
                      )}
                      {doc.journey === 'vendor' && aaUploadState === 'polling' && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--fx-text3)' }}>Processing your bank statement…</p>
                      )}
                      {doc.journey === 'vendor' && aaUploadError && (
                        <p className="text-xs mt-1 flex items-center gap-1" style={{ color: 'var(--fx-red)' }}><AlertTriangle className="w-3 h-3" />{aaUploadError}</p>
                      )}
                      {formData[doc.key] && (
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {isDigilocker ? (
                          <span className="text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1"
                            style={{ background: 'var(--fx-surface2)', color: 'var(--fx-accent)', border: '1px solid var(--fx-border)' }}>
                            <ShieldCheck className="w-3 h-3" />{doc.journeyNote || 'DigiLocker Verified'}
                          </span>
                        ) : (
                          <p className="text-xs flex items-center gap-1" style={{ color: 'var(--fx-green)' }}><CheckCircle2 className="w-3 h-3" />
                            {doc.journey === 'parse' ? 'Uploaded — will be analysed' : doc.journey === 'vendor' ? 'Verified via Account Aggregator' : 'Uploaded'}
                          </p>
                        )}
                        {doc.journey !== 'vendor' && <button onClick={() => { setPreviewDisclaimer(true); setPreviewDoc({ url: fileUrl(formData[doc.key]), label: doc.label }); }} className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition"><Eye className="w-4 h-4" /></button>}
                      </div>
                    )}
                    </div>
                    {doc.journey === 'vendor' ? (
                      formData[doc.key] ? (
                        <button type="button"
                          onClick={() => { onChange(doc.key, ''); setAaUploadState('idle'); setAaUploadError(''); }}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium transition"
                          style={{ background: 'var(--fx-surface2)', color: 'var(--fx-text2)', border: '1px solid var(--fx-border)' }}>
                          Re-upload
                        </button>
                      ) : (
                        <button type="button"
                          onClick={handleAAStatementInitiate}
                          disabled={aaUploadState === 'initiating' || aaUploadState === 'polling'}
                          className="px-4 py-2 rounded-lg text-sm font-medium transition inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-60"
                          style={{ background: 'var(--fx-accent)', color: '#fff' }}>
                          {(aaUploadState === 'initiating' || aaUploadState === 'polling') && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          {aaUploadState === 'initiating' ? 'Connecting…' : aaUploadState === 'polling' ? 'Processing…' : 'Upload via AA'}
                        </button>
                      )
                    ) : (
                      <label className="cursor-pointer">
                        {/* accept comes from the document's own spec: a passport
                            photo is images-only, a bank statement is PDF-only.
                            One shared accept let customers attach a photo of a
                            statement, which Digitap cannot parse at all. */}
                        <input type="file" accept={doc.accept} className="hidden" disabled={!!uploading[doc.key]}
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            // Extension-based, not MIME: some Android pickers send
                            // application/octet-stream for a valid PDF, and the old
                            // MIME allow-list rejected those outright.
                            const fileErr = validateDocFile(doc, file);
                            if (fileErr) {
                              setErrors((p: any) => ({ ...p, [doc.key]: fileErr }));
                              e.target.value = '';
                              return;
                            }
                            setErrors((p: any) => ({ ...p, [doc.key]: '' }));
                            const fd = new FormData();
                            fd.append('session_token', getSession() || '');
                            fd.append('document_type', doc.key.replace('_url', ''));
                            fd.append('file', file);
                            setUploading((u: any) => ({ ...u, [doc.key]: true }));
                            try {
                              const res = await fetch(`${API_URL}/api/upload-document-session`, { method: 'POST', body: fd });
                              const data = await res.json().catch(() => ({}));
                              if (res.ok && data.url) {
                                onChange(doc.key, data.url);
                              } else {
                                // Show the server's reason verbatim — it names the
                                // actual problem (wrong type, too large, not saved).
                                setErrors((p: any) => ({ ...p, [doc.key]: data.detail || 'Upload failed. Please try again.' }));
                                e.target.value = '';
                              }
                            } catch {
                              setErrors((p: any) => ({ ...p, [doc.key]: 'Could not reach the server. Check your connection and try again.' }));
                              e.target.value = '';
                            } finally {
                              setUploading((u: any) => ({ ...u, [doc.key]: false }));
                            }
                          }}
                        />
                        {/* The verb matches the journey. A `fetch` document that
                            DigiLocker has not filled yet offers "Upload instead"
                            — the manual fallback, not the expected path — so the
                            customer is not told to go find a file we can retrieve. */}
                        <span className={`px-4 py-2 rounded-lg text-sm font-medium transition inline-flex items-center gap-1.5 whitespace-nowrap ${uploading[doc.key] ? 'opacity-70 cursor-wait' : ''} ${formData[doc.key] ? 'bg-green-600 text-white' : state === 'awaiting' ? 'bg-gray-500 text-white hover:bg-gray-600' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                          {uploading[doc.key] && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          {uploading[doc.key]
                            ? 'Uploading'
                            : formData[doc.key]
                              ? 'Replace'
                              : state === 'awaiting'
                                ? 'Upload instead'
                                : 'Upload'}
                        </span>
                      </label>
                    )}
                  </div>
                  {errors[doc.key] && <p className="text-xs text-red-500 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{errors[doc.key]}</p>}
                  </div>
                  );
                })}
              </div>
              <Nav onPrev={() => setCurrentStep(4)} onNext={handleNext} />
            </div>
          )}

          {currentStep === 6 && (
            <div className="space-y-5 animate-[fadeIn_0.3s_ease-out]">
              <SectionTitle icon="RVW" color="var(--fx-green)" title="Review & Submit" />
              <RS title="Identity & KYC">
                <RR label="PAN" value={formData.pan_number ? formData.pan_number.slice(0,2)+'***'+formData.pan_number.slice(-2) : ''} />
                <RR label="Aadhaar" value={formData.aadhaar_number ? 'XXXX XXXX '+String(formData.aadhaar_number).slice(-4) : formData.aadhaar_last4 ? `XXXX XXXX ${formData.aadhaar_last4}` : ''} />
                <RR label="Name" value={[formData.first_name, formData.middle_name, formData.last_name].filter(Boolean).join(' ') || formData.customer_name} />
                <RR label="DOB" value={formData.date_of_birth} />
                <RR label="Gender" value={formData.gender} />
                <RR label="Marital Status" value={formData.marital_status} />
              </RS>
              <RS title="Address">
                <RR label="Permanent" value={[formData.permanent_house, formData.permanent_street, formData.permanent_landmark, formData.permanent_locality].filter(Boolean).join(', ') || formData.permanent_address} />
                <RR label="Pincode" value={formData.permanent_pincode} />
                <RR label="State" value={codeLabel(5, formData.permanent_state_code)} />
                <RR label="District" value={codeLabel(6, formData.permanent_city_code)} />
                {formData.same_as_current ? (
                  <RR label="Current" value="Same as permanent address" />
                ) : (
                  <RR label="Current" value={[formData.current_house, formData.current_street, formData.current_landmark, formData.current_locality].filter(Boolean).join(', ') || formData.current_address} />
                )}
              </RS>
              <RS title="Occupation">
                <RR label="Qualification" value={codeLabel(7, formData.qualification)} />
                <RR label="Employment" value={codeLabel(9, formData.employment_type)} />
                <RR label="Employer" value={formData.employer_name} />
                <RR label="Designation" value={formData.designation} />
                <RR label="Experience" value={formData.total_work_experience ? `${formData.total_work_experience} years` : ''} />
              </RS>
              <RS title="Loan & Financial">
                <RR label="Amount" value={formData.loan_amount_requested ? `₹${parseFloat(formData.loan_amount_requested).toLocaleString('en-IN')}` : ''} />
                <RR label="Purpose" value={formData.purpose_of_loan} />
                <RR label="Net Income" value={formData.monthly_net_income ? `₹${parseFloat(formData.monthly_net_income).toLocaleString('en-IN')}` : ''} />
              </RS>
              {(formData.guarantor_name || formData.guarantor_phone) && (
                <RS title="Guarantor">
                  <RR label="Name" value={formData.guarantor_name} />
                  <RR label="Phone" value={formData.guarantor_phone} />
                </RS>
              )}
              <div className="rounded-2xl p-4" style={{ background: 'var(--fx-accent-tint)', border: '1px solid color-mix(in oklch, var(--fx-accent) 35%, var(--fx-border))' }}>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)}
                    className="mt-1 w-5 h-5 rounded flex-shrink-0 cursor-pointer"
                    style={{ accentColor: 'var(--fx-accent)' }} />
                  <span className="text-sm" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-body)' }}>I declare all information provided is true and accurate. I authorize the bank to verify details and conduct credit checks as required.</span>
                </label>
              </div>
              {nameMatchLocked ? (
                <div className="rounded-xl p-4 flex items-start gap-3" style={{ background: 'var(--fx-red-tint)', border: '1px solid var(--fx-red-tint)' }}>
                  <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--fx-red)' }} />
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--fx-red)', fontFamily: 'var(--font-heading)' }}>Application Locked — Submission Not Allowed</p>
                    <p className="text-xs mt-1" style={{ color: 'var(--fx-red)', fontFamily: 'var(--font-body)' }}>This application is locked due to identity verification failure. Please contact your bank branch to unlock or re-verify your identity before submitting.</p>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl p-3 flex items-start gap-2" style={{ background: 'var(--fx-amber-tint)', border: '1px solid var(--fx-amber-tint)' }}>
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: 'var(--fx-amber)' }} />
                  <p className="text-xs" style={{ color: 'var(--fx-amber)', fontFamily: 'var(--font-body)' }}>Once submitted, this application cannot be edited until reviewed by a bank officer.</p>
                </div>
              )}
              <div className="flex gap-4">
                <button onClick={() => { autoSave(); setCurrentStep(5); window.scrollTo(0, 0); }}
                  className="flex-1 py-4 rounded-xl font-semibold transition hover:opacity-80"
                  style={{ background: 'var(--fx-surface2)', color: 'var(--fx-text2)', fontFamily: 'var(--font-heading)', border: '1px solid var(--fx-border)' }}>
                  ← Previous
                </button>
                <button onClick={handleSubmit} disabled={submitting || !agreed || nameMatchLocked}
                  className="flex-1 py-4 rounded-xl font-semibold text-white transition hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  style={{ background: nameMatchLocked ? 'var(--fx-red)' : 'linear-gradient(135deg, var(--fx-green) 0%, color-mix(in oklch, var(--fx-green) 75%, black) 100%)', fontFamily: 'var(--font-heading)' }}>
                  {nameMatchLocked ? 'Submission Locked' : submitting ? <><Loader2 className="w-5 h-5 animate-spin" /><span>Submitting...</span></> : 'Submit Application →'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Document Preview Modal */}
      {previewDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
          onClick={(e) => { if (e.target === e.currentTarget) setPreviewDoc(null); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setPreviewDoc(null); }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden animate-[fadeIn_0.15s_ease-out]">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
              <h3 className="font-semibold text-gray-900 dark:text-white text-sm sm:text-base truncate pr-4">{previewDoc.label}</h3>
              <div className="flex items-center gap-2 flex-shrink-0">
                <a href={previewDoc.url} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition" title="Open in new tab">
                  <ExternalLink className="w-4 h-4" />
                </a>
                <button onClick={() => setPreviewDoc(null)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            {/* Disclaimer banner for DigiLocker documents */}
            {previewDisclaimer && /digilocker/i.test(previewDoc.url) && (
              <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800/50 flex-shrink-0">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800 dark:text-amber-300 flex-1">
                  This is <strong>not</strong> an official Aadhaar document. This is a preview of identity information fetched via DigiLocker for verification purposes only.
                </p>
                <button onClick={() => setPreviewDisclaimer(false)} className="text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 flex-shrink-0">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {/* Content — disable right-click, drag, and PDF toolbar */}
            <div className="flex-1 overflow-auto flex items-center justify-center bg-gray-100 dark:bg-gray-950 min-h-[300px]"
              onContextMenu={e => e.preventDefault()}
              onDragStart={e => e.preventDefault()}
            >
              {/\.(jpg|jpeg|png|gif|webp)$/i.test(previewDoc.url) ? (
                <img src={previewDoc.url} alt={previewDoc.label} className="max-w-full max-h-[75vh] object-contain pointer-events-none select-none" draggable={false} />
              ) : /\.pdf$/i.test(previewDoc.url) ? (
                <iframe src={`${previewDoc.url}#toolbar=0&navpanes=0&scrollbar=1`} className="w-full h-[75vh]" title={previewDoc.label} />
              ) : (
                <div className="text-center p-8">
                  <p className="text-gray-500 dark:text-gray-400 text-sm mb-3">Preview not available for this file type</p>
                  <a href={previewDoc.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline text-sm flex items-center gap-1 justify-center">
                    <ExternalLink className="w-4 h-4" />Open in new tab
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function F({ label, required, error, children, fieldName, fieldSources }: any) {
  const src = fieldSources && fieldName ? fieldSources[fieldName] : null;
  return (
    <div className="transition-all duration-200">
      <div className="flex items-center flex-wrap gap-1 sm:gap-1.5 mb-1">
        <label className="text-sm font-medium" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-body)' }}>{label} {required && <span style={{ color: 'var(--fx-red)' }}>*</span>}</label>
        {src && !src.modified && (
          <div className="relative group flex-shrink-0">
            <span className={`px-1.5 sm:px-2 py-0.5 text-[8px] sm:text-[9px] font-medium rounded cursor-help inline-flex items-center gap-0.5 ${
              src.source === 'agent_call' ? 'fx-badge-green' : 'fx-badge-accent'
            }`}>
              {src.source === 'pan' ? 'PAN' : src.source === 'agent_call' ? 'Voice Call' : 'Aadhaar'}
            </span>
            <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-50 pointer-events-none">
              <div className="fx-tooltip text-[10px] px-2 py-1.5 rounded-lg whitespace-nowrap max-w-[250px]">
                <p>{src.source === 'agent_call' ? 'Collected during voice call' : `Fetched from ${src.source.toUpperCase()}`}</p>
                <p className="mt-0.5 truncate" style={{ color: 'var(--fx-text3)' }}>{src.original}</p>
              </div>
            </div>
          </div>
        )}
        {src && src.modified && (
          <div className="relative group flex-shrink-0">
            <span className="px-1.5 sm:px-2 py-0.5 text-[8px] sm:text-[9px] font-medium rounded fx-badge-orange cursor-help inline-flex items-center gap-0.5">
              Modified
            </span>
            <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-50 pointer-events-none">
              <div className="fx-tooltip text-[10px] px-2 py-1.5 rounded-lg whitespace-nowrap max-w-[250px]">
                <p>Original from {src.source === 'agent_call' ? 'VOICE CALL' : src.source.toUpperCase()}: <span style={{ color: 'var(--fx-text3)' }}>{src.original}</span></p>
                <p className="mt-0.5" style={{ color: 'var(--fx-orange)' }}>Modified by applicant</p>
              </div>
            </div>
          </div>
        )}
      </div>
      {children}
      {error && <p className="text-xs mt-1.5 flex items-center gap-1 animate-[fadeIn_0.2s]" style={{ color: 'var(--fx-red)', fontFamily: 'var(--font-body)' }}><AlertTriangle className="w-3 h-3 flex-shrink-0" />{error}</p>}
    </div>
  );
}
// The old `color + '18'` / `${color}40` alpha-suffix trick only worked for hex
// literals. Now that `color` is a design token (var(--fx-...)), concatenation
// produced invalid CSS like `var(--fx-orange)18` and the tint/border silently
// disappeared. color-mix does the same job for a token, in either theme.
function SectionTitle({ icon, color, title }: { icon: string; color: string; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-8 h-8 rounded flex items-center justify-center text-[10px] font-bold flex-shrink-0"
        style={{
          background: `color-mix(in oklch, ${color} 12%, transparent)`,
          border: `1px solid color-mix(in oklch, ${color} 30%, transparent)`,
          color,
          fontFamily: 'var(--font-heading)',
        }}>
        {icon}
      </div>
      <h2 className="text-lg font-bold" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>{title}</h2>
    </div>
  );
}
function Nav({ onPrev, onNext }: any) {
  return (
    <div className="flex gap-3 pt-2">
      {onPrev && (
        <button onClick={onPrev}
          className="flex-1 rounded-xl font-semibold text-sm transition hover:opacity-80 active:scale-[0.98]"
          style={{ background: 'var(--fx-surface2)', color: 'var(--fx-text2)', fontFamily: 'var(--font-heading)', border: '1.5px solid var(--fx-border)', height: '52px' }}>
          ← Back
        </button>
      )}
      {onNext && (
        <button onClick={onNext}
          className={`${onPrev ? 'flex-1' : 'w-full'} rounded-xl font-semibold text-white text-sm transition hover:-translate-y-0.5 hover:shadow-xl active:scale-[0.98]`}
          style={{ background: 'var(--fx-accent-grad)', fontFamily: 'var(--font-heading)', height: '52px', boxShadow: 'var(--fx-accent-glow)' }}>
          Continue →
        </button>
      )}
    </div>
  );
}
function RS({ title, children }: any) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--fx-border)', boxShadow: 'var(--fx-elevation)' }}>
      <div className="px-4 sm:px-5 py-3" style={{ background: 'var(--fx-surface2)', borderBottom: '1px solid var(--fx-border)' }}>
        <h3 className="font-semibold text-sm" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-heading)' }}>{title}</h3>
      </div>
      <div className="px-4 sm:px-5 py-4 space-y-3" style={{ background: 'var(--fx-surface)' }}>{children}</div>
    </div>
  );
}
function RR({ label, value }: any) {
  return (
    <div className="flex justify-between items-start gap-4">
      <span className="text-sm flex-shrink-0" style={{ color: 'var(--fx-text3)', fontFamily: 'var(--font-body)' }}>{label}</span>
      <span className="text-sm font-semibold text-right" style={{ color: 'var(--fx-text)', fontFamily: 'var(--font-body)' }}>{value || '—'}</span>
    </div>
  );
}
function inp(error: string) {
  // Explicit text colour in BOTH themes — without it the value inherits the
  // page colour and is invisible (dark text on the dark-mode field until blur).
  // Tokenised: one rule set that follows the theme, replacing the parallel
  // light/dark class pairs that had to be kept in sync by hand.
  const base = 'fx-input w-full px-4 py-3 rounded-xl text-sm outline-none transition-all duration-150 border';
  const ok   = 'fx-input-ok';
  const err  = 'fx-input-err animate-[shake_0.3s]';
  return `${base} ${error ? err : ok}`;
}
