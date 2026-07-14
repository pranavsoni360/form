'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import {
  ChevronDown, ChevronRight, Save, RotateCcw, AlertTriangle,
  CheckCircle2, Loader2, ArrowLeft, Info,
} from 'lucide-react';

// ── Toggle switch (pill style) ──────────────────────────────────────────────
function Toggle({ on, onChange, size = 'md', onColor = '#2563EB' }: {
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
        background: on ? onColor : '#94A3B8',
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
          <tr className="text-left" style={{ color: '#64748B' }}>
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
                    style={{ border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#0F172A' }} />
                </td>
              ))}
              <td className="pb-1">
                <input type="text" value={b.rating || ''}
                  onChange={e => update(i, 'rating', e.target.value)}
                  placeholder="label"
                  className="w-24 px-2 py-1 rounded text-xs outline-none"
                  style={{ border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#0F172A' }} />
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
          <tr className="text-left" style={{ color: '#64748B' }}>
            <th className="pb-1 pr-3 font-medium">Category</th>
            <th className="pb-1 pr-3 font-medium">Score</th>
            <th className="pb-1 font-medium">Rating</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(cats).map(([key, cat]) => (
            <tr key={key}>
              <td className="pr-2 pb-1">
                <span className="text-[11px] font-medium" style={{ color: '#1E293B' }}>
                  {CATEGORY_LABEL_MAP[key] ?? key}
                </span>
                {CATEGORY_LABEL_MAP[key] && (
                  <div className="font-mono text-[9px]" style={{ color: '#94A3B8' }}>{key}</div>
                )}
              </td>
              <td className="pr-2 pb-1">
                <input type="number" value={cat.score}
                  onChange={e => update(key, 'score', e.target.value)}
                  className="w-16 px-2 py-1 rounded text-xs outline-none"
                  style={{ border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#0F172A' }} />
              </td>
              <td className="pb-1">
                <input type="text" value={cat.rating || ''}
                  onChange={e => update(key, 'rating', e.target.value)}
                  placeholder="label"
                  className="w-24 px-2 py-1 rounded text-xs outline-none"
                  style={{ border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#0F172A' }} />
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
        border: `1px solid ${disabled ? 'var(--line)' : '#C9D4E3'}`,
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

        <span className="flex-1 text-sm font-semibold truncate" style={{ color: 'var(--ink)' }}>
          {param.title}
          <span className="ml-2 text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
            style={{ background: 'var(--ground)', color: 'var(--ink-muted)' }}>{param.type}</span>
        </span>

        {/* Weight + effective share */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="w-28">
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
            className="sc-num w-16 text-xs"
          />
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 py-3" style={{ background: 'var(--raised)', borderTop: '1px solid var(--line)' }}>
          {/* Doc required */}
          <div className="flex items-center gap-4 mb-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!!param.doc_required}
                onChange={e => set({ doc_required: e.target.checked })}
                className="rounded" />
              <span className="text-xs font-medium" style={{ color: '#374151' }}>Requires document</span>
            </label>

            {param.doc_required && (
              <>
                <select value={param.doc_field || ''}
                  onChange={e => set({ doc_field: e.target.value })}
                  className="text-xs px-2 py-1 rounded outline-none"
                  style={{ border: '1px solid #CBD5E1', color: '#374151', background: '#F8FAFC' }}>
                  <option value="">— choose field —</option>
                  {DOC_FIELDS.map(d => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>

                <label className="flex items-center gap-1.5 text-xs" style={{ color: '#374151' }}>
                  Max without doc:
                  <input type="number" min="0" max="100" step="1"
                    value={param.no_doc_max_score ?? 95}
                    onChange={e => set({ no_doc_max_score: parseFloat(e.target.value) || 95 })}
                    className="w-14 px-2 py-1 rounded text-xs outline-none"
                    style={{ border: '1px solid #CBD5E1', background: '#fff', color: '#0F172A' }} />
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
              <p className="mb-2 font-medium" style={{ color: '#374151' }}>Sub-parameters</p>
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
                      <span className="flex-1 truncate" style={{ color: '#475569' }}>{child.title}</span>
                      <input type="number" min="0" step="1"
                        value={child.weight} disabled={cDisabled}
                        onChange={e => setChild(ck, { weight: parseFloat(e.target.value) || 0 })}
                        className="w-14 px-2 py-1 rounded text-xs text-right outline-none"
                        style={{ border: '1px solid #CBD5E1', background: cDisabled ? '#F1F5F9' : '#fff', color: '#0F172A' }} />
                      <span className="w-24 text-right text-[10px]"
                        style={{ color: cDisabled ? '#94A3B8' : '#2563EB' }}>
                        {cDisabled ? '(excluded)' : `→ ${cEff.toFixed(1)}% of group`}
                      </span>
                    </div>
                  );
                });
              })()}
              <p className="mt-1.5 italic" style={{ color: '#94A3B8' }}>
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
      {/* Pillar header */}
      <div className="w-full flex items-center gap-3 pr-4 py-3"
        style={{
          background: pillarDisabled ? '#475569' : 'var(--navy-soft)',
          color: '#fff',
          // Weight-share spine: a left rail sized to this pillar's % of 100.
          borderLeft: `4px solid ${pillarDisabled ? 'rgba(255,255,255,0.2)' : '#60A5FA'}`,
          paddingLeft: 'calc(1rem - 4px)',
        }}>
        <button onClick={() => setOpen(v => !v)} className="flex-shrink-0" aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown className="w-4 h-4" style={{ color: 'rgba(255,255,255,0.6)' }} />
                 : <ChevronRight className="w-4 h-4" style={{ color: 'rgba(255,255,255,0.6)' }} />}
        </button>

        {/* Pillar enable/disable toggle */}
        <Toggle on={!pillarDisabled} onColor="#3B82F6"
          onChange={next => onTogglePillar(pillarKey, next)} />

        <button onClick={() => setOpen(v => !v)} className="flex-1 text-left">
          <span className="font-semibold text-sm">{pillar.title}</span>
          {pillarDisabled && <span className="ml-2 text-[10px] font-medium uppercase tracking-wide"
            style={{ color: 'rgba(255,255,255,0.55)' }}>excluded</span>}
        </button>

        <div className="flex items-center gap-3">
          <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums' }}>
            {activeCount}/{totalCount} active
          </span>
          <div className="flex items-center gap-1.5">
            <input type="number" min="0" max="100" step="1"
              value={pillar.weight}
              disabled={pillarDisabled}
              onChange={e => onUpdatePillar(pillarKey, parseFloat(e.target.value) || 0)}
              className="w-14 px-2 py-1 rounded-md text-xs text-right outline-none font-bold"
              style={{ background: 'rgba(255,255,255,0.14)', color: '#fff', border: '1px solid rgba(255,255,255,0.25)', fontVariantNumeric: 'tabular-nums' }} />
            <span className="text-xs" style={{ color: 'rgba(255,255,255,0.45)' }}>/ 100</span>
          </div>
        </div>
      </div>

      {open && (
        <div className="p-4" style={{ background: 'var(--raised)' }}>
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
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  const token = typeof window !== 'undefined' ? getAccessToken('bank') : null;

  useEffect(() => {
    if (!token) { router.push('/bank/login'); return; }
    fetch(`${API_URL}/api/lrs/config`, { headers: { Authorization: `Bearer ${token}` } })
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
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F8FAFC' }}>
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: '#2563EB' }} />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F8FAFC' }}>
        <p className="text-sm" style={{ color: '#EF4444' }}>Failed to load config.</p>
      </div>
    );
  }

  const isDirty = JSON.stringify(config) !== JSON.stringify(original);
  const pillarWeightOk = Math.abs(totalPillarWeight - 100) < 0.5;

  return (
    <div className="min-h-screen sc-root" style={{ background: 'var(--ground)' }}>
      <style dangerouslySetInnerHTML={{ __html: `
        .sc-root {
          --ground: #EEF1F6;
          --surface: #FFFFFF;
          --raised: #F7F9FC;
          --ink: #0B1E3B;
          --ink-muted: #5A6B85;
          --ink-faint: #94A3B8;
          --line: #DBE2EC;
          --accent: #1D4ED8;
          --navy: #071A38;
          --navy-soft: #0D2650;
          --approve: #047857;
          --refer: #B45309;
          --reject: #B91C1C;
          color: var(--ink);
        }
        .sc-card {
          background: var(--surface);
          border: 1px solid var(--line);
          border-radius: 14px;
          box-shadow: 0 1px 2px rgba(11,30,59,0.04);
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
        .sc-num {
          border: 1px solid var(--line); border-radius: 8px; background: var(--surface);
          color: var(--ink); padding: 6px 8px; text-align: right; outline: none;
          font-variant-numeric: tabular-nums; transition: border-color .15s, box-shadow .15s;
        }
        .sc-num:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(29,78,216,0.12); }
        .sc-num:disabled { background: var(--raised); color: var(--ink-faint); }
        /* Decision score track */
        .sc-track { display: flex; height: 12px; border-radius: 6px; overflow: hidden; box-shadow: inset 0 0 0 1px rgba(11,30,59,0.06); }
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
        .sc-toggle:focus-visible { box-shadow: 0 0 0 3px rgba(29,78,216,0.35); }
        .sc-toggle-knob {
          display: block; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.25);
          transition: transform .18s cubic-bezier(.4,.0,.2,1);
        }
        @media (prefers-reduced-motion: reduce) {
          .sc-toggle-knob, .sc-track-zone, .sc-meter-fill, .sc-eff-fill { transition: none; }
        }
      ` }} />

      {/* Top bar */}
      <div className="sticky top-0 z-20 flex items-center gap-3 px-6 py-3"
        style={{ background: '#071A38', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <button onClick={() => router.push('/bank/dashboard')}
          className="flex items-center gap-1.5 text-sm"
          style={{ color: 'rgba(255,255,255,0.55)' }}>
          <ArrowLeft className="w-4 h-4" /> Dashboard
        </button>
        <span style={{ color: 'rgba(255,255,255,0.2)' }}>/</span>
        <span className="text-sm font-semibold text-white">Scorecard Configuration</span>
        <span className="text-xs px-2 py-0.5 rounded font-mono"
          style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.45)' }}>
          {config.config_version}
        </span>

        <div className="flex-1" />

        {isDirty && (
          <button onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm"
            style={{ color: 'rgba(255,255,255,0.6)', background: 'rgba(255,255,255,0.07)' }}>
            <RotateCcw className="w-3.5 h-3.5" /> Discard
          </button>
        )}
        <button onClick={handleSave} disabled={!isDirty || saving || !pillarWeightOk}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded text-sm font-semibold disabled:opacity-40"
          style={{ background: '#2563EB', color: '#fff' }}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg text-sm"
          style={{ background: toast.type === 'ok' ? '#065F46' : '#991B1B', color: '#fff' }}>
          {toast.type === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}

      <div className="max-w-4xl mx-auto px-6 py-6">

        {/* Pillar weight total warning */}
        {!pillarWeightOk && (
          <div className="flex items-start gap-2.5 rounded-xl p-3 mb-4 text-sm"
            style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B' }}>
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            Enabled pillar weights sum to {totalPillarWeight.toFixed(1)} — must equal exactly 100 before saving. Adjust the enabled pillars&apos; weights (disabled pillars are excluded).
          </div>
        )}

        {/* ── Decision thresholds ── */}
        <section className="sc-card mb-5" style={{ padding: '1.25rem 1.35rem' }}>
          <div className="flex items-baseline justify-between mb-1">
            <h2 className="sc-eyebrow">Decision Thresholds</h2>
            <span className="sc-hint">how the score maps to an outcome</span>
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

          <div className="grid grid-cols-2 gap-6">
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
          <h2 className="sc-eyebrow">Pillars &amp; Parameters</h2>
          <div className="flex items-center gap-2.5">
            <div className="sc-meter" title={`${totalPillarWeight.toFixed(1)} of 100`}>
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
        <div className="rounded-xl p-4 text-xs" style={{ background: '#fff', border: '1px solid #E2E8F0', color: '#64748B' }}>
          <p className="font-semibold mb-1" style={{ color: '#374151' }}>How weights work</p>
          <ul className="space-y-1 list-disc list-inside">
            <li>Everything has an <strong>on/off toggle</strong> — whole pillars, parameters, and composite sub-parameters. Turning anything off excludes it and rebalances its siblings.</li>
            <li><strong>Enabled</strong> pillar weights must sum to <strong>100</strong> (disabled pillars are excluded and the rest are rescaled).</li>
            <li>Parameter and sub-parameter weights are <strong>relative</strong> — set any numbers; the enabled ones are auto-rescaled (to the pillar weight, or to 100% within a composite group). The <span style={{ color: '#2563EB' }}>→ effective</span> value shows each one&apos;s real contribution.</li>
            <li>Disabling or re-weighting anything <strong>proportionally rebalances</strong> the rest automatically — no need to make them add up.</li>
            <li>If a parameter requires a document and none was submitted, its score is capped at the configured max (default 95).</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
