'use client';

import { useState } from 'react';

interface FormStep1Props {
  data: any;
  customerData: any;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
}

export default function FormStep1({ data, customerData, onChange, onNext }: FormStep1Props) {
  const [errors, setErrors] = useState<any>({});

  const validateStep = () => {
    const newErrors: any = {};

    if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      newErrors.email = 'Valid email is required';
    }

    if (!data.date_of_birth) {
      newErrors.date_of_birth = 'Date of birth is required';
    }

    if (!data.address_line1) {
      newErrors.address_line1 = 'Address is required';
    }

    if (!data.city) {
      newErrors.city = 'City is required';
    }

    if (!data.pincode || !/^\d{6}$/.test(data.pincode)) {
      newErrors.pincode = 'Valid 6-digit pincode is required';
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
          Personal Details
        </h2>
        <p className="text-gray-600">
          Please verify and complete your personal information
        </p>
      </div>

      {/* Name (Prefilled, Editable) */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Full Name <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={data.customer_name || customerData?.customer_name || ''}
          onChange={(e) => onChange('customer_name', e.target.value)}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          placeholder="Enter your full name"
        />
      </div>

      {/* Phone (Prefilled, Read-only) */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Phone Number
        </label>
        <input
          type="text"
          value={customerData?.phone || ''}
          disabled
          className="w-full px-4 py-3 border border-gray-200 rounded-lg bg-gray-50 text-gray-600 cursor-not-allowed"
        />
        <p className="text-xs text-gray-500 mt-1">
          Phone number cannot be changed
        </p>
      </div>

      {/* Email */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Email Address <span className="text-red-500">*</span>
        </label>
        <input
          type="email"
          value={data.email || customerData?.email || ''}
          onChange={(e) => onChange('email', e.target.value)}
          className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none ${
            errors.email ? 'border-red-300' : 'border-gray-300'
          }`}
          placeholder="your.email@example.com"
        />
        {errors.email && (
          <p className="text-sm text-red-600 mt-1">{errors.email}</p>
        )}
      </div>

      {/* Date of Birth */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Date of Birth <span className="text-red-500">*</span>
        </label>
        <input
          type="date"
          value={data.date_of_birth || customerData?.date_of_birth || ''}
          onChange={(e) => onChange('date_of_birth', e.target.value)}
          className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none ${
            errors.date_of_birth ? 'border-red-300' : 'border-gray-300'
          }`}
          max={new Date().toISOString().split('T')[0]}
        />
        {errors.date_of_birth && (
          <p className="text-sm text-red-600 mt-1">{errors.date_of_birth}</p>
        )}
      </div>

      {/* Gender */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Gender <span className="text-red-500">*</span>
        </label>
        <div className="flex gap-4">
          {['Male', 'Female', 'Other'].map((gender) => (
            <label key={gender} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="gender"
                value={gender}
                checked={data.gender === gender}
                onChange={(e) => onChange('gender', e.target.value)}
                className="w-4 h-4 text-blue-600 focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-gray-700">{gender}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Marital Status */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Marital Status
        </label>
        <select
          value={data.marital_status || ''}
          onChange={(e) => onChange('marital_status', e.target.value)}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">Select marital status</option>
          <option value="Single">Single</option>
          <option value="Married">Married</option>
          <option value="Divorced">Divorced</option>
          <option value="Widowed">Widowed</option>
        </select>
      </div>

      {/* Address */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Address Line 1 <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={data.address_line1 || ''}
          onChange={(e) => onChange('address_line1', e.target.value)}
          className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none ${
            errors.address_line1 ? 'border-red-300' : 'border-gray-300'
          }`}
          placeholder="House no, Building name"
        />
        {errors.address_line1 && (
          <p className="text-sm text-red-600 mt-1">{errors.address_line1}</p>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Address Line 2
        </label>
        <input
          type="text"
          value={data.address_line2 || ''}
          onChange={(e) => onChange('address_line2', e.target.value)}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
          placeholder="Street, Locality"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            City <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={data.city || ''}
            onChange={(e) => onChange('city', e.target.value)}
            className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none ${
              errors.city ? 'border-red-300' : 'border-gray-300'
            }`}
            placeholder="City"
          />
          {errors.city && (
            <p className="text-sm text-red-600 mt-1">{errors.city}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            State <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={data.state || ''}
            onChange={(e) => onChange('state', e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            placeholder="State"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Pincode <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={data.pincode || ''}
          onChange={(e) => onChange('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))}
          className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none ${
            errors.pincode ? 'border-red-300' : 'border-gray-300'
          }`}
          placeholder="6-digit pincode"
          maxLength={6}
        />
        {errors.pincode && (
          <p className="text-sm text-red-600 mt-1">{errors.pincode}</p>
        )}
      </div>

      {/* Next Button */}
      <button
        onClick={handleNext}
        className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-4 rounded-xl font-semibold hover:from-blue-700 hover:to-indigo-700 transition-all"
      >
        Continue to Employment Details →
      </button>
    </div>
  );
}
