import React, { useEffect, useState } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { DashboardCard } from './DashboardCard';

interface ActiveModePanelProps {
  currentMode?: 0 | 1;
  isConnected: boolean;
  onApply: (mode: 0 | 1) => Promise<void>;
}

export const ActiveModePanel: React.FC<ActiveModePanelProps> = ({ currentMode, isConnected, onApply }) => {
  const [selectedMode, setSelectedMode] = useState<0 | 1 | undefined>(currentMode);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedMode(currentMode);
  }, [currentMode]);

  const handleSelect = (mode: 0 | 1) => {
    if (!isConnected || isApplying) return;
    setError(null);
    setSelectedMode(mode);
  };

  const handleApply = async () => {
    if (selectedMode === undefined) return;
    setError(null);
    setIsApplying(true);
    try {
      await onApply(selectedMode);
    } catch (err) {
      setError('Failed to update Active Mode');
      console.error('Active Mode apply failed:', err);
    } finally {
      setIsApplying(false);
    }
  };

  const modeButtonClass = (mode: 0 | 1) => {
    const isSelected = selectedMode === mode;
    if (!isConnected) {
      return 'flex-1 px-4 py-2 rounded-lg font-semibold text-sm transition-all bg-transparent text-slate-600 cursor-not-allowed';
    }
    return `flex-1 px-4 py-2 rounded-lg font-semibold text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
      isSelected
        ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
        : 'bg-transparent text-slate-400 hover:text-slate-200'
    } ${isApplying ? 'opacity-60 cursor-wait' : ''}`;
  };

  const isDirty = selectedMode !== undefined && selectedMode !== currentMode;

  return (
    <DashboardCard title="Active Mode" accent="blue">
      <div className="flex gap-2 bg-slate-900 p-1 rounded-lg border border-slate-700">
        <button
          onClick={() => handleSelect(0)}
          disabled={!isConnected || isApplying}
          className={modeButtonClass(0)}
        >
          MODE 0
        </button>
        <button
          onClick={() => handleSelect(1)}
          disabled={!isConnected || isApplying}
          className={modeButtonClass(1)}
        >
          MODE 1
        </button>
      </div>

      <button
        onClick={handleApply}
        disabled={!isConnected || !isDirty || isApplying}
        className={`w-full mt-3 px-3 py-2 rounded font-semibold text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
          !isConnected || !isDirty || isApplying
            ? 'bg-slate-700 text-slate-500 cursor-not-allowed focus-visible:ring-slate-600'
            : 'bg-blue-600 text-white hover:bg-blue-500 active:scale-95 focus-visible:ring-blue-500'
        }`}
      >
        {isApplying ? 'Applying...' : 'Apply Mode'}
      </button>

      {!isConnected && (
        <p className="text-xs text-slate-500 mt-2 text-center">Connect to dongle first</p>
      )}

      {error && (
        <p className="text-xs text-red-400 mt-2 text-center">{error}</p>
      )}

      {selectedMode === 1 && (
        <div className="mt-3 bg-orange-900/20 border border-orange-800/50 rounded p-3 flex items-start gap-2">
          <ExclamationTriangleIcon className="w-5 h-5 text-orange-400 shrink-0 mt-0.5" />
          <div className="text-sm text-orange-200">
            MODE 1: the dongle automatically transmits data to the cloud twice, at a 3-minute interval. This will increase data usage on your cellular plan. If data usage is a concern, switch to MODE 0.
          </div>
        </div>
      )}
    </DashboardCard>
  );
};
