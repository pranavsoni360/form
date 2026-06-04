import { cn } from '@/lib/utils/cn';

interface DataCardProps {
  title:      string;
  value:      string | number;
  subtitle?:  string;
  icon?:      React.ReactNode;
  trend?:     { value: number; label: string };
  accent?:    'blue' | 'green' | 'red' | 'purple' | 'orange';
  className?: string;
}

const ACCENT_STYLES = {
  blue:   { bg: 'rgba(37,99,235,0.08)',  icon: '#2563EB', border: 'rgba(37,99,235,0.15)'  },
  green:  { bg: 'rgba(5,150,105,0.08)',  icon: '#059669', border: 'rgba(5,150,105,0.15)'  },
  red:    { bg: 'rgba(220,38,38,0.08)',  icon: '#DC2626', border: 'rgba(220,38,38,0.15)'  },
  purple: { bg: 'rgba(124,58,237,0.08)', icon: '#7C3AED', border: 'rgba(124,58,237,0.15)' },
  orange: { bg: 'rgba(234,88,12,0.08)',  icon: '#EA580C', border: 'rgba(234,88,12,0.15)'  },
};

export default function DataCard({
  title,
  value,
  subtitle,
  icon,
  trend,
  accent = 'blue',
  className,
}: DataCardProps) {
  const a = ACCENT_STYLES[accent];
  const trendPositive = trend && trend.value >= 0;

  return (
    <div
      className={cn('rounded-2xl p-5 transition-all duration-200 hover:shadow-md', className)}
      style={{
        background:   'var(--bg-card)',
        border:       '1px solid var(--border)',
        boxShadow:    'var(--shadow-sm)',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider truncate"
            style={{ color: 'var(--text-muted)', letterSpacing: '0.07em' }}>
            {title}
          </p>
          <p className="text-2xl font-bold mt-1.5 tabular-nums"
            style={{ color: 'var(--text-primary)', fontFamily: 'Plus Jakarta Sans' }}>
            {value}
          </p>
          {subtitle && (
            <p className="text-xs mt-1 truncate" style={{ color: 'var(--text-muted)' }}>
              {subtitle}
            </p>
          )}
          {trend && (
            <p className={cn('text-xs font-semibold mt-2 flex items-center gap-1')}
              style={{ color: trendPositive ? '#059669' : '#DC2626' }}>
              <span>{trendPositive ? '↑' : '↓'}</span>
              <span>{Math.abs(trend.value)}% {trend.label}</span>
            </p>
          )}
        </div>
        {icon && (
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: a.bg, color: a.icon, border: `1px solid ${a.border}` }}>
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}