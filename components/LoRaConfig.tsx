import React, { useState, useEffect } from 'react';
import {
  PlusIcon,
  TrashIcon,
  Cog8ToothIcon,
  CpuChipIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
} from '@heroicons/react/24/outline';
import { useLoRaConnection } from '../hooks/useLoRaConnection';
import { LogViewer } from './LogViewer';
import { LoRaDevice, EightChDevice } from '../types';

interface LoRaConfigProps {
  onRegisterDisconnect?: (fn: () => Promise<void>) => void;
}

export const LoRaConfig: React.FC<LoRaConfigProps> = ({ onRegisterDisconnect }) => {
  const {
    connectionState,
    connect,
    disconnect,
    config,
    devices,
    isLoading,
    error,
    setupProgress,
    isSetupInProgress,
    loraStatus,
    setLoraModule,
    switchModuleStatus,
    logs,
    clearLogs,
    fetchLoRaData,
    fetchSerialPorts,
    addDevice,
    deleteDevices,
    startLoRaConfigSetup,
    clearSetupProgress,
    listLoRaDevices,
    addEightChDevice,
    deleteEightChDevices,
    queryEightChDevice,
  } = useLoRaConnection();

  const LORA_MODULE_KEY = 'lora-module-type';
  const CHANNEL_PLANS_8CH = ['AS923 AS1', 'AS923 AS2', 'EU868', 'US915 SUB1', 'US915 SUB2', 'AU915', 'KR920', 'IN868'] as const;

  const [loraModuleType, setLoraModuleType] = useState<'Single Channel' | '8 Channels'>(() => {
    const saved = localStorage.getItem(LORA_MODULE_KEY);
    return saved === '8 Channels' ? '8 Channels' : 'Single Channel';
  });

  const [formData, setFormData] = useState({
    frequency: '',
    sf: '7',
    ch_plan: loraModuleType === '8 Channels' ? 'AS923 AS1' : '0',
    serial_interface: '',
  });

  const [newDevice, setNewDevice] = useState({
    idx: '0',
    id: '',
    nsKey: '',
    appKey: '',
    transmit_interval: '60',
    otaaMode: false,
    devEUI: '',
    appEUI: '',
    otaaAppKey: '',
  });

  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(new Set());
  const [showSetupPopup, setShowSetupPopup] = useState(false);
  const [setupMessage, setSetupMessage] = useState('');
  const [addDeviceError, setAddDeviceError] = useState<string | null>(null);
  const [deleteConfirmPending, setDeleteConfirmPending] = useState(false);

  const [new8ChDevice, setNew8ChDevice] = useState<EightChDevice>({
    devEUI: '', devAddr: '', nwkSKey: '', appSKey: '', appEUI: '', appKey: '', mode: 'ABP',
  });
  const [eightChDeviceError, setEightChDeviceError] = useState<string | null>(null);
  const [queryDevEUI, setQueryDevEUI] = useState('');
  const [queryResult, setQueryResult] = useState<EightChDevice | null | 'not_found'>(null);
  const [isQuerying, setIsQuerying] = useState(false);
  const [queryDeletePending, setQueryDeletePending] = useState(false);

  // Load initial data on mount only
  useEffect(() => {
    fetchLoRaData();
    fetchSerialPorts();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Register disconnect function so App.tsx can await it before switching tabs
  useEffect(() => {
    onRegisterDisconnect?.(disconnect);
    setLoraModule(loraModuleType);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLoRaModuleChange = (module: 'Single Channel' | '8 Channels') => {
    localStorage.setItem(LORA_MODULE_KEY, module);
    setLoraModuleType(module);
    setLoraModule(module);
    switchModuleStatus(module);
    setFormData(prev => ({
      ...prev,
      ch_plan: module === '8 Channels' ? 'AS923 AS1' : '0',
    }));
  };

  // Update form when config is loaded
  useEffect(() => {
    if (config) {
      setFormData({
        frequency: config.frequency,
        sf: config.sf,
        ch_plan: config.ch_plan,
        serial_interface: config.serial_interface,
      });
    }
  }, [config]);

  // Handle setup progress
  useEffect(() => {
    if (setupProgress) {
      if (setupProgress.completed) {
        setShowSetupPopup(true);
        if (setupProgress.failed_devices && setupProgress.failed_devices.length > 0) {
          setSetupMessage(
            `Setup completed with errors.\nFailed Devices: ${setupProgress.failed_devices.join(', ')}`
          );
        } else {
          setSetupMessage(`${setupProgress.setup_status || 'Setup completed successfully'}`);
        }
      }
    }
  }, [setupProgress]);

  const handleFormChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleNewDeviceChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const target = e.target as HTMLInputElement;
    const { name, value, type } = target;
    setNewDevice(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? target.checked : value,
    }));
  };

  const handleAddDevice = async () => {
    setAddDeviceError(null);

    if (!newDevice.id || !newDevice.nsKey || !newDevice.appKey) {
      setAddDeviceError('Please fill in Device ID, Network Section Key, and Application Section Key');
      return;
    }

    if (newDevice.id.length !== 8) {
      setAddDeviceError('Device ID must be exactly 8 characters');
      return;
    }

    if (newDevice.nsKey.length !== 32) {
      setAddDeviceError('Network Section Key must be exactly 32 characters');
      return;
    }

    if (newDevice.appKey.length !== 32) {
      setAddDeviceError('Application Section Key must be exactly 32 characters');
      return;
    }

    if (newDevice.otaaMode) {
      if (!newDevice.devEUI || newDevice.devEUI.length !== 16) {
        setAddDeviceError('DevEUI must be exactly 16 characters');
        return;
      }
      if (!newDevice.appEUI || newDevice.appEUI.length !== 16) {
        setAddDeviceError('AppEUI must be exactly 16 characters');
        return;
      }
      if (!newDevice.otaaAppKey || newDevice.otaaAppKey.length !== 32) {
        setAddDeviceError('OTAA AppKey must be exactly 32 characters');
        return;
      }
    }

    const success = await addDevice(newDevice as LoRaDevice);
    if (success) {
      setNewDevice({
        idx: '0',
        id: '',
        nsKey: '',
        appKey: '',
        transmit_interval: '60',
        otaaMode: false,
        devEUI: '',
        appEUI: '',
        otaaAppKey: '',
      });
    }
  };

  const handleDeleteSelectedDevices = async () => {
    if (selectedDevices.size === 0) return;

    if (!deleteConfirmPending) {
      setDeleteConfirmPending(true);
      setTimeout(() => setDeleteConfirmPending(false), 3000);
      return;
    }

    setDeleteConfirmPending(false);
    const success = await deleteDevices(Array.from(selectedDevices));
    if (success) {
      setSelectedDevices(new Set());
    }
  };

  const handleToggleDeviceSelection = (deviceNum: string) => {
    const newSelected = new Set(selectedDevices);
    if (newSelected.has(deviceNum)) {
      newSelected.delete(deviceNum);
    } else {
      newSelected.add(deviceNum);
    }
    setSelectedDevices(newSelected);
  };

  const handleStartConfigSetup = async () => {
    await startLoRaConfigSetup(formData);
  };

  const handleNew8ChDeviceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setNew8ChDevice(prev => ({ ...prev, [name]: value }));
  };

  const handleAdd8ChDevice = async () => {
    setEightChDeviceError(null);
    const d = new8ChDevice;
    if (!d.devEUI || d.devEUI.length !== 16) { setEightChDeviceError('DevEUI must be exactly 16 characters'); return; }
    if (!d.devAddr || d.devAddr.length !== 8) { setEightChDeviceError('DevAddr must be exactly 8 characters'); return; }
    if (d.mode === 'ABP') {
      if (!d.nwkSKey || d.nwkSKey.length !== 32) { setEightChDeviceError('NwkSKey must be exactly 32 characters'); return; }
      if (!d.appSKey || d.appSKey.length !== 32) { setEightChDeviceError('AppSKey must be exactly 32 characters'); return; }
    } else {
      if (!d.appEUI || d.appEUI.length !== 16) { setEightChDeviceError('AppEUI must be exactly 16 characters'); return; }
      if (!d.appKey || d.appKey.length !== 32) { setEightChDeviceError('AppKey must be exactly 32 characters'); return; }
    }
    const success = await addEightChDevice(d);
    if (success) {
      setNew8ChDevice({ devEUI: '', devAddr: '', nwkSKey: '', appSKey: '', appEUI: '', appKey: '', mode: 'ABP' });
    }
  };

  const handleQueryDevice = async () => {
    if (!queryDevEUI || queryDevEUI.length !== 16) return;
    setIsQuerying(true);
    setQueryResult(null);
    setQueryDeletePending(false);
    const result = await queryEightChDevice(queryDevEUI);
    setQueryResult(result ?? 'not_found');
    setIsQuerying(false);
  };

  const handleQueryDelete = async () => {
    if (!queryDeletePending) {
      setQueryDeletePending(true);
      setTimeout(() => setQueryDeletePending(false), 3000);
      return;
    }
    if (queryResult && queryResult !== 'not_found') {
      await deleteEightChDevices([queryResult.devEUI]);
      setQueryResult(null);
      setQueryDeletePending(false);
    }
  };

  const handleListLoRaDevices = async () => {
    await listLoRaDevices();
  };

  const handleClosePopup = async () => {
    setShowSetupPopup(false);
    await clearSetupProgress();
  };

  const handleSerialConnect = () => {
    if (connectionState === 'CONNECTED') {
      disconnect();
    } else {
      connect();
    }
  };

  const deviceCount = Object.keys(devices).length;
  const canAddMoreDevices = deviceCount < 16;
  const isConnected = connectionState === 'CONNECTED';

  return (
    <div className="space-y-6 pb-8">
      {/* Connection Status */}
      <div className="bg-slate-800/50 p-4 rounded-2xl border border-slate-700 backdrop-blur-sm flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`px-4 py-1.5 rounded-full text-sm font-medium border ${
            isConnected 
              ? 'bg-green-500/10 border-green-500/30 text-green-400' 
              : 'bg-slate-700/50 border-slate-600 text-slate-400'
          }`}>
            {isConnected ? 'CONNECTED' : 'DISCONNECTED'}
          </div>
        </div>
        <button
          onClick={handleSerialConnect}
          className={`px-4 py-2.5 rounded-lg font-semibold transition-all shadow-lg hover:shadow-xl active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
            isConnected
              ? 'bg-red-500/10 text-red-400 border border-red-500/50 hover:bg-red-500/20 focus-visible:ring-red-500'
              : 'bg-blue-600 text-white hover:bg-blue-500 shadow-blue-500/20 focus-visible:ring-blue-500'
          }`}
        >
          {isConnected ? 'Serial Disconnect' : 'Serial Connect'}
        </button>
      </div>

      {/* LoRa Module selector */}
      <div className="bg-slate-800/50 p-4 rounded-2xl border border-slate-700 backdrop-blur-sm">
        <div className="flex items-center gap-2 mb-3">
          <div className="p-1.5 bg-purple-600/20 rounded border border-purple-500/30">
            <CpuChipIcon className="w-4 h-4 text-purple-400" />
          </div>
          <div>
            <span className="text-sm font-semibold text-white">LoRa Module</span>
            <p className="text-slate-400 text-xs">Select the module channel variant</p>
          </div>
        </div>
        <div className="flex gap-2 p-1 bg-slate-900 rounded-lg border border-slate-700">
          {(['Single Channel', '8 Channels'] as const).map((m) => (
            <button
              key={m}
              onClick={() => handleLoRaModuleChange(m)}
              className={`flex-1 py-2.5 rounded text-sm font-bold tracking-wide transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 ${
                loraModuleType === m
                  ? 'bg-purple-600 text-white shadow-md shadow-purple-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* LoRa Status Display */}
      {loraModuleType === '8 Channels' ? (
        <div className="grid grid-cols-1 gap-4">
          <div className="bg-purple-900/15 p-4 rounded-2xl border border-purple-700/40 backdrop-blur-sm">
            <div className="text-xs text-purple-400/80 mb-1 font-medium uppercase tracking-wide">Channel Plan</div>
            <div className={`text-2xl font-bold ${loraStatus.channelPlan !== '--' ? 'text-white' : 'text-slate-500'}`}>{loraStatus.channelPlan}</div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-purple-900/15 p-4 rounded-2xl border border-purple-700/40 backdrop-blur-sm">
            <div className="text-xs text-purple-400/80 mb-1 font-medium uppercase tracking-wide">Frequency</div>
            <div className={`text-2xl font-bold ${loraStatus.frequency !== '--' ? 'text-white' : 'text-slate-500'}`}>{loraStatus.frequency}</div>
          </div>
          <div className="bg-purple-900/15 p-4 rounded-2xl border border-purple-700/40 backdrop-blur-sm">
            <div className="text-xs text-purple-400/80 mb-1 font-medium uppercase tracking-wide">Spreading Factor</div>
            <div className={`text-2xl font-bold ${loraStatus.sf !== '--' ? 'text-white' : 'text-slate-500'}`}>{loraStatus.sf}</div>
          </div>
          <div className="bg-purple-900/15 p-4 rounded-2xl border border-purple-700/40 backdrop-blur-sm">
            <div className="text-xs text-purple-400/80 mb-1 font-medium uppercase tracking-wide">Channel Plan</div>
            <div className={`text-2xl font-bold ${loraStatus.channelPlan !== '--' ? 'text-white' : 'text-slate-500'}`}>{loraStatus.channelPlan}</div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-lg p-4 flex items-start gap-3">
          <ExclamationTriangleIcon className="w-6 h-6 text-red-400 shrink-0 mt-0.5" />
          <div className="text-sm text-red-200">{error}</div>
        </div>
      )}

      {/* LoRa Configuration Settings */}
      <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700 backdrop-blur-sm space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <div className="p-2 bg-purple-600/20 rounded-lg border border-purple-500/30">
            <Cog8ToothIcon className="w-5 h-5 text-purple-400" />
          </div>
          <h2 className="text-lg font-bold text-white">LoRa Configuration</h2>
        </div>

        {loraModuleType === '8 Channels' ? (
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Channel Plan
            </label>
            <select
              name="ch_plan"
              value={formData.ch_plan}
              onChange={handleFormChange}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-500"
            >
              {CHANNEL_PLANS_8CH.map(plan => (
                <option key={plan} value={plan}>{plan}</option>
              ))}
            </select>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Frequency (9 digits)
              </label>
              <input
                type="text"
                name="frequency"
                value={formData.frequency}
                onChange={handleFormChange}
                maxLength={9}
                placeholder="123456789"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Spreading Factor
              </label>
              <select
                name="sf"
                value={formData.sf}
                onChange={handleFormChange}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                {[7, 8, 9, 10, 11, 12].map(sf => (
                  <option key={sf} value={sf}>
                    SF{sf}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Channel Plan
              </label>
              <select
                name="ch_plan"
                value={formData.ch_plan}
                onChange={handleFormChange}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                <option value="0">AS923</option>
                <option value="1">US915</option>
                <option value="2">AU915</option>
                <option value="3">EU868</option>
                <option value="4">KR920</option>
                <option value="5">IN865</option>
                <option value="6">RU864</option>
              </select>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleStartConfigSetup}
            disabled={isLoading || isSetupInProgress}
            className="px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800"
          >
            LoRa Config Setup
          </button>
        </div>
      </div>

      {/* Query LoRa Device — 8 Channels only */}
      {loraModuleType === '8 Channels' && (
        <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700 backdrop-blur-sm space-y-4">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-blue-600/20 rounded-lg border border-blue-500/30">
              <Cog8ToothIcon className="w-5 h-5 text-blue-400" />
            </div>
            <h2 className="text-lg font-bold text-white">Query LoRa Device</h2>
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={queryDevEUI}
              onChange={e => { setQueryDevEUI(e.target.value); setQueryResult(null); }}
              maxLength={16}
              placeholder="DevEUI (16 characters)"
              className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleQueryDevice}
              disabled={isQuerying || isLoading || queryDevEUI.length !== 16}
              className="w-36 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800"
            >
              {isQuerying ? 'Querying…' : 'Query'}
            </button>
          </div>

          {queryResult === 'not_found' && (
            <p className="text-sm text-slate-400">Device not found.</p>
          )}

          {queryResult && queryResult !== 'not_found' && (
            <div className="flex gap-2 items-center">
              <div className="flex-1 bg-slate-900/60 rounded-lg border border-slate-700 px-3 py-2">
                <p className="font-mono text-sm text-slate-200 break-all">
                  {[queryResult.devEUI, queryResult.devAddr, queryResult.nwkSKey, queryResult.appSKey].join(':')}
                </p>
              </div>
              <button
                onClick={handleQueryDelete}
                className={`w-36 py-2 rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
                  queryDeletePending
                    ? 'bg-red-500 hover:bg-red-400 text-white focus-visible:ring-red-400'
                    : 'bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/40 focus-visible:ring-red-500'
                }`}
              >
                {queryDeletePending ? 'Confirm Delete' : 'Delete Device'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Current Devices */}
      {loraModuleType === 'Single Channel' && deviceCount > 0 && (
        <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700 backdrop-blur-sm space-y-4">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-cyan-600/20 rounded-lg border border-cyan-500/30">
              <Cog8ToothIcon className="w-5 h-5 text-cyan-400" />
            </div>
            <h2 className="text-lg font-bold text-white">
              Current LoRa Devices ({deviceCount}/16)
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-slate-300">
              <thead>
                <tr className="border-b border-slate-600">
                  <th className="text-left py-3 px-3 font-semibold text-slate-400">Select</th>
                  <th className="text-left py-3 px-3 font-semibold text-slate-400">Index</th>
                  <th className="text-left py-3 px-3 font-semibold text-slate-400">Device ID</th>
                  <th className="text-left py-3 px-3 font-semibold text-slate-400">Net Section Key</th>
                  <th className="text-left py-3 px-3 font-semibold text-slate-400">App Section Key</th>
                  <th className="text-left py-3 px-3 font-semibold text-slate-400">DevEUI</th>
                  <th className="text-left py-3 px-3 font-semibold text-slate-400">AppEUI</th>
                  <th className="text-left py-3 px-3 font-semibold text-slate-400">OTAA AppKey</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(devices).map(([num, device]) => (
                  <tr key={num} className="border-b border-slate-700 hover:bg-slate-700/30">
                    <td className="py-3 px-3">
                      <input type="checkbox" checked={selectedDevices.has(num)} onChange={() => handleToggleDeviceSelection(num)} className="w-4 h-4 rounded border-slate-600 text-blue-600 focus:ring-blue-500" />
                    </td>
                    <td className="py-3 px-3 font-mono">{device.idx}</td>
                    <td className="py-3 px-3 font-mono">{device.id}</td>
                    <td className="py-3 px-3 font-mono text-xs truncate" title={device.nsKey}>{device.nsKey}</td>
                    <td className="py-3 px-3 font-mono text-xs truncate" title={device.appKey}>{device.appKey}</td>
                    <td className="py-3 px-3 font-mono text-xs text-slate-400">{device.devEUI || <span className="text-slate-600">—</span>}</td>
                    <td className="py-3 px-3 font-mono text-xs text-slate-400">{device.appEUI || <span className="text-slate-600">—</span>}</td>
                    <td className="py-3 px-3 font-mono text-xs text-slate-400 truncate" title={device.otaaAppKey}>{device.otaaAppKey || <span className="text-slate-600">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selectedDevices.size > 0 && (
            <button onClick={handleDeleteSelectedDevices} className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${deleteConfirmPending ? 'bg-red-500 hover:bg-red-400 text-white focus-visible:ring-red-400 scale-[1.02]' : 'bg-red-600 hover:bg-red-500 text-white focus-visible:ring-red-500'}`}>
              <TrashIcon className="w-4 h-4" />
              {deleteConfirmPending ? `Confirm Delete (${selectedDevices.size})` : `Delete Selected (${selectedDevices.size})`}
            </button>
          )}
        </div>
      )}


      {/* Add New Device — Single Channel */}
      {loraModuleType === 'Single Channel' && canAddMoreDevices && (
        <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700 backdrop-blur-sm space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-green-600/20 rounded-lg border border-green-500/30">
                <PlusIcon className="w-5 h-5 text-green-400" />
              </div>
              <h2 className="text-lg font-bold text-white">Add New LoRa Device</h2>
            </div>
            <button onClick={handleListLoRaDevices} disabled={isLoading} className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800">
              List LoRa Devices
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Device Index (0-15)</label>
              <select name="idx" value={newDevice.idx} onChange={handleNewDeviceChange} className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-green-500">
                {Array.from({ length: 16 }, (_, i) => <option key={i} value={String(i)}>{i}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Device ID (8 characters)</label>
              <input type="text" name="id" value={newDevice.id} onChange={handleNewDeviceChange} maxLength={8} placeholder="12345678" className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-green-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Network Section Key (32 characters)</label>
              <input type="text" name="nsKey" value={newDevice.nsKey} onChange={handleNewDeviceChange} maxLength={32} placeholder="12345678901234567890123456789012" className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Application Section Key (32 characters)</label>
              <input type="text" name="appKey" value={newDevice.appKey} onChange={handleNewDeviceChange} maxLength={32} placeholder="12345678901234567890123456789012" className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button type="button" role="switch" aria-checked={newDevice.otaaMode} onClick={() => setNewDevice(prev => ({ ...prev, otaaMode: !prev.otaaMode }))} className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-slate-800 ${newDevice.otaaMode ? 'bg-green-600' : 'bg-slate-600'}`}>
              <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${newDevice.otaaMode ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
            <span className="text-sm font-medium text-slate-300">OTAA Node</span>
            {newDevice.otaaMode && <span className="text-xs text-green-400/80">sends AT+BISOTAA</span>}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={`block text-sm font-medium mb-2 ${newDevice.otaaMode ? 'text-slate-300' : 'text-slate-600'}`}>DevEUI (16 characters)</label>
              <input type="text" name="devEUI" value={newDevice.devEUI} onChange={handleNewDeviceChange} maxLength={16} placeholder="0000000000000000" disabled={!newDevice.otaaMode} className={`w-full border rounded-lg px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors ${newDevice.otaaMode ? 'bg-slate-900 border-slate-600 text-slate-200' : 'bg-slate-900/40 border-slate-700 text-slate-600 cursor-not-allowed'}`} />
            </div>
            <div>
              <label className={`block text-sm font-medium mb-2 ${newDevice.otaaMode ? 'text-slate-300' : 'text-slate-600'}`}>AppEUI (16 characters)</label>
              <input type="text" name="appEUI" value={newDevice.appEUI} onChange={handleNewDeviceChange} maxLength={16} placeholder="0000000000000000" disabled={!newDevice.otaaMode} className={`w-full border rounded-lg px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors ${newDevice.otaaMode ? 'bg-slate-900 border-slate-600 text-slate-200' : 'bg-slate-900/40 border-slate-700 text-slate-600 cursor-not-allowed'}`} />
            </div>
          </div>
          <div>
            <label className={`block text-sm font-medium mb-2 ${newDevice.otaaMode ? 'text-slate-300' : 'text-slate-600'}`}>OTAA AppKey (32 characters)</label>
            <input type="text" name="otaaAppKey" value={newDevice.otaaAppKey} onChange={handleNewDeviceChange} maxLength={32} placeholder="00000000000000000000000000000000" disabled={!newDevice.otaaMode} className={`w-full border rounded-lg px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors ${newDevice.otaaMode ? 'bg-slate-900 border-slate-600 text-slate-200' : 'bg-slate-900/40 border-slate-700 text-slate-600 cursor-not-allowed'}`} />
          </div>

          <button onClick={handleAddDevice} disabled={isLoading} className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800">
            <PlusIcon className="w-4 h-4" />
            Add Device
          </button>
          {addDeviceError && (
            <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-800/50 rounded-lg">
              <ExclamationTriangleIcon className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">{addDeviceError}</p>
            </div>
          )}
        </div>
      )}

      {loraModuleType === 'Single Channel' && deviceCount >= 16 && (
        <div className="bg-slate-700/30 border border-slate-600 rounded-lg p-4 text-sm text-slate-300">
          Maximum of 16 devices reached.
        </div>
      )}

      {/* Add New Device — 8 Channels */}
      {loraModuleType === '8 Channels' && (
        <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700 backdrop-blur-sm space-y-4">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-green-600/20 rounded-lg border border-green-500/30">
              <PlusIcon className="w-5 h-5 text-green-400" />
            </div>
            <h2 className="text-lg font-bold text-white">Add New LoRa Device</h2>
          </div>

          {/* Mode selector */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Mode</label>
            <div className="flex gap-2 p-1 bg-slate-900 rounded-lg border border-slate-700">
              {(['ABP', 'OTAA'] as const).map(m => (
                <button key={m} onClick={() => setNew8ChDevice(prev => ({ ...prev, mode: m }))} className={`flex-1 py-2 rounded text-sm font-bold tracking-wide transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 ${new8ChDevice.mode === m ? 'bg-green-600 text-white shadow-md shadow-green-500/30' : 'text-slate-400 hover:text-slate-200'}`}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">DevEUI (16 characters)</label>
              <input type="text" name="devEUI" value={new8ChDevice.devEUI} onChange={handleNew8ChDeviceChange} maxLength={16} placeholder="0000000000000000" className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">DevAddr (8 characters)</label>
              <input type="text" name="devAddr" value={new8ChDevice.devAddr} onChange={handleNew8ChDeviceChange} maxLength={8} placeholder="00000000" className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
            </div>
            <div>
              <label className={`block text-sm font-medium mb-2 ${new8ChDevice.mode === 'ABP' ? 'text-slate-300' : 'text-slate-600'}`}>NwkSKey (32 characters)</label>
              <input type="text" name="nwkSKey" value={new8ChDevice.nwkSKey} onChange={handleNew8ChDeviceChange} maxLength={32} placeholder="00000000000000000000000000000000" disabled={new8ChDevice.mode !== 'ABP'} className={`w-full border rounded-lg px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors ${new8ChDevice.mode === 'ABP' ? 'bg-slate-900 border-slate-600 text-slate-200' : 'bg-slate-900/40 border-slate-700 text-slate-600 cursor-not-allowed'}`} />
            </div>
            <div>
              <label className={`block text-sm font-medium mb-2 ${new8ChDevice.mode === 'ABP' ? 'text-slate-300' : 'text-slate-600'}`}>AppSKey (32 characters)</label>
              <input type="text" name="appSKey" value={new8ChDevice.appSKey} onChange={handleNew8ChDeviceChange} maxLength={32} placeholder="00000000000000000000000000000000" disabled={new8ChDevice.mode !== 'ABP'} className={`w-full border rounded-lg px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors ${new8ChDevice.mode === 'ABP' ? 'bg-slate-900 border-slate-600 text-slate-200' : 'bg-slate-900/40 border-slate-700 text-slate-600 cursor-not-allowed'}`} />
            </div>
            <div>
              <label className={`block text-sm font-medium mb-2 ${new8ChDevice.mode === 'OTAA' ? 'text-slate-300' : 'text-slate-600'}`}>AppEUI (16 characters)</label>
              <input type="text" name="appEUI" value={new8ChDevice.appEUI} onChange={handleNew8ChDeviceChange} maxLength={16} placeholder="0000000000000000" disabled={new8ChDevice.mode !== 'OTAA'} className={`w-full border rounded-lg px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors ${new8ChDevice.mode === 'OTAA' ? 'bg-slate-900 border-slate-600 text-slate-200' : 'bg-slate-900/40 border-slate-700 text-slate-600 cursor-not-allowed'}`} />
            </div>
            <div>
              <label className={`block text-sm font-medium mb-2 ${new8ChDevice.mode === 'OTAA' ? 'text-slate-300' : 'text-slate-600'}`}>AppKey (32 characters)</label>
              <input type="text" name="appKey" value={new8ChDevice.appKey} onChange={handleNew8ChDeviceChange} maxLength={32} placeholder="00000000000000000000000000000000" disabled={new8ChDevice.mode !== 'OTAA'} className={`w-full border rounded-lg px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors ${new8ChDevice.mode === 'OTAA' ? 'bg-slate-900 border-slate-600 text-slate-200' : 'bg-slate-900/40 border-slate-700 text-slate-600 cursor-not-allowed'}`} />
            </div>
          </div>

          <button onClick={handleAdd8ChDevice} disabled={isLoading} className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800">
            <PlusIcon className="w-4 h-4" />
            Add Device
          </button>
          {eightChDeviceError && (
            <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-800/50 rounded-lg">
              <ExclamationTriangleIcon className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">{eightChDeviceError}</p>
            </div>
          )}
        </div>
      )}

      {/* Serial Log */}
      <div className="h-64">
        <LogViewer logs={logs} onClear={clearLogs} />
      </div>

      {/* Setup Progress Popup */}
      {showSetupPopup && setupProgress && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 max-w-md w-full mx-4 space-y-4">
            <div className="flex items-center gap-3">
              {setupProgress.error ? (
                <ExclamationTriangleIcon className="w-8 h-8 text-red-400 shrink-0" />
              ) : (
                <CheckCircleIcon className="w-8 h-8 text-green-400 shrink-0" />
              )}
              <h3 className="text-lg font-bold text-white">Setup Complete</h3>
            </div>

            <div className="space-y-2">
              <div className="w-full bg-slate-700 rounded-full h-2">
                <div
                  className="bg-blue-500 h-2 rounded-full transition-all"
                  style={{ width: `${setupProgress.percentage}%` }}
                />
              </div>
              <p className="text-sm text-slate-400">{setupProgress.percentage}% Complete</p>
            </div>

            <p className="text-sm text-slate-200 whitespace-pre-line">{setupMessage}</p>

            <button
              onClick={handleClosePopup}
              className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800"
            >
              Okay
            </button>
          </div>
        </div>
      )}

      {/* Loading Spinner when setup is in progress */}
      {isSetupInProgress && !showSetupPopup && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 max-w-sm w-full mx-4 space-y-4">
            <div className="flex justify-center">
              <div className="animate-spin">
                <Cog8ToothIcon className="w-8 h-8 text-blue-400" />
              </div>
            </div>
            <p className="text-slate-200 text-center">Setting up LoRa...</p>
            {setupProgress && (
              <>
                <div className="w-full bg-slate-700 rounded-full h-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full transition-all"
                    style={{ width: `${setupProgress.percentage}%` }}
                  />
                </div>
                <p className="text-xs text-slate-400 text-center">{setupProgress.message}</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
