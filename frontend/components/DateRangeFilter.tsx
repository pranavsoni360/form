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

  // 30px quiet chips matching FilterPills/PeriodChip, active = accent ring on
  // surface2. Date inputs use the mono face like every other Finix figure, and
  // color-scheme is inherited so the native picker matches the palette.
  //
  // This was briefly dual-styled behind a `finix` flag while /bank/batch was
  // still on the legacy design. All three callers (/bank/dashboard, /bank/calls,
  // /bank/batch) are now migrated, so the flag is gone and Finix is the only
  // style. Any future caller gets it automatically.
  const presetClass = (active: boolean) =>
    `fx-tap inline-flex h-[30px] items-center whitespace-nowrap rounded-[10px] px-3 text-[12px] transition-colors ${
      active
        ? 'bg-fx-surface2 text-fx-text shadow-[inset_0_0_0_1px_var(--fx-accent)]'
        : 'text-fx-text2 hover:bg-fx-surface2 hover:text-fx-text'
    }`;

  const labelClass = 'text-[11px] text-fx-text3';

  const inputClass =
    'fx-mono rounded-[10px] bg-fx-surface2 px-2 py-1.5 text-[12px] text-fx-text outline-none focus:shadow-[inset_0_0_0_1px_var(--fx-accent)]';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1.5 overflow-x-auto">
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
