'use client';

import { Suspense } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';

function SuccessContent() {
  const searchParams = useSearchParams();
  const loanId       = searchParams.get('loan_id');

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 dark:from-gray-900 dark:to-gray-950 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl border border-gray-200 dark:border-gray-800 p-8 w-full max-w-md text-center">

        {/* Icon */}
        <div className="w-20 h-20 bg-green-50 dark:bg-green-900/20 rounded-full flex items-center justify-center mx-auto mb-6">
          <CheckCircle2 className="w-10 h-10 text-emerald-500" />
        </div>

        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
          Application submitted!
        </h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm mb-6">
          Your loan application has been successfully submitted and is under review.
        </p>

        {/* Loan ID */}
        {loanId && (
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/30 rounded-2xl p-4 mb-6">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Your loan ID</p>
            <p className="text-xl font-bold text-blue-600 dark:text-blue-400 font-mono">
              {loanId}
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              Save this for future reference
            </p>
          </div>
        )}

        {/* Next steps */}
        <div className="bg-gray-50 dark:bg-gray-800 rounded-2xl p-4 text-left space-y-3 mb-6">
          {[
            'Our team will review your application within 24–48 hours',
            'You will receive updates on WhatsApp',
            'Keep your phone accessible for verification calls',
          ].map((text, i) => (
            <p key={i} className="text-sm text-gray-700 dark:text-gray-300 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
              <span>{text}</span>
            </p>
          ))}
        </div>

        {/* Contact */}
        <div className="pt-4 border-t border-gray-100 dark:border-gray-800">
          <p className="text-sm text-gray-400 dark:text-gray-500">
            Need help? Call us at{" "}
            <a
              href="tel:1800-103-0408"
              className="text-blue-600 dark:text-blue-400 font-semibold hover:underline"
            >
              1800-103-0408
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function SuccessPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
          <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <SuccessContent />
    </Suspense>
  );
}