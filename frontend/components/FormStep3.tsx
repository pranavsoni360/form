'use client';

import { useState } from 'react';
import FileUpload from './FileUpload';
import { verifyPAN, verifyAadhaar, validatePANFormat, validateAadhaarFormat } from '@/lib/api';

interface FormStep3Props {
  data: any;
  token: string;
  onChange: (field: string, value: any) => void;
  onNext: () => void;
  onPrevious: () => void;
}

export default function FormStep3({ data, token, onChange, onNext, onPrevious }: FormStep3Props) {
  const [errors, setErrors] = useState<any>({});
  const [verifying, setVerifying] = useState<string>('');
  const [verified, setVerified] = useState<any>({
    pan: data.pan_verified || false,
    aadhaar: data.aadhaar_verified || false,
  });

  const handleVerifyPAN = async () => {
    if (!data.pan_number) {
      setErrors({ ...errors, pan_number: 'Please enter PAN number' });
      return;
    }

    if (!validatePANFormat(data.pan_number)) {
      setErrors({ ...errors, pan_number: 'Invalid PAN format (e.g., ABCDE1234F)' });
      return;
    }

    setVerifying('pan');
    setErrors({ ...errors, pan_number: '' });

    try {
      await verifyPAN(token, data.pan_number);
      setVerified({ ...verified, pan: true });
      onChange('pan_verified', true);
    } catch (error: any) {
      setErrors({ ...errors, pan_number: error.message || 'PAN verification failed' });
    } finally {
      setVerifying('');
    }
  };

  const handleVerifyAadhaar = async () => {
    if (!data.aadhaar_number) {
      setErrors({ ...errors, aadhaar_number: 'Please enter Aadhaar number' });
      return;
    }

    if (!validateAadhaarFormat(data.aadhaar_number)) {
      setErrors({ ...errors, aadhaar_number: 'Invalid Aadhaar format (12 digits)' });
      return;
    }

    setVerifying('aadhaar');
    setErrors({ ...errors, aadhaar_number: '' });

    try {
      const response = await verifyAadhaar(token, data.aadhaar_number);
      setVerified({ ...verified, aadhaar: true });
      onChange('aadhaar_verified', true);
      onChange('aadhaar_last4', response.last4);
    } catch (error: any) {
      setErrors({ ...errors, aadhaar_number: error.message || 'Aadhaar verification failed' });
    } finally {
      setVerifying('');
    }
  };

  const validateStep = () => {
    const newErrors: any = {};

    if (!verified.pan) {
      newErrors.pan_number = 'Please verify your PAN';
    }

    if (!verified.aadhaar) {
      newErrors.aadhaar_number = 'Please verify your Aadhaar';
    }

    if (!data.pan_card_url) {
      newErrors.pan_card = 'Please upload PAN card';
    }

    if (!data.aadhaar_front_url) {
      newErrors.aadhaar_front = 'Please upload Aadhaar front';
    }

    if (!data.photo_url) {
      newErrors.photo = 'Please upload your photo';
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
          KYC & Document Verification
        </h2>
        <p className="text-gray-600">
          Upload your identity documents for verification
        </p>
      </div>

      {/* PAN Verification */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
        <h3 className="font-semibold text-gray-900 mb-4">
          PAN Card Verification
        </h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              PAN Number <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={data.pan_number || ''}
                onChange={(e) => onChange('pan_number', e.target.value.toUpperCase())}
                disabled={verified.pan}
                className={`flex-1 px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none uppercase ${
                  verified.pan ? 'bg-green-50 border-green-300' : 
                  errors.pan_number ? 'border-red-300' : 'border-gray-300'
                }`}
                placeholder="ABCDE1234F"
                maxLength={10}
              />
              <button
                onClick={handleVerifyPAN}
                disabled={verified.pan || verifying === 'pan'}
                className={`px-6 py-3 rounded-lg font-semibold transition ${
                  verified.pan
                    ? 'bg-green-500 text-white cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                {verifying === 'pan' ? 'Verifying...' : verified.pan ? '✓ Verified' : 'Verify'}
              </button>
            </div>
            {errors.pan_number && (
              <p className="text-sm text-red-600 mt-1">{errors.pan_number}</p>
            )}
            {verified.pan && (
              <p className="text-sm text-green-600 mt-1 flex items-center gap-1">
                ✓ PAN verified successfully
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Upload PAN Card <span className="text-red-500">*</span>
            </label>
            <FileUpload
              token={token}
              documentType="pan_card"
              onUploadComplete={(url) => onChange('pan_card_url', url)}
              existingUrl={data.pan_card_url}
              accept="image/*,application/pdf"
            />
            {errors.pan_card && (
              <p className="text-sm text-red-600 mt-1">{errors.pan_card}</p>
            )}
          </div>
        </div>
      </div>

      {/* Aadhaar Verification */}
      <div className="bg-orange-50 border border-orange-200 rounded-lg p-6">
        <h3 className="font-semibold text-gray-900 mb-4">
          Aadhaar Card Verification
        </h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Aadhaar Number <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={data.aadhaar_number || ''}
                onChange={(e) => onChange('aadhaar_number', e.target.value.replace(/\D/g, '').slice(0, 12))}
                disabled={verified.aadhaar}
                className={`flex-1 px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none ${
                  verified.aadhaar ? 'bg-green-50 border-green-300' : 
                  errors.aadhaar_number ? 'border-red-300' : 'border-gray-300'
                }`}
                placeholder="XXXX XXXX XXXX"
                maxLength={12}
              />
              <button
                onClick={handleVerifyAadhaar}
                disabled={verified.aadhaar || verifying === 'aadhaar'}
                className={`px-6 py-3 rounded-lg font-semibold transition ${
                  verified.aadhaar
                    ? 'bg-green-500 text-white cursor-not-allowed'
                    : 'bg-orange-600 text-white hover:bg-orange-700'
                }`}
              >
                {verifying === 'aadhaar' ? 'Verifying...' : verified.aadhaar ? '✓ Verified' : 'Verify'}
              </button>
            </div>
            {errors.aadhaar_number && (
              <p className="text-sm text-red-600 mt-1">{errors.aadhaar_number}</p>
            )}
            {verified.aadhaar && (
              <p className="text-sm text-green-600 mt-1 flex items-center gap-1">
                ✓ Aadhaar verified successfully (Last 4 digits: {data.aadhaar_last4})
              </p>
            )}
            <p className="text-xs text-gray-500 mt-1">
              🔒 Only last 4 digits will be stored as per UIDAI guidelines
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Upload Aadhaar Front <span className="text-red-500">*</span>
            </label>
            <FileUpload
              token={token}
              documentType="aadhaar_front"
              onUploadComplete={(url) => onChange('aadhaar_front_url', url)}
              existingUrl={data.aadhaar_front_url}
              accept="image/*,application/pdf"
            />
            {errors.aadhaar_front && (
              <p className="text-sm text-red-600 mt-1">{errors.aadhaar_front}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Upload Aadhaar Back
            </label>
            <FileUpload
              token={token}
              documentType="aadhaar_back"
              onUploadComplete={(url) => onChange('aadhaar_back_url', url)}
              existingUrl={data.aadhaar_back_url}
              accept="image/*,application/pdf"
            />
          </div>
        </div>
      </div>

      {/* Photo Upload */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Upload Your Photo <span className="text-red-500">*</span>
        </label>
        <FileUpload
          token={token}
          documentType="photo"
          onUploadComplete={(url) => onChange('photo_url', url)}
          existingUrl={data.photo_url}
          accept="image/*"
        />
        {errors.photo && (
          <p className="text-sm text-red-600 mt-1">{errors.photo}</p>
        )}
        <p className="text-xs text-gray-500 mt-1">
          Passport size photo, clear face visible
        </p>
      </div>

      {/* Income Proof (Optional) */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Income Proof (Optional)
        </label>
        <FileUpload
          token={token}
          documentType="income_proof"
          onUploadComplete={(url) => onChange('income_proof_url', url)}
          existingUrl={data.income_proof_url}
          accept="image/*,application/pdf"
        />
        <p className="text-xs text-gray-500 mt-1">
          Salary slip, ITR, or bank statement
        </p>
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
          Continue to Review →
        </button>
      </div>
    </div>
  );
}
