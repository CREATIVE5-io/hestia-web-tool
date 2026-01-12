import React, { useState, useEffect } from 'react';
import { NTNConfig } from '../types';
import { CogIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';

interface ConfigPanelProps {
  onApplyConfig: (config: NTNConfig) => Promise<void>;
  isConnected: boolean;
  configApplied?: boolean;
}

const CONFIG_STORAGE_KEY = 'ntn-dongle-config';

export const ConfigPanel: React.FC<ConfigPanelProps> = ({ 
  onApplyConfig, 
  isConnected
}) => {
  const [config, setConfig] = useState<NTNConfig>({
    apn: '',
    remoteIp: '',
    remotePort: '',
    localPort: '55001'
  });
  const [isApplying, setIsApplying] = useState(false);
  const [showReconnectPrompt, setShowReconnectPrompt] = useState(false);
  const [useDefault, setUseDefault] = useState(false);
  const [savedConfig, setSavedConfig] = useState<NTNConfig | null>(null);

  // Load saved config on mount
  useEffect(() => {
    const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (saved) {
      try {
        const parsedConfig = JSON.parse(saved);
        setSavedConfig(parsedConfig);
        if (!useDefault) {
          setConfig(parsedConfig);
        }
      } catch (e) {
        console.warn('Failed to load saved config');
      }
    }
  }, [useDefault]);

  const saveConfig = (newConfig: NTNConfig) => {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(newConfig));
  };

  const handleDefaultToggle = (checked: boolean) => {
    setUseDefault(checked);
    if (checked) {
      setConfig({
        apn: '',
        remoteIp: '',
        remotePort: '',
        localPort: '55001'
      });
    } else if (savedConfig) {
      setConfig(savedConfig);
    }
  };

  const handleApply = async () => {
    if (!useDefault && (!config.apn || !config.remoteIp || !config.remotePort)) {
      alert('Please fill in APN, Remote IP, and Remote Port');
      return;
    }

    setIsApplying(true);
    try {
      await onApplyConfig(config);
      if (!useDefault) {
        saveConfig(config);
      }
      setShowReconnectPrompt(true);
    } catch (error) {
      console.error('Config apply failed:', error);
    } finally {
      setIsApplying(false);
    }
  };

  const isFormValid = useDefault || (config.apn && config.remoteIp && config.remotePort);

  return (
    <div className="bg-slate-800/50 p-4 rounded-2xl border border-slate-700 backdrop-blur-sm">
      <div className="flex items-center gap-2 mb-4">
        <div className="p-1.5 bg-orange-600/20 rounded border border-orange-500/30">
          <CogIcon className="w-4 h-4 text-orange-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-white">NTN Configuration</h2>
          <p className="text-slate-400 text-xs">Configure APN and connection settings</p>
        </div>
      </div>

      {showReconnectPrompt && (
        <div className="mb-4 bg-yellow-900/20 border border-yellow-800/50 rounded p-3 flex items-start gap-2">
          <ExclamationTriangleIcon className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" />
          <div className="text-xs text-yellow-200">
            <strong className="block mb-1">Configuration Applied!</strong>
            Please unplug the NTN dongle and plug it back in to apply the new settings, then reconnect.
          </div>
        </div>
      )}

      <div className="mb-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={useDefault}
            onChange={(e) => handleDefaultToggle(e.target.checked)}
            className="rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-xs text-slate-300">Use Default APN Settings</span>
        </label>
      </div>

      <div className="space-y-3 mb-4">
        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            APN <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={config.apn}
            onChange={(e) => setConfig(prev => ({ ...prev, apn: e.target.value }))}
            className={`w-full border border-slate-600 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 focus:border-transparent ${
              useDefault ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-slate-900 text-white'
            }`}
            placeholder="e.g., internet"
            disabled={isApplying || useDefault}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Remote IP <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={config.remoteIp}
            onChange={(e) => setConfig(prev => ({ ...prev, remoteIp: e.target.value }))}
            className={`w-full border border-slate-600 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 focus:border-transparent ${
              useDefault ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-slate-900 text-white'
            }`}
            placeholder="192.168.1.100"
            disabled={isApplying || useDefault}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Remote Port <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={config.remotePort}
              onChange={(e) => setConfig(prev => ({ ...prev, remotePort: e.target.value }))}
              className={`w-full border border-slate-600 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 focus:border-transparent ${
                useDefault ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-slate-900 text-white'
              }`}
              placeholder="8080"
              disabled={isApplying || useDefault}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Local Port
            </label>
            <input
              type="text"
              value={config.localPort || ''}
              onChange={(e) => setConfig(prev => ({ ...prev, localPort: e.target.value }))}
              className={`w-full border border-slate-600 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 focus:border-transparent ${
                useDefault ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-slate-900 text-white'
              }`}
              placeholder="55001"
              disabled={isApplying || useDefault}
            />
          </div>
        </div>
      </div>

      <button
        onClick={handleApply}
        disabled={!isConnected || !isFormValid || isApplying}
        className={`w-full px-3 py-2 rounded font-semibold text-sm transition-all ${
          !isConnected || !isFormValid || isApplying
            ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
            : 'bg-orange-600 text-white hover:bg-orange-500 active:scale-95'
        }`}
      >
        {isApplying ? 'Applying...' : 'Apply Configuration'}
      </button>

      {!isConnected && (
        <p className="text-xs text-slate-500 mt-2 text-center">
          Connect to dongle first
        </p>
      )}
    </div>
  );
};