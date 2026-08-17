'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { API_URL } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import {
  ChevronDown, ChevronRight, Save, RotateCcw, AlertTriangle,
  CheckCircle2, Loader2, ArrowLeft, Info,
} from 'lucide-react';
import { FinixThemeProvider, Button } from '@/components/finix';

// ── Formula registry ────────────────────────────────────────────────────────
// Keyed by input_key. `formula` is how the raw metric is derived (mirrors the
// backend in normalize.py / decision.py / fn_lrs_*); `scoring` is how the raw
// value maps to a 0–100 sub-score (band/category lookup from this config).
interface FormulaDoc { formula: string; scoring: string; note?: string }

const FORMULAS: Record<string, FormulaDoc> = {
  // ── Credit bureau ──
  credit_score: {
    formula: 'Bureau credit score (CIBIL / Experian), 300–900, taken as reported.',
    scoring: 'Banded: 800–900 → 100, 750–799 → 80, 700–749 → 60, 650–699 → 40, 300–649 → 20.',
  },
  on_time_payment_pct: {
    formula: 'On-time payments ÷ total payments due × 100, from bureau tradeline history.',
    scoring: 'Higher is better: ≥99% → 100, 95–99% → 80, 90–95% → 60, 80–90% → 40, <80% → 20.',
  },
  credit_utilization_pct: {
    formula: 'Total balances ÷ total revolving credit limit × 100.',
    scoring: 'Lower is better: ≤10% → 100, 10–30% → 80, 30–50% → 60, 50–70% → 40, >70% → 20.',
  },
  hard_inquiries_12m: {
    formula: 'Count of hard credit inquiries in the last 12 months.',
    scoring: 'Fewer is better: 0–1 → 100, 2–3 → 80, 4–5 → 60, 6–8 → 40, ≥9 → 20.',
  },
  credit_history_years: {
    formula: 'Age of the oldest active credit account, in years.',
    scoring: 'Longer is better: ≥7y → 100, 4–7y → 80, 2–4y → 60, 1–2y → 40, <1y → 20.',
  },
  public_record_type: {
    formula: 'Worst adverse public record on file (judgment / lien / foreclosure / bankruptcy).',
    scoring: 'Category lookup — none → 100, down to bankruptcy < 7y → 20.',
  },
  // ── Income & affordability ──
  net_monthly_income: {
    formula: 'Net (take-home) monthly income after statutory deductions.',
    scoring: 'Higher is better: >₹60k → 100, ₹40–60k → 80, ₹25–40k → 60, ₹15–25k → 40, <₹15k → 20.',
  },
  new_loan_emi_to_income_pct: {
    formula: 'EMI(requested amount, nominal ROI, tenure) ÷ net monthly income × 100.\nEMI = P·r / (1 − (1+r)⁻ⁿ), r = ROI/1200, n = tenure months.',
    scoring: 'Lower is better: <15% → 100, 15–25% → 80, 25–35% → 60, 35–50% → 40, >50% → 20.',
  },
  employment_type: {
    formula: 'Employment category as declared / verified.',
    scoring: 'Govt/PSU → 100, private MNC → 90, private SME → 70, self-employed stable → 60, irregular → 40, freelancer → 20.',
  },
  job_tenure_years: {
    formula: 'Years in the current job / business.',
    scoring: '>5y → 100, 3–5y → 80, 1–3y → 60, <1y → 40.',
  },
  income_volatility_pct: {
    formula: 'Std deviation of monthly income ÷ mean monthly income × 100 (from bank statements).',
    scoring: 'Lower is better: <10% → 100, 10–25% → 60, >25% → 40.',
  },
  industry_risk_class: {
    formula: 'Risk class of the employer / business industry.',
    scoring: 'Govt/Health/IT/Banking → 100, retail/manufacturing → 70, construction/tourism → 40.',
  },
  // ── Banking behaviour ──
  amb_pct_of_nmi: {
    formula: 'Average monthly balance ÷ net monthly income × 100 (from bank statements).',
    scoring: 'Higher is better: >50% → 100, 30–50% → 80, 20–30% → 60, 10–20% → 40, <10% → 20.',
  },
  otp_ratio_pct: {
    formula: 'On-time loan/EMI payments ÷ total scheduled payments × 100 (statement-derived).',
    scoring: '≥95% → 100, 90–95% → 80, 80–90% → 50, <80% → 20.',
  },
  missed_payment_ratio: {
    formula: 'Missed payments ÷ total scheduled payments.',
    scoring: '0 → 100, ≤0.1 → 60, >0.1 → 20.',
  },
  penalty_count: {
    formula: 'Count of late-payment / cheque-bounce penalties in the statement window.',
    scoring: '0 → 100, 1 → 60, 2–3 → 40, >3 → 20.',
  },
  net_cash_flow: {
    formula: 'Total monthly credits − total monthly debits (avg over statement window).',
    scoring: 'Positive → 100, zero → 60, negative → 20.',
  },
  surplus_income_ratio: {
    formula: '(Net monthly income − total monthly obligations) ÷ net monthly income × 100.',
    scoring: '≥30% → 100, 15–30% → 60, <15% → 20.',
  },
  // ── Profile & identity ──
  employer_reputation_class: {
    formula: 'Reputation tier of the employer.',
    scoring: 'Govt/PSU → 100, MNC → 90, large corporate → 85, SME → 70, startup → 60, … unemployed → 0.',
  },
  job_tenure_stability_pct: {
    formula: 'Current job tenure ÷ total work experience × 100.',
    scoring: '≥50% → 100, <50% → 50.',
  },
  income_cv_pct: {
    formula: 'Coefficient of variation of income = std dev ÷ mean × 100.',
    scoring: 'Lower is better: ≤2% → 100, 2–5% → 80, 5–10% → 60, 10–20% → 40, >20% → 20.',
  },
  age_years: {
    formula: 'Applicant age in years (from date of birth).',
    scoring: 'Prime band 25–55 → 80, 18–24 or 55–65 → 40, outside → 20.',
  },
  education_class: {
    formula: 'Highest education level attained.',
    scoring: 'Postgraduate/professional → 100, graduate/diploma → 70, high-school or below → 40.',
  },
  ownership_class: {
    formula: 'Residence ownership status.',
    scoring: 'Owned (no mortgage) → 100, … PG/hostel → 50, homeless/unknown → 20.',
  },
  years_at_address: {
    formula: 'Years living at the current address.',
    scoring: '>3y → 100, 1–3y → 75, <1y → 50.',
  },
  housing_burden_pct: {
    formula: 'Monthly rent / housing cost ÷ net monthly income × 100.',
    scoring: 'Lower is better: <30% → 100, 30–50% → 70, ≥50% → 40.',
  },
  total_emi_pct_income: {
    formula: 'Existing EMIs ÷ net monthly income × 100.',
    scoring: 'Lower is better: <20% → 100, 20–40% → 75, >40% → 50.',
  },
  active_loans_count: {
    formula: 'Number of currently active loan accounts.',
    scoring: '0–1 → 100, 2–3 → 75, ≥4 → 40.',
  },
  cc_utilization_pct: {
    formula: 'Credit-card balances ÷ credit-card limits × 100.',
    scoring: 'Lower is better: <10% → 100, 10–30% → 75, >30% → 40.',
  },
  dti_pct: {
    formula: 'Debt-to-income = total monthly debt obligations ÷ net monthly income × 100.',
    scoring: 'Lower is better: <30% → 100, 30–50% → 75, >50% → 40.',
  },
};

