import React, { useState } from 'react';
import { useDongleConnection } from './hooks/useDongleConnection';
import { ConnectionState, DriverMode } from './types';
import { DashboardCard } from './components/DashboardCard';
import { StatusBadge } from './components/StatusBadge';
import { LogViewer } from './components/LogViewer';
import { 
  SignalIcon, 
  WifiIcon, 
  CommandLineIcon, 
  CpuChipIcon,
  FingerPrintIcon,
  ExclamationTriangleIcon,
  QuestionMarkCircleIcon
} from '@heroicons/react/24/outline';

const App: React.FC = () => {
  const { connectionState, connect, disconnect, logs, clearLogs, data } = useDongleConnection();
  const [driverMode, setDriverMode] = useState<DriverMode>(DriverMode.AUTO);

  const isConnected = connectionState === ConnectionState.CONNECTED;

  const handleConnect = () => {
    if (isConnected) {
      disconnect();
    } else {
      connect(driverMode);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-6">
        
        {/* Header Section */}
        <header className="flex flex-col xl:flex-row justify-between items-center gap-4 bg-slate-800/50 p-6 rounded-2xl border border-slate-700 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-blue-600/20 rounded-xl border border-blue-500/30">
              <WifiIcon className="w-8 h-8 text-blue-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">NTN Dongle Master</h1>
              <p className="text-slate-400 text-sm">Modbus RTU over Web Serial</p>
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
              onClick={handleConnect}
              className={`px-6 py-2.5 rounded-lg font-semibold transition-all shadow-lg hover:shadow-xl active:scale-95 ${
                isConnected
                  ? 'bg-red-500/10 text-red-400 border border-red-500/50 hover:bg-red-500/20'
                  : 'bg-blue-600 text-white hover:bg-blue-500 shadow-blue-500/20'
              }`}
            >
              {isConnected ? 'Disconnect' : 'Connect'}
            </button>
          </div>
        </header>

        {/* Troubleshooting Tip - Only visible when disconnected */}
        {!isConnected && (
          <div className="bg-blue-900/20 border border-blue-800/50 rounded-lg p-4 flex items-start gap-3">
             <QuestionMarkCircleIcon className="w-6 h-6 text-blue-400 shrink-0 mt-0.5" />
             <div className="text-sm text-slate-300">
               <strong className="text-blue-300 block mb-1">Device picker empty?</strong>
               If you have installed drivers (CH340/CP210x) but the list is empty, switch <strong>DRIVER MODE</strong> to <strong>Native</strong>. 
               If that fails, try <strong>Polyfill</strong>. On macOS, you may need to check Security & Privacy settings.
             </div>
          </div>
        )}

        {/* Main Dashboard Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Column 1: Device Info & Status */}
          <div className="space-y-6">
            <DashboardCard title="Device Information">
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-slate-700 rounded-lg">
                    <CpuChipIcon className="w-5 h-5 text-slate-300" />
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">Model Name</div>
                    <div className="font-mono text-lg text-white">{data.modelName}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-slate-700 rounded-lg">
                    <CommandLineIcon className="w-5 h-5 text-slate-300" />
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">Firmware Version</div>
                    <div className="font-mono text-lg text-white">{data.fwVersion}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-slate-700 rounded-lg">
                    <FingerPrintIcon className="w-5 h-5 text-slate-300" />
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">IMSI</div>
                    <div className="font-mono text-lg text-white">{data.imsi}</div>
                  </div>
                </div>
              </div>
            </DashboardCard>

            <DashboardCard title="NTN Dongle Status">
              <div className="flex flex-col">
                <StatusBadge label="Module AT Ready" active={data.status.moduleAtReady} />
                <StatusBadge label="Downlink/IP Ready" active={data.status.downlinkReady} />
                <StatusBadge label="SIM Ready" active={data.status.simReady} />
                <StatusBadge label="Network Registered" active={data.status.networkRegistered} />
              </div>
            </DashboardCard>
          </div>

          {/* Column 2: Signal Metrics */}
          <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6 h-fit">
            <DashboardCard title="Signal Strength (RSRP)" className="h-full">
               <div className="flex flex-col items-center justify-center py-6">
                 <SignalIcon className={`w-12 h-12 mb-2 ${
                   data.rsrp !== '--' && parseInt(data.rsrp) > -100 ? 'text-green-500' : 'text-slate-600'
                 }`} />
                 <div className="text-5xl font-bold text-white tracking-tighter">
                   {data.rsrp} <span className="text-lg text-slate-500 font-normal">dBm</span>
                 </div>
                 <div className="mt-2 text-sm text-slate-500">Reference Signal Received Power</div>
               </div>
            </DashboardCard>

            <DashboardCard title="Signal Quality (SINR)" className="h-full">
               <div className="flex flex-col items-center justify-center py-6">
                 <div className="w-12 h-12 rounded-full border-4 border-slate-700 flex items-center justify-center mb-2">
                    <div className={`w-3 h-3 rounded-full ${
                      data.sinr !== '--' && parseInt(data.sinr) > 5 ? 'bg-green-500' : 'bg-slate-600'
                    }`} />
                 </div>
                 <div className="text-5xl font-bold text-white tracking-tighter">
                   {data.sinr} <span className="text-lg text-slate-500 font-normal">dB</span>
                 </div>
                 <div className="mt-2 text-sm text-slate-500">Signal-to-Interference-plus-Noise Ratio</div>
               </div>
            </DashboardCard>
            
            {/* Log Section spans full width of this column */}
            <div className="md:col-span-2 h-96">
               <LogViewer logs={logs} onClear={clearLogs} />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-slate-600 text-sm py-4">
           {isConnected ? (
             <span className="flex items-center justify-center gap-2">
               <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </span>
                Live Polling (3s interval)
             </span>
           ) : (
             <span>Waiting for connection...</span>
           )}
        </div>

      </div>
    </div>
  );
};

export default App;