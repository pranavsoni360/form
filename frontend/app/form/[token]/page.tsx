'use client';

import { Building2, Lock, ShieldCheck, Check, AlertTriangle, Paperclip, Loader2, Save, CheckCircle2, XCircle, Upload, FileText } from 'lucide-react';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

const API_URL = 'https://virtualvaani.vgipl.com:8200';

export default function LoanFormPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [customerData, setCustomerData] = useState<any>(null);
  const [currentStep, setCurrentStep] = useState(1);
  const [highestStep, setHighestStep] = useState(1);
  const [formData, setFormData] = useState<any>({});
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [errors, setErrors] = useState<any>({});

  useEffect(() => { validateToken(); }, [token]);

  useEffect(() => {
    if (!customerData) return;
    const timer = setTimeout(() => autoSave(), 2000);
    return () => clearTimeout(timer);
  }, [formData]);

  const [otpStep, setOtpStep] = useState<'phone' | 'otp' | 'verified'>('phone');
  const [phoneInput, setPhoneInput] = useState('');
  const [otpInput, setOtpInput] = useState('');
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [otpError, setOtpError] = useState('');
  const [otpTimer, setOtpTimer] = useState(0);
  const [panVerifying, setPanVerifying] = useState(false);
  const [aadhaarVerifying, setAadhaarVerifying] = useState(false);

  const handleVerifyPAN = async () => {
    const pan = formData.pan_number || '';
    if (!pan || !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan)) {
      setErrors((p: any) => ({ ...p, pan_number: 'Invalid PAN format (e.g. ABCDE1234F)' }));
      return;
    }
    setPanVerifying(true);
    try {
      const res = await fetch(`${API_URL}/api/verify-pan?token=${token}&pan_number=${pan}`, { method: 'POST' });
      if (!res.ok) throw new Error('Verification failed');
      onChange('pan_verified', true);
      onChange('pan_verification_timestamp', new Date().toISOString());
      setErrors((p: any) => ({ ...p, pan_number: '' }));
    } catch (err: any) {
      setErrors((p: any) => ({ ...p, pan_number: err.message || 'PAN verification failed' }));
    } finally { setPanVerifying(false); }
  };

  const handleVerifyAadhaar = async () => {
    const aadhaar = formData.aadhaar_number || '';
    if (!aadhaar || !/^\d{12}$/.test(aadhaar)) {
      setErrors((p: any) => ({ ...p, aadhaar_number: 'Enter valid 12-digit Aadhaar number' }));
      return;
    }
    setAadhaarVerifying(true);
    try {
      const res = await fetch(`${API_URL}/api/verify-aadhaar?token=${token}&aadhaar_number=${aadhaar}`, { method: 'POST' });
      if (!res.ok) throw new Error('Verification failed');
      const data = await res.json();
      onChange('aadhaar_verified', true);
      onChange('aadhaar_last4', data.last4);
      onChange('aadhaar_verification_timestamp', new Date().toISOString());
      setErrors((p: any) => ({ ...p, aadhaar_number: '' }));
    } catch (err: any) {
      setErrors((p: any) => ({ ...p, aadhaar_number: err.message || 'Aadhaar verification failed' }));
    } finally { setAadhaarVerifying(false); }
  };

  const validateToken = async () => {
    try {
      const res = await fetch(`${API_URL}/api/validate-token/${token}`);
      const data = await res.json();
      if (data.status === 'valid') {
        setCustomerData(data.data);
        setFormData(data.data);
        if (data.current_step && data.current_step > 1) { setCurrentStep(data.current_step); } setHighestStep(Math.max(data.current_step || 1, data.data?.highest_step || 1));
        setOtpStep('verified');
      } else if (data.status === 'otp_required') {
        setOtpStep('phone');
      } else {
        setError(data.detail || 'Invalid or expired link');
      }
    } catch {
      setError('Failed to load. Check your connection.');
    } finally {
      setLoading(false);
    }
  };

  const handleSendOTP = async () => {
    if (!phoneInput || phoneInput.replace(/\D/g,'').length < 10) {
      setOtpError('Enter a valid 10-digit mobile number'); return;
    }
    setOtpSending(true);
    setOtpError('');
    try {
      const res = await fetch(`${API_URL}/api/send-otp?token=${token}`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'otp_sent') {
        setOtpStep('otp');
        setOtpTimer(30);
        const interval = setInterval(() => {
          setOtpTimer(t => { if (t <= 1) { clearInterval(interval); return 0; } return t - 1; });
        }, 1000);
      } else {
        setOtpError(data.detail || 'Failed to send OTP');
      }
    } catch {
      setOtpError('Failed to send OTP. Try again.');
    } finally {
      setOtpSending(false);
    }
  };

  const handleVerifyOTP = async () => {
    if (!otpInput || otpInput.length !== 6) {
      setOtpError('Enter the 6-digit OTP'); return;
    }
    setOtpVerifying(true);
    setOtpError('');
    try {
      const res = await fetch(`${API_URL}/api/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, otp: otpInput }),
      });
      const data = await res.json();
      if (data.status === 'verified' || data.status === 'already_verified') {
        // Reload token data
        const res2 = await fetch(`${API_URL}/api/validate-token/${token}`);
        const data2 = await res2.json();
        if (data2.status === 'valid') {
          setCustomerData(data2.data);
          setFormData(data2.data);
          setOtpStep('verified');
        }
      } else {
        setOtpError(data.detail || 'Incorrect OTP');
      }
    } catch {
      setOtpError('Verification failed. Try again.');
    } finally {
      setOtpVerifying(false);
    }
  };

  const autoSave = async () => {
    if (!customerData) return;
    setSaving(true);
    try {
      const cleanData = {
        customer_name: formData.customer_name,
        email: formData.email,
        title: formData.title,
        first_name: formData.first_name,
        middle_name: formData.middle_name,
        last_name: formData.last_name,
        full_name: formData.full_name,
        date_of_birth: formData.date_of_birth,
        gender: formData.gender,
        marital_status: formData.marital_status,
        current_address: formData.current_address,
        permanent_address: formData.same_as_current ? formData.current_address : formData.permanent_address,
        same_as_current: formData.same_as_current,
        pan_number: formData.pan_number,
        aadhaar_last4: formData.aadhaar_number ? String(formData.aadhaar_number).slice(-4) : null,
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
      const filtered = Object.fromEntries(
        Object.entries(cleanData).filter(([_, v]) => v !== undefined && v !== null && v !== '')
      );
      await fetch(`${API_URL}/api/autosave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, step: currentStep, data: { ...filtered, highest_step: highestStep } }),
      });
      setLastSaved(new Date().toLocaleTimeString());
    } catch {}
    setSaving(false);
  };

  const onChange = (field: string, value: any) => {
    setFormData((p: any) => ({ ...p, [field]: value }));
    setErrors((p: any) => ({ ...p, [field]: '' }));
  };

  const validate = (fields: any) => {
    const e: any = {};
    Object.entries(fields).forEach(([key, msg]) => {
      if (!formData[key] || String(formData[key]).trim() === '') e[key] = msg;
    });
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const step1Valid = () => validate({
    pan_number: 'PAN is mandatory',
    aadhaar_number: 'Aadhaar is mandatory',
    full_name: 'Full name is mandatory',
    date_of_birth: 'Date of birth is mandatory',
    gender: 'Gender is mandatory',
    current_address: 'Current address is mandatory',
  });

  const step2Valid = () => validate({
    qualification: 'Qualification is mandatory',
    occupation: 'Occupation is mandatory',
    industry_type: 'Industry type is mandatory',
    employment_type: 'Employment type is mandatory',
    designation: 'Designation is mandatory',
    total_work_experience: 'Total work experience is mandatory',
    residential_status: 'Residential status is mandatory',
    tenure_stability: 'Tenure stability is mandatory',
    employer_address: 'Employer address is mandatory',
  });

  const step3Valid = () => validate({
    loan_amount_requested: 'Loan amount is mandatory',
    purpose_of_loan: 'Purpose of loan is mandatory',
    monthly_gross_income: 'Monthly gross income is mandatory',
    monthly_net_income: 'Monthly net income is mandatory',
  });

  const handleNext = () => {
    let valid = false;
    if (currentStep === 1) valid = step1Valid();
    else if (currentStep === 2) valid = step2Valid();
    else if (currentStep === 3) valid = step3Valid();
    else valid = true;
    if (valid) { autoSave(); setCurrentStep(s => { const next = s + 1; setHighestStep(h => Math.max(h, next)); return next; }); setErrors({}); window.scrollTo(0,0); }
  };

  const handleSubmit = async () => {
    if (!agreed) { alert('Please agree to the declaration'); return; }
    setSubmitting(true);
    try {
      await autoSave();
      const res = await fetch(`${API_URL}/api/submit-form?token=${token}`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'submitted') {
        router.push(`/success?loan_id=${customerData.loan_id}`);
      } else {
        alert(data.detail || 'Submission failed');
      }
    } catch { alert('Submission failed. Please try again.'); }
    finally { setSubmitting(false); }
  };

  if (loading) return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-600 mx-auto"></div>
        <p className="mt-4 text-gray-600">Loading your application...</p>
      </div>
    </div>
  );

  if (error) return (
    <div className="min-h-screen bg-red-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
        <div className="mb-4"><AlertTriangle className="w-16 h-16 text-yellow-500 mx-auto" /></div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Link Error</h2>
        <p className="text-gray-600">{error}</p>
      </div>
    </div>
  );

  if (!loading && !error && otpStep !== 'verified') return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full">
        <div className="text-center mb-6">
          <div className="text-5xl mb-3">🔐</div>
          <h1 className="text-2xl font-bold text-gray-900">Verify Your Identity</h1>
          <p className="text-sm text-gray-500 mt-2">
            {otpStep === 'phone' ? 'Enter your registered mobile number to access the form' : 'Enter the OTP sent to your WhatsApp'}
          </p>
        </div>

        {otpStep === 'phone' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Mobile Number <span className="text-red-500">*</span>
              </label>
              <div className="flex gap-2">
                <span className="px-3 py-3 bg-gray-100 border border-gray-300 rounded-lg text-gray-600 text-sm">+91</span>
                <input
                  type="tel"
                  value={phoneInput}
                  onChange={e => { setPhoneInput(e.target.value.replace(/\D/g,'').slice(0,10)); setOtpError(''); }}
                  className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                  placeholder="10-digit mobile number"
                  maxLength={10}
                />
              </div>
            </div>

            {otpError && <p className="text-red-500 text-sm">{otpError}</p>}

            <button
              onClick={handleSendOTP}
              disabled={otpSending}
              className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3 rounded-xl font-semibold hover:from-blue-700 hover:to-indigo-700 transition disabled:opacity-50"
            >
              {otpSending ? 'Sending OTP...' : 'Send OTP on WhatsApp →'}
            </button>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-xs text-blue-800 flex items-center gap-1"><Lock className="w-3 h-3" />OTP will be sent to your WhatsApp number registered with the bank</p>
            </div>
          </div>
        )}

        {otpStep === 'otp' && (
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-center">
              <p className="text-sm text-green-800 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" />OTP sent to WhatsApp for +91 {phoneInput}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Enter 6-digit OTP <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={otpInput}
                onChange={e => { setOtpInput(e.target.value.replace(/\D/g,'').slice(0,6)); setOtpError(''); }}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-center text-2xl font-bold tracking-widest"
                placeholder="000000"
                maxLength={6}
              />
            </div>

            {otpError && <p className="text-red-500 text-sm text-center">{otpError}</p>}

            <button
              onClick={handleVerifyOTP}
              disabled={otpVerifying || otpInput.length !== 6}
              className="w-full bg-gradient-to-r from-green-600 to-emerald-600 text-white py-3 rounded-xl font-semibold hover:from-green-700 hover:to-emerald-700 transition disabled:opacity-50"
            >
              {otpVerifying ? 'Verifying...' : 'Verify OTP'}
            </button>

            <div className="text-center">
              {otpTimer > 0 ? (
                <p className="text-sm text-gray-500">Resend OTP in {otpTimer}s</p>
              ) : (
                <button onClick={() => { setOtpStep('phone'); setOtpInput(''); setOtpError(''); }}
                  className="text-sm text-blue-600 hover:underline">
                  ← Change number / Resend OTP
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const steps = ['KYC & Personal', 'Occupation', 'Loan & Financial', 'Documents', 'Review'];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-6 px-4">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="bg-white rounded-2xl shadow-lg p-5 mb-4">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2"><Building2 className="w-5 h-5 text-blue-600" />Loan Application</h1>
              <p className="text-sm text-gray-500">ID: {customerData?.loan_id} · ₹{parseFloat(customerData?.loan_amount || 0).toLocaleString('en-IN')}</p>
            </div>
            <div className="text-xs text-right">
              {saving ? <span className="text-blue-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Saving...</span> : lastSaved ? <span className="text-green-500 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Saved {lastSaved}</span> : null}
            </div>
          </div>
          <div className="relative">
            {/* Connector line background */}
            <div className="absolute top-4 left-6 right-6 h-0.5 bg-gray-200"></div>
            {/* Connector line progress */}
            <div className="absolute top-4 left-6 h-0.5 bg-green-400 transition-all duration-300" style={{width: `${Math.max(0, (Math.max(highestStep, currentStep) - 1)) / (steps.length - 1) * (100 - 8)}%`}}></div>
            {/* Steps */}
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
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold z-10 transition-all duration-200 ${
                        isViewing
                          ? 'bg-blue-600 text-white cursor-pointer ring-4 ring-blue-200 hover:bg-blue-700 hover:scale-110'
                          : isActiveFrontier
                          ? 'bg-white text-blue-600 border-[3px] border-blue-500 cursor-pointer hover:bg-blue-50 hover:scale-110'
                          : isCompleted
                          ? 'bg-green-500 text-white cursor-pointer hover:bg-green-600 hover:scale-110'
                          : 'bg-gray-200 text-gray-500'
                      }`}
                    >
                      {isCompleted ? '✓' : stepNum}
                    </div>
                    <span className={`text-[11px] mt-2 text-center leading-tight ${
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

        <div className="bg-white rounded-2xl shadow-lg p-6">

          {/* STEP 1 - KYC & Personal */}
          {currentStep === 1 && (
            <div className="space-y-5">
              <h2 className="text-xl font-bold text-gray-900">KYC & Personal Details</h2>

              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-4">
                <p className="text-sm font-semibold text-blue-800">Identity Verification</p>
                <F label="PAN Number" required error={errors.pan_number}>
                  <div className="flex gap-2">
                    <input type="text" value={formData.pan_number || ''} onChange={e => onChange('pan_number', e.target.value.toUpperCase())} disabled={formData.pan_verified} className={`flex-1 ${formData.pan_verified ? 'bg-green-50 border-green-300' : ''} ${inp(errors.pan_number)}`} placeholder="ABCDE1234F" maxLength={10} />
                    <button type="button" onClick={handleVerifyPAN} disabled={formData.pan_verified || panVerifying} className={`px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition ${formData.pan_verified ? 'bg-green-500 text-white cursor-default' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                      {panVerifying ? 'Verifying...' : formData.pan_verified ? 'Verified' : 'Verify'}
                    </button>
                  </div>
                  {formData.pan_verified && <p className="text-xs text-green-600 mt-1 flex items-center gap-1"><ShieldCheck className="w-3 h-3" />PAN verified{formData.pan_verification_timestamp ? ` on ${new Date(formData.pan_verification_timestamp).toLocaleString()}` : ''}</p>}
                </F>
                <F label="Aadhaar Number" required error={errors.aadhaar_number}>
                  <div className="flex gap-2">
                    <input type="text" value={formData.aadhaar_number || ''} onChange={e => onChange('aadhaar_number', e.target.value.replace(/\D/g,'').slice(0,12))} disabled={formData.aadhaar_verified} className={`flex-1 ${formData.aadhaar_verified ? 'bg-green-50 border-green-300' : ''} ${inp(errors.aadhaar_number)}`} placeholder="12-digit Aadhaar" maxLength={12} />
                    <button type="button" onClick={handleVerifyAadhaar} disabled={formData.aadhaar_verified || aadhaarVerifying} className={`px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition ${formData.aadhaar_verified ? 'bg-green-500 text-white cursor-default' : 'bg-orange-600 text-white hover:bg-orange-700'}`}>
                      {aadhaarVerifying ? 'Verifying...' : formData.aadhaar_verified ? 'Verified' : 'Verify'}
                    </button>
                  </div>
                  {formData.aadhaar_verified && <p className="text-xs text-green-600 mt-1 flex items-center gap-1"><ShieldCheck className="w-3 h-3" />Aadhaar verified (last 4: {formData.aadhaar_last4}){formData.aadhaar_verification_timestamp ? ` on ${new Date(formData.aadhaar_verification_timestamp).toLocaleString()}` : ''}</p>}
                  {!formData.aadhaar_verified && <p className="text-xs text-gray-500 mt-1">Only last 4 digits will be stored</p>}
                </F>
              </div>

              <div className="grid grid-cols-4 gap-3">
                <F label="Title" required>
                  <select value={formData.title || ''} onChange={e => onChange('title', e.target.value)} className={inp('')}>
                    <option value="">-</option>
                    {['Mr','Mrs','Ms','Dr'].map(t => <option key={t}>{t}</option>)}
                  </select>
                </F>
                <div className="col-span-3">
                  <F label="First Name" required error={errors.full_name}>
                    <input type="text" value={formData.first_name || ''} onChange={e => { onChange('first_name', e.target.value); onChange('full_name', `${formData.title||''} ${e.target.value} ${formData.middle_name||''} ${formData.last_name||''}`.trim()); }} className={inp(errors.full_name)} placeholder="First name" />
                  </F>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <F label="Middle Name">
                  <input type="text" value={formData.middle_name || ''} onChange={e => onChange('middle_name', e.target.value)} className={inp('')} placeholder="Optional" />
                </F>
                <F label="Last Name" required>
                  <input type="text" value={formData.last_name || ''} onChange={e => onChange('last_name', e.target.value)} className={inp('')} placeholder="Last name" />
                </F>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <F label="Date of Birth" required error={errors.date_of_birth}>
                  <input type="date" value={formData.date_of_birth || ''} onChange={e => onChange('date_of_birth', e.target.value)} className={inp(errors.date_of_birth)} max={new Date().toISOString().split('T')[0]} />
                </F>
                <F label="Gender" required error={errors.gender}>
                  <select value={formData.gender || ''} onChange={e => onChange('gender', e.target.value)} className={inp(errors.gender)}>
                    <option value="">Select</option>
                    {['Male','Female','Other'].map(g => <option key={g}>{g}</option>)}
                  </select>
                </F>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <F label="Marital Status">
                  <select value={formData.marital_status || ''} onChange={e => onChange('marital_status', e.target.value)} className={inp('')}>
                    <option value="">Select</option>
                    {['Single','Married','Divorced','Widowed'].map(s => <option key={s}>{s}</option>)}
                  </select>
                </F>
                <F label="Email Address">
                  <input type="email" value={formData.email || ''} onChange={e => onChange('email', e.target.value)} className={inp('')} placeholder="Optional" />
                </F>
              </div>

              <F label="Current Address" required error={errors.current_address}>
                <textarea rows={3} value={formData.current_address || ''} onChange={e => onChange('current_address', e.target.value)} className={inp(errors.current_address)} placeholder="Full current address" />
              </F>

              <F label="Permanent Address">
                <textarea rows={2} value={formData.same_as_current ? formData.current_address : (formData.permanent_address || '')} onChange={e => onChange('permanent_address', e.target.value)} disabled={formData.same_as_current} className={`${formData.same_as_current ? 'bg-gray-100 text-gray-500' : ''} ${inp('')}`} placeholder="If different from current address" />
                <label className="flex items-center gap-2 mt-2 cursor-pointer">
                  <input type="checkbox" checked={formData.same_as_current || false} onChange={e => { onChange('same_as_current', e.target.checked); if(e.target.checked) onChange('permanent_address', formData.current_address); }} className="w-4 h-4" />
                  <span className="text-sm text-gray-600">Same as current address</span>
                </label>
              </F>

              <Nav onNext={handleNext} />
            </div>
          )}

          {/* STEP 2 - Occupation */}
          {currentStep === 2 && (
            <div className="space-y-5">
              <h2 className="text-xl font-bold text-gray-900">Occupation Details</h2>

              <div className="grid grid-cols-2 gap-3">
                <F label="Qualification" required error={errors.qualification}>
                  <select value={formData.qualification || ''} onChange={e => onChange('qualification', e.target.value)} className={inp(errors.qualification)}>
                    <option value="">Select</option>
                    {['Below 10th','10th Pass','12th Pass','Diploma','Graduate','Post Graduate','PhD'].map(q => <option key={q}>{q}</option>)}
                  </select>
                </F>
                <F label="Occupation" required error={errors.occupation}>
                  <select value={formData.occupation || ''} onChange={e => onChange('occupation', e.target.value)} className={inp(errors.occupation)}>
                    <option value="">Select</option>
                    {['Salaried','Self Employed Professional','Self Employed Business','Retired','Student','Housewife'].map(o => <option key={o}>{o}</option>)}
                  </select>
                </F>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <F label="Industry Type" required error={errors.industry_type}>
                  <select value={formData.industry_type || ''} onChange={e => onChange('industry_type', e.target.value)} className={inp(errors.industry_type)}>
                    <option value="">Select</option>
                    {['IT/Software','Banking/Finance','Healthcare','Education','Manufacturing','Retail','Government','Real Estate','Transport','Other'].map(i => <option key={i}>{i}</option>)}
                  </select>
                </F>
                <F label="Employment Type" required error={errors.employment_type}>
                  <select value={formData.employment_type || ''} onChange={e => onChange('employment_type', e.target.value)} className={inp(errors.employment_type)}>
                    <option value="">Select</option>
                    {['Permanent','Contractual','Part-time','Self-employed','Business Owner'].map(e => <option key={e}>{e}</option>)}
                  </select>
                </F>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <F label="Employer Name">
                  <input type="text" value={formData.employer_name || ''} onChange={e => onChange('employer_name', e.target.value)} className={inp('')} placeholder="Company / Business name" />
                </F>
                <F label="Designation" required error={errors.designation}>
                  <input type="text" value={formData.designation || ''} onChange={e => onChange('designation', e.target.value)} className={inp(errors.designation)} placeholder="e.g. Senior Manager" />
                </F>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <F label="Total Work Experience (yrs)" required error={errors.total_work_experience}>
                  <input type="number" step="0.5" min="0" value={formData.total_work_experience || ''} onChange={e => onChange('total_work_experience', e.target.value)} className={inp(errors.total_work_experience)} placeholder="e.g. 5.5" />
                </F>
                <F label="Experience at Current Org (yrs)">
                  <input type="number" step="0.5" min="0" value={formData.experience_current_org || ''} onChange={e => onChange('experience_current_org', e.target.value)} className={inp('')} placeholder="e.g. 2" />
                </F>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <F label="Residential Status" required error={errors.residential_status}>
                  <select value={formData.residential_status || ''} onChange={e => onChange('residential_status', e.target.value)} className={inp(errors.residential_status)}>
                    <option value="">Select</option>
                    {['Self Owned','Rented','Company Provided','Family Owned','PG/Hostel'].map(r => <option key={r}>{r}</option>)}
                  </select>
                </F>
                <F label="Tenure Stability" required error={errors.tenure_stability}>
                  <select value={formData.tenure_stability || ''} onChange={e => onChange('tenure_stability', e.target.value)} className={inp(errors.tenure_stability)}>
                    <option value="">Select</option>
                    {['Less than 1 year','1-2 years','2-5 years','5-10 years','More than 10 years'].map(t => <option key={t}>{t}</option>)}
                  </select>
                </F>
              </div>

              <F label="Employer Address" required error={errors.employer_address}>
                <textarea rows={2} value={formData.employer_address || ''} onChange={e => onChange('employer_address', e.target.value)} className={inp(errors.employer_address)} placeholder="Full employer / business address" />
              </F>

              <Nav onPrev={() => { autoSave(); setCurrentStep(1); window.scrollTo(0,0); }} onNext={handleNext} />
            </div>
          )}

          {/* STEP 3 - Loan & Financial */}
          {currentStep === 3 && (
            <div className="space-y-5">
              <h2 className="text-xl font-bold text-gray-900">Loan & Financial Details</h2>

              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-4">
                <p className="text-sm font-semibold text-blue-800">Loan Details</p>
                <div className="grid grid-cols-2 gap-3">
                  <F label="Loan Amount (₹)" required error={errors.loan_amount_requested}>
                    <input type="number" value={formData.loan_amount_requested || formData.loan_amount || ''} onChange={e => onChange('loan_amount_requested', e.target.value)} className={inp(errors.loan_amount_requested)} placeholder="e.g. 500000" />
                  </F>
                  <F label="Repayment Period (Years)">
                    <select value={formData.repayment_period_years || ''} onChange={e => onChange('repayment_period_years', e.target.value)} className={inp('')}>
                      <option value="">Select</option>
                      {[1,2,3,5,7,10,15,20,25,30].map(y => <option key={y} value={y}>{y} {y===1?'year':'years'}</option>)}
                    </select>
                  </F>
                </div>
                <F label="Purpose of Loan" required error={errors.purpose_of_loan}>
                  <select value={formData.purpose_of_loan || ''} onChange={e => onChange('purpose_of_loan', e.target.value)} className={inp(errors.purpose_of_loan)}>
                    <option value="">Select</option>
                    {['Home Purchase','Home Renovation','Business Expansion','Education','Medical Emergency','Debt Consolidation','Vehicle Purchase','Wedding','Travel','Personal Use','Other'].map(p => <option key={p}>{p}</option>)}
                  </select>
                </F>
                <F label="Scheme">
                  <input type="text" value={formData.scheme || ''} onChange={e => onChange('scheme', e.target.value)} className={inp('')} placeholder="Optional - bank scheme if applicable" />
                </F>
              </div>

              <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-4">
                <p className="text-sm font-semibold text-green-800">Financial Details</p>
                <div className="grid grid-cols-2 gap-3">
                  <F label="Monthly Gross Income (₹)" required error={errors.monthly_gross_income}>
                    <input type="number" value={formData.monthly_gross_income || ''} onChange={e => onChange('monthly_gross_income', e.target.value)} className={inp(errors.monthly_gross_income)} placeholder="Before deductions" />
                  </F>
                  <F label="Monthly Deductions (₹)">
                    <input type="number" value={formData.monthly_deductions || ''} onChange={e => onChange('monthly_deductions', e.target.value)} className={inp('')} placeholder="Tax, PF etc." />
                  </F>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <F label="Existing Monthly EMIs (₹)">
                    <input type="number" value={formData.monthly_emi_existing || ''} onChange={e => onChange('monthly_emi_existing', e.target.value)} className={inp('')} placeholder="0 if none" />
                  </F>
                  <F label="Monthly Net Income (₹)" required error={errors.monthly_net_income}>
                    <input type="number" value={formData.monthly_net_income || ''} onChange={e => onChange('monthly_net_income', e.target.value)} className={inp(errors.monthly_net_income)} placeholder="Take home salary" />
                  </F>
                </div>
              </div>

              <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={formData.criminal_records || false} onChange={e => onChange('criminal_records', e.target.checked)} className="mt-1 w-5 h-5" />
                  <span className="text-sm text-gray-700">I have pending criminal cases or criminal records</span>
                </label>
                <p className="text-xs text-gray-500 mt-2">Leave unchecked if you have no criminal records (default)</p>
              </div>

              <Nav onPrev={() => { autoSave(); setCurrentStep(2); window.scrollTo(0,0); }} onNext={handleNext} />
            </div>
          )}

          {/* STEP 4 - Documents */}
          {currentStep === 4 && (
            <div className="space-y-5">
              <h2 className="text-xl font-bold text-gray-900">Document Upload</h2>
              <p className="text-sm text-gray-500">Upload clear scanned copies or photos. Max 5MB each. PDF/JPG/PNG accepted.</p>

              <div className="space-y-3">
                {[
                  { key: 'pan_card_url', label: 'PAN Card', required: true },
                  { key: 'aadhaar_front_url', label: 'Aadhaar Front', required: true },
                  { key: 'aadhaar_back_url', label: 'Aadhaar Back', required: false },
                  { key: 'photo_url', label: 'Passport Size Photo', required: true },
                  { key: 'proof_of_identification_url', label: 'Proof of Identification', required: false },
                  { key: 'proof_of_residence_url', label: 'Proof of Residence', required: false },
                  { key: 'salary_slips_url', label: 'Salary Slips (Last 3 months)', required: true },
                  { key: 'itr_form16_url', label: 'ITR / Form 16', required: false },
                  { key: 'bank_statements_url', label: 'Bank Statements (Last 6 months)', required: true },
                ].map(doc => (
                  <div key={doc.key} className={`flex items-center justify-between p-4 rounded-xl border-2 ${formData[doc.key] ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {doc.label} {doc.required && <span className="text-red-500">*</span>}
                      </p>
                      {formData[doc.key] && <p className="text-xs text-green-600 mt-1 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Uploaded</p>}
                    </div>
                    <label className="cursor-pointer">
                      <input type="file" accept="image/*,application/pdf" className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          if (file.size > 5 * 1024 * 1024) { alert('File too large. Max 5MB'); return; }
                          const fd = new FormData();
                          fd.append('token', token);
                          fd.append('document_type', doc.key.replace('_url', ''));
                          fd.append('file', file);
                          try {
                            const res = await fetch(`${API_URL}/api/upload-document`, { method: 'POST', body: fd });
                            const data = await res.json();
                            if (data.url) onChange(doc.key, data.url);
                            else alert('Upload failed');
                          } catch { alert('Upload failed. Storage may not be configured yet.'); }
                        }}
                      />
                      <span className={`px-4 py-2 rounded-lg text-sm font-medium transition ${formData[doc.key] ? 'bg-green-600 text-white' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                        {formData[doc.key] ? 'Replace' : 'Upload'}
                      </span>
                    </label>
                  </div>
                ))}
              </div>

              <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3">
                <p className="text-xs text-yellow-800 flex items-center gap-1"><Paperclip className="w-3 h-3" />If storage is not yet configured, document upload will show an error. You can skip and submit — documents can be collected separately.</p>
              </div>

              <Nav onPrev={() => { autoSave(); setCurrentStep(3); window.scrollTo(0,0); }} onNext={handleNext} />
            </div>
          )}

          {/* STEP 5 - Review */}
          {currentStep === 5 && (
            <div className="space-y-5">
              <h2 className="text-xl font-bold text-gray-900">Review & Submit</h2>

              <RS title="Identity & KYC">
                <RR label="PAN" value={formData.pan_number ? formData.pan_number.slice(0,2)+'***'+formData.pan_number.slice(-2) : ''} />
                <RR label="Aadhaar" value={formData.aadhaar_number ? 'XXXX XXXX '+String(formData.aadhaar_number).slice(-4) : ''} />
              </RS>

              <RS title="Personal Details">
                <RR label="Name" value={[formData.title, formData.first_name, formData.middle_name, formData.last_name].filter(Boolean).join(' ')} />
                <RR label="DOB" value={formData.date_of_birth} />
                <RR label="Gender" value={formData.gender} />
                <RR label="Marital Status" value={formData.marital_status} />
                <RR label="Email" value={formData.email} />
                <RR label="Current Address" value={formData.current_address} />
              </RS>

              <RS title="Occupation Details">
                <RR label="Qualification" value={formData.qualification} />
                <RR label="Occupation" value={formData.occupation} />
                <RR label="Industry" value={formData.industry_type} />
                <RR label="Employment Type" value={formData.employment_type} />
                <RR label="Employer" value={formData.employer_name} />
                <RR label="Designation" value={formData.designation} />
                <RR label="Total Experience" value={formData.total_work_experience ? `${formData.total_work_experience} years` : ''} />
                <RR label="Residential Status" value={formData.residential_status} />
              </RS>

              <RS title="Loan & Financial Details">
                <RR label="Loan Amount" value={formData.loan_amount_requested ? `₹${parseFloat(formData.loan_amount_requested).toLocaleString('en-IN')}` : ''} />
                <RR label="Repayment Period" value={formData.repayment_period_years ? `${formData.repayment_period_years} years` : ''} />
                <RR label="Purpose" value={formData.purpose_of_loan} />
                <RR label="Monthly Net Income" value={formData.monthly_net_income ? `₹${parseFloat(formData.monthly_net_income).toLocaleString('en-IN')}` : ''} />
                <RR label="Existing EMIs" value={formData.monthly_emi_existing ? `₹${parseFloat(formData.monthly_emi_existing).toLocaleString('en-IN')}` : 'None'} />
              </RS>

              <RS title="Documents">
                {[
                  ['PAN Card', 'pan_card_url'],
                  ['Aadhaar Front', 'aadhaar_front_url'],
                  ['Photo', 'photo_url'],
                  ['Salary Slips', 'salary_slips_url'],
                  ['Bank Statements', 'bank_statements_url'],
                  ['ITR/Form 16', 'itr_form16_url'],
                ].map(([label, key]) => (
                  <div key={key} className="flex justify-between text-sm">
                    <span className="text-gray-500">{label}:</span>
                    <span className={formData[key] ? 'text-green-600 font-medium' : 'text-gray-400'}>
                      {formData[key] ? 'Uploaded' : '— Not uploaded'}
                    </span>
                  </div>
                ))}
              </RS>

              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} className="mt-1 w-5 h-5 text-blue-600 rounded" />
                  <span className="text-sm text-gray-700">I hereby declare that all information provided is true and accurate to the best of my knowledge. I authorize the bank to verify all details and conduct credit checks as required.</span>
                </label>
              </div>

              <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3">
                <p className="text-xs text-yellow-800 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />Once submitted, this application cannot be edited until reviewed by a bank officer.</p>
              </div>

              <div className="flex gap-4">
                <button onClick={() => { autoSave(); setCurrentStep(4); window.scrollTo(0,0); }} className="flex-1 bg-gray-200 text-gray-700 py-4 rounded-xl font-semibold hover:bg-gray-300 transition">← Previous</button>
                <button onClick={handleSubmit} disabled={submitting || !agreed}
                  className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 text-white py-4 rounded-xl font-semibold hover:from-green-700 hover:to-emerald-700 transition disabled:opacity-50">
                  {submitting ? 'Submitting...' : 'Submit Application'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function F({ label, required, error, children }: any) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
      {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
    </div>
  );
}

function Nav({ onPrev, onNext }: any) {
  return (
    <div className="flex gap-4 pt-2">
      {onPrev && <button onClick={onPrev} className="flex-1 bg-gray-200 text-gray-700 py-4 rounded-xl font-semibold hover:bg-gray-300 transition">← Previous</button>}
      {onNext && <button onClick={onNext} className={`${onPrev ? 'flex-1' : 'w-full'} bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-4 rounded-xl font-semibold hover:from-blue-700 hover:to-indigo-700 transition`}>Continue →</button>}
    </div>
  );
}

function RS({ title, children }: any) {
  return (
    <div className="bg-gray-50 rounded-xl p-4">
      <h3 className="font-semibold text-gray-900 mb-3">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function RR({ label, value }: any) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-gray-500">{label}:</span>
      <span className="font-medium text-gray-900 text-right max-w-xs">{value || '—'}</span>
    </div>
  );
}

function inp(error: string) {
  return `w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm ${error ? 'border-red-300 bg-red-50' : 'border-gray-300'}`;
}