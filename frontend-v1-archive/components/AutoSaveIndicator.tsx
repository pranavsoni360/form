'use client';

import { formatDistanceToNow } from 'date-fns';

interface AutoSaveIndicatorProps {
  saving: boolean;
  lastSaved: Date | null;
  offline: boolean;
}

export default function AutoSaveIndicator({ saving, lastSaved, offline }: AutoSaveIndicatorProps) {
  if (offline) {
    return (
      <div className="flex items-center gap-2 text-yellow-600 text-sm">
        <div className="w-2 h-2 rounded-full bg-yellow-600"></div>
        <span>Offline - Changes saved locally</span>
      </div>
    );
  }

  if (saving) {
    return (
      <div className="flex items-center gap-2 text-blue-600 text-sm">
        <div className="animate-spin rounded-full h-3 w-3 border-2 border-blue-600 border-t-transparent"></div>
        <span>Saving...</span>
      </div>
    );
  }

  if (lastSaved) {
    return (
      <div className="flex items-center gap-2 text-green-600 text-sm">
        <div className="w-2 h-2 rounded-full bg-green-600 animate-pulse"></div>
        <span>Saved {formatDistanceToNow(lastSaved, { addSuffix: true })}</span>
      </div>
    );
  }

  return null;
}
