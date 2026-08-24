'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { initiateAAUpload, checkAAStatus, rescoreLRS } from '@/lib/api/bank';

interface BankStatementPanelProps {
  token: string;
  applicationId: string;
  app: any;
  onRefresh: () => void;
}

type PanelState = 'idle' | 'initiating' | 'ready' | 'checking' | 'complete' | 'failed';

const FIELD_LABELS: Record<string, string> = {
  amb_pct_of_nmi:       'Avg Balance % of Income',
  net_cash_flow:        'Net Cash Flow (₹)',
  surplus_income_ratio: 'Surplus / Income %',
  otp_ratio_pct:        'On-Time Payment %',
  missed_payment_ratio: 'Missed Payment Ratio',
  penalty_count:        'Penalty Charges',
  employment_type:      'Employment Type',
  net_monthly_income:   'Monthly Income (₹)',
};

function fmt(key: string, value: any): string {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!isNaN(n)) {
    if (key.includes('ratio') || key === 'missed_payment_ratio') return (n * (key === 'missed_payment_ratio' ? 100 : 1)).toFixed(1) + '%';
    if (key.includes('pct') || key.includes('_pct')) return n.toFixed(1) + '%';
    if (key.includes('income') || key.includes('flow')) return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
    if (key === 'penalty_count') return String(Math.round(n));
    return n.toFixed(1);
  }
  return String(value).replace(/_/g, ' ');
}

