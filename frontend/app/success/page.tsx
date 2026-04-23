'use client';

import { Suspense } from 'react';
import { CheckCircle2, Phone } from 'lucide-react';
import { useSearchParams } from 'next/navigation';

function SuccessContent() {
  const searchParams = useSearchParams();
  const loanId = searchParams.get('loan_id');

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
        <div className="mb-4"><CheckCircle2 className="w-16 h-16 text-green-500 mx-auto" /></div>
        <h1 className="text-3xl font-bold text-gray-900 mb-4">
          Application Submitted!
        </h1>
        <p className="text-gray-600 mb-6">
          Your loan application has been successfully submitted.
        </p>
        
        {loanId && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <p className="text-sm text-gray-600 mb-1">Loan ID</p>
            <p className="text-xl font-bold text-blue-600">{loanId}</p>
          </div>
        )}

        <div className="space-y-3 text-left bg-gray-50 rounded-lg p-4">
          <p className="text-sm text-gray-700 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
            <span>Our team will review your application within 24-48 hours</span>
          </p>
          <p className="text-sm text-gray-700 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
            <span>You will receive updates on WhatsApp</span>
          </p>
          <p className="text-sm text-gray-700 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
            <span>Keep your phone accessible for verification calls</span>
          </p>
        </div>

        <div className="mt-6 pt-6 border-t">
          <p className="text-sm text-gray-500">
            Need help? Contact us at <br />
            <a href="tel:1800-XXX-XXXX" className="text-blue-600 font-semibold">
              1800-XXX-XXXX
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function SuccessPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
      <SuccessContent />
    </Suspense>
  );
}
