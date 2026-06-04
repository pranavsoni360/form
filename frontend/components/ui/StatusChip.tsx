'use client';

import { getStatusColor, getStatusLabel, getSuggestionColor } from '@/lib/utils/statusConfig';
import { cn } from '@/lib/utils/cn';

interface StatusChipProps {
  status:    string;
  type?:     'application' | 'suggestion';
  size?:     'sm' | 'md';
  className?: string;
}

export default function StatusChip({
  status,
  type      = 'application',
  size      = 'md',
  className,
}: StatusChipProps) {
  const color = type === 'suggestion'
    ? getSuggestionColor(status)
    : getStatusColor(status);

  const label = type === 'suggestion'
    ? status.charAt(0).toUpperCase() + status.slice(1)
    : getStatusLabel(status);

  return (
    <span
      className={cn(
        'inline-flex items-center font-medium rounded-full',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm',
        color,
        className
      )}
    >
      {label}
    </span>
  );
}