export function BankStatementPanel({ token, applicationId, app, onRefresh }: BankStatementPanelProps) {
  const alreadyComplete = Boolean(app.aa_completed_at && app.aa_lrs_inputs);
  const alreadyInitiated = Boolean(app.aa_initiated_at);

  const [state, setState] = useState<PanelState>(
    alreadyComplete ? 'complete' : alreadyInitiated ? 'ready' : 'idle'
  );
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);
  const [mappedFields, setMappedFields] = useState<Record<string, any> | null>(
    alreadyComplete ? (app.aa_lrs_inputs || null) : null
  );
  const [error, setError] = useState<string | null>(null);
  const [rescoring, setRescoring] = useState(false);
  const [rescored, setRescored] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPoll = () => {
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
  };

  const pollStatus = useCallback(async () => {
    try {
      const data = await checkAAStatus(token, applicationId);
      if (data.status === 'complete') {
        stopPoll();
        setMappedFields(data.mapped_fields || app.aa_lrs_inputs || null);
        setState('complete');
        onRefresh();
      } else if (data.status === 'failed') {
        stopPoll();
        setState('failed');
        setError('Statement processing failed. Please try again.');
      } else {
        pollTimer.current = setTimeout(pollStatus, 5000);
      }
    } catch {
      pollTimer.current = setTimeout(pollStatus, 8000);
    }
  }, [token, applicationId, onRefresh, app.aa_lrs_inputs]);

  useEffect(() => { return () => stopPoll(); }, []);

  const handleInitiate = async () => {
    setState('initiating');
    setError(null);
    try {
      const data = await initiateAAUpload(token, applicationId);
      setUploadUrl(data.url);
      setState('ready');
      onRefresh();
    } catch (e: any) {
      setError(e.message || 'Could not generate upload link');
      setState('idle');
    }
  };

  const handleCheckStatus = async () => {
    setState('checking');
    setError(null);
    try {
      const data = await checkAAStatus(token, applicationId);
      if (data.status === 'complete') {
        setMappedFields(data.mapped_fields || null);
        setState('complete');
        onRefresh();
      } else if (data.status === 'failed') {
        setState('failed');
        setError('Statement processing failed. Please generate a new link.');
      } else if (data.status === 'pending') {
        setState('ready');
        // auto-poll every 5s
        pollTimer.current = setTimeout(pollStatus, 5000);
      } else {
        setState('ready');
      }
    } catch (e: any) {
      setError(e.message || 'Could not check status');
      setState('ready');
    }
  };

  const handleRescore = async () => {
    setRescoring(true);
    try {
      await rescoreLRS(token, applicationId);
      setRescored(true);
      onRefresh();
    } catch {
      // non-blocking — LRS panel will show the updated score on next load
    } finally {
      setRescoring(false);
    }
  };

  const containerStyle: React.CSSProperties = {
    background: 'rgba(59,130,246,0.04)',
    border: '1px solid rgba(59,130,246,0.12)',
    backdropFilter: 'blur(12px)',
    borderRadius: '12px',
    padding: '16px',
    marginTop: '12px',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'rgba(59,130,246,0.7)',
    marginBottom: '10px',
  };

  const btnBase: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '7px 14px',
    borderRadius: '8px',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    border: 'none',
    transition: 'opacity 0.15s',
  };

  const primaryBtn: React.CSSProperties = {
    ...btnBase,
    background: 'rgba(59,130,246,0.9)',
    color: '#fff',
  };

  const ghostBtn: React.CSSProperties = {
    ...btnBase,
    background: 'rgba(59,130,246,0.08)',
    color: 'rgba(59,130,246,0.9)',
    border: '1px solid rgba(59,130,246,0.2)',
  };

  const urlBoxStyle: React.CSSProperties = {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    background: 'rgba(0,0,0,0.03)',
    border: '1px solid rgba(59,130,246,0.12)',
    borderRadius: '8px',
    padding: '8px 12px',
    marginBottom: '10px',
  };

  const fields = mappedFields || {};
  const fieldKeys = Object.keys(FIELD_LABELS).filter(k => fields[k] !== undefined);

  return (
    <div style={containerStyle}>
      <div style={labelStyle}>Bank Statement · Account Aggregator</div>

      {/* ── IDLE: never initiated ─────────────────────────── */}
      {state === 'idle' && (
        <div>
          <p style={{ fontSize: '13px', color: 'var(--fx-text2, #6b7280)', marginBottom: '12px' }}>
            Generate a secure upload link for the customer to share their bank statement.
            Covers the last 6 months automatically.
          </p>
          <button style={primaryBtn} onClick={handleInitiate}>
            ⬆ Get Upload Link
          </button>
        </div>
      )}

      {/* ── INITIATING ───────────────────────────────────── */}
      {state === 'initiating' && (
        <p style={{ fontSize: '13px', color: 'var(--fx-text2, #6b7280)' }}>Generating link…</p>
      )}

      {/* ── READY: URL generated, waiting for customer ────── */}
      {state === 'ready' && (
        <div>
          {uploadUrl && (
            <div>
              <p style={{ fontSize: '12px', color: 'var(--fx-text2, #6b7280)', marginBottom: '6px' }}>
                Share this link with the customer to upload their bank statement:
              </p>
              <div style={urlBoxStyle}>
                <span style={{ fontSize: '12px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fx-text, #111)' }}>
                  {uploadUrl}
                </span>
                <button
                  style={{ ...ghostBtn, padding: '4px 10px', fontSize: '11px' }}
                  onClick={() => navigator.clipboard.writeText(uploadUrl)}
                >
                  Copy
                </button>
              </div>
            </div>
          )}
          {!uploadUrl && (
            <p style={{ fontSize: '13px', color: 'var(--fx-text2, #6b7280)', marginBottom: '10px' }}>
              Upload link previously generated. Click below once the customer has uploaded.
            </p>
          )}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button style={primaryBtn} onClick={handleCheckStatus}>
              ↻ Check Status
            </button>
            <button style={ghostBtn} onClick={handleInitiate}>
              New Link
            </button>
          </div>
        </div>
      )}

      {/* ── CHECKING ─────────────────────────────────────── */}
      {state === 'checking' && (
        <p style={{ fontSize: '13px', color: 'var(--fx-text2, #6b7280)' }}>Checking status…</p>
      )}

      {/* ── COMPLETE ─────────────────────────────────────── */}
      {state === 'complete' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px' }}>
            <span style={{ color: '#22c55e', fontSize: '14px' }}>✓</span>
            <span style={{ fontSize: '13px', fontWeight: 500, color: '#22c55e' }}>Statement received & processed</span>
          </div>

          {fieldKeys.length > 0 && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: '8px',
              marginBottom: '14px',
            }}>
              {fieldKeys.map(k => (
                <div key={k} style={{
                  background: 'rgba(59,130,246,0.05)',
                  border: '1px solid rgba(59,130,246,0.1)',
                  borderRadius: '8px',
                  padding: '8px 10px',
                }}>
                  <div style={{ fontSize: '10px', color: 'rgba(59,130,246,0.7)', fontWeight: 600, marginBottom: '2px' }}>
                    {FIELD_LABELS[k]}
                  </div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fx-text, #111)' }}>
                    {fmt(k, fields[k])}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!rescored ? (
            <button
              style={primaryBtn}
              onClick={handleRescore}
              disabled={rescoring}
            >
              {rescoring ? 'Rescoring…' : '↻ Rescore LRS with statement data'}
            </button>
          ) : (
            <span style={{ fontSize: '12px', color: '#22c55e' }}>
              ✓ LRS rescore triggered — check the LRS panel for updated score
            </span>
          )}
        </div>
      )}

      {/* ── FAILED ───────────────────────────────────────── */}
      {state === 'failed' && (
        <div>
          <p style={{ fontSize: '13px', color: '#ef4444', marginBottom: '10px' }}>
            Statement processing failed. Please generate a new link and try again.
          </p>
          <button style={primaryBtn} onClick={handleInitiate}>
            ↻ Try Again
          </button>
        </div>
      )}

      {error && (
        <p style={{ fontSize: '12px', color: '#ef4444', marginTop: '8px' }}>{error}</p>
      )}
    </div>
  );
}
