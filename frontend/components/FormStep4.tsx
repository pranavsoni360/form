'use client';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

import { useState } from 'react';
import { submitForm, maskAadhaar, maskPAN } from '@/lib/api';

interface FormStep4Props {
  data: any;
  token: string;
  onChange: (field: string, value: any) => void;
  onPrevious: () => void;
  onSubmit: () => void;
}

export default function FormStep4({ data, token, onChange, onPrevious, onSubmit }: FormStep4Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [agreed, setAgreed] = useState(false);

  const handleSubmit = async () => {
    if (!agreed) {
      setError('Please agree to terms and conditions');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      await submitForm(token);
      onSubmit();
    } catch (err: any) {
      setError(err.message || 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const Section = ({ title, children }: any) => (
    <div className="bg-gray-50 rounded-lg p-4">
      <h3 className="font-semibold text-gray-900 mb-3">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );

  const Field = ({ label, value }: any) => (
    <div className="flex justify-between text-sm">
      <span className="text-gray-600">{label}:</span>
      <span className="font-medium text-gray-900">{value || 'Not provided'}</span>
    </div>
  );

  const Document = ({ label, url }: any) => (
    <div className="flex justify-between items-center text-sm">
      <span className="text-gray-600">{label}:</span>
      {url ? (
        <span className="text-green-600 flex items-center gap-1">
          Uploaded
        </span>
      ) : (
        <span className="text-red-600">✗ Missing</span>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          Review & Submit
        </h2>
        <p className="text-gray-600">
          Please review all information before submitting
        </p>
      </div>

      {/* Personal Details */}
      <Section title="Personal Details">
        <Field label="Full Name" value={data.customer_name} />
        <Field label="Email" value={data.email} />
        <Field label="Date of Birth" value={data.date_of_birth} />
        <Field label="Gender" value={data.gender} />
        <Field label="Marital Status" value={data.marital_status} />
        <Field label="Address" value={`${data.address_line1}, ${data.city}, ${data.state} - ${data.pincode}`} />
      </Section>

      {/* Employment Details */}
      <Section title="Employment & Financial Details">
        <Field label="Employment Type" value={data.employment_type} />
        <Field label={data.employment_type === 'Salaried' ? 'Employer' : 'Business Name'} value={data.employer_name} />
        {data.designation && <Field label="Designation" value={data.designation} />}
        <Field label="Monthly Income" value={`₹${parseFloat(data.monthly_income || 0).toLocaleString('en-IN')}`} />
        <Field label="Loan Purpose" value={data.loan_purpose} />
        {data.requested_loan_amount && (
          <Field label="Requested Amount" value={`₹${parseFloat(data.requested_loan_amount).toLocaleString('en-IN')}`} />
        )}
        {data.loan_tenure_months && (
          <Field label="Loan Tenure" value={`${data.loan_tenure_months} months`} />
        )}
      </Section>

      {/* KYC Details */}
      <Section title="KYC Details">
        <Field label="PAN Number" value={maskPAN(data.pan_number || '')} />
        <Field label="Aadhaar" value={maskAadhaar(data.aadhaar_last4 ? '********' + data.aadhaar_last4 : '')} />
        <div className="pt-2 border-t">
          <p className="text-xs text-gray-500 mb-2">Documents Uploaded:</p>
          <Document label="PAN Card" url={data.pan_card_url} />
          <Document label="Aadhaar Front" url={data.aadhaar_front_url} />
          {data.aadhaar_back_url && <Document label="Aadhaar Back" url={data.aadhaar_back_url} />}
          <Document label="Photo" url={data.photo_url} />
          {data.income_proof_url && <Document label="Income Proof" url={data.income_proof_url} />}
        </div>
      </Section>

      {/* Terms & Conditions */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-1 w-5 h-5 text-blue-600 focus:ring-2 focus:ring-blue-500 rounded"
          />
          <span className="text-sm text-gray-700">
            I hereby declare that the information provided is true and accurate to the best of my knowledge. 
            I authorize the bank to verify the information and agree to the{' '}
            <a href="#" className="text-blue-600 underline">terms and conditions</a>.
          </span>
        </label>
      </div>

      {/* Error Message */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Important Notice */}
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <p className="text-sm text-yellow-800 font-medium mb-2">
          Important
        </p>
        <ul className="text-sm text-yellow-700 space-y-1 list-disc list-inside">
          <li>Once submitted, you cannot edit this application</li>
          <li>Our team will review within 24-48 hours</li>
          <li>You will receive updates on WhatsApp</li>
        </ul>
      </div>

      {/* Navigation Buttons */}
      <div className="flex gap-4 pt-4">
        <button
          onClick={onPrevious}
          disabled={submitting}
          className="flex-1 bg-gray-200 text-gray-700 py-4 rounded-xl font-semibold hover:bg-gray-300 transition-all disabled:opacity-50"
        >
          ← Previous
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting || !agreed}
          className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 text-white py-4 rounded-xl font-semibold hover:from-green-700 hover:to-emerald-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <span className="flex items-center justify-center gap-2">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
              Submitting...
            </span>
          ) : (
            'Submit Application'
          )}
        </button>
      </div>
    </div>
  );
}
