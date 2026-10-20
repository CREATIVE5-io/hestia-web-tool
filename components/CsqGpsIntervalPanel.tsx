import React, { useEffect, useState } from 'react';
import { DashboardCard } from './DashboardCard';
import { CSQ_GPS_INTERVAL_OPTIONS, getCsqGpsIntervalLabel } from '../types';

interface CsqGpsIntervalPanelProps {
  currentValue?: number;
  isConnected: boolean;
  onApply: (value: number) => Promise<void>;
}

export const CsqGpsIntervalPanel: React.FC<CsqGpsIntervalPanelProps> = ({ currentValue, isConnected, onApply }) => {
  const [selectedValue, setSelectedValue] = useState<number | undefined>(currentValue);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedValue(currentValue);
  }, [currentValue]);

  const handleApply = async () => {
    if (selectedValue === undefined) return;
    setError(null);
    setIsApplying(true);
    try {
      await onApply(selectedValue);
    } catch (err) {
      setError('Failed to update CSQ/GPS interval');
      console.error('CSQ/GPS interval apply failed:', err);
    } finally {
      setIsApplying(false);
    }
  };

  const isDirty = selectedValue !== undefined && selectedValue !== currentValue;

  return (
    <DashboardCard title="CSQ/GPS Refresh Interval" accent="blue">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-slate-400">Current</span>
        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-200">
          {getCsqGpsIntervalLabel(currentValue)}
        </span>
      </div>

      <select
        value={selectedValue ?? ''}
        onChange={(e) => { setError(null); setSelectedValue(Number(e.target.value)); }}
        disabled={!isConnected || isApplying}
        className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:text-slate-600 disabled:cursor-not-allowed"
      >
        {selectedValue === undefined && <option value="" disabled>Select interval...</option>}
        {CSQ_GPS_INTERVAL_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      <p className="text-xs text-slate-500 mt-2 text-center">
        How often the dongle refreshes RSRP/SINR (and GPS) from the NTN module. Signal is polled at the same rate. Saved to dongle EEPROM.
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
        {isApplying ? 'Applying...' : 'Apply Interval'}
      </button>

      {!isConnected && (
        <p className="text-xs text-slate-500 mt-2 text-center">Connect to dongle first</p>
      )}

      {error && (
        <p className="text-xs text-red-400 mt-2 text-center">{error}</p>
      )}
    </DashboardCard>
  );
};
