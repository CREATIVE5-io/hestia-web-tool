import React, { useState, useRef } from 'react';
import { useDongleConnection } from './hooks/useDongleConnection';
import { ConnectionState, DriverMode, getCsqGpsIntervalLabel } from './types';
import { DashboardCard } from './components/DashboardCard';
import { StatusBadge } from './components/StatusBadge';
import { LogViewer } from './components/LogViewer';
import { ConfigPanel } from './components/ConfigPanel';
import { ActiveModePanel } from './components/ActiveModePanel';
import { CsqGpsIntervalPanel } from './components/CsqGpsIntervalPanel';
import { CollapsibleSection } from './components/CollapsibleSection';
import { LoRaConfig } from './components/LoRaConfig';
import { FirmwareUpdate } from './components/FirmwareUpdate';
import { FirmwareUpdate9151 } from './components/FirmwareUpdate9151';
import { NtnDongleAT } from './components/NtnDongleAT';
import { DongleModelPanel, loadSavedModel, loadSavedLoraModule, isNordicModel, hasLoraModel } from './components/DongleModelPanel';
import { NordicPanel } from './components/NordicPanel';
import { UplinkPanel } from './components/UplinkPanel';
import type { DongleModel, LoraModuleType } from './components/DongleModelPanel';
import {
  SignalIcon,
  WifiIcon,
  CommandLineIcon,
  CpuChipIcon,
  FingerPrintIcon,
  QuestionMarkCircleIcon,
  ChartBarIcon,
  RssIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { getSerialUnsupportedReason } from './utils/serialSupport';

type Tab = 'ntn' | 'ntn-at' | 'lora' | 'firmware' | 'firmware-9151';

const serialUnsupportedReason = getSerialUnsupportedReason();

const App: React.FC = () => {
  const [dongleModel, setDongleModel] = useState<DongleModel>(loadSavedModel);
  const [loraModule, setLoraModule] = useState<LoraModuleType>(loadSavedLoraModule);
  const dongleConn = useDongleConnection(dongleModel, loraModule);
  const { connectionState, connect, disconnect, logs, clearLogs, data, applyNTNConfig, applyActiveMode, applyCsqGpsInterval, sendNtnModuleCommand, sendUplinkData, isReadLoopActive, isDeviceReady, startReadLoop, stopReadLoop } = dongleConn;
  const [driverMode, setDriverMode] = useState<DriverMode>(DriverMode.AUTO);
  const [activeTab, setActiveTab] = useState<Tab>('ntn');
  const loraDisconnectRef = useRef<(() => Promise<void>) | null>(null);
  const fwDisconnectRef   = useRef<(() => Promise<void>) | null>(null);
  const fw9151DisconnectRef = useRef<(() => Promise<void>) | null>(null);
  const ntnAtDisconnectRef = useRef<(() => Promise<void>) | null>(null);
  const [isFwUpdating, setIsFwUpdating] = useState(false);

  const isConnected = connectionState === ConnectionState.CONNECTED;
  const csqDisabled = data.csqGpsInterval === 0;
  const signalPollLabel = csqDisabled ? 'off' : data.csqGpsInterval === undefined || data.csqGpsInterval === 0xFE ? '10s' : getCsqGpsIntervalLabel(data.csqGpsInterval);

  // Stop the active tab's connection before switching tabs
  const handleTabSwitch = async (tab: Tab) => {
    if (tab === activeTab) return;
    if (isFwUpdating) return;
    if (activeTab === 'ntn') {
      // Stop NTN read loop and disconnect serial port before switching
      await disconnect();
    } else if (activeTab === 'ntn-at' && ntnAtDisconnectRef.current) {
      // Stop AT session and disconnect serial port before switching
      await ntnAtDisconnectRef.current();
    } else if (activeTab === 'lora' && loraDisconnectRef.current) {
      // Stop LoRa loop and disconnect serial port before switching
      await loraDisconnectRef.current();
    } else if (activeTab === 'firmware' && fwDisconnectRef.current) {
      await fwDisconnectRef.current();
    } else if (activeTab === 'firmware-9151' && fw9151DisconnectRef.current) {
      await fw9151DisconnectRef.current();
    }
    setActiveTab(tab);
  };

  const handleSerialConnect = () => {
    if (isConnected) {
      disconnect();
    } else {
      connect(driverMode);
    }
  };

  const handleReadLoopToggle = () => {
    if (isReadLoopActive) {
      stopReadLoop();
    } else {
      startReadLoop();
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 p-4 md:p-8 font-sans">
      <div className="max-w-7xl mx-auto space-y-6">

        {serialUnsupportedReason && (
          <div role="alert" className="flex items-start gap-3 p-4 rounded-2xl border border-red-500/40 bg-red-500/10 text-red-200">
            <ExclamationTriangleIcon className="w-6 h-6 shrink-0 text-red-400" />
            <div>
              <p className="font-semibold">Serial access is not available in this browser</p>
              <p className="text-sm text-red-200/80">{serialUnsupportedReason}</p>
            </div>
          </div>
        )}

        {/* Tab Navigation - Moved to top */}
        <div className="flex gap-2 bg-slate-800/50 p-2 rounded-2xl border border-slate-700 backdrop-blur-sm">
          <button
            onClick={() => handleTabSwitch('ntn')}
            disabled={isFwUpdating && activeTab !== 'ntn'}
            className={`flex-1 px-6 py-3 rounded-lg font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
              activeTab === 'ntn'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                : isFwUpdating
                  ? 'bg-transparent text-slate-600 cursor-not-allowed'
                  : 'bg-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            NTN Dongle
          </button>
          <button
            onClick={() => handleTabSwitch('ntn-at')}
            disabled={isFwUpdating && activeTab !== 'ntn-at'}
            className={`flex-1 px-6 py-3 rounded-lg font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
              activeTab === 'ntn-at'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                : isFwUpdating
                  ? 'bg-transparent text-slate-600 cursor-not-allowed'
                  : 'bg-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            NTN Dongle - AT
          </button>
          <button
            onClick={() => handleTabSwitch('lora')}
            disabled={isFwUpdating && activeTab !== 'lora'}
            className={`flex-1 px-6 py-3 rounded-lg font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
              activeTab === 'lora'
                ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20'
                : isFwUpdating
                  ? 'bg-transparent text-slate-600 cursor-not-allowed'
                  : 'bg-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            LoRa Configuration
          </button>
          <button
            onClick={() => handleTabSwitch('firmware')}
            disabled={isFwUpdating && activeTab !== 'firmware'}
            className={`flex-1 px-6 py-3 rounded-lg font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
              activeTab === 'firmware'
                ? 'bg-amber-600 text-white shadow-lg shadow-amber-500/20'
                : isFwUpdating
                  ? 'bg-transparent text-slate-600 cursor-not-allowed'
                  : 'bg-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Firmware Update
          </button>
          <button
            onClick={() => handleTabSwitch('firmware-9151')}
            disabled={isFwUpdating && activeTab !== 'firmware-9151'}
            className={`flex-1 px-6 py-3 rounded-lg font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
              activeTab === 'firmware-9151'
                ? 'bg-amber-600 text-white shadow-lg shadow-amber-500/20'
                : isFwUpdating
                  ? 'bg-transparent text-slate-600 cursor-not-allowed'
                  : 'bg-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Firmware Update - 9151
          </button>
        </div>

        {/* Header Section - Only show on NTN Dongle tab */}
        {activeTab === 'ntn' && (
          <header className="flex flex-col xl:flex-row justify-between items-center gap-4 bg-slate-800/50 p-6 rounded-2xl border border-slate-700 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-blue-600/20 rounded-xl border border-blue-500/30">
                <WifiIcon className="w-8 h-8 text-blue-400" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white tracking-tight">Hestia Control Suite</h1>
                <p className="text-slate-400 text-sm">NTN Dongle Configuration</p>
              </div>
            </div>

            <div className="flex flex-col md:flex-row items-center gap-4">
               {/* Driver Mode Selector */}
              <div className="flex items-center gap-2 bg-slate-900 p-1 rounded-lg border border-slate-700">
                <span className="text-xs text-slate-500 px-2 font-semibold">DRIVER MODE:</span>
                <select 
                  value={driverMode} 
                  onChange={(e) => setDriverMode(e.target.value as DriverMode)}
                  disabled={isConnected}
                  className="bg-slate-800 text-slate-300 text-sm rounded border-none focus:ring-1 focus:ring-blue-500 py-1 pl-2 pr-8 disabled:opacity-50"
                >
                  <option value={DriverMode.AUTO}>Auto Detect</option>
                  <option value={DriverMode.NATIVE}>Native (OS Driver)</option>
                  <option value={DriverMode.POLYFILL}>Polyfill (WebUSB)</option>
                </select>
              </div>

              <div className={`px-4 py-1.5 rounded-full text-sm font-medium border ${
                isConnected 
                  ? 'bg-green-500/10 border-green-500/30 text-green-400' 
                  : 'bg-slate-700/50 border-slate-600 text-slate-400'
              }`}>
                {isConnected ? 'CONNECTED' : 'DISCONNECTED'}
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

              <button
                onClick={handleReadLoopToggle}
                disabled={!isConnected}
                className={`px-4 py-2.5 rounded-lg font-semibold transition-all shadow-lg hover:shadow-xl active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
                  !isConnected
                    ? 'bg-slate-700 text-slate-500 cursor-not-allowed focus-visible:ring-slate-600'
                    : isReadLoopActive
                    ? 'bg-orange-500/10 text-orange-400 border border-orange-500/50 hover:bg-orange-500/20 focus-visible:ring-orange-500'
                    : 'bg-green-600 text-white hover:bg-green-500 shadow-green-500/20 focus-visible:ring-green-500'
                }`}
              >
                {isReadLoopActive ? 'Disconnect' : 'Connect'}
              </button>
            </div>
          </header>
        )}

        {/* Troubleshooting Tip - Only visible when disconnected and on NTN tab */}
        {!isConnected && activeTab === 'ntn' && (
          <div className="bg-blue-900/20 border border-blue-800/50 rounded-lg p-4 flex items-start gap-3">
             <QuestionMarkCircleIcon className="w-6 h-6 text-blue-400 shrink-0 mt-0.5" />
             <div className="text-sm text-slate-300">
               <strong className="text-blue-300 block mb-1">Device picker empty?</strong>
               If you have installed drivers (CH340/CP210x) but the list is empty, switch <strong>DRIVER MODE</strong> to <strong>Native</strong>. 
               If that fails, try <strong>Polyfill</strong>. On macOS, you may need to check Security & Privacy settings.
             </div>
          </div>
        )}

        {/* Device Settings - rarely changed, collapsed by default */}
        {activeTab === 'ntn' && (
          <CollapsibleSection
            title="Device Settings"
            summary={<>
              Active Mode: <span className="font-mono text-slate-200">{data.activeMode !== undefined ? `MODE ${data.activeMode}` : '--'}</span>
              <span className="mx-2 text-slate-600">·</span>
              CSQ/GPS: <span className="font-mono text-slate-200">{getCsqGpsIntervalLabel(data.csqGpsInterval)}</span>
            </>}
          >
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ActiveModePanel currentMode={data.activeMode} isConnected={isConnected} onApply={applyActiveMode} />
              <CsqGpsIntervalPanel currentValue={data.csqGpsInterval} isConnected={isConnected} onApply={applyCsqGpsInterval} />
            </div>
          </CollapsibleSection>
        )}

        {/* NTN Dongle Tab Content */}
        {activeTab === 'ntn' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-6">
            
            {/* Columns 1+2: inner 2-col grid so row-mates share the same height automatically */}
            <div className="lg:col-span-2 xl:col-span-2 grid grid-cols-1 lg:grid-cols-2 gap-6 lg:grid-rows-[auto_1fr]">

              {/* Row 1: Dongle Model | Device Information */}
              <DongleModelPanel model={dongleModel} onChange={setDongleModel} loraModule={loraModule} onLoraModuleChange={setLoraModule} disabled={isConnected} />

              <DashboardCard title="Device Information" accent="blue">
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-blue-600/20 rounded border border-blue-500/30">
                      <CpuChipIcon className="w-4 h-4 text-blue-400" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Model Name</div>
                      <div className="font-mono text-sm text-white">{data.modelName}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-cyan-600/20 rounded border border-cyan-500/30">
                      <CommandLineIcon className="w-4 h-4 text-cyan-400" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Firmware Version</div>
                      <div className="font-mono text-sm text-white">{data.fwVersion}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-violet-600/20 rounded border border-violet-500/30">
                      <FingerPrintIcon className="w-4 h-4 text-violet-400" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">IMSI</div>
                      <div className="font-mono text-sm text-white">{data.imsi}</div>
                    </div>
                  </div>
                </div>
              </DashboardCard>

              {/* Row 2: Config | NTN Status */}
              <ConfigPanel
                onApplyConfig={applyNTNConfig}
                isConnected={isConnected}
                deviceConfig={data.currentConfig}
              />

              <DashboardCard title="NTN Dongle Status" accent="blue">
                <div className="flex flex-col space-y-1">
                  <StatusBadge label="Module AT Ready" active={data.status.moduleAtReady} />
                  <StatusBadge label="SIM Ready" active={data.status.simReady} />
                  <StatusBadge label="Network Registered" active={data.status.networkRegistered} />
                  <StatusBadge label="IP Ready" active={data.status.downlinkReady} />
                  <StatusBadge label="Socket Ready" active={data.status.socketReady} />
                  <div className="pt-2 mt-1 border-t border-slate-700/70">
                    <StatusBadge label="NTN Ready" active={data.status.moduleAtReady && data.status.simReady && data.status.networkRegistered && data.status.downlinkReady && data.status.socketReady} />
                  </div>
                </div>
              </DashboardCard>

            </div>

            {/* Column 3-4: Signal Metrics */}
            <div className="xl:col-span-2 lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6 h-fit">
              <DashboardCard title="Signal Strength (RSRP)" className="h-full" accent={data.rsrp !== '--' && parseInt(data.rsrp) > -100 ? 'green' : 'blue'}>
                 <div className="flex flex-col items-center justify-center py-4">
                   <SignalIcon className={`w-10 h-10 mb-2 ${
                     data.rsrp !== '--' && parseInt(data.rsrp) > -100 ? 'text-green-500' : 'text-slate-600'
                   }`} />
                   <div className="text-3xl font-bold text-white tracking-tighter">
                     {data.rsrp} <span className="text-sm text-slate-500 font-normal">dBm</span>
                   </div>
                   {csqDisabled && <div className="mt-1 text-xs text-orange-400">CSQ disabled</div>}
                   <div className="mt-1 text-xs text-slate-500 text-center">Reference Signal Received Power</div>
                 </div>
              </DashboardCard>

              <DashboardCard title="Signal Quality (SINR)" className="h-full" accent={data.sinr !== '--' && parseInt(data.sinr) > 5 ? 'green' : 'blue'}>
                 <div className="flex flex-col items-center justify-center py-4">
                   <ChartBarIcon className={`w-10 h-10 mb-2 ${
                     data.sinr !== '--' && parseInt(data.sinr) > 5 ? 'text-green-500' : 'text-slate-600'
                   }`} />
                   <div className="text-3xl font-bold text-white tracking-tighter">
                     {data.sinr} <span className="text-sm text-slate-500 font-normal">dB</span>
                   </div>
                   {csqDisabled && <div className="mt-1 text-xs text-orange-400">CSQ disabled</div>}
                   <div className="mt-1 text-xs text-slate-500 text-center">Signal-to-Interference-plus-Noise Ratio</div>
                 </div>
              </DashboardCard>

              {/* LoRa Data (A2 / A2+) */}
              {hasLoraModel(dongleModel) && (
                <div className="md:col-span-2">
                  <DashboardCard title="LoRa DATA" accent="blue" noUppercase>
                    <div className="flex items-start gap-2">
                      <div className="p-1.5 bg-purple-600/20 rounded border border-purple-500/30 shrink-0 mt-0.5">
                        <RssIcon className="w-4 h-4 text-purple-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-slate-500 mb-1">
                          {loraModule === '8-ch' ? 'AT+BISULGET payload' : 'AT+BISGET=? payload'}
                        </div>
                        <div className={`font-mono text-sm break-all ${data.loraData === '--' ? 'text-slate-500' : 'text-green-400'}`}>
                          {data.loraData}
                        </div>
                      </div>
                    </div>
                  </DashboardCard>
                </div>
              )}

              {/* Serial Log */}
              <div className="md:col-span-2 h-80">
                <LogViewer logs={logs} onClear={clearLogs} />
              </div>
            </div>

            {/* Data Upload: full-width row */}
            <div className="lg:col-span-2 xl:col-span-4">
              <UplinkPanel isReady={isConnected && isDeviceReady} sendUplink={sendUplinkData} />
            </div>

            {/* nRF9151 features (A1+ / A2+): full-width row */}
            {isNordicModel(dongleModel) && (
              <div className="lg:col-span-2 xl:col-span-4">
                <NordicPanel isReady={isConnected && isDeviceReady} sendCommand={sendNtnModuleCommand} />
              </div>
            )}
          </div>
        )}

        {/* NTN Dongle AT Tab Content */}
        {activeTab === 'ntn-at' && (
          <NtnDongleAT onRegisterDisconnect={(fn) => { ntnAtDisconnectRef.current = fn; }} />
        )}

        {/* LoRa Configuration Tab Content */}
        {activeTab === 'lora' && (
          <LoRaConfig onRegisterDisconnect={(fn) => { loraDisconnectRef.current = fn; }} />
        )}

        {/* Firmware Update Tab Content */}
        {activeTab === 'firmware' && (
          <FirmwareUpdate
            driverMode={driverMode}
            onRegisterDisconnect={(fn) => { fwDisconnectRef.current = fn; }}
            onRunningChange={setIsFwUpdating}
          />
        )}

        {/* nRF9151 Firmware Update Tab Content */}
        {activeTab === 'firmware-9151' && (
          <FirmwareUpdate9151
            driverMode={driverMode}
            onRegisterDisconnect={(fn) => { fw9151DisconnectRef.current = fn; }}
            onRunningChange={setIsFwUpdating}
          />
        )}

        {/* Footer */}
        <div className="text-center text-slate-600 text-sm py-4">
           {isConnected && isReadLoopActive && activeTab === 'ntn' ? (
             <span className="flex items-center justify-center gap-2">
               <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </span>
                Live Polling (status 10s · LoRa 30s · signal {signalPollLabel})
             </span>
           ) : isConnected && activeTab === 'ntn' ? (
             <span>Serial connected - Click Connect to start communication</span>
           ) : activeTab === 'ntn' ? (
             <span>Waiting for serial connection...</span>
           ) : activeTab === 'ntn-at' ? (
             <span>NTN Dongle AT Mode — Modbus RTU switches the dongle into UART passthrough for direct AT commands</span>
           ) : activeTab === 'lora' ? (
             <span>LoRa Configuration Interface - Configure your LoRa dongle and devices</span>
           ) : activeTab === 'firmware' ? (
             <span>Firmware Update — Flash NTN Dongle firmware via Web Serial</span>
           ) : (
             <span>Firmware Update - 9151 — Flash nRF9151 modem firmware via UART passthrough</span>
           )}
        </div>

      </div>
    </div>
  );
};

export default App;
