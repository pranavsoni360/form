'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import {
  ChevronDown, ChevronRight, Save, RotateCcw, AlertTriangle,
  CheckCircle2, Loader2, ArrowLeft, ToggleLeft, ToggleRight,
  FileText, Info,
} from 'lucide-react';

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
            <th className="pb-1 pr-3 font-medium">Category key</th>
            <th className="pb-1 pr-3 font-medium">Score</th>
            <th className="pb-1 font-medium">Rating</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(cats).map(([key, cat]) => (
            <tr key={key}>
              <td className="pr-2 pb-1">
                <span className="font-mono text-[11px]" style={{ color: '#475569' }}>{key}</span>
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

  return (
    <div className="rounded-lg mb-2 overflow-hidden"
      style={{ border: `1px solid ${disabled ? '#E2E8F0' : '#CBD5E1'}`, opacity: disabled ? 0.55 : 1 }}>
      {/* Header row */}
      <div className="flex items-center gap-3 px-3 py-2.5"
        style={{ background: disabled ? '#F8FAFC' : '#F1F5F9' }}>
        <button onClick={() => setExpanded(v => !v)} className="flex-shrink-0" style={{ color: '#64748B' }}>
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>

        {/* Toggle enable/disable */}
        <button onClick={() => set({ enabled: !disabled })} className="flex-shrink-0">
          {disabled
            ? <ToggleLeft className="w-5 h-5" style={{ color: '#94A3B8' }} />
            : <ToggleRight className="w-5 h-5" style={{ color: '#2563EB' }} />}
        </button>

        <span className="flex-1 text-sm font-medium truncate" style={{ color: '#0F172A' }}>
          {param.title}
          <span className="ml-1.5 text-[10px] font-normal px-1.5 py-0.5 rounded"
            style={{ background: '#E2E8F0', color: '#64748B' }}>{param.type}</span>
        </span>

        {/* Weight */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <input
            type="number" min="0" max="100" step="0.1"
            value={param.weight}
            disabled={disabled}
            onChange={e => set({ weight: parseFloat(e.target.value) || 0 })}
            className="w-16 px-2 py-1 rounded text-xs text-right outline-none"
            style={{ border: '1px solid #CBD5E1', background: disabled ? '#F1F5F9' : '#fff', color: '#0F172A' }}
          />
          <span className="text-[10px] w-20 text-right" style={{ color: '#64748B' }}>
            {disabled ? '(disabled)' : `→ ${effW.toFixed(1)} eff.`}
          </span>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 py-3" style={{ background: '#fff', borderTop: '1px solid #E2E8F0' }}>
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

          {/* Composite: show children summary */}
          {param.type === 'composite' && param.children && (
            <div className="text-xs" style={{ color: '#64748B' }}>
              <p className="mb-1 font-medium">Sub-parameters:</p>
              {Object.entries(param.children).map(([k, child]) => (
                <div key={k} className="flex justify-between py-0.5">
                  <span>{child.title}</span>
                  <span className="font-mono">{child.weight}% composite weight</span>
                </div>
              ))}
              <p className="mt-1 italic" style={{ color: '#94A3B8' }}>Edit composite sub-weights via the JSON view (coming soon).</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PillarCard({
  pillarKey, pillar,
  onUpdatePillar, onUpdateParam,
}: {
  pillarKey: string; pillar: Pillar;
  onUpdatePillar: (key: string, weight: number) => void;
  onUpdateParam: (pk: string, ppk: string, updated: ScoreParam) => void;
}) {
  const [open, setOpen] = useState(true);
  const enabledW = enabledWeightSum(pillar);
  const allW = Object.values(pillar.parameters).reduce((s, p) => s + p.weight, 0);
  const weightOk = Math.abs(enabledW - pillar.weight) < 0.5;

  return (
    <div className="rounded-xl mb-4 overflow-hidden"
      style={{ border: '1px solid #CBD5E1' }}>
      {/* Pillar header */}
      <button className="w-full flex items-center gap-3 px-4 py-3 text-left"
        style={{ background: '#0D2650', color: '#fff' }}
        onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: 'rgba(255,255,255,0.6)' }} />
               : <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'rgba(255,255,255,0.6)' }} />}
        <span className="flex-1 font-semibold text-sm">{pillar.title}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>
            {Object.values(pillar.parameters).filter(p => p.enabled !== false).length}/
            {Object.keys(pillar.parameters).length} active
          </span>
          <div className="flex items-center gap-1.5">
            <input type="number" min="0" max="100" step="1"
              value={pillar.weight}
              onClick={e => e.stopPropagation()}
              onChange={e => { e.stopPropagation(); onUpdatePillar(pillarKey, parseFloat(e.target.value) || 0); }}
              className="w-14 px-2 py-1 rounded text-xs text-right outline-none font-semibold"
              style={{ background: 'rgba(255,255,255,0.15)', color: '#fff', border: '1px solid rgba(255,255,255,0.25)' }} />
            <span className="text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>/ 100</span>
          </div>
        </div>
      </button>

      {!weightOk && open && (
        <div className="flex items-center gap-2 px-4 py-2 text-xs"
          style={{ background: '#FEF3C7', color: '#92400E', borderBottom: '1px solid #FDE68A' }}>
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          Active parameter weights sum to {enabledW.toFixed(1)}, but pillar weight is {pillar.weight}.
          Adjust weights so they match — the engine will rescale, but mismatches may cause unexpected effective weights.
        </div>
      )}

      {open && (
        <div className="p-4" style={{ background: '#F8FAFC' }}>
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
      .then(r => r.json())
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

  const totalPillarWeight = config
    ? Object.values(config.pillars).reduce((s, p) => s + p.weight, 0)
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
    <div className="min-h-screen" style={{ background: '#F1F5F9' }}>

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
            Pillar weights sum to {totalPillarWeight.toFixed(1)} — must equal exactly 100 before saving.
          </div>
        )}

        {/* ── Decision thresholds ── */}
        <section className="rounded-xl p-5 mb-5"
          style={{ background: '#fff', border: '1px solid #CBD5E1' }}>
          <h2 className="text-sm font-bold mb-4" style={{ color: '#0F172A' }}>Decision Thresholds</h2>
          <div className="grid grid-cols-2 gap-6">
            {(['approve', 'refer'] as const).map(key => (
              <div key={key}>
                <label className="block text-xs font-semibold mb-1 uppercase tracking-wide"
                  style={{ color: '#64748B' }}>
                  {key === 'approve' ? 'Approve if score ≥' : 'Refer if score ≥'}
                </label>
                <div className="flex items-center gap-3">
                  <input type="range" min="0" max="100" step="1"
                    value={config.decision_thresholds[key]}
                    onChange={e => updateThreshold(key, parseInt(e.target.value))}
                    className="flex-1 accent-blue-600" />
                  <input type="number" min="0" max="100"
                    value={config.decision_thresholds[key]}
                    onChange={e => updateThreshold(key, parseInt(e.target.value) || 0)}
                    className="w-14 px-2 py-1.5 rounded text-sm font-bold text-right outline-none"
                    style={{ border: '1px solid #CBD5E1', color: '#0F172A' }} />
                </div>
                <p className="text-[11px] mt-1" style={{ color: '#94A3B8' }}>
                  {key === 'approve'
                    ? `Score ≥ ${config.decision_thresholds.approve} → Approved`
                    : `Score ${config.decision_thresholds.refer}–${config.decision_thresholds.approve - 1} → Refer for review`}
                </p>
              </div>
            ))}
          </div>
          <p className="text-[11px] mt-3 flex items-center gap-1" style={{ color: '#94A3B8' }}>
            <Info className="w-3 h-3" />
            Score below {config.decision_thresholds.refer} → Rejected automatically.
          </p>
        </section>

        {/* ── Pillars ── */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold" style={{ color: '#0F172A' }}>Pillars & Parameters</h2>
          <span className="text-xs" style={{ color: pillarWeightOk ? '#16A34A' : '#DC2626' }}>
            Pillar total: {totalPillarWeight.toFixed(1)} / 100
          </span>
        </div>

        {Object.entries(config.pillars).map(([pillarKey, pillar]) => (
          <PillarCard
            key={pillarKey}
            pillarKey={pillarKey}
            pillar={pillar}
            onUpdatePillar={updatePillarWeight}
            onUpdateParam={updateParam}
          />
        ))}

        {/* Legend */}
        <div className="rounded-xl p-4 text-xs" style={{ background: '#fff', border: '1px solid #E2E8F0', color: '#64748B' }}>
          <p className="font-semibold mb-1" style={{ color: '#374151' }}>How weights work</p>
          <ul className="space-y-1 list-disc list-inside">
            <li>Pillar weights must sum to <strong>100</strong>.</li>
            <li>Parameter weights are absolute points — active ones should sum to their pillar weight.</li>
            <li>Disabled parameters are <strong>excluded from scoring</strong>; remaining weights are proportionally scaled at scoring time.</li>
            <li>If a parameter requires a document and none was submitted, its score is capped at the configured max (default 95).</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