// ── Info popover ─────────────────────────────────────────────────────────────
function InfoButton({ inputKey, title, doc: docProp }: { inputKey?: string; title: string; doc?: FormulaDoc }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const doc = docProp ?? (inputKey ? FORMULAS[inputKey] : undefined);

  const POP_W = 288;

  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Anchor below the button, centered, clamped to the viewport.
    let left = r.left + r.width / 2 - POP_W / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - POP_W - 10));
    setPos({ top: r.bottom + 8, left });
  }, []);

  const toggle = useCallback(() => {
    setOpen(v => {
      const next = !v;
      if (next) place();
      return next;
    });
  }, [place]);

  // Reposition on scroll/resize while open, and close on outside interaction.
  useEffect(() => {
    if (!open) return;
    const onScrollResize = () => place();
    const onDown = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, place]);

  if (!doc) return null;

  return (
    <span className="sc-info-wrap" onClick={e => e.stopPropagation()}>
      <button ref={btnRef} type="button" className="sc-info-btn"
        aria-label={`How ${title} is calculated`} aria-expanded={open}
        onClick={toggle}>
        <Info className="w-3.5 h-3.5" />
      </button>
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div className="sc-popover" role="tooltip"
          style={{ top: pos.top, left: pos.left, width: POP_W }}
          onClick={e => e.stopPropagation()}>
          <span className="sc-pop-title">{title}</span>
          <span className="sc-pop-label">Formula</span>
          <span className="sc-pop-body">{doc.formula}</span>
          <span className="sc-pop-label">Scoring</span>
          <span className="sc-pop-body">{doc.scoring}</span>
          {doc.note && <span className="sc-pop-note">{doc.note}</span>}
        </div>,
        document.body,
      )}
    </span>
  );
}

