import React from 'react';
import { CpuChipIcon } from '@heroicons/react/24/outline';

export type DongleModel = 'A1' | 'A2';

const MODEL_STORAGE_KEY = 'ntn-dongle-model';

export function loadSavedModel(): DongleModel {
  const saved = localStorage.getItem(MODEL_STORAGE_KEY);
  return saved === 'A1' || saved === 'A2' ? saved : 'A1';
}

interface DongleModelPanelProps {
  model: DongleModel;
  onChange: (model: DongleModel) => void;
}

export const DongleModelPanel: React.FC<DongleModelPanelProps> = ({ model, onChange }) => {
  const handleChange = (m: DongleModel) => {
    localStorage.setItem(MODEL_STORAGE_KEY, m);
    onChange(m);
  };

  return (
    <div className="bg-slate-800/50 p-4 rounded-2xl border border-slate-700 backdrop-blur-sm">
      <div className="flex items-center gap-2 mb-4">
        <div className="p-1.5 bg-blue-600/20 rounded border border-blue-500/30">
          <CpuChipIcon className="w-4 h-4 text-blue-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-white">Dongle Model</h2>
          <p className="text-slate-400 text-xs">Select the hardware model variant</p>
        </div>
      </div>

      <div className="flex gap-2 p-1 bg-slate-900 rounded-lg border border-slate-700">
        {(['A1', 'A2'] as DongleModel[]).map((m) => (
          <button
            key={m}
            onClick={() => handleChange(m)}
            className={`flex-1 py-2.5 rounded text-sm font-bold tracking-wide transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
              model === m
                ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <p className="text-xs text-slate-500 mt-2 text-center">
        Selected: <span className="text-blue-400 font-semibold">{model}</span>
      </p>
    </div>
  );
};
