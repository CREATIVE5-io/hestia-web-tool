import React from 'react';
import { CpuChipIcon } from '@heroicons/react/24/outline';

export type DongleModel = 'A1' | 'A2';
export type LoraModuleType = 'single-ch' | '8-ch';

const MODEL_STORAGE_KEY = 'ntn-dongle-model';
const LORA_MODULE_STORAGE_KEY = 'ntn-lora-module';

export function loadSavedModel(): DongleModel {
  const saved = localStorage.getItem(MODEL_STORAGE_KEY);
  return saved === 'A1' || saved === 'A2' ? saved : 'A1';
}

export function loadSavedLoraModule(): LoraModuleType {
  const saved = localStorage.getItem(LORA_MODULE_STORAGE_KEY);
  return saved === '8-ch' ? '8-ch' : 'single-ch';
}

interface DongleModelPanelProps {
  model: DongleModel;
  onChange: (model: DongleModel) => void;
  loraModule: LoraModuleType;
  onLoraModuleChange: (module: LoraModuleType) => void;
  disabled?: boolean;
}

export const DongleModelPanel: React.FC<DongleModelPanelProps> = ({ model, onChange, loraModule, onLoraModuleChange, disabled = false }) => {
  const handleModelChange = (m: DongleModel) => {
    if (disabled) return;
    localStorage.setItem(MODEL_STORAGE_KEY, m);
    onChange(m);
  };

  const handleLoraModuleChange = (m: LoraModuleType) => {
    if (disabled) return;
    localStorage.setItem(LORA_MODULE_STORAGE_KEY, m);
    onLoraModuleChange(m);
  };

  const loraDisabledByModel = model === 'A1';
  const loraDisabled = disabled || loraDisabledByModel;

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

      {/* NTN Dongle row */}
      <div className="mb-3">
        <div className={`text-xs mb-1.5 font-medium uppercase tracking-wider ${disabled ? 'text-slate-600' : 'text-slate-500'}`}>NTN Dongle</div>
        <div className={`flex gap-2 p-1 rounded-lg border ${disabled ? 'bg-slate-900/50 border-slate-700/50' : 'bg-slate-900 border-slate-700'}`}>
          {(['A1', 'A2'] as DongleModel[]).map((m) => (
            <button
              key={m}
              onClick={() => handleModelChange(m)}
              disabled={disabled}
              className={`flex-1 py-2.5 rounded text-sm font-bold tracking-wide transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                disabled
                  ? model === m
                    ? 'bg-blue-600/40 text-slate-500 cursor-not-allowed shadow-none'
                    : 'text-slate-700 cursor-not-allowed'
                  : model === m
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* LoRa Module row */}
      <div>
        <div className={`text-xs mb-1.5 font-medium uppercase tracking-wider ${loraDisabled ? 'text-slate-600' : 'text-slate-500'}`}>
          LoRa Module
        </div>
        <div className={`flex gap-2 p-1 rounded-lg border ${loraDisabled ? 'bg-slate-900/50 border-slate-700/50' : 'bg-slate-900 border-slate-700'}`}>
          {([['single-ch', 'Single CH'], ['8-ch', '8 CHs']] as [LoraModuleType, string][]).map(([m, label]) => (
            <button
              key={m}
              onClick={() => !loraDisabled && handleLoraModuleChange(m)}
              disabled={loraDisabled}
              className={`flex-1 py-2.5 rounded text-sm font-bold tracking-wide transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                loraDisabledByModel
                  ? 'text-slate-700 cursor-not-allowed'
                  : disabled
                  ? loraModule === m
                    ? 'bg-blue-600/40 text-slate-500 cursor-not-allowed shadow-none'
                    : 'text-slate-700 cursor-not-allowed'
                  : loraModule === m
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-slate-500 mt-2 text-center">
        Selected: <span className="text-blue-400 font-semibold">{model}</span>
        {model === 'A2' && (
          <span className="text-purple-400 font-semibold"> · {loraModule === '8-ch' ? '8 CHs' : 'Single CH'}</span>
        )}
      </p>
    </div>
  );
};
