import { cn } from '@/lib/utils/cn';

interface EmptyStateProps {
  title:       string;
  description?: string;
  icon?:        React.ReactNode;
  action?:      React.ReactNode;
  className?:   string;
}

export default function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn(
      'flex flex-col items-center justify-center py-16 px-6 text-center',
      className
    )}>
      {icon && (
        <div className="mb-4 text-gray-300 dark:text-gray-700">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-gray-700 dark:text-gray-300">
        {title}
      </h3>
      {description && (
        <p className="mt-1 text-sm text-gray-400 dark:text-gray-600 max-w-xs">
          {description}
        </p>
      )}
      {action && (
        <div className="mt-4">
          {action}
        </div>
      )}
    </div>
  );
}