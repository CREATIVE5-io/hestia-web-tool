import React, { useEffect, useRef, useState } from 'react';
import { useDongleConnectionAT } from '../hooks/useDongleConnectionAT';
import { ConnectionState, DriverMode } from '../types';
import { DashboardCard } from './DashboardCard';
import { LogViewer } from './LogViewer';
import { CommandLineIcon, QuestionMarkCircleIcon } from '@heroicons/react/24/outline';

interface NtnDongleATProps {
  onRegisterDisconnect?: (fn: () => Promise<void>) => void;
}

export const NtnDongleAT: React.FC<NtnDongleATProps> = ({ onRegisterDisconnect }) => {
  const {
    connectionState,
    connect,
    disconnect,
    logs,
    clearLogs,
    isReadLoopActive,
    isBootstrapping,
    isSending,
    inFlightCommand,
    cancelledCommand,
    showRawRx,
    setShowRawRx,
    isWaitingAtReady,
    startReadLoop,
    stopReadLoop,
    sendCommand,
    cancelCommand
  } = useDongleConnectionAT();

  const [driverMode, setDriverMode] = useState<DriverMode>(DriverMode.AUTO);
  const [commandInput, setCommandInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Tick an elapsed-seconds counter while a command is awaiting its response.
  useEffect(() => {
    if (!inFlightCommand) return;
    setElapsedSec(0);
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - inFlightCommand.startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [inFlightCommand]);

  const isConnected = connectionState === ConnectionState.CONNECTED;
  const isError = connectionState === ConnectionState.ERROR;

  useEffect(() => {
    onRegisterDisconnect?.(disconnect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSerialConnect = () => {
    if (isConnected) {
      disconnect();
    } else {
      connect(driverMode);
    }
  };

  const handleSessionToggle = () => {
    if (isReadLoopActive) {
      stopReadLoop();
    } else {
      startReadLoop();
    }
  };

  const handleSend = () => {
    const command = commandInput.trim();
    if (!command) return;
    sendCommand(command);
    setCommandInput('');
    inputRef.current?.focus();
  };

  return (
    <div className="space-y-6">
      {/* Header - same layout as the Hestia Control Suite header on the NTN Dongle tab */}
      <header className="flex flex-col xl:flex-row justify-between items-center gap-4 bg-slate-800/50 p-6 rounded-2xl border border-slate-700 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-blue-600/20 rounded-xl border border-blue-500/30">
            <CommandLineIcon className="w-8 h-8 text-blue-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Hestia Control Suite</h1>
            <p className="text-slate-400 text-sm">NTN Dongle - AT Command Mode</p>
          </div>
        </div>

        <div className="flex flex-col md:flex-row items-center gap-4">
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
              : isError
                ? 'bg-red-500/10 border-red-500/30 text-red-400'
                : 'bg-slate-700/50 border-slate-600 text-slate-400'
          }`}>
            {isConnected ? 'CONNECTED' : isError ? 'ERROR' : 'DISCONNECTED'}
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
            onClick={handleSessionToggle}
            disabled={!isConnected || isBootstrapping}
            className={`px-4 py-2.5 rounded-lg font-semibold transition-all shadow-lg hover:shadow-xl active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
              !isConnected || isBootstrapping
                ? 'bg-slate-700 text-slate-500 cursor-not-allowed focus-visible:ring-slate-600'
                : isReadLoopActive
                ? 'bg-orange-500/10 text-orange-400 border border-orange-500/50 hover:bg-orange-500/20 focus-visible:ring-orange-500'
                : 'bg-green-600 text-white hover:bg-green-500 shadow-green-500/20 focus-visible:ring-green-500'
            }`}
          >
            {isBootstrapping ? 'Switching to UART...' : isReadLoopActive ? 'Disconnect' : 'Connect'}
          </button>
        </div>
      </header>

      {/* Troubleshooting tip - only visible when disconnected */}
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

      {isConnected && !isReadLoopActive && !isBootstrapping && (
        <div className="bg-blue-900/20 border border-blue-800/50 rounded-lg p-4 flex items-start gap-3">
          <QuestionMarkCircleIcon className="w-6 h-6 text-blue-400 shrink-0 mt-0.5" />
          <div className="text-sm text-slate-300">
            Click <strong className="text-blue-300">Connect</strong> to set the device password over Modbus RTU and switch it into UART passthrough (MODE 3) for direct AT commands.
          </div>
        </div>
      )}

      {isWaitingAtReady && (
        <div className="bg-blue-900/20 border border-blue-800/50 rounded-lg p-4 flex items-start gap-3">
          <QuestionMarkCircleIcon className="w-6 h-6 text-blue-400 shrink-0 mt-0.5" />
          <div className="text-sm text-slate-300">
            Polling <strong className="text-blue-300">ATI</strong> until the module reports Module AT Ready — per the NTN_RMM-T1 manual, the module won't answer until its own boot/attach finishes, which can take up to ~80s. Watch the log for progress.
          </div>
        </div>
      )}

      {/* AT terminal: input (1/4 width) + log (3/4 width) */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-stretch">
        <div className="lg:col-span-1">
          <DashboardCard title="AT Command" accent="blue" className="h-full flex flex-col">
            <div className="flex flex-col gap-3 h-full">
              <input
                ref={inputRef}
                type="text"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSend(); } }}
                placeholder="AT+..."
                disabled={!isReadLoopActive || isSending || isWaitingAtReady}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              />
              <button
                onClick={handleSend}
                disabled={!isReadLoopActive || isSending || isWaitingAtReady || !commandInput.trim()}
                className="w-full px-4 py-2 rounded-lg font-semibold bg-blue-600 text-white hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed transition-all"
              >
                {isSending ? 'Sending...' : 'Send'}
              </button>
              {inFlightCommand && (
                <div className="bg-slate-900 border border-blue-800/50 rounded-lg p-3 text-xs text-slate-300 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin shrink-0" />
                    <span className="font-mono truncate">{inFlightCommand.command}</span>
                  </div>
                  <div className="text-slate-400">
                    Waiting for response... {elapsedSec}s / {Math.round(inFlightCommand.timeoutMs / 1000)}s
                  </div>
                  <button
                    onClick={cancelCommand}
                    className="w-full px-3 py-1.5 rounded-lg font-semibold bg-orange-500/10 text-orange-400 border border-orange-500/50 hover:bg-orange-500/20 transition-all"
                  >
                    Cancel
                  </button>
                  <p className="text-slate-500">
                    Cancel only stops waiting here - the module keeps running the command.
                  </p>
                </div>
              )}
              {!inFlightCommand && cancelledCommand && (
                <div className="bg-orange-900/20 border border-orange-800/50 rounded-lg p-3 text-xs text-orange-300">
                  <strong className="font-mono">{cancelledCommand}</strong> may still be running on the module.
                  New commands may be ignored until its late reply (OK/ERROR) appears in the log.
                </div>
              )}
              <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showRawRx}
                  onChange={(e) => setShowRawRx(e.target.checked)}
                  className="rounded border-slate-600 bg-slate-800"
                />
                Log raw RX bytes (debug)
              </label>
              <p className="text-xs text-slate-500">
                {isWaitingAtReady
                  ? 'Waiting for Module AT Ready (auto ATI polling)...'
                  : isReadLoopActive
                  ? 'Type an AT command and press Enter or Send.'
                  : 'Start an AT session (Connect) to enable command input.'}
              </p>
            </div>
          </DashboardCard>
        </div>

        <div className="lg:col-span-3 h-96">
          <LogViewer logs={logs} onClear={clearLogs} title="AT COMMAND LOG" />
        </div>
      </div>
    </div>
  );
};
