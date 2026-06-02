'use client';

import { Suspense, useState } from 'react';
import { CheckCircle2, Copy, Check, Phone } from 'lucide-react';
import { useSearchParams } from 'next/navigation';

function SuccessContent() {
  const searchParams = useSearchParams();
  const loanId = searchParams.get('loan_id') || '';
  const [copied, setCopied] = useState(false);

  const copyId = () => {
    navigator.clipboard.writeText(loanId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const steps = [
    { n: '1', title: 'Application Review',    desc: 'Our team reviews your details within 24–48 hours.' },
    { n: '2', title: 'Document Verification', desc: 'We verify your submitted KYC and financial documents.' },
    { n: '3', title: 'Loan Disbursement',     desc: 'Once approved, the amount is credited to your account.' },
  ];

  return (
    <div className="min-h-screen flex items-center justify-center py-10 px-4" style={{ background: '#F0F4FF' }}>
      <div className="w-full max-w-md">

        {/* Main card */}
        <div className="bg-white rounded-2xl overflow-hidden" style={{ boxShadow: '0 8px 40px rgba(0,0,0,0.1)', border: '1px solid #E2E8F0' }}>

          {/* Green top band */}
          <div className="h-2 w-full" style={{ background: 'linear-gradient(90deg, #059669, #34D399)' }} />

          <div className="px-7 py-8 text-center">

            {/* Animated checkmark */}
            <div className="flex justify-center mb-5">
              <div className="w-20 h-20 rounded-full flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, #F0FDF4 0%, #DCFCE7 100%)', border: '2px solid #6EE7B7', boxShadow: '0 0 0 8px rgba(5,150,105,0.06)' }}>
                <CheckCircle2 className="w-10 h-10" style={{ color: '#059669' }} />
              </div>
            </div>

            <h1 className="text-2xl font-bold mb-2" style={{ color: '#0F172A', fontFamily: 'var(--font-heading)' }}>
              Application Submitted!
            </h1>
            <p className="text-sm mb-6" style={{ color: '#475569', fontFamily: 'var(--font-body)' }}>
              We've received your application and will review it shortly.
            </p>

            {/* Loan ID box */}
            {loanId && (
              <div className="rounded-xl px-5 py-4 mb-6 flex items-center justify-between"
                style={{ background: '#0F172A', border: '1px solid #1E293B' }}>
                <div className="text-left">
                  <p className="text-xs mb-1" style={{ color: 'rgba(255,255,255,0.4)', fontFamily: 'var(--font-body)' }}>Loan ID</p>
                  <p className="font-semibold" style={{ color: '#fff', fontFamily: 'var(--font-mono-loan)', fontSize: '0.9rem', letterSpacing: '0.04em' }}>
                    {loanId}
                  </p>
                </div>
                <button onClick={copyId}
                  className="w-8 h-8 rounded-lg flex items-center justify-center transition hover:opacity-80"
                  style={{ background: 'rgba(255,255,255,0.1)' }}>
                  {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" style={{ color: 'rgba(255,255,255,0.5)' }} />}
                </button>
              </div>
            )}

            {/* What happens next */}
            <div className="text-left rounded-xl overflow-hidden mb-6" style={{ border: '1px solid #E2E8F0' }}>
              <div className="px-5 py-3" style={{ background: '#F8F9FC', borderBottom: '1px solid #E2E8F0' }}>
                <p className="text-sm font-semibold" style={{ color: '#0F172A', fontFamily: 'var(--font-heading)' }}>What happens next?</p>
              </div>
              <div className="px-5 py-4 space-y-4 bg-white">
                {steps.map(({ n, title, desc }) => (
                  <div key={n} className="flex items-start gap-3">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-white text-xs flex-shrink-0 mt-0.5"
                      style={{ background: '#1A1A2E', fontFamily: 'var(--font-heading)' }}>
                      {n}
                    </div>
                    <div>
                      <p className="text-sm font-semibold" style={{ color: '#0F172A', fontFamily: 'var(--font-body)' }}>{title}</p>
                      <p className="text-xs mt-0.5" style={{ color: '#64748B', fontFamily: 'var(--font-body)' }}>{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Support */}
            <div className="mb-6 py-4" style={{ borderTop: '1px solid #F1F5F9' }}>
              <p className="text-xs mb-1" style={{ color: '#94A3B8', fontFamily: 'var(--font-body)' }}>Need help? Call us at</p>
              <a href="tel:18001030408" className="flex items-center justify-center gap-2 font-bold"
                style={{ color: '#1A1A2E', fontFamily: 'var(--font-mono-loan)', fontSize: '1.1rem' }}>
                <Phone className="w-4 h-4" />
                1800-103-0408
              </a>
            </div>

            {/* Return home */}
            <a href="/"
              className="block w-full rounded-xl font-semibold text-white text-sm text-center py-3.5 transition hover:-translate-y-0.5 hover:shadow-lg"
              style={{ background: 'linear-gradient(135deg, #1A1A2E 0%, #0F3460 100%)', fontFamily: 'var(--font-heading)', boxShadow: '0 4px 14px rgba(26,26,46,0.25)' }}>
              ← Return to Home
            </a>
          </div>
        </div>

      </div>
    </div>
  );
}

export default function SuccessPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F0F4FF' }}>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: '#1A1A2E' }} />
      </div>
    }>
      <SuccessContent />
    </Suspense>
  );
}
