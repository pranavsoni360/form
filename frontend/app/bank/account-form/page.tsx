'use client';

import { Building2, Lock, ShieldCheck, AlertTriangle, Loader2, CheckCircle2 } from 'lucide-react';
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { API_URL } from '@/lib/api';

function AccountFormInner() {
  const searchParams = useSearchParams();
  const call_id = searchParams.get('call_id') || '';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [prefillData, setPrefillData] = useState<any>(null);
  const [formData, setFormData] = useState<any>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [errors, setErrors] = useState<any>({});
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    if (!call_id) {
      setError('Invalid or missing application link. Please use the link sent to your WhatsApp.');
      setLoading(false);
      return;
    }
    loadPrefillData();
  }, [call_id]);

  const loadPrefillData = async () => {
    try {
      const res = await fetch(`${API_URL}/api/agent/form-data/${call_id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || 'Application not found');
      }
      const json = await res.json();
      const data = json.data || {};
      setPrefillData(data);
      setFormData({
        name: data.customer_name || '',
        phone: data.phone || '',
        age: data.age || '',
        account_type: data.account_type || '',
        initial_deposit: data.initial_deposit || '',
        monthly_income: data.monthly_income || '',
        employment_type: data.employment_type || '',
        employer_name: data.employer_name || '',
        qualification: '',
        work_experience: '',
        existing_emi: '',
        address: data.address || '',
        pan_number: data.pan_number || '',
        aadhar_number: data.aadhar_number || '',
        // Loan fields (shown only when agent_type !== account_opening)
        loan_type: data.loan_type || '',
        loan_amount: data.loan_amount || '',
        loan_purpose: data.loan_purpose || '',
      });
    } catch (err: any) {
      setError(err.message || 'Failed to load application data. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const onChange = (field: string, value: string) => {
    setFormData((prev: any) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev: any) => ({ ...prev, [field]: '' }));
  };

  const isAccountOpening = prefillData?.agent_type === 'account_opening';

  const validate = () => {
    const e: any = {};
    if (!formData.name?.trim()) e.name = 'Full name is required';
    if (!formData.phone?.trim()) e.phone = 'Phone number is required';
    if (!formData.address?.trim()) e.address = 'Address is required';
    if (isAccountOpening) {
      if (!formData.account_type?.trim()) e.account_type = 'Account type is required';
    } else {
      if (!formData.loan_type?.trim()) e.loan_type = 'Loan type is required';
      if (!formData.loan_amount?.trim()) e.loan_amount = 'Loan amount is required';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!agreed) { alert('Please agree to the declaration before submitting.'); return; }
    if (!validate()) return;

    setSubmitting(true);
    setSubmitError('');
    try {
      const payload = {
        name: formData.name,
        phone: formData.phone,
        age: formData.age,
        monthly_income: formData.monthly_income,
        employment_type: formData.employment_type,
        employer_name: formData.employer_name,
        qualification: formData.qualification,
        work_experience: formData.work_experience,
        existing_emi: formData.existing_emi,
        address: formData.address,
        pan_number: formData.pan_number,
        aadhar_number: formData.aadhar_number,
        // Conditional fields
        ...(isAccountOpening
          ? { account_type: formData.account_type, initial_deposit: formData.initial_deposit }
          : { loan_type: formData.loan_type, loan_amount: formData.loan_amount, loan_purpose: formData.loan_purpose }),
      };
      const res = await fetch(`${API_URL}/api/agent/submit-form/${call_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || 'Submission failed');
      }
      setSubmitted(true);
    } catch (err: any) {
      setSubmitError(err.message || 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Loading ───────────────────────────────────────────────────────────────
  if (loading) return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-600 mx-auto"></div>
        <p className="mt-4 text-gray-600">Loading your application...</p>
      </div>
    </div>
  );

  // ─── Error ─────────────────────────────────────────────────────────────────
  if (error) return (
    <div className="min-h-screen bg-red-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
        <AlertTriangle className="w-16 h-16 text-yellow-500 mx-auto mb-4" />
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Link Error</h2>
        <p className="text-gray-600">{error}</p>
      </div>
    </div>
  );

  // ─── Success ───────────────────────────────────────────────────────────────
  if (submitted) return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
        <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Application Submitted!</h2>
        <p className="text-gray-600 mb-4">
          {isAccountOpening
            ? 'Your account opening application has been received. Our team will contact you within 1-2 business days.'
            : 'Your loan application has been received. Our team will contact you within 1-2 business days.'}
        </p>
        <p className="text-sm text-gray-500 flex items-center justify-center gap-1">
          <Lock className="w-3 h-3" /> Your information is secure and encrypted.
        </p>
      </div>
    </div>
  );

  // ─── Form ──────────────────────────────────────────────────────────────────
  const title = isAccountOpening ? 'Account Opening Application' : 'Loan Application';
  const bankName = isAccountOpening ? 'Union Bank of India' : 'Pusad Urban Bank';

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-6 px-4">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="bg-white rounded-2xl shadow-lg p-5 mb-4">
          <div className="flex items-start gap-3">
            <Building2 className="w-8 h-8 text-blue-600 flex-shrink-0 mt-0.5" />
            <div>
              <h1 className="text-xl font-bold text-gray-900">{title}</h1>
              <p className="text-sm text-gray-500">{bankName} · Pre-filled from your call</p>
            </div>
          </div>
          <div className="mt-3 bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-xs text-blue-800 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3 flex-shrink-0" />
              Fields pre-filled from your phone call. Please review and complete the form.
            </p>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-lg p-6 space-y-6">

          {/* ── Personal Details ── */}
          <section className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-900 border-b pb-2">Personal Details</h2>

            <F label="Full Name" required error={errors.name}>
              <input type="text" value={formData.name || ''} onChange={e => onChange('name', e.target.value)}
                className={inp(errors.name)} placeholder="Enter your full name" />
            </F>

            <div className="grid grid-cols-2 gap-3">
              <F label="Phone Number" required error={errors.phone}>
                <input type="tel" value={formData.phone || ''} onChange={e => onChange('phone', e.target.value)}
                  className={inp(errors.phone)} placeholder="10-digit mobile number" />
              </F>
              <F label="Age">
                <input type="number" value={formData.age || ''} onChange={e => onChange('age', e.target.value)}
                  className={inp('')} placeholder="e.g. 32" min="18" max="100" />
              </F>
            </div>

            <F label="Current Address" required error={errors.address}>
              <textarea rows={3} value={formData.address || ''} onChange={e => onChange('address', e.target.value)}
                className={inp(errors.address)} placeholder="Full current address including city and pincode" />
            </F>
          </section>

          {/* ── Account / Loan Details (conditional) ── */}
          {isAccountOpening ? (
            <section className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900 border-b pb-2">Account Details</h2>

              <div className="grid grid-cols-2 gap-3">
                <F label="Account Type" required error={errors.account_type}>
                  <select value={formData.account_type || ''} onChange={e => onChange('account_type', e.target.value)}
                    className={inp(errors.account_type)}>
                    <option value="">Select</option>
                    {['Savings', 'Current', 'Salary', 'Fixed Deposit', 'Recurring Deposit'].map(t => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </F>
                <F label="Expected Initial Deposit (₹)">
                  <input type="number" value={formData.initial_deposit || ''} onChange={e => onChange('initial_deposit', e.target.value)}
                    className={inp('')} placeholder="e.g. 10000" min="0" />
                </F>
              </div>
            </section>
          ) : (
            <section className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900 border-b pb-2">Loan Details</h2>

              <div className="grid grid-cols-2 gap-3">
                <F label="Loan Type" required error={errors.loan_type}>
                  <select value={formData.loan_type || ''} onChange={e => onChange('loan_type', e.target.value)}
                    className={inp(errors.loan_type)}>
                    <option value="">Select</option>
                    {['Home Loan', 'Personal Loan', 'Business Loan', 'Vehicle Loan', 'Education Loan', 'Gold Loan', 'Other'].map(t => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </F>
                <F label="Loan Amount (₹)" required error={errors.loan_amount}>
                  <input type="number" value={formData.loan_amount || ''} onChange={e => onChange('loan_amount', e.target.value)}
                    className={inp(errors.loan_amount)} placeholder="e.g. 500000" min="0" />
                </F>
              </div>

              <F label="Loan Purpose">
                <select value={formData.loan_purpose || ''} onChange={e => onChange('loan_purpose', e.target.value)}
                  className={inp('')}>
                  <option value="">Select</option>
                  {['Home Purchase', 'Home Renovation', 'Business Expansion', 'Education', 'Medical Emergency',
                    'Debt Consolidation', 'Vehicle Purchase', 'Wedding', 'Travel', 'Personal Use', 'Other'].map(p => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </F>
            </section>
          )}

          {/* ── Financial & Employment Details ── */}
          <section className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-900 border-b pb-2">Financial & Employment Details</h2>

            <div className="grid grid-cols-2 gap-3">
              <F label="Monthly Income (₹)">
                <input type="number" value={formData.monthly_income || ''} onChange={e => onChange('monthly_income', e.target.value)}
                  className={inp('')} placeholder="e.g. 50000" min="0" />
              </F>
              <F label="Existing Monthly EMIs (₹)">
                <input type="number" value={formData.existing_emi || ''} onChange={e => onChange('existing_emi', e.target.value)}
                  className={inp('')} placeholder="0 if none" min="0" />
              </F>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <F label="Employment Type">
                <select value={formData.employment_type || ''} onChange={e => onChange('employment_type', e.target.value)}
                  className={inp('')}>
                  <option value="">Select</option>
                  {['Salaried', 'Self Employed Professional', 'Self Employed Business', 'Retired', 'Student', 'Housewife'].map(t => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </F>
              <F label="Employer / Company Name">
                <input type="text" value={formData.employer_name || ''} onChange={e => onChange('employer_name', e.target.value)}
                  className={inp('')} placeholder="Company or business name" />
              </F>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <F label="Educational Qualification">
                <select value={formData.qualification || ''} onChange={e => onChange('qualification', e.target.value)}
                  className={inp('')}>
                  <option value="">Select</option>
                  {['Below 10th', '10th Pass', '12th Pass', 'Diploma', 'Graduate', 'Post Graduate', 'PhD'].map(q => (
                    <option key={q}>{q}</option>
                  ))}
                </select>
              </F>
              <F label="Years of Work Experience">
                <input type="number" step="0.5" min="0" value={formData.work_experience || ''} onChange={e => onChange('work_experience', e.target.value)}
                  className={inp('')} placeholder="e.g. 5" />
              </F>
            </div>
          </section>

          {/* ── KYC Details ── */}
          <section className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-900 border-b pb-2">KYC Details</h2>
            <p className="text-xs text-gray-500 flex items-center gap-1">
              <Lock className="w-3 h-3" /> Your KYC information is encrypted and stored securely.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <F label="PAN Number">
                <input type="text" value={formData.pan_number || ''} onChange={e => onChange('pan_number', e.target.value.toUpperCase())}
                  className={inp('')} placeholder="ABCDE1234F" maxLength={10} />
              </F>
              <F label="Aadhaar Number">
                <input type="text" value={formData.aadhar_number || ''} onChange={e => onChange('aadhar_number', e.target.value.replace(/\D/g, '').slice(0, 12))}
                  className={inp('')} placeholder="12-digit Aadhaar" maxLength={12} inputMode="numeric" />
              </F>
            </div>
          </section>

          {/* ── Declaration ── */}
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} className="mt-1 w-5 h-5 text-blue-600 rounded" />
              <span className="text-sm text-gray-700">
                I hereby declare that all information provided is true and accurate to the best of my knowledge.
                I authorise {bankName} to verify my details and process my application.
              </span>
            </label>
          </div>

          {submitError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3">
              <p className="text-sm text-red-800 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />{submitError}
              </p>
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={submitting || !agreed}
            className="w-full bg-gradient-to-r from-green-600 to-emerald-600 text-white py-4 rounded-xl font-semibold hover:from-green-700 hover:to-emerald-700 transition disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {submitting
              ? <><Loader2 className="w-5 h-5 animate-spin" /><span>Submitting...</span></>
              : `Submit ${isAccountOpening ? 'Account' : 'Loan'} Application`}
          </button>

          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3">
            <p className="text-xs text-yellow-800 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Once submitted, this application will be reviewed by a bank officer who will contact you.
            </p>
          </div>

        </div>
      </div>
    </div>
  );
}

export default function AccountFormPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-600"></div>
      </div>
    }>
      <AccountFormInner />
    </Suspense>
  );
}

function F({ label, required, error, children }: { label: string; required?: boolean; error?: string; children: React.ReactNode }) {
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

function inp(error: string) {
  return `w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm ${error ? 'border-red-300 bg-red-50' : 'border-gray-300'}`;
}
