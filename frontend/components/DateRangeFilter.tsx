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
}: {
  value: DateRangeValue;
  onChange: (v: DateRangeValue) => void;
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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => selectPreset(p.key)}
            className={`px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition ${
              value.preset === p.key
                ? 'bg-blue-600 text-white'
                : 'bg-white dark:bg-dark-section border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-blue-400'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {value.preset === 'custom' && (
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">From</label>
          <input
            type="date"
            value={value.from}
            max={value.to || undefined}
            onChange={(e) => setCustom('from', e.target.value)}
            className="px-2 py-1.5 border border-gray-300 dark:border-gray-600 dark:bg-dark-input dark:text-gray-100 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
          />
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">To</label>
          <input
            type="date"
            value={value.to}
            min={value.from || undefined}
            onChange={(e) => setCustom('to', e.target.value)}
            className="px-2 py-1.5 border border-gray-300 dark:border-gray-600 dark:bg-dark-input dark:text-gray-100 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}
    </div>
  );
}
