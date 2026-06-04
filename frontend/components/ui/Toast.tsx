'use client';

import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastProps {
  message:   string;
  type?:     ToastType;
  duration?: number;
  onClose:   () => void;
}

const STYLES: Record<ToastType, { container: string; icon: React.ReactNode }> = {
  success: {
    container: 'bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800',
    icon: <CheckCircle className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />,
  },
  error: {
    container: 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800',
    icon: <XCircle className="w-5 h-5 text-red-600 dark:text-red-400" />,
  },
  warning: {
    container: 'bg-yellow-50 border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800',
    icon: <AlertTriangle className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />,
  },
  info: {
    container: 'bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800',
    icon: <Info className="w-5 h-5 text-blue-600 dark:text-blue-400" />,
  },
};

export function Toast({ message, type = 'info', duration = 4000, onClose }: ToastProps) {
  const [visible, setVisible] = useState(true);
  const style = STYLES[type];

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onClose, 300);
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onClose]);

  return (
    <div className={cn(
      'flex items-start gap-3 px-4 py-3 rounded-2xl border shadow-lg',
      'transition-all duration-300',
      visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2',
      style.container
    )}>
      {style.icon}
      <p className="flex-1 text-sm text-gray-700 dark:text-gray-300">{message}</p>
      <button onClick={() => { setVisible(false); setTimeout(onClose, 300); }}>
        <X className="w-4 h-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" />
      </button>
    </div>
  );
}

// Toast container — place in root layout
export function ToastContainer({ toasts, onClose }: {
  toasts: Array<{ id: string; message: string; type: ToastType }>;
  onClose: (id: string) => void;
}) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 w-80">
      {toasts.map(t => (
        <Toast
          key={t.id}
          message={t.message}
          type={t.type}
          onClose={() => onClose(t.id)}
        />
      ))}
    </div>
  );
}