// ── Toggle switch (pill style) ──────────────────────────────────────────────
function Toggle({ on, onChange, size = 'md', onColor = 'var(--fx-accent)' }: {
  on: boolean;
  onChange: (next: boolean) => void;
  size?: 'sm' | 'md';
  onColor?: string;
}) {
  const dims = size === 'sm'
    ? { w: 32, h: 18, knob: 12, pad: 3 }
    : { w: 40, h: 22, knob: 16, pad: 3 };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={e => { e.stopPropagation(); onChange(!on); }}
      className="sc-toggle flex-shrink-0"
      style={{
        width: dims.w, height: dims.h, borderRadius: dims.h,
        background: on ? onColor : 'var(--fx-border-strong)',
        padding: dims.pad,
      }}
    >
      <span
        className="sc-toggle-knob"
        style={{
          width: dims.knob, height: dims.knob, borderRadius: '50%',
          transform: on ? `translateX(${dims.w - dims.knob - dims.pad * 2}px)` : 'translateX(0)',
        }}
      />
    </button>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Band { from: number; to: number; score: number; rating?: string; approval?: string }
interface Category { score: number; rating?: string; approval?: string }

interface ScoreParam {
  title: string;
  weight: number;
  type: 'range' | 'category' | 'composite';
  input_key?: string;
  enabled?: boolean;
  doc_required?: boolean;
  doc_field?: string;
  no_doc_max_score?: number;
  bands?: Band[];
  categories?: Record<string, Category>;
  children?: Record<string, ScoreParam>;
}

interface Pillar {
  title: string;
  weight: number;
  source?: string;
  enabled?: boolean;
  parameters: Record<string, ScoreParam>;
}

interface ScorecardConfig {
  config_version: string;
  score_range: [number, number];
  decision_thresholds: { approve: number; refer: number };
  pillars: Record<string, Pillar>;
  [key: string]: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function deepClone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

function enabledParams(pillar: Pillar) {
  return Object.entries(pillar.parameters).filter(([, p]) => p.enabled !== false);
}

function enabledWeightSum(pillar: Pillar) {
  return enabledParams(pillar).reduce((s, [, p]) => s + (p.weight || 0), 0);
}

function effectiveWeight(param: ScoreParam, pillar: Pillar): number {
  const sum = enabledWeightSum(pillar);
  if (sum <= 0 || param.enabled === false) return 0;
  return Math.round((param.weight / sum) * pillar.weight * 10) / 10;
}

const CATEGORY_LABEL_MAP: Record<string, string> = {
  // public records
  'none':                       'No Public Records',
  '__default__':                'Default / Unknown',
  'civil_judgment_gt5':         'Civil Judgment (> 5 yrs)',
  'civil_judgment_lt5':         'Civil Judgment (< 5 yrs)',
  'tax_lien_gt5':               'Tax Lien (> 5 yrs)',
  'tax_lien_lt5':               'Tax Lien (< 5 yrs)',
  'foreclosure_lt5':            'Foreclosure (< 5 yrs)',
  'bankruptcy_lt7':             'Bankruptcy (< 7 yrs)',
  // employment type
  'salaried_govt_psu':          'Govt / PSU Salaried',
  'salaried_private_mnc':       'Private MNC Salaried',
  'salaried_private_small':     'Private SME Salaried',
  'self_employed_stable':       'Self-Employed (Stable)',
  'self_employed_irregular':    'Self-Employed (Irregular)',
  'freelancer':                 'Freelancer',
  // industry risk
  'govt_health_it_banking':     'Govt / Health / IT / Banking',
  'retail_manufacturing':       'Retail / Manufacturing',
  'construction_tourism':       'Construction / Tourism',
  // employer reputation
  'govt_psu':                   'Government / PSU',
  'mnc':                        'MNC',
  'large_corporate':            'Large Corporate',
  'sme':                        'SME',
  'startup':                    'Startup',
  'self_employed_professional': 'Self-Employed Professional',
  'self_employed_business':     'Self-Employed Business',
  'contract_parttime':          'Contract / Part-time',
  'unemployed':                 'Unemployed',
  // education
  'postgraduate_professional':  'Postgraduate / Professional',
  'graduate_diploma':           'Graduate / Diploma',
  'highschool_or_below':        'High School or Below',
  // residential
  'owned_no_mortgage':          'Owned (No Mortgage)',
  'owned_with_mortgage':        'Owned (With Mortgage)',
  'living_with_family':         'Living with Family',
  'rented_long_term':           'Rented (Long-term)',
  'rented_short_term':          'Rented (Short-term)',
  'pg_hostel_temporary':        'PG / Hostel / Temporary',
  'homeless_unknown':           'Homeless / Unknown',
};

const DOC_FIELDS = [
  { value: 'bank_statement_url',  label: 'Bank Statement' },
  { value: 'income_proof_url',    label: 'Income Proof' },
  { value: 'pan_card_url',        label: 'PAN Card' },
  { value: 'aadhaar_front_url',   label: 'Aadhaar (Front)' },
  { value: 'aadhaar_back_url',    label: 'Aadhaar (Back)' },
  { value: 'photo_url',           label: 'Photograph' },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function BandEditor({ bands, onChange }: { bands: Band[]; onChange: (b: Band[]) => void }) {
  const update = (i: number, key: keyof Band, val: string) => {
    const next = deepClone(bands);
    (next[i] as unknown as Record<string, unknown>)[key] = key === 'rating' || key === 'approval' ? val : parseFloat(val) || 0;
    onChange(next);
  };
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-left" style={{ color: 'var(--fx-text3)' }}>
            <th className="pb-1 pr-3 font-medium">From</th>
            <th className="pb-1 pr-3 font-medium">To</th>
            <th className="pb-1 pr-3 font-medium">Score</th>
            <th className="pb-1 font-medium">Rating</th>
          </tr>
        </thead>
        <tbody>
          {bands.map((b, i) => (
            <tr key={i}>
              {(['from', 'to', 'score'] as const).map(k => (
                <td key={k} className="pr-2 pb-1">
                  <input type="number" value={b[k]}
                    onChange={e => update(i, k, e.target.value)}
                    className="w-20 px-2 py-1 rounded text-xs outline-none"
                    style={{ border: 'none', background: 'var(--fx-surface2)', color: 'var(--fx-text)' }} />
                </td>
              ))}
              <td className="pb-1">
                <input type="text" value={b.rating || ''}
                  onChange={e => update(i, 'rating', e.target.value)}
                  placeholder="label"
                  className="w-24 px-2 py-1 rounded text-xs outline-none"
                  style={{ border: 'none', background: 'var(--fx-surface2)', color: 'var(--fx-text)' }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoryEditor({ cats, onChange }: {
  cats: Record<string, Category>;
  onChange: (c: Record<string, Category>) => void;
}) {
  const update = (key: string, field: 'score' | 'rating', val: string) => {
    const next = deepClone(cats);
    if (field === 'score') next[key].score = parseFloat(val) || 0;
    else next[key].rating = val;
    onChange(next);
  };
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-left" style={{ color: 'var(--fx-text3)' }}>
            <th className="pb-1 pr-3 font-medium">Category</th>
            <th className="pb-1 pr-3 font-medium">Score</th>
            <th className="pb-1 font-medium">Rating</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(cats).map(([key, cat]) => (
            <tr key={key}>
              <td className="pr-2 pb-1">
                <span className="text-[11px] font-medium" style={{ color: 'var(--fx-text)' }}>
                  {CATEGORY_LABEL_MAP[key] ?? key}
                </span>
              </td>
              <td className="pr-2 pb-1">
                <input type="number" value={cat.score}
                  onChange={e => update(key, 'score', e.target.value)}
                  className="w-16 px-2 py-1 rounded text-xs outline-none"
                  style={{ border: 'none', background: 'var(--fx-surface2)', color: 'var(--fx-text)' }} />
              </td>
              <td className="pb-1">
                <input type="text" value={cat.rating || ''}
                  onChange={e => update(key, 'rating', e.target.value)}
                  placeholder="label"
                  className="w-24 px-2 py-1 rounded text-xs outline-none"
                  style={{ border: 'none', background: 'var(--fx-surface2)', color: 'var(--fx-text)' }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ParamRow({
  pillarKey, paramKey, param, pillar,
  onUpdate,
}: {
  pillarKey: string; paramKey: string;
  param: ScoreParam; pillar: Pillar;
  onUpdate: (pk: string, ppk: string, updated: ScoreParam) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const disabled = param.enabled === false;
  const effW = effectiveWeight(param, pillar);

  const set = (patch: Partial<ScoreParam>) => onUpdate(pillarKey, paramKey, { ...param, ...patch });

  // Effective bar width relative to the pillar weight (so it reads as share).
  const effPct = pillar.weight > 0 ? Math.min(100, (effW / pillar.weight) * 100) : 0;

  return (
    <div className="mb-2 overflow-hidden"
      style={{
        border: `1px solid ${disabled ? 'var(--line)' : 'var(--fx-border-strong)'}`,
        borderRadius: 10, opacity: disabled ? 0.6 : 1,
        background: 'var(--surface)',
      }}>
      {/* Header row */}
      <div className="flex items-center gap-3 px-3 py-2.5"
        style={{ background: disabled ? 'var(--raised)' : 'var(--surface)' }}>
        <button onClick={() => setExpanded(v => !v)} className="flex-shrink-0" style={{ color: 'var(--ink-faint)' }}
          aria-label={expanded ? 'Collapse' : 'Expand'}>
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>

        {/* Toggle enable/disable */}
        <Toggle on={!disabled} onChange={next => set({ enabled: next })} />

        <span className="flex-1 min-w-0 flex items-center gap-1.5">
          <span className="text-sm font-semibold truncate" style={{ color: 'var(--ink)' }}>{param.title}</span>
          <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0"
            style={{ background: 'var(--ground)', color: 'var(--ink-muted)' }}>{param.type}</span>
          <InfoButton inputKey={param.input_key} title={param.title} />
        </span>

        {/* Weight + effective share */}
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <div className="hidden sm:block w-28">
            <div className="sc-eff-bar">
              <div className="sc-eff-fill" style={{
                width: `${disabled ? 0 : effPct}%`,
                background: disabled ? 'var(--ink-faint)' : 'var(--accent)',
              }} />
            </div>
            <div className="text-[10px] mt-1 text-right" style={{ color: disabled ? 'var(--ink-faint)' : 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>
              {disabled ? 'excluded' : `${effW.toFixed(1)} pts effective`}
            </div>
          </div>
          <input
            type="number" min="0" max="100" step="0.1"
            value={param.weight}
            disabled={disabled}
            onChange={e => set({ weight: parseFloat(e.target.value) || 0 })}
            className="sc-num w-14 text-xs"
          />
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 sm:px-4 py-3" style={{ background: 'var(--raised)', borderTop: '1px solid var(--line)' }}>
          {/* Doc required */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-4 mb-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!!param.doc_required}
                onChange={e => set({ doc_required: e.target.checked })}
                className="rounded" />
              <span className="text-xs font-medium" style={{ color: 'var(--fx-text)' }}>Requires document</span>
            </label>

            {param.doc_required && (
              <>
                <select value={param.doc_field || ''}
                  onChange={e => set({ doc_field: e.target.value })}
                  className="text-xs px-2 py-1 rounded outline-none"
                  style={{ border: 'none', color: 'var(--fx-text)', background: 'var(--fx-surface2)' }}>
                  <option value="">— choose field —</option>
                  {DOC_FIELDS.map(d => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>

                <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--fx-text)' }}>
                  Max without doc:
                  <input type="number" min="0" max="100" step="1"
                    value={param.no_doc_max_score ?? 95}
                    onChange={e => set({ no_doc_max_score: parseFloat(e.target.value) || 95 })}
                    className="w-14 px-2 py-1 rounded text-xs outline-none"
                    style={{ border: 'none', background: 'var(--fx-surface2)', color: 'var(--fx-text)' }} />
                </label>
              </>
            )}
          </div>

          {/* Band editor */}
          {param.type === 'range' && param.bands && (
            <BandEditor bands={param.bands} onChange={bands => set({ bands })} />
          )}

          {/* Category editor */}
          {param.type === 'category' && param.categories && (
            <CategoryEditor cats={param.categories}
              onChange={categories => set({ categories })} />
          )}

          {/* Composite: editable sub-parameters with toggle + weight */}
          {param.type === 'composite' && param.children && (
            <div className="text-xs">
              <p className="mb-2 font-medium" style={{ color: 'var(--fx-text)' }}>Sub-parameters</p>
              {(() => {
                const children = param.children!;
                const enabledSum = Object.values(children)
                  .filter(c => c.enabled !== false)
                  .reduce((s, c) => s + (c.weight || 0), 0);
                const setChild = (ck: string, patch: Partial<ScoreParam>) => {
                  const nextChildren = { ...children, [ck]: { ...children[ck], ...patch } };
                  set({ children: nextChildren });
                };
                return Object.entries(children).map(([ck, child]) => {
                  const cDisabled = child.enabled === false;
                  const cEff = cDisabled || enabledSum <= 0
                    ? 0
                    : Math.round((child.weight / enabledSum) * 100 * 10) / 10;
                  return (
                    <div key={ck} className="flex items-center gap-2 py-1"
                      style={{ opacity: cDisabled ? 0.5 : 1 }}>
                      <Toggle size="sm" on={!cDisabled}
                        onChange={next => setChild(ck, { enabled: next })} />
                      <span className="flex-1 min-w-0 flex items-center gap-1.5">
                        <span className="truncate" style={{ color: 'var(--fx-text2)' }}>{child.title}</span>
                        <InfoButton inputKey={child.input_key} title={child.title} />
                      </span>
                      <input type="number" min="0" step="1"
                        value={child.weight} disabled={cDisabled}
                        onChange={e => setChild(ck, { weight: parseFloat(e.target.value) || 0 })}
                        className="w-14 px-2 py-1 rounded text-xs text-right outline-none"
                        style={{ border: 'none', background: cDisabled ? 'var(--fx-bg)' : 'var(--fx-surface2)', color: 'var(--fx-text)' }} />
                      <span className="hidden sm:inline w-24 text-right text-[10px]"
                        style={{ color: cDisabled ? 'var(--fx-text3)' : 'var(--fx-accent)' }}>
                        {cDisabled ? '(excluded)' : `→ ${cEff.toFixed(1)}% of group`}
                      </span>
                    </div>
                  );
                });
              })()}
              <p className="mt-1.5 italic" style={{ color: 'var(--fx-text3)' }}>
                Sub-weights are relative — enabled ones are rescaled to 100% of this group.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PillarCard({
  pillarKey, pillar,
  onUpdatePillar, onTogglePillar, onUpdateParam,
}: {
  pillarKey: string; pillar: Pillar;
  onUpdatePillar: (key: string, weight: number) => void;
  onTogglePillar: (key: string, enabled: boolean) => void;
  onUpdateParam: (pk: string, ppk: string, updated: ScoreParam) => void;
}) {
  const [open, setOpen] = useState(true);
  const pillarDisabled = pillar.enabled === false;
  const activeCount = Object.values(pillar.parameters).filter(p => p.enabled !== false).length;
  const totalCount = Object.keys(pillar.parameters).length;

  return (
    <div className="sc-card mb-4 overflow-hidden"
      style={{ opacity: pillarDisabled ? 0.65 : 1, borderRadius: 14 }}>
      {/* Pillar header. Was white text on a fixed navy fill; that becomes
          invisible now the fill is a theme surface, so every colour here is a
          token. The accent left rail is kept — it's the weight-share spine. */}
      <div className="w-full flex items-center gap-3 pr-4 py-3"
        style={{
          background: 'var(--fx-surface)',
          color: 'var(--fx-text)',
          // Weight-share spine: a left rail sized to this pillar's % of 100.
          borderLeft: `4px solid ${pillarDisabled ? 'var(--fx-border-strong)' : 'var(--fx-accent)'}`,
          paddingLeft: 'calc(1rem - 4px)',
        }}>
        <button onClick={() => setOpen(v => !v)} className="flex-shrink-0" aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown className="w-4 h-4 text-fx-text3" />
                 : <ChevronRight className="w-4 h-4 text-fx-text3" />}
        </button>

        {/* Pillar enable/disable toggle */}
        <Toggle on={!pillarDisabled} onColor="var(--fx-accent)"
          onChange={next => onTogglePillar(pillarKey, next)} />

        <button onClick={() => setOpen(v => !v)} className="flex-1 text-left">
          <span className="text-[13px] font-medium">{pillar.title}</span>
          {pillarDisabled && <span className="ml-2 text-[10px] font-medium uppercase tracking-wide text-fx-text3">excluded</span>}
        </button>

        <div className="flex items-center gap-2 sm:gap-3">
          <span className="fx-mono hidden text-[11px] text-fx-text3 sm:inline">
            {activeCount}/{totalCount} active
          </span>
          <div className="flex items-center gap-1.5">
            <input type="number" min="0" max="100" step="1"
              value={pillar.weight}
              disabled={pillarDisabled}
              onChange={e => onUpdatePillar(pillarKey, parseFloat(e.target.value) || 0)}
              className="sc-num w-14 text-xs font-medium" />
            <span className="text-xs text-fx-text3">/ 100</span>
          </div>
        </div>
      </div>

      {open && (
        <div className="p-2 sm:p-4" style={{ background: 'var(--raised)' }}>
          {Object.entries(pillar.parameters).map(([ppk, param]) => (
            <ParamRow key={ppk}
              pillarKey={pillarKey} paramKey={ppk}
              param={param} pillar={pillar}
              onUpdate={onUpdateParam} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ScorecardPage() {
  const router = useRouter();
  const [config, setConfig] = useState<ScorecardConfig | null>(null);
  const [original, setOriginal] = useState<ScorecardConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rescoring, setRescoring] = useState(false);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    // Read the token on the client (after mount) so we never redirect on a
    // transient SSR/first-paint null. Only bounce to login if it's truly absent.
    const t = getAccessToken('bank');
    if (!t) { router.push('/bank/login'); return; }
    setToken(t);
    fetch(`${API_URL}/api/lrs/config`, { headers: { Authorization: `Bearer ${t}` } })
      .then(async r => {
        const data = await r.json();
        if (!r.ok || !data || typeof data !== 'object' || !data.pillars) {
          throw new Error(data?.detail || data?.error || 'Invalid scorecard config response');
        }
        return data as ScorecardConfig;
      })
      .then(data => {
        setConfig(deepClone(data));
        setOriginal(deepClone(data));
      })
      .catch(() => setToast({ type: 'err', msg: 'Failed to load scorecard config.' }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const totalPillarWeight = config?.pillars
    ? Object.values(config.pillars)
        .filter(p => p.enabled !== false)
        .reduce((s, p) => s + (p.weight || 0), 0)
    : 0;

  const handleSave = async () => {
    if (!config || !token) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/lrs/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Save failed');
      setOriginal(deepClone(config));
      setToast({ type: 'ok', msg: 'Scorecard saved — new scoring uses this config immediately.' });
    } catch (e: unknown) {
      setToast({ type: 'err', msg: e instanceof Error ? e.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (original) { setConfig(deepClone(original)); }
  };

  // Bulk re-score: applies the saved config to PRE-DECISION applications only
  // (draft / submitted / documents_submitted). Approved/disbursed apps stay
  // frozen. Runs async on the server; returns how many were queued.
  const handleRescorePending = async () => {
    if (!token) return;
    setRescoring(true);
    try {
      const res = await fetch(`${API_URL}/api/lrs/rescore-pending`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Re-score failed');
      setToast({
        type: 'ok',
        msg: `Queued ${data.queued} pending application(s) for re-scoring. Approved / disbursed applications are left unchanged.`,
      });
    } catch (e: unknown) {
      setToast({ type: 'err', msg: e instanceof Error ? e.message : 'Re-score failed' });
    } finally {
      setRescoring(false);
    }
  };

  // Return to the previous in-app screen. Use browser history when we arrived
  // from within the app; otherwise (opened/refreshed directly on this URL, so
  // history has no same-origin entry) fall back to the dashboard — never login.
  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1
        && document.referrer && document.referrer.includes(window.location.host)) {
      router.back();
    } else {
      router.push('/bank/dashboard');
    }
  };

  const updatePillarWeight = useCallback((pillarKey: string, weight: number) => {
    setConfig(prev => {
      if (!prev) return prev;
      const next = deepClone(prev);
      next.pillars[pillarKey].weight = weight;
      return next;
    });
  }, []);

  const togglePillar = useCallback((pillarKey: string, enabled: boolean) => {
    setConfig(prev => {
      if (!prev) return prev;
      const next = deepClone(prev);
      next.pillars[pillarKey].enabled = enabled;
      return next;
    });
  }, []);

  const updateParam = useCallback((pillarKey: string, paramKey: string, updated: ScoreParam) => {
    setConfig(prev => {
      if (!prev) return prev;
      const next = deepClone(prev);
      next.pillars[pillarKey].parameters[paramKey] = updated;
      return next;
    });
  }, []);

  const updateThreshold = (key: 'approve' | 'refer', val: number) => {
    setConfig(prev => {
      if (!prev) return prev;
      const next = deepClone(prev);
      next.decision_thresholds[key] = val;
      return next;
    });
  };

  if (loading) {
    return (
      <FinixThemeProvider>
        <div className="finix-root grid min-h-screen place-items-center">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fx-accent)' }} />
        </div>
      </FinixThemeProvider>
    );
  }

  if (!config) {
    return (
      <FinixThemeProvider>
        <div className="finix-root grid min-h-screen place-items-center">
          <p className="text-[13px]" style={{ color: 'var(--fx-red)' }}>Failed to load config.</p>
        </div>
      </FinixThemeProvider>
    );
  }

  const isDirty = JSON.stringify(config) !== JSON.stringify(original);
  const pillarWeightOk = Math.abs(totalPillarWeight - 100) < 0.5;

  return (
    // finix-root is REQUIRED here, not decorative: the sc-* token block below
    // now reads --fx-* variables, and those are scoped to .finix-root. Without
    // it every sc- token resolves to nothing. The provider supplies the theme
    // because this screen renders its own chrome rather than BankUserShell's.
    <FinixThemeProvider>
    <div className="finix-root sc-root min-h-screen" style={{ background: 'var(--ground)' }}>
      <style dangerouslySetInnerHTML={{ __html: `
        /* FINIX MIGRATION (Job 2): this screen keeps its own sc-* component
           layer — 1,143 lines of deeply nested band/category editors that drive
           real credit decisions, so rewriting them carries regression risk that
           buys nothing visually. Instead every sc- token is REPOINTED at the
           --fx-* layer, so the whole screen picks up the Finix palette and,
           crucially, works in BOTH themes: the values below were hard-coded
           light-only hexes (#FFFFFF surfaces, #0B1E3B ink), which rendered
           unreadable once the shell went dark.
           The sc- names are kept so no markup below has to change. */
        .sc-root {
          --ground: var(--fx-bg);
          --surface: var(--fx-surface);
          --raised: var(--fx-surface2);
          --ink: var(--fx-text);
          --ink-muted: var(--fx-text2);
          --ink-faint: var(--fx-text3);
          --line: var(--fx-border);
          --accent: var(--fx-accent);
          /* The two "navy" tokens were a fixed dark chrome colour used for the
             top bar and pillar headers. On the Finix layer that role is surface,
             which flips correctly per theme. */
          --navy: var(--fx-surface);
          --navy-soft: var(--fx-surface2);
          --approve: var(--fx-green);
          --refer: var(--fx-amber);
          --reject: var(--fx-red);
          color: var(--ink);
        }
        /* Finix cards sit on surface2 with no border — separation by lift. */
        .sc-card {
          background: var(--fx-surface2);
          border: none;
          border-radius: 14px;
        }
        .sc-eyebrow {
          font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
          text-transform: uppercase; color: var(--ink-muted);
        }
        .sc-hint { font-size: 11px; color: var(--ink-faint); line-height: 1.5; }
        .sc-field-label {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
        }
        .sc-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
        /* Match components/finix/Field.tsx Input: no border, surface2 fill,
           accent inset ring on focus, mono figures. */
        .sc-num {
          border: none; border-radius: 8px; background: var(--fx-surface2);
          color: var(--ink); padding: 6px 8px; text-align: right; outline: none;
          font-family: var(--fx-mono, ui-monospace, monospace);
          font-variant-numeric: tabular-nums; transition: box-shadow .15s;
        }
        .sc-num:focus { box-shadow: inset 0 0 0 1px var(--fx-accent); }
        .sc-num:disabled { background: var(--fx-bg); color: var(--ink-faint); }
        /* Decision score track */
        .sc-track { display: flex; height: 12px; border-radius: 6px; overflow: hidden; box-shadow: inset 0 0 0 1px var(--fx-border); }
        .sc-track-zone { transition: width .2s ease; }
        /* Header meter */
        .sc-meter { width: 120px; height: 8px; border-radius: 4px; background: var(--line); overflow: hidden; }
        .sc-meter-fill { height: 100%; border-radius: 4px; transition: width .25s ease, background .25s; }
        /* Effective-weight proportion bar */
        .sc-eff-bar { height: 5px; border-radius: 3px; background: var(--line); overflow: hidden; }
        .sc-eff-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width .2s ease; }
        /* Toggle */
        .sc-toggle {
          position: relative; border: none; cursor: pointer; display: inline-flex; align-items: center;
          transition: background .18s ease; outline: none;
        }
        .sc-toggle:focus-visible { box-shadow: var(--fx-focus); }
        .sc-toggle-knob {
          display: block; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.25);
          transition: transform .18s cubic-bezier(.4,.0,.2,1);
        }
        @media (prefers-reduced-motion: reduce) {
          .sc-toggle-knob, .sc-track-zone, .sc-meter-fill, .sc-eff-fill { transition: none; }
        }
        /* Info popover */
        .sc-info-wrap { position: relative; display: inline-flex; flex-shrink: 0; }
        .sc-info-btn {
          display: inline-flex; align-items: center; justify-content: center;
          width: 18px; height: 18px; border-radius: 50%; border: none; cursor: pointer;
          background: transparent; color: var(--ink-faint); transition: color .15s, background .15s;
        }
        .sc-info-btn:hover { color: var(--accent); background: var(--fx-accent-tint); }
        .sc-info-btn:focus-visible { outline: none; box-shadow: var(--fx-focus); }
        /* NOTE: the popover renders in a document.body portal, OUTSIDE .sc-root,
           so CSS custom properties (--navy etc.) are undefined here. Use literal
           colours only — a var() here resolves to transparent. */
        .sc-popover {
          position: fixed; z-index: 9999; display: flex; flex-direction: column; gap: 3px;
          padding: 12px 13px; border-radius: 10px;
          background: #071A38; color: #ffffff; opacity: 1;
          border: 1px solid #1E3A5F;
          box-shadow: 0 12px 34px rgba(7,26,56,0.45); text-align: left;
          font-weight: 400; text-transform: none; letter-spacing: normal;
          animation: sc-pop-in .12s ease-out;
        }
        @keyframes sc-pop-in {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) { .sc-popover { animation: none; } }
        .sc-pop-title { font-size: 12px; font-weight: 700; margin-bottom: 4px; color: #ffffff; }
        .sc-pop-label {
          font-size: 9px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
          color: #93C5FD; margin-top: 5px;
        }
        .sc-pop-body { font-size: 11.5px; line-height: 1.5; color: rgba(255,255,255,0.92); white-space: pre-line; }
        .sc-pop-note { font-size: 10.5px; line-height: 1.45; color: rgba(255,255,255,0.6); margin-top: 6px; font-style: italic; }
      ` }} />

      {/* Top bar — was a fixed navy chrome bar; now the Finix surface so it
          flips with the theme. Every action and its disabled logic is unchanged. */}
      <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-fx-border px-3 py-3 sm:gap-3 sm:px-6"
        style={{ background: 'var(--fx-surface)' }}>
        <button onClick={goBack}
          className="fx-tap flex flex-shrink-0 items-center gap-1.5 text-[13px] text-fx-text2 hover:text-fx-text">
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">Back</span>
        </button>
        <span className="hidden text-fx-text3 sm:inline">/</span>
        <span className="truncate text-[13px] font-medium text-fx-text">
          <span className="hidden sm:inline">Scorecard configuration</span>
          <span className="sm:hidden">Scorecard</span>
        </span>
        <span className="fx-mono hidden rounded px-2 py-0.5 text-[11px] text-fx-text3 sm:inline"
          style={{ background: 'var(--fx-surface2)' }}>
          {config.config_version}
        </span>

        <div className="flex-1" />

        {isDirty && (
          <Button variant="quiet" onClick={handleReset} className="flex-shrink-0">
            <RotateCcw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Discard</span>
          </Button>
        )}
        <Button
          variant="quiet"
          onClick={handleRescorePending}
          disabled={isDirty || saving || rescoring}
          title={isDirty ? 'Save the scorecard first, then re-score' : 'Re-score draft/submitted applications with the saved config (approved/disbursed untouched)'}
          className="flex-shrink-0"
        >
          {rescoring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">{rescoring ? 'Re-scoring…' : 'Re-score pending'}</span>
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={!isDirty || saving || !pillarWeightOk}
          className="flex-shrink-0"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">{saving ? 'Saving…' : 'Save changes'}</span>
        </Button>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed left-1/2 top-16 z-50 flex -translate-x-1/2 items-center gap-2 rounded-[10px] px-4 py-2.5 text-[13px]"
          style={{
            background: 'var(--fx-surface)',
            boxShadow: `var(--fx-elevation), inset 0 0 0 1px var(--fx-${toast.type === 'ok' ? 'green' : 'red'})`,
            color: `var(--fx-${toast.type === 'ok' ? 'green' : 'red'})`,
          }}
          role="status"
        >
          {toast.type === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}

      <div className="max-w-4xl mx-auto px-3 sm:px-6 py-4 sm:py-6">

        {/* Pillar weight total warning */}
        {!pillarWeightOk && (
          <div className="mb-4 flex items-start gap-2.5 rounded-[10px] p-3 text-[13px]"
            style={{ background: 'var(--fx-red-tint)', color: 'var(--fx-red)' }}>
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            Enabled pillar weights sum to {totalPillarWeight.toFixed(1)} — must equal exactly 100 before saving. Adjust the enabled pillars&apos; weights (disabled pillars are excluded).
          </div>
        )}

        {/* ── How scoring works (transparency) ── */}
        <section className="sc-card mb-5" style={{ padding: '1rem' }}>
          <div className="flex flex-wrap items-baseline justify-between gap-1 mb-2">
            <h2 className="sc-eyebrow">How Scoring Works</h2>
            <span className="sc-hint hidden sm:inline">what your edits change</span>
          </div>
          <p style={{ color: 'var(--ink-muted)', fontSize: '.82rem', lineHeight: 1.6, margin: '0 0 .6rem' }}>
            Each applicant earns a <b style={{ color: 'var(--ink)' }}>0–100 score</b>. Every parameter maps its value to a
            0–100 sub-score via its bands (tap the info icon on any parameter to see its exact bands), then rolls up by weight:
          </p>
          <code style={{ display: 'block', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '.8rem',
            background: 'var(--ground, rgba(0,0,0,.03))', border: '1px solid var(--line, rgba(0,0,0,.08))',
            borderRadius: '8px', padding: '.6rem .8rem', color: 'var(--ink)', overflowX: 'auto' }}>
            Total = Σ ( parameter_score × weight ÷ 100 )
          </code>
          <p style={{ color: 'var(--ink-muted)', fontSize: '.82rem', lineHeight: 1.6, margin: '.6rem 0 0' }}>
            The total drives a <b style={{ color: 'var(--ink)' }}>decision</b> (thresholds below), then a risk-based
            <b style={{ color: 'var(--ink)' }}> interest rate</b> and a <b style={{ color: 'var(--ink)' }}>loan offer</b>
            {' '}(amount / tenure / EMI, from the applicant&apos;s income &amp; repayment capacity). The full per-applicant
            {' '}&ldquo;why this score&rdquo; breakdown appears on each application&apos;s <b style={{ color: 'var(--ink)' }}>LRS Credit Assessment</b> panel.
          </p>
          <p style={{ color: 'var(--ink-muted)', fontSize: '.72rem', opacity: .8, margin: '.6rem 0 0' }}>
            Saving here changes scoring for <b>new</b> and <b>re-scored</b> applications only — existing scores stay frozen until re-run.
          </p>
        </section>

        {/* ── Decision thresholds ── */}
        <section className="sc-card mb-5" style={{ padding: '1rem' }}>
          <div className="flex flex-wrap items-baseline justify-between gap-1 mb-1">
            <h2 className="sc-eyebrow">Decision Thresholds</h2>
            <span className="sc-hint hidden sm:inline">how the score maps to an outcome</span>
          </div>

          {/* Visual score track: reject | refer | approve zones */}
          <div className="mt-4 mb-5">
            <div className="sc-track" role="img"
              aria-label={`Reject below ${config.decision_thresholds.refer}, refer ${config.decision_thresholds.refer} to ${config.decision_thresholds.approve - 1}, approve ${config.decision_thresholds.approve} and above`}>
              <div className="sc-track-zone" style={{ width: `${config.decision_thresholds.refer}%`, background: 'var(--reject)' }} />
              <div className="sc-track-zone" style={{ width: `${config.decision_thresholds.approve - config.decision_thresholds.refer}%`, background: 'var(--refer)' }} />
              <div className="sc-track-zone" style={{ width: `${100 - config.decision_thresholds.approve}%`, background: 'var(--approve)' }} />
            </div>
            <div className="flex justify-between mt-1.5 sc-hint" style={{ fontVariantNumeric: 'tabular-nums' }}>
              <span>0</span><span>50</span><span>100</span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
            {(['approve', 'refer'] as const).map(key => (
              <div key={key}>
                <label className="sc-field-label" style={{ color: key === 'approve' ? 'var(--approve)' : 'var(--refer)' }}>
                  <span className="sc-dot" style={{ background: key === 'approve' ? 'var(--approve)' : 'var(--refer)' }} />
                  {key === 'approve' ? 'Approve if score ≥' : 'Refer if score ≥'}
                </label>
                <div className="flex items-center gap-3 mt-1.5">
                  <input type="range" min="0" max="100" step="1"
                    value={config.decision_thresholds[key]}
                    onChange={e => updateThreshold(key, parseInt(e.target.value))}
                    className="flex-1"
                    style={{ accentColor: key === 'approve' ? 'var(--approve)' : 'var(--refer)' }} />
                  <input type="number" min="0" max="100"
                    value={config.decision_thresholds[key]}
                    onChange={e => updateThreshold(key, parseInt(e.target.value) || 0)}
                    className="sc-num w-16 font-bold" style={{ fontSize: '0.95rem' }} />
                </div>
                <p className="sc-hint mt-1.5">
                  {key === 'approve'
                    ? `${config.decision_thresholds.approve} and above → Approved`
                    : `${config.decision_thresholds.refer}–${config.decision_thresholds.approve - 1} → Refer for review`}
                </p>
              </div>
            ))}
          </div>
          <p className="sc-hint mt-3 flex items-center gap-1.5">
            <Info className="w-3 h-3" style={{ color: 'var(--reject)' }} />
            Below {config.decision_thresholds.refer} → Rejected automatically.
          </p>
        </section>

        {/* ── Pillars ── */}
        <div className="flex items-center justify-between mb-3">
          <span className="flex items-center gap-1.5">
            <h2 className="sc-eyebrow">Pillars &amp; Parameters</h2>
            <InfoButton title="How the final score is built"
              doc={{
                formula:
                  'Each parameter → 0–100 sub-score via its band/category.\n' +
                  'Pillar score = Σ(param sub-score × param weight) ÷ Σ(param weight).\n' +
                  'Final score = Σ(pillar score × pillar weight) ÷ Σ(pillar weight).',
                scoring:
                  'Only enabled items count; weights of the rest are rescaled proportionally. ' +
                  'Missing-data pillars are dropped and remaining pillar weights renormalise to 100.',
                note: 'A parameter needing a document but missing it is capped at its no-doc max (default 95).',
              }} />
          </span>
          <div className="flex items-center gap-2.5">
            <div className="sc-meter hidden sm:block" title={`${totalPillarWeight.toFixed(1)} of 100`}>
              <div className="sc-meter-fill"
                style={{
                  width: `${Math.min(100, totalPillarWeight)}%`,
                  background: pillarWeightOk ? 'var(--approve)' : 'var(--refer)',
                }} />
            </div>
            <span className="text-xs font-semibold" style={{ color: pillarWeightOk ? 'var(--approve)' : 'var(--refer)', fontVariantNumeric: 'tabular-nums' }}>
              {totalPillarWeight.toFixed(0)} / 100
            </span>
          </div>
        </div>

        {Object.entries(config.pillars).map(([pillarKey, pillar]) => (
          <PillarCard
            key={pillarKey}
            pillarKey={pillarKey}
            pillar={pillar}
            onUpdatePillar={updatePillarWeight}
            onTogglePillar={togglePillar}
            onUpdateParam={updateParam}
          />
        ))}

        {/* Legend */}
        <div className="sc-card p-4 text-[12px] text-fx-text2">
          <p className="mb-1 font-medium text-fx-text">How weights work</p>
          <ul className="list-inside list-disc space-y-1">
            <li>Everything has an <strong>on/off toggle</strong> — whole pillars, parameters, and composite sub-parameters. Turning anything off excludes it and rebalances its siblings.</li>
            <li><strong>Enabled</strong> pillar weights must sum to <strong>100</strong> (disabled pillars are excluded and the rest are rescaled).</li>
            <li>Parameter and sub-parameter weights are <strong>relative</strong> — set any numbers; the enabled ones are auto-rescaled (to the pillar weight, or to 100% within a composite group). The <span style={{ color: 'var(--fx-accent)' }}>→ effective</span> value shows each one&apos;s real contribution.</li>
            <li>Disabling or re-weighting anything <strong>proportionally rebalances</strong> the rest automatically — no need to make them add up.</li>
            <li>If a parameter requires a document and none was submitted, its score is capped at the configured max (default 95).</li>
          </ul>
        </div>
      </div>
    </div>
    </FinixThemeProvider>
  );
}
