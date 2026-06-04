'use client';

import { useState } from 'react';

interface FormStep2Props {
  data: any;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onPrevious: () => void;
}

export default function FormStep2({ data, onChange, onNext, onPrevious }: FormStep2Props) {
  const [errors, setErrors] = useState<any>({});

  const validateStep = () => {
    const newErrors: any = {};

    if (!data.employment_type) {
      newErrors.employment_type = 'Employment type is required';
    }

    if (!data.employer_name) {
      newErrors.employer_name = 'Employer/Business name is required';
    }

    if (!data.monthly_income || parseFloat(data.monthly_income) <= 0) {
      newErrors.monthly_income = 'Valid monthly income is required';
    }

    if (!data.loan_purpose) {
      newErrors.loan_purpose = 'Loan purpose is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleNext = () => {
    if (validateStep()) {
      onNext();
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          Employment & Financial Details
        </h2>
        <p className="text-gray-600">
          Tell us about your income and employment
        </p>
      </div>

      {/* Employment Type */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-3">
          Employment Type <span className="text-red-500">*</span>
        </label>
        <div className="grid grid-cols-3 gap-3">
          {['Salaried', 'Self-employed', 'Business'].map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => onChange('employment_type', type)}
              className={`py-3 px-4 rounded-lg border-2 font-medium transition ${
                data.employment_type === type
                  ? 'border-blue-600 bg-blue-50 text-blue-600'
                  : 'border-gray-300 hover:border-blue-300'
              }`}
            >
              {type}
            </button>
          ))}
        </div>
        {errors.employment_type && (
          <p className="text-sm text-red-600 mt-1">{errors.employment_type}</p>
        )}
      </div>

      {/* Employer/Business Name */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          {data.employment_type === 'Salaried' ? 'Employer Name' : 'Business Name'} <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={data.employer_name || ''}
          onChange={(e) => onChange('employer_name', e.target.value)}
          className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none ${
            errors.employer_name ? 'border-red-300' : 'border-gray-300'
          }`}
          placeholder={data.employment_type === 'Salaried' ? 'Company name' : 'Business name'}
        />
        {errors.employer_name && (
          <p className="text-sm text-red-600 mt-1">{errors.employer_name}</p>
        )}
      </div>

      {/* Designation (for Salaried) */}
      {data.employment_type === 'Salaried' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Designation/Job Title
          </label>
          <input
            type="text"
            value={data.designation || ''}
            onChange={(e) => onChange('designation', e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            placeholder="e.g., Senior Manager, Software Engineer"
          />
        </div>
      )}

      {/* Years at Job/Business */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Years at Current {data.employment_type === 'Business' ? 'Business' : 'Job'}
        </label>
        <input
          type="number"
          step="0.5"
          value={data.years_at_job || ''}
          onChange={(e) => onChange('years_at_job', e.target.value)}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
          placeholder="e.g., 2.5"
          min="0"
          max="50"
        />
      </div>

      {/* Monthly Income */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Monthly Income (₹) <span className="text-red-500">*</span>
        </label>
        <input
          type="number"
          value={data.monthly_income || ''}
          onChange={(e) => onChange('monthly_income', e.target.value)}
          className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none ${
            errors.monthly_income ? 'border-red-300' : 'border-gray-300'
          }`}
          placeholder="e.g., 50000"
          min="0"
        />
        {errors.monthly_income && (
          <p className="text-sm text-red-600 mt-1">{errors.monthly_income}</p>
        )}
        {data.monthly_income && (
          <p className="text-sm text-gray-600 mt-1">
            ₹{parseFloat(data.monthly_income).toLocaleString('en-IN')}/month
          </p>
        )}
      </div>

      {/* Loan Purpose */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Loan Purpose <span className="text-red-500">*</span>
        </label>
        <select
          value={data.loan_purpose || ''}
          onChange={(e) => onChange('loan_purpose', e.target.value)}
          className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none ${
            errors.loan_purpose ? 'border-red-300' : 'border-gray-300'
          }`}
        >
          <option value="">Select loan purpose</option>
          <option value="Home Purchase">Home Purchase</option>
          <option value="Business Expansion">Business Expansion</option>
          <option value="Education">Education</option>
          <option value="Medical Emergency">Medical Emergency</option>
          <option value="Debt Consolidation">Debt Consolidation</option>
          <option value="Vehicle Purchase">Vehicle Purchase</option>
          <option value="Wedding">Wedding</option>
          <option value="Travel">Travel</option>
          <option value="Other">Other</option>
        </select>
        {errors.loan_purpose && (
          <p className="text-sm text-red-600 mt-1">{errors.loan_purpose}</p>
        )}
      </div>

      {/* Requested Loan Amount */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Requested Loan Amount (₹)
        </label>
        <input
          type="number"
          value={data.requested_loan_amount || ''}
          onChange={(e) => onChange('requested_loan_amount', e.target.value)}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
          placeholder="e.g., 500000"
          min="0"
        />
        {data.requested_loan_amount && (
          <p className="text-sm text-gray-600 mt-1">
            ₹{parseFloat(data.requested_loan_amount).toLocaleString('en-IN')}
          </p>
        )}
      </div>

      {/* Loan Tenure */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Loan Tenure (months)
        </label>
        <select
          value={data.loan_tenure_months || ''}
          onChange={(e) => onChange('loan_tenure_months', e.target.value)}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">Select tenure</option>
          <option value="12">12 months (1 year)</option>
          <option value="24">24 months (2 years)</option>
          <option value="36">36 months (3 years)</option>
          <option value="60">60 months (5 years)</option>
          <option value="120">120 months (10 years)</option>
          <option value="180">180 months (15 years)</option>
          <option value="240">240 months (20 years)</option>
        </select>
      </div>

      {/* Navigation Buttons */}
      <div className="flex gap-4 pt-4">
        <button
          onClick={onPrevious}
          className="flex-1 bg-gray-200 text-gray-700 py-4 rounded-xl font-semibold hover:bg-gray-300 transition-all"
        >
          ← Previous
        </button>
        <button
          onClick={handleNext}
          className="flex-1 bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-4 rounded-xl font-semibold hover:from-blue-700 hover:to-indigo-700 transition-all"
        >
          Continue to Documents →
        </button>
      </div>
    </div>
  );
}
