import React, { useEffect, useState } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { DashboardCard } from './DashboardCard';

type ActiveMode = 0 | 1 | 2 | 3;
const ALL_MODES: ActiveMode[] = [0, 1, 2, 3];
const isSwitchable = (mode: ActiveMode): mode is 0 | 1 => mode === 0 || mode === 1;

interface ActiveModePanelProps {
  currentMode?: ActiveMode;
  isConnected: boolean;
  onApply: (mode: 0 | 1) => Promise<void>;
}

export const ActiveModePanel: React.FC<ActiveModePanelProps> = ({ currentMode, isConnected, onApply }) => {
  const [selectedMode, setSelectedMode] = useState<ActiveMode | undefined>(currentMode);
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
    if (selectedMode === undefined || !isSwitchable(selectedMode)) return;
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

  const modeButtonClass = (mode: ActiveMode) => {
    const isSelected = selectedMode === mode;

    if (!isSwitchable(mode)) {
      return `flex-1 px-3 py-2 rounded-lg font-semibold text-sm cursor-not-allowed ${
        isSelected ? 'bg-slate-700/60 text-slate-300 border border-slate-600' : 'bg-transparent text-slate-600'
      }`;
    }

    if (!isConnected) {
      return 'flex-1 px-3 py-2 rounded-lg font-semibold text-sm transition-all bg-transparent text-slate-600 cursor-not-allowed';
    }

    return `flex-1 px-3 py-2 rounded-lg font-semibold text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
      isSelected
        ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
        : 'bg-transparent text-slate-400 hover:text-slate-200'
    } ${isApplying ? 'opacity-60 cursor-wait' : ''}`;
  };

  const isDirty = selectedMode !== undefined && isSwitchable(selectedMode) && selectedMode !== currentMode;

  return (
    <DashboardCard title="Active Mode" accent="blue">
      <div className="flex gap-2 bg-slate-900 p-1 rounded-lg border border-slate-700">
        {ALL_MODES.map((mode) => (
          <button
            key={mode}
            onClick={isSwitchable(mode) ? () => handleSelect(mode) : undefined}
            disabled={!isSwitchable(mode) || !isConnected || isApplying}
            title={!isSwitchable(mode) ? 'MODE 2/3 are shown for reference only and cannot be selected here' : undefined}
            className={modeButtonClass(mode)}
          >
            MODE {mode}
          </button>
        ))}
      </div>

      <p className="text-xs text-slate-500 mt-2 text-center">
        Only MODE 0 and MODE 1 can be selected. MODE 2 and MODE 3 are shown for reference only.
      </p>

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
