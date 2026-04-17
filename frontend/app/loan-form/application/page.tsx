'use client';
import { Building2, Lock, CheckCircle2, Loader2, AlertTriangle, ShieldCheck, Eye, X, ExternalLink } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

import { API_URL, getCodeList } from '@/lib/api';
const INACTIVITY_LIMIT = 4 * 60 * 1000; // 4 min warning, 5 min logout

export default function LoanApplication() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [appData, setAppData] = useState<any>(null);
  const [formData, setFormData] = useState<any>({});
  const [currentStep, setCurrentStep] = useState(1);
  const [highestStep, setHighestStep] = useState(1);
  const [panVerifying, setPanVerifying] = useState(false);
  const [panFocused, setPanFocused] = useState(false);
  const [aadhaarVerifying, setAadhaarVerifying] = useState(false);
  const [codeLists, setCodeLists] = useState<Record<number, {code_mst_id: string, code_desc: string}[]>>({});
  const [cityOptions, setCityOptions] = useState<{code_mst_id: string, code_desc: string}[]>([]);
  const [permCityOptions, setPermCityOptions] = useState<{code_mst_id: string, code_desc: string}[]>([]);

  const handleVerifyPAN = async () => {
    const pan = formData.pan_number || '';
    if (!pan || !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan)) {
      setErrors((p: any) => ({ ...p, pan_number: 'Invalid PAN format (e.g. ABCDE1234F)' }));
      return;
    }
    setPanVerifying(true);
    try {
      const session = sessionStorage.getItem('loan_session');
      const res = await fetch(`${API_URL}/api/verify-pan-session?session_token=${session}&pan_number=${pan}`, { method: 'POST' });
      if (!res.ok) throw new Error('Verification failed');
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
        setFormData((p: any) => ({ ...p, field_sources: { ...(p.field_sources || {}), ...panSources } }));
      }
      setErrors((p: any) => ({ ...p, pan_number: '' }));
    } catch (err: any) {
      setErrors((p: any) => ({ ...p, pan_number: err.message || 'PAN verification failed' }));
    } finally { setPanVerifying(false); }
  };

  const [digilockerRequestId, setDigilockerRequestId] = useState('');
  const [digilockerStep, setDigilockerStep] = useState<'idle' | 'linking' | 'waiting' | 'fetching' | 'done'>('idle');

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

      // Save state before redirecting to DigiLocker
      sessionStorage.setItem('digilocker_request_id', linkData.request_id);

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
  const [previewDoc, setPreviewDoc] = useState<{ url: string; label: string } | null>(null);
  const [previewDisclaimer, setPreviewDisclaimer] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [errors, setErrors] = useState<any>({});
  const [inactivityWarning, setInactivityWarning] = useState(false);
  let inactivityTimer: any = null;
  let warningTimer: any = null;

  const getSession = () => sessionStorage.getItem('loan_session');

  const logout = useCallback(() => {
    sessionStorage.removeItem('loan_session');
    sessionStorage.removeItem('session_expiry');
    setSessionExpired(true);
  }, []);

  const resetInactivityTimer = useCallback(() => {
    clearTimeout(inactivityTimer);
    clearTimeout(warningTimer);
    setInactivityWarning(false);
    warningTimer = setTimeout(() => setInactivityWarning(true), INACTIVITY_LIMIT);
    inactivityTimer = setTimeout(() => logout(), INACTIVITY_LIMIT + 60000);
  }, [logout]);

  useEffect(() => {
    const session = getSession();
    if (!session) { router.push('/loan-form'); return; }
    loadApplication();
    const events = ['mousedown', 'keypress', 'scroll', 'touchstart'];
    events.forEach(e => window.addEventListener(e, resetInactivityTimer));
    resetInactivityTimer();
    return () => {
      events.forEach(e => window.removeEventListener(e, resetInactivityTimer));
      clearTimeout(inactivityTimer);
      clearTimeout(warningTimer);
    };
  }, []);

  // Detect return from DigiLocker redirect
  useEffect(() => {
    const requestId = sessionStorage.getItem('digilocker_request_id');
    if (!requestId || !appData) return;
    const session = getSession();
    if (!session) return;

    // Clear the flag immediately to prevent re-running
    sessionStorage.removeItem('digilocker_request_id');
    sessionStorage.removeItem('digilocker_aadhaar');

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
            onChange('full_name', d.name); onChange('customer_name', d.name);
            const np = d.name.trim().split(/\s+/);
            if (np.length >= 3) { onChange('first_name', np[0]); onChange('middle_name', np.slice(1,-1).join(' ')); onChange('last_name', np[np.length-1]); }
            else if (np.length === 2) { onChange('first_name', np[0]); onChange('last_name', np[1]); }
            else { onChange('first_name', d.name); }
          }
          if (d.dob) onChange('date_of_birth', d.dob);
          if (d.gender) onChange('gender', d.gender);
          if (d.address) onChange('current_address', d.address);
          if (d.house) onChange('current_house', d.house);
          if (d.street) onChange('current_street', d.street);
          if (d.landmark) onChange('current_landmark', d.landmark);
          if (d.locality) onChange('current_locality', d.locality);
          if (d.pin) onChange('current_pincode', d.pin);
          if (d.state_code) { onChange('current_state_code', d.state_code); fetchCities(d.state_code, 'current'); }
          if (d.city_code) onChange('current_city_code', d.city_code);
          if (d.marital_status) onChange('marital_status', d.marital_status);
          // Set field_sources for Aadhaar badges
          const aadhaarSources: Record<string, any> = {};
          if (d.dob) aadhaarSources.date_of_birth = { source: 'aadhaar', original: d.dob, modified: false };
          if (d.gender) aadhaarSources.gender = { source: 'aadhaar', original: d.gender, modified: false };
          if (d.house) aadhaarSources.current_house = { source: 'aadhaar', original: d.house, modified: false };
          if (d.street) aadhaarSources.current_street = { source: 'aadhaar', original: d.street, modified: false };
          if (d.landmark) aadhaarSources.current_landmark = { source: 'aadhaar', original: d.landmark, modified: false };
          if (d.locality) aadhaarSources.current_locality = { source: 'aadhaar', original: d.locality, modified: false };
          if (d.pin) aadhaarSources.current_pincode = { source: 'aadhaar', original: d.pin, modified: false };
          if (d.state_code || d.state) aadhaarSources.current_state_code = { source: 'aadhaar', original: d.state || d.state_code, modified: false };
          if (d.city_code || d.district) aadhaarSources.current_city_code = { source: 'aadhaar', original: d.district || d.city_code, modified: false };
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
          setFormData((p: any) => ({ ...p, field_sources: { ...(p.field_sources || {}), ...aadhaarSources } }));
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
        setAppData(data.data);
        setFormData(data.data);
        const savedStep = data.data.current_step || 1; setCurrentStep(savedStep); setHighestStep(Math.max(savedStep, data.data.highest_step || 1));
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
        current_address: [formData.current_house, formData.current_street, formData.current_landmark, formData.current_locality].filter(Boolean).join(', '),
        permanent_address: isSame
          ? [formData.current_house, formData.current_street, formData.current_landmark, formData.current_locality].filter(Boolean).join(', ')
          : [formData.permanent_house, formData.permanent_street, formData.permanent_landmark, formData.permanent_locality].filter(Boolean).join(', '),
        same_as_current: formData.same_as_current,
        // Split address fields
        current_house: formData.current_house,
        current_street: formData.current_street,
        current_landmark: formData.current_landmark,
        current_locality: formData.current_locality,
        current_pincode: formData.current_pincode,
        current_state_code: formData.current_state_code,
        current_city_code: formData.current_city_code,
        permanent_house: isSame ? formData.current_house : formData.permanent_house,
        permanent_street: isSame ? formData.current_street : formData.permanent_street,
        permanent_landmark: isSame ? formData.current_landmark : formData.permanent_landmark,
        permanent_locality: isSame ? formData.current_locality : formData.permanent_locality,
        permanent_pincode: isSame ? formData.current_pincode : formData.permanent_pincode,
        permanent_state_code: isSame ? formData.current_state_code : formData.permanent_state_code,
        permanent_city_code: isSame ? formData.current_city_code : formData.permanent_city_code,
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
      setLastSaved(new Date().toLocaleTimeString());
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

  // Live validation on blur
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

  const step1Valid = () => validate({ pan_number: 'Required', full_name: 'Required', date_of_birth: 'Required', gender: 'Required' });
  const step2Valid = () => {
    const base: any = { current_house: 'Required', current_street: 'Required', current_pincode: 'Required', current_state_code: 'Required', current_city_code: 'Required' };
    if (!formData.same_as_current) {
      base.permanent_house = 'Required'; base.permanent_street = 'Required';
      base.permanent_pincode = 'Required'; base.permanent_state_code = 'Required'; base.permanent_city_code = 'Required';
    }
    const ok = validate(base);
    if (ok && formData.current_pincode && !/^\d{6}$/.test(formData.current_pincode)) {
      setErrors((p: any) => ({ ...p, current_pincode: 'Enter valid 6-digit pincode' })); return false;
    }
    if (ok && !formData.same_as_current && formData.permanent_pincode && !/^\d{6}$/.test(formData.permanent_pincode)) {
      setErrors((p: any) => ({ ...p, permanent_pincode: 'Enter valid 6-digit pincode' })); return false;
    }
    return ok;
  };
  const step3Valid = () => validate({ qualification: 'Required', occupation: 'Required', industry_type: 'Required', employment_type: 'Required', designation: 'Required', total_work_experience: 'Required', residential_status: 'Required', tenure_stability: 'Required', employer_address: 'Required' });
  const step4Valid = () => validate({ loan_amount_requested: 'Required', purpose_of_loan: 'Required', monthly_gross_income: 'Required', monthly_net_income: 'Required' });

  const handleNext = () => {
    let valid = false;
    if (currentStep === 1) valid = step1Valid();
    else if (currentStep === 2) valid = step2Valid();
    else if (currentStep === 3) valid = step3Valid();
    else if (currentStep === 4) valid = step4Valid();
    else valid = true;

    if (valid) {
      autoSave();
      setCurrentStep(prev => { const next = prev + 1; setHighestStep(h => Math.max(h, next)); return next; });
      setErrors({});
      window.scrollTo(0, 0);
    }
  };

  const handleSubmit = async () => {
    if (!agreed) { alert('Please agree to the declaration'); return; }
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
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-red-100 dark:from-gray-900 dark:to-gray-950 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-dark-card rounded-2xl shadow-xl dark:shadow-gray-900/50 p-8 max-w-md w-full text-center">
        <div className="mb-4"><AlertTriangle className="w-16 h-16 text-orange-500 mx-auto" /></div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Session Expired</h2>
        <p className="text-gray-600 mb-6">Your session has expired due to inactivity. Please verify again to continue.</p>
        <button onClick={() => router.push('/loan-form')} className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-4 rounded-xl font-semibold hover:from-blue-700 hover:to-indigo-700 transition">
          Re-verify with OTP →
        </button>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-4">Your progress has been saved automatically</p>
      </div>
    </div>
  );

  if (loading) return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-950 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-600 mx-auto"></div>
        <p className="mt-4 text-gray-600">Loading your application...</p>
      </div>
    </div>
  );

  const steps = ['KYC & Identity', 'Address', 'Occupation', 'Loan & Financial', 'Documents', 'Review'];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-950 py-6 px-4 transition-colors">
      {inactivityWarning && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 pointer-events-none">
          <div className="pointer-events-auto bg-white/80 dark:bg-dark-card/80 backdrop-blur-md border border-orange-200 dark:border-orange-800 shadow-2xl rounded-2xl px-8 py-5 max-w-md w-full mx-4 animate-[slideDown_0.3s_ease-out]">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-orange-500" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">Session Expiring Soon</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Your session will expire in 1 minute due to inactivity. Interact with the form to stay active.</p>
              </div>
            </div>
            <div className="mt-3 h-1 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-orange-400 rounded-full animate-[shrink_60s_linear_forwards]" />
            </div>
          </div>
        </div>
      )}

      <div className="max-w-2xl mx-auto px-3 sm:px-4">
        <div className="bg-white dark:bg-dark-card rounded-2xl shadow-lg dark:shadow-gray-900/50 p-3 sm:p-5 mb-4 transition-colors">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h1 className="text-base sm:text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2"><Building2 className="w-5 h-5 text-blue-600 flex-shrink-0" />Loan Application</h1>
              <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 truncate max-w-[200px] sm:max-w-none">
                {appData?.customer_name} · {appData?.loan_id}
              </p>
            </div>
            <div className="text-xs text-right">
              <div className="flex items-center gap-3">
              {saving ? <span className="text-blue-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /><span className="hidden sm:inline">Saving...</span></span> : lastSaved ? <span className="text-green-500 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /><span className="hidden sm:inline">Saved {lastSaved}</span></span> : null}
              <ThemeToggle />
            </div>
            </div>
          </div>
          <div className="relative">
            <div className="absolute top-3.5 sm:top-4 left-4 sm:left-6 right-4 sm:right-6 h-0.5 bg-gray-200 dark:bg-gray-700"></div>
            <div className="absolute top-3.5 sm:top-4 left-4 sm:left-6 h-0.5 bg-green-400 transition-all duration-300" style={{width: `${Math.max(0, (Math.max(highestStep, currentStep) - 1)) / (steps.length - 1) * (100 - 8)}%`}}></div>
            <div className="relative flex justify-between">
              {steps.map((s, i) => {
                const stepNum = i + 1;
                const isViewing = currentStep === stepNum;
                const isCompleted = highestStep > stepNum && !isViewing;
                const isActiveFrontier = highestStep === stepNum && !isViewing;
                const isReachable = stepNum <= highestStep;
                return (
                  <div key={i} className="flex flex-col items-center" style={{width: `${100/steps.length}%`}}>
                    <div
                      onClick={() => { if (isReachable) { autoSave(); setCurrentStep(stepNum); window.scrollTo(0,0); } }}
                      className={`w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-[10px] sm:text-xs font-bold z-10 transition-all duration-200 ${
                        isViewing
                          ? 'bg-blue-600 text-white cursor-pointer ring-4 ring-blue-200 hover:bg-blue-700 hover:scale-110'
                          : isActiveFrontier
                          ? 'bg-white text-blue-600 border-[3px] border-blue-500 cursor-pointer hover:bg-blue-50 hover:scale-110'
                          : isCompleted
                          ? 'bg-green-500 text-white cursor-pointer hover:bg-green-600 hover:scale-110'
                          : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {isCompleted ? '✓' : stepNum}
                    </div>
                    <span className={`text-[9px] sm:text-[11px] mt-1 sm:mt-2 text-center leading-tight ${
                      isViewing ? 'text-blue-600 font-semibold'
                        : isActiveFrontier ? 'text-blue-500 font-medium'
                        : isCompleted ? 'text-green-600 font-medium'
                        : 'text-gray-400'
                    }`}>{s}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-dark-card rounded-2xl shadow-lg dark:shadow-gray-900/50 p-4 sm:p-6 transition-colors">

          {currentStep === 1 && (
            <div className="space-y-5 animate-[fadeIn_0.3s_ease-out]">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">KYC & Personal Details</h2>
              <div className="bg-blue-50 dark:bg-dark-section border border-blue-200 dark:border-gray-700/50 rounded-xl p-4 space-y-4">
                <p className="text-sm font-semibold text-blue-800 dark:text-gray-300">Identity Verification</p>
                <F label="PAN Number" required error={errors.pan_number}>
                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <input type="text"
                        value={panFocused ? (formData.pan_number || '') : (formData.pan_number ? formData.pan_number.replace(/./g, '\u2022') : '')}
                        onChange={e => onChange('pan_number', e.target.value.toUpperCase())}
                        onFocus={() => setPanFocused(true)}
                        onBlur={() => setPanFocused(false)}
                        disabled={formData.pan_verified}
                        readOnly={!panFocused && !!formData.pan_number && !formData.pan_verified}
                        className={`w-full ${formData.pan_verified ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-700' : ''} ${!panFocused && formData.pan_number ? 'tracking-widest' : ''} ${inp(errors.pan_number)}`}
                        placeholder="ABCDE1234F" maxLength={10} />
                      {formData.pan_number && !formData.pan_verified && !panFocused && (
                        <button type="button" onClick={() => { onChange('pan_number', ''); setPanFocused(true); }}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-red-500 transition p-1" title="Clear & re-enter">
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    <button type="button" onClick={handleVerifyPAN} disabled={formData.pan_verified || panVerifying} className={`px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition flex items-center justify-center gap-2 min-w-[110px] ${formData.pan_verified ? 'bg-green-500 text-white cursor-default' : 'bg-blue-600 text-white hover:bg-blue-700'} disabled:opacity-70`}>
                      {panVerifying ? <><Loader2 className="w-4 h-4 animate-spin" /><span>Verifying...</span></> : formData.pan_verified ? 'Verified' : 'Verify'}
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
                  ) : (
                    <button type="button" onClick={handleVerifyAadhaar} disabled={aadhaarVerifying}
                      className="w-full py-3 rounded-lg text-xs sm:text-sm font-semibold transition flex items-center justify-center gap-2 bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 active:scale-[0.98]">
                      {digilockerStep === 'linking' ? <><Loader2 className="w-4 h-4 animate-spin" /> <span>Opening DigiLocker...</span></> :
                       digilockerStep === 'fetching' ? <><Loader2 className="w-4 h-4 animate-spin" /> <span>Fetching data...</span></> :
                       <><ShieldCheck className="w-4 h-4" /> <span>Verify Aadhaar via DigiLocker</span></>}
                    </button>
                  )}
                  {digilockerStep === 'waiting' && <p className="text-xs text-orange-600 dark:text-orange-400 mt-1 animate-pulse">Please complete authentication on the DigiLocker window...</p>}
                  {digilockerStep === 'fetching' && <p className="text-xs text-blue-600 dark:text-blue-400 mt-1 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Fetching your Aadhaar data from DigiLocker...</p>}
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 flex items-center gap-1"><Lock className="w-3 h-3" />Only last 4 digits stored</p>
                </F>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                <F label="First Name" required error={errors.full_name} fieldName="first_name" fieldSources={formData.field_sources}>
                  <input type="text" value={formData.first_name || ''} onChange={e => { onChange('first_name', e.target.value); onChange('full_name', `${e.target.value} ${formData.middle_name||''} ${formData.last_name||''}`.trim()); }} className={inp(errors.full_name)} placeholder="First name" />
                </F>
                <F label="Middle Name" fieldName="middle_name" fieldSources={formData.field_sources}><input type="text" value={formData.middle_name || ''} onChange={e => onChange('middle_name', e.target.value)} className={inp('')} placeholder="Optional" /></F>
                <F label="Last Name" required fieldName="last_name" fieldSources={formData.field_sources}><input type="text" value={formData.last_name || ''} onChange={e => onChange('last_name', e.target.value)} className={inp('')} placeholder="Last name" /></F>
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
              <Nav onNext={handleNext} />
            </div>
          )}

          {currentStep === 2 && (
            <div className="space-y-5 animate-[fadeIn_0.3s_ease-out]">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">Address Details</h2>
              <div className="bg-blue-50 dark:bg-dark-section border border-blue-200 dark:border-gray-700/50 rounded-xl p-4 space-y-4">
                <p className="text-sm font-semibold text-blue-800 dark:text-gray-300">Current Address</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="House / Flat No" required error={errors.current_house} fieldName="current_house" fieldSources={formData.field_sources}>
                    <input type="text" value={formData.current_house || ''} onChange={e => onChange('current_house', e.target.value)} className={inp(errors.current_house)} placeholder="e.g. 123, Flat B-2" />
                  </F>
                  <F label="Street / Road" required error={errors.current_street} fieldName="current_street" fieldSources={formData.field_sources}>
                    <input type="text" value={formData.current_street || ''} onChange={e => onChange('current_street', e.target.value)} className={inp(errors.current_street)} placeholder="e.g. MG Road" />
                  </F>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="Landmark" fieldName="current_landmark" fieldSources={formData.field_sources}>
                    <input type="text" value={formData.current_landmark || ''} onChange={e => onChange('current_landmark', e.target.value)} className={inp('')} placeholder="e.g. Near Railway Station" />
                  </F>
                  <F label="Locality / Area" fieldName="current_locality" fieldSources={formData.field_sources}>
                    <input type="text" value={formData.current_locality || ''} onChange={e => onChange('current_locality', e.target.value)} className={inp('')} placeholder="e.g. Andheri West" />
                  </F>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                  <F label="Pincode" required error={errors.current_pincode} fieldName="current_pincode" fieldSources={formData.field_sources}>
                    <input type="text" value={formData.current_pincode || ''} onChange={e => onChange('current_pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} className={inp(errors.current_pincode)} placeholder="6-digit pincode" maxLength={6} inputMode="numeric" />
                  </F>
                  <F label="State" required error={errors.current_state_code} fieldName="current_state_code" fieldSources={formData.field_sources}>
                    <select value={formData.current_state_code || ''} onChange={e => { onChange('current_state_code', e.target.value); onChange('current_city_code', ''); if (e.target.value) fetchCities(e.target.value, 'current'); else setCityOptions([]); }} className={inp(errors.current_state_code)}>
                      <option value="">Select State</option>
                      {(codeLists[5] || []).map(s => <option key={s.code_mst_id} value={s.code_mst_id}>{s.code_desc}</option>)}
                    </select>
                  </F>
                  <F label="City / District" required error={errors.current_city_code} fieldName="current_city_code" fieldSources={formData.field_sources}>
                    <select value={formData.current_city_code || ''} onChange={e => onChange('current_city_code', e.target.value)} disabled={!formData.current_state_code} className={inp(errors.current_city_code)}>
                      <option value="">{formData.current_state_code ? 'Select City' : 'Select state first'}</option>
                      {cityOptions.map(c => <option key={c.code_mst_id} value={c.code_mst_id}>{c.code_desc}</option>)}
                    </select>
                  </F>
                </div>
              </div>
              <div className="bg-green-50 dark:bg-dark-section border border-green-200 dark:border-gray-700/50 rounded-xl p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-green-800 dark:text-gray-300">Permanent Address</p>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={formData.same_as_current || false} onChange={e => onChange('same_as_current', e.target.checked)} className="w-4 h-4 dark:bg-gray-700 dark:border-gray-600" />
                    <span className="text-xs sm:text-sm text-gray-600 dark:text-gray-400">Same as current</span>
                  </label>
                </div>
                {formData.same_as_current ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400 italic">Permanent address will be the same as current address.</p>
                ) : (<>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="House / Flat No" required error={errors.permanent_house}>
                    <input type="text" value={formData.permanent_house || ''} onChange={e => onChange('permanent_house', e.target.value)} className={inp(errors.permanent_house)} placeholder="e.g. 456, Block C" />
                  </F>
                  <F label="Street / Road" required error={errors.permanent_street}>
                    <input type="text" value={formData.permanent_street || ''} onChange={e => onChange('permanent_street', e.target.value)} className={inp(errors.permanent_street)} placeholder="e.g. Station Road" />
                  </F>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="Landmark"><input type="text" value={formData.permanent_landmark || ''} onChange={e => onChange('permanent_landmark', e.target.value)} className={inp('')} placeholder="Optional" /></F>
                  <F label="Locality / Area"><input type="text" value={formData.permanent_locality || ''} onChange={e => onChange('permanent_locality', e.target.value)} className={inp('')} placeholder="Optional" /></F>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                  <F label="Pincode" required error={errors.permanent_pincode}>
                    <input type="text" value={formData.permanent_pincode || ''} onChange={e => onChange('permanent_pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} className={inp(errors.permanent_pincode)} placeholder="6-digit pincode" maxLength={6} inputMode="numeric" />
                  </F>
                  <F label="State" required error={errors.permanent_state_code}>
                    <select value={formData.permanent_state_code || ''} onChange={e => { onChange('permanent_state_code', e.target.value); onChange('permanent_city_code', ''); if (e.target.value) fetchCities(e.target.value, 'permanent'); else setPermCityOptions([]); }} className={inp(errors.permanent_state_code)}>
                      <option value="">Select State</option>
                      {(codeLists[5] || []).map(s => <option key={s.code_mst_id} value={s.code_mst_id}>{s.code_desc}</option>)}
                    </select>
                  </F>
                  <F label="City / District" required error={errors.permanent_city_code}>
                    <select value={formData.permanent_city_code || ''} onChange={e => onChange('permanent_city_code', e.target.value)} disabled={!formData.permanent_state_code} className={inp(errors.permanent_city_code)}>
                      <option value="">{formData.permanent_state_code ? 'Select City' : 'Select state first'}</option>
                      {permCityOptions.map(c => <option key={c.code_mst_id} value={c.code_mst_id}>{c.code_desc}</option>)}
                    </select>
                  </F>
                </div>
                </>)}
              </div>
              <Nav onPrev={() => setCurrentStep(1)} onNext={handleNext} />
            </div>
          )}

          {currentStep === 3 && (
            <div className="space-y-5 animate-[fadeIn_0.3s_ease-out]">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">Occupation Details</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <F label="Qualification" required error={errors.qualification}>
                  <select value={formData.qualification || ''} onChange={e => onChange('qualification', e.target.value)} className={inp(errors.qualification)}>
                    <option value="">Select</option>
                    {(codeLists[7] || []).map(o => <option key={o.code_mst_id} value={o.code_mst_id}>{o.code_desc}</option>)}
                  </select>
                </F>
                <F label="Occupation" required error={errors.occupation}>
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
                <F label="Total Experience (yrs)" required error={errors.total_work_experience}><input type="number" step="0.5" min="0" value={formData.total_work_experience || ''} onChange={e => onChange('total_work_experience', e.target.value)} className={inp(errors.total_work_experience)} placeholder="e.g. 5.5" /></F>
                <F label="Experience at Current Org (yrs)"><input type="number" step="0.5" min="0" value={formData.experience_current_org || ''} onChange={e => onChange('experience_current_org', e.target.value)} className={inp('')} placeholder="e.g. 2" /></F>
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
                    {(codeLists[12] || []).map(o => <option key={o.code_mst_id} value={o.code_mst_id}>{o.code_desc}</option>)}
                  </select>
                </F>
              </div>
              <F label="Employer Address" required error={errors.employer_address}>
                <textarea rows={2} value={formData.employer_address || ''} onChange={e => onChange('employer_address', e.target.value)} className={inp(errors.employer_address)} placeholder="Full employer / business address" />
              </F>
              <Nav onPrev={() => setCurrentStep(2)} onNext={handleNext} />
            </div>
          )}

          {currentStep === 4 && (
            <div className="space-y-5 animate-[fadeIn_0.3s_ease-out]">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">Loan & Financial Details</h2>
              <div className="bg-blue-50 dark:bg-dark-section border border-blue-200 dark:border-gray-700/50 rounded-xl p-4 space-y-4">
                <p className="text-sm font-semibold text-blue-800 dark:text-gray-300">Loan Details</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="Loan Amount (₹)" required error={errors.loan_amount_requested} fieldName="loan_amount_requested" fieldSources={formData.field_sources}>
                    <input type="number" value={formData.loan_amount_requested || ''} onChange={e => onChange('loan_amount_requested', e.target.value)} className={inp(errors.loan_amount_requested)} placeholder="e.g. 500000" />
                  </F>
                  <F label="Repayment Period (Years)">
                    <select value={formData.repayment_period_years || ''} onChange={e => onChange('repayment_period_years', e.target.value)} className={inp('')}>
                      <option value="">Select</option>
                      {[1,2,3,5,7,10,15,20,25,30].map(y => <option key={y} value={y}>{y} {y===1?'year':'years'}</option>)}
                    </select>
                  </F>
                </div>
                <F label="Purpose of Loan" required error={errors.purpose_of_loan} fieldName="purpose_of_loan" fieldSources={formData.field_sources}>
                  <select value={formData.purpose_of_loan || ''} onChange={e => onChange('purpose_of_loan', e.target.value)} className={inp(errors.purpose_of_loan)}>
                    <option value="">Select</option>
                    {(codeLists[13] || []).map(o => <option key={o.code_mst_id} value={o.code_mst_id}>{o.code_desc}</option>)}
                  </select>
                </F>
                <F label="Scheme"><input type="text" value={formData.scheme || ''} onChange={e => onChange('scheme', e.target.value)} className={inp('')} placeholder="Optional" /></F>
              </div>
              <div className="bg-green-50 dark:bg-dark-section border border-green-200 dark:border-gray-700/50 rounded-xl p-4 space-y-4">
                <p className="text-sm font-semibold text-green-800 dark:text-gray-300">Financial Details</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="Monthly Gross Income (₹)" required error={errors.monthly_gross_income} fieldName="monthly_gross_income" fieldSources={formData.field_sources}>
                    <input type="number" value={formData.monthly_gross_income || ''} onChange={e => onChange('monthly_gross_income', e.target.value)} className={inp(errors.monthly_gross_income)} placeholder="Before deductions" />
                  </F>
                  <F label="Monthly Deductions (₹)">
                    <input type="number" value={formData.monthly_deductions || ''} onChange={e => onChange('monthly_deductions', e.target.value)} className={inp('')} placeholder="Tax, PF etc." />
                  </F>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                  <F label="Existing Monthly EMIs (₹)" fieldName="monthly_emi_existing" fieldSources={formData.field_sources}>
                    <input type="number" value={formData.monthly_emi_existing || ''} onChange={e => onChange('monthly_emi_existing', e.target.value)} className={inp('')} placeholder="0 if none" />
                  </F>
                  <F label="Monthly Net Income (₹)" required error={errors.monthly_net_income}>
                    <input type="number" value={formData.monthly_net_income || ''} onChange={e => onChange('monthly_net_income', e.target.value)} className={inp(errors.monthly_net_income)} placeholder="Take home salary" />
                  </F>
                </div>
              </div>
              <div className="bg-yellow-50 dark:bg-dark-section border border-yellow-200 dark:border-gray-700/50 rounded-xl p-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={formData.criminal_records || false} onChange={e => onChange('criminal_records', e.target.checked)} className="mt-1 w-5 h-5 dark:bg-gray-700 dark:border-gray-600" />
                  <span className="text-sm text-gray-700 dark:text-gray-300">I have pending criminal cases or criminal records</span>
                </label>
              </div>
              <Nav onPrev={() => setCurrentStep(3)} onNext={handleNext} />
            </div>
          )}

          {currentStep === 5 && (
            <div className="space-y-5 animate-[fadeIn_0.3s_ease-out]">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">Document Upload</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">Max 5MB each. PDF/JPG/PNG accepted.</p>
              <div className="space-y-3">
                {[
                  { key: 'aadhaar_front_url', label: 'Aadhaar Document', required: true },
                  { key: 'photo_url', label: 'Passport Size Photo', required: true },
                  { key: 'salary_slips_url', label: 'Salary Slips (Last 3 months)', required: true },
                  { key: 'itr_form16_url', label: 'ITR / Form 16', required: false },
                  { key: 'bank_statements_url', label: 'Bank Statements (Last 6 months)', required: true },
                  { key: 'proof_of_identification_url', label: 'Proof of Identification', required: false },
                  { key: 'proof_of_residence_url', label: 'Proof of Residence', required: false },
                ].map(doc => {
                  const fs = formData.field_sources?.[doc.key];
                  const isDigilocker = fs?.source === 'aadhaar';
                  return (
                  <div key={doc.key} className={`flex items-center justify-between p-4 rounded-xl border-2 ${formData[doc.key] ? (isDigilocker ? 'border-blue-400/50 dark:border-blue-800/40 bg-blue-50/50 dark:bg-dark-section' : 'border-green-400/50 dark:border-green-800/40 bg-green-50 dark:bg-dark-section') : 'border-gray-200 dark:border-gray-700/50 bg-gray-50 dark:bg-dark-section'}`}>
                    <div>
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{doc.label} {doc.required && <span className="text-red-500">*</span>}</p>
                      {formData[doc.key] && (
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {isDigilocker ? (
                          <span className="text-xs bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
                            <ShieldCheck className="w-3 h-3" />DigiLocker Verified
                          </span>
                        ) : (
                          <p className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Uploaded</p>
                        )}
                        <button onClick={() => { setPreviewDisclaimer(true); setPreviewDoc({ url: `${API_URL}${formData[doc.key]}`, label: doc.label }); }} className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition"><Eye className="w-4 h-4" /></button>
                      </div>
                    )}
                    </div>
                    <label className="cursor-pointer">
                      <input type="file" accept="image/*,application/pdf" className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          if (file.size > 5 * 1024 * 1024) { alert('File too large. Max 5MB'); return; }
                          const fd = new FormData();
                          fd.append('session_token', getSession() || '');
                          fd.append('document_type', doc.key.replace('_url', ''));
                          fd.append('file', file);
                          try {
                            const res = await fetch(`${API_URL}/api/upload-document-session`, { method: 'POST', body: fd });
                            const data = await res.json();
                            if (data.url) onChange(doc.key, data.url);
                            else alert('Upload failed. Storage may not be configured.');
                          } catch { alert('Upload failed.'); }
                        }}
                      />
                      <span className={`px-4 py-2 rounded-lg text-sm font-medium transition ${formData[doc.key] ? 'bg-green-600 text-white' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                        {formData[doc.key] ? 'Replace' : 'Upload'}
                      </span>
                    </label>
                  </div>
                  );
                })}
              </div>
              <Nav onPrev={() => setCurrentStep(4)} onNext={handleNext} />
            </div>
          )}

          {currentStep === 6 && (
            <div className="space-y-5 animate-[fadeIn_0.3s_ease-out]">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">Review & Submit</h2>
              <RS title="Identity & KYC">
                <RR label="PAN" value={formData.pan_number ? formData.pan_number.slice(0,2)+'***'+formData.pan_number.slice(-2) : ''} />
                <RR label="Aadhaar" value={formData.aadhaar_number ? 'XXXX XXXX '+String(formData.aadhaar_number).slice(-4) : formData.aadhaar_last4 ? `XXXX XXXX ${formData.aadhaar_last4}` : ''} />
                <RR label="Name" value={[formData.first_name, formData.middle_name, formData.last_name].filter(Boolean).join(' ') || formData.customer_name} />
                <RR label="DOB" value={formData.date_of_birth} />
                <RR label="Gender" value={formData.gender} />
                <RR label="Marital Status" value={formData.marital_status} />
              </RS>
              <RS title="Address">
                <RR label="Current" value={[formData.current_house, formData.current_street, formData.current_landmark, formData.current_locality].filter(Boolean).join(', ') || formData.current_address} />
                <RR label="Pincode" value={formData.current_pincode} />
                <RR label="State" value={codeLabel(5, formData.current_state_code)} />
                <RR label="City" value={codeLabel(6, formData.current_city_code)} />
                {formData.same_as_current ? (
                  <RR label="Permanent" value="Same as current address" />
                ) : (
                  <RR label="Permanent" value={[formData.permanent_house, formData.permanent_street, formData.permanent_landmark, formData.permanent_locality].filter(Boolean).join(', ') || formData.permanent_address} />
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
                <RR label="Purpose" value={codeLabel(13, formData.purpose_of_loan)} />
                <RR label="Net Income" value={formData.monthly_net_income ? `₹${parseFloat(formData.monthly_net_income).toLocaleString('en-IN')}` : ''} />
              </RS>
              <div className="bg-blue-50 dark:bg-dark-section border border-blue-200 dark:border-gray-700/50 rounded-xl p-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} className="mt-1 w-5 h-5 text-blue-600 rounded" />
                  <span className="text-sm text-gray-700 dark:text-gray-300">I declare all information provided is true and accurate. I authorize the bank to verify details and conduct credit checks as required.</span>
                </label>
              </div>
              <div className="bg-yellow-50 dark:bg-dark-section border border-yellow-200 dark:border-gray-700/50 rounded-xl p-3">
                <p className="text-xs text-yellow-800 dark:text-gray-300 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />Once submitted, this application cannot be edited until reviewed by a bank officer.</p>
              </div>
              <div className="flex gap-4">
                <button onClick={() => { autoSave(); setCurrentStep(5); window.scrollTo(0,0); }} className="flex-1 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 py-4 rounded-xl font-semibold hover:bg-gray-300 dark:hover:bg-gray-600 transition">← Previous</button>
                <button onClick={handleSubmit} disabled={submitting || !agreed}
                  className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 text-white py-4 rounded-xl font-semibold hover:from-green-700 hover:to-emerald-700 transition disabled:opacity-50 flex items-center justify-center gap-2">
                  {submitting ? <><Loader2 className="w-5 h-5 animate-spin" /><span>Submitting...</span></> : 'Submit Application'}
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
        <label className="text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-300">{label} {required && <span className="text-red-500 text-xs">*</span>}</label>
        {src && !src.modified && (
          <div className="relative group flex-shrink-0">
            <span className={`px-1.5 sm:px-2 py-0.5 text-[8px] sm:text-[9px] font-medium rounded cursor-help inline-flex items-center gap-0.5 ${
              src.source === 'agent_call'
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
            }`}>
              {src.source === 'pan' ? 'PAN' : src.source === 'agent_call' ? 'Voice Call' : 'Aadhaar'}
            </span>
            <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-50 pointer-events-none">
              <div className="bg-gray-900 dark:bg-gray-700 text-white text-[10px] px-2 py-1.5 rounded-lg shadow-lg whitespace-nowrap max-w-[250px]">
                <p>{src.source === 'agent_call' ? 'Collected during voice call' : `Fetched from ${src.source.toUpperCase()}`}</p>
                <p className="text-gray-300 mt-0.5 truncate">{src.original}</p>
              </div>
            </div>
          </div>
        )}
        {src && src.modified && (
          <div className="relative group flex-shrink-0">
            <span className="px-1.5 sm:px-2 py-0.5 text-[8px] sm:text-[9px] font-medium rounded bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 cursor-help inline-flex items-center gap-0.5">
              Modified
            </span>
            <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-50 pointer-events-none">
              <div className="bg-gray-900 dark:bg-gray-700 text-white text-[10px] px-2 py-1.5 rounded-lg shadow-lg whitespace-nowrap max-w-[250px]">
                <p>Original from {src.source === 'agent_call' ? 'VOICE CALL' : src.source.toUpperCase()}: <span className="text-gray-300">{src.original}</span></p>
                <p className="text-orange-300 mt-0.5">Modified by applicant</p>
              </div>
            </div>
          </div>
        )}
      </div>
      {children}
      {error && <p className="text-red-500 text-xs mt-1 animate-[fadeIn_0.2s]">{error}</p>}
    </div>
  );
}
function Nav({ onPrev, onNext }: any) {
  return (
    <div className="flex gap-4 pt-2">
      {onPrev && <button onClick={onPrev} className="flex-1 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 py-4 rounded-xl font-semibold hover:bg-gray-300 dark:hover:bg-gray-600 transition">← Previous</button>}
      {onNext && <button onClick={onNext} className={`${onPrev ? 'flex-1' : 'w-full'} bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-4 rounded-xl font-semibold hover:from-blue-700 hover:to-indigo-700 transition`}>Continue →</button>}
    </div>
  );
}
function RS({ title, children }: any) {
  return <div className="bg-gray-50 dark:bg-dark-section rounded-xl p-4"><h3 className="font-semibold text-gray-900 dark:text-white mb-3">{title}</h3><div className="space-y-2">{children}</div></div>;
}
function RR({ label, value }: any) {
  return <div className="flex justify-between text-sm"><span className="text-gray-500 dark:text-gray-400">{label}:</span><span className="font-medium text-gray-900 dark:text-gray-100 text-right max-w-xs">{value || '—'}</span></div>;
}
function inp(error: string) {
  return `w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm transition-all duration-200 ${error ? 'border-red-300 bg-red-50 dark:bg-red-900/10 dark:border-red-700 animate-[shake_0.3s]' : 'border-gray-300 dark:border-gray-600 dark:bg-dark-card/80 dark:text-gray-100 hover:border-blue-300 dark:hover:border-blue-600'}`;
}