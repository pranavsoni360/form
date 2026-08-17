'use client';

// Reusable date-range filter used across the bank portal (Call Logs, Batch
// Calling, Dashboard). Presets Today / Yesterday / Last 7 / Last 30 / Custom,
// plus "All" (no filter) so pages keep their default full view until a range is
// picked. Emits YYYY-MM-DD `from`/`to` (both inclusive) — empty strings mean an
// open/absent bound, which callers translate to omitted date_from/date_to.

export type RangePreset = 'all' | 'today' | 'yesterday' | 'last7' | 'last30' | 'custom';

export type DateRangeValue = { preset: RangePreset; from: string; to: string };

export const DEFAULT_RANGE: DateRangeValue = { preset: 'all', from: '', to: '' };

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Resolve a preset into an inclusive {from, to} pair in LOCAL calendar days.
// last7 / last30 are inclusive of today (6 / 29 days back → 7 / 30 days total).
export function rangeForPreset(preset: RangePreset, from = '', to = ''): { from: string; to: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t = ymd(today);
  const minus = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return ymd(d);
  };
  switch (preset) {
    case 'today':     return { from: t, to: t };
    case 'yesterday': return { from: minus(1), to: minus(1) };
    case 'last7':     return { from: minus(6), to: t };
    case 'last30':    return { from: minus(29), to: t };
    case 'custom':    return { from, to };
    case 'all':
    default:          return { from: '', to: '' };
  }
}

const PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 Days' },
  { key: 'last30', label: 'Last 30 Days' },
  { key: 'custom', label: 'Custom' },
];

export default function DateRangeFilter({
  value,
  onChange,
  /**
   * Render with the Finix token palette instead of the legacy Tailwind one.
   *
   * This component is shared by migrated screens (/bank/dashboard, /bank/calls)
   * and not-yet-migrated ones (/bank/batch). Its legacy look — white pills with
   * a saturated blue active state — reads as foreign inside a Finix shell and is
   * outright broken on the dark palette. Rather than fork the component (which
   * would duplicate the date maths that callers depend on), the presentation
   * switches and every date behaviour stays shared.
   *
   * Remove the flag once /bank/batch is migrated and make Finix the only style.
   */
  finix = false,
}: {
  value: DateRangeValue;
  onChange: (v: DateRangeValue) => void;
  finix?: boolean;
}) {
  const selectPreset = (preset: RangePreset) => {
    if (preset === 'custom') {
      // Seed the custom inputs with today if nothing is set yet.
      const seed = rangeForPreset('today');
      onChange({ preset, from: value.from || seed.from, to: value.to || seed.to });
    } else {
      const r = rangeForPreset(preset);
      onChange({ preset, from: r.from, to: r.to });
    }
  };

  const setCustom = (field: 'from' | 'to', v: string) => {
    onChange({ ...value, preset: 'custom', [field]: v });
  };

  // Finix: 30px quiet chips matching FilterPills/PeriodChip, active = accent
  // ring on surface2. Date inputs use the mono face like every other Finix
  // figure, and color-scheme is inherited so the native picker matches.
  const presetClass = (active: boolean) =>
    finix
      ? `fx-tap inline-flex h-[30px] items-center whitespace-nowrap rounded-[10px] px-3 text-[12px] transition-colors ${
          active
            ? 'bg-fx-surface2 text-fx-text shadow-[inset_0_0_0_1px_var(--fx-accent)]'
            : 'text-fx-text2 hover:bg-fx-surface2 hover:text-fx-text'
        }`
      : `px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition ${
          active
            ? 'bg-blue-600 text-white'
            : 'bg-white dark:bg-dark-section border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-blue-400'
        }`;

  const labelClass = finix
    ? 'text-[11px] text-fx-text3'
    : 'text-xs font-medium text-gray-500 dark:text-gray-400';

  const inputClass = finix
    ? 'fx-mono rounded-[10px] bg-fx-surface2 px-2 py-1.5 text-[12px] text-fx-text outline-none focus:shadow-[inset_0_0_0_1px_var(--fx-accent)]'
    : 'px-2 py-1.5 border border-gray-300 dark:border-gray-600 dark:bg-dark-input dark:text-gray-100 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="flex flex-col gap-2">
      <div className={finix ? 'flex gap-1.5 overflow-x-auto' : 'flex gap-2 overflow-x-auto pb-1'}>
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => selectPreset(p.key)}
            aria-pressed={value.preset === p.key}
            className={presetClass(value.preset === p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {value.preset === 'custom' && (
        <div className="flex items-center gap-2 flex-wrap">
          <label className={labelClass}>From</label>
          <input
            type="date"
            value={value.from}
            max={value.to || undefined}
            onChange={(e) => setCustom('from', e.target.value)}
            className={inputClass}
          />
          <label className={labelClass}>To</label>
          <input
            type="date"
            value={value.to}
            min={value.from || undefined}
            onChange={(e) => setCustom('to', e.target.value)}
            className={inputClass}
          />
        </div>
      )}
    </div>
  );
}
