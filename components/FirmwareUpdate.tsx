import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUpTrayIcon,
  CheckCircleIcon,
  XCircleIcon,
  ArrowPathIcon,
  DocumentIcon,
  CpuChipIcon,
} from '@heroicons/react/24/outline';
import { DriverMode } from '../types';
import { useFirmwareUpdate } from '../hooks/useFirmwareUpdate';
import { LogViewer } from './LogViewer';
import type { UpdatePhase } from '../utils/ntnUpdate';

interface FirmwareUpdateProps {
  driverMode: DriverMode;
  onRegisterDisconnect: (fn: () => Promise<void>) => void;
  onRunningChange: (running: boolean) => void;
}

// ── Phase display config ──────────────────────────────────────────────────────

const PHASES: Array<{ key: UpdatePhase; label: string }> = [
  { key: 'modbus_password',        label: 'Unlock Password'       },
  { key: 'modbus_engineering',     label: 'Engineering Mode'      },
  { key: 'modbus_bootloader',      label: 'Bootloader Mode'       },
  { key: 'modbus_reset',           label: 'MCU Reset'             },
  { key: 'waiting_for_bootloader', label: 'Waiting for Bootloader' },
  { key: 'mdfu_handshake',         label: 'MDFU Handshake'        },
  { key: 'mdfu_start_transfer',    label: 'Start Transfer'        },
  { key: 'mdfu_transferring',      label: 'Transferring Firmware' },
  { key: 'mdfu_verify',            label: 'Verify Image'          },
  { key: 'mdfu_end_transfer',      label: 'End Transfer'          },
  { key: 'done',                   label: 'Complete'              },
];

const PHASE_ORDER = PHASES.map(p => p.key);

function phaseIndex(p: UpdatePhase): number {
  return PHASE_ORDER.indexOf(p);
}

// ── Component ─────────────────────────────────────────────────────────────────

export const FirmwareUpdate: React.FC<FirmwareUpdateProps> = ({
  driverMode,
  onRegisterDisconnect,
  onRunningChange,
}) => {
  const {
    status, phase, progress, logs, errorMsg,
    portSelected, selectPort, releasePort,
    startUpdate, clearLogs,
  } = useFirmwareUpdate();

  const [imageData, setImageData]   = useState<Uint8Array | null>(null);
  const [imageName, setImageName]   = useState<string>('');
  const [imageSize, setImageSize]   = useState<number>(0);
  const [skipModbus, setSkipModbus] = useState(false);
  const [slaveId, setSlaveId]       = useState(1);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Register releasePort as the tab-switch disconnect handler
  useEffect(() => {
    onRegisterDisconnect(releasePort);
  }, [onRegisterDisconnect, releasePort]);

  // Notify parent when update running state changes
  useEffect(() => {
    onRunningChange(status === 'running');
  }, [status, onRunningChange]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const buf = ev.target?.result as ArrayBuffer;
      setImageData(new Uint8Array(buf));
      setImageName(file.name);
      setImageSize(file.size);
    };
    reader.readAsArrayBuffer(file);
  };

  const handleStart = () => {
    if (!imageData || !portSelected) return;
    void startUpdate(imageData, { slaveId, skipModbus });
  };

  const isRunning  = status === 'running';
  const currentIdx = phaseIndex(phase);
  const canStart   = !!imageData && portSelected && !isRunning;

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3 bg-slate-800/50 p-6 rounded-2xl border border-slate-700 backdrop-blur-sm">
        <div className="p-3 bg-amber-600/20 rounded-xl border border-amber-500/30">
          <ArrowUpTrayIcon className="w-8 h-8 text-amber-400" />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Firmware Update</h2>
          <p className="text-slate-400 text-sm">Flash NTN Dongle firmware via Web Serial (MDFU protocol)</p>
        </div>
        <div className="ml-auto text-xs text-slate-500 font-mono">
          DRIVER: <span className="text-amber-400">{driverMode}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

        {/* Left column: Port + File + Options + Phase stepper */}
        <div className="space-y-6">

          {/* Setup card: port + file + options + start */}
          <div className="bg-slate-800/50 rounded-2xl border border-slate-700 p-6 space-y-4">

            {/* Step 1 — Serial port */}
            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                Step 1 — Select Serial Port
              </h3>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => void selectPort(driverMode)}
                  disabled={isRunning}
                  className={`flex-1 flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
                    isRunning
                      ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                      : portSelected
                        ? 'bg-green-500/10 border border-green-500/30 text-green-400 hover:bg-green-500/20'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600 border border-slate-600'
                  }`}
                >
                  <CpuChipIcon className="w-4 h-4 shrink-0" />
                  {portSelected ? 'Port selected — click to change' : 'Select Serial Port…'}
                </button>
                {portSelected && (
                  <button
                    onClick={() => void releasePort()}
                    disabled={isRunning}
                    className="px-3 py-2.5 rounded-lg text-sm text-slate-400 hover:text-red-400 hover:bg-red-500/10 border border-slate-600 hover:border-red-500/30 transition-all disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    title="Deselect port"
                  >
                    <XCircleIcon className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Step 2 — Firmware image */}
            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                Step 2 — Select Firmware Image
              </h3>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isRunning}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border-2 border-dashed border-slate-600 hover:border-amber-500/50 hover:bg-amber-500/5 transition-all disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <DocumentIcon className="w-5 h-5 text-slate-400 shrink-0" />
                <span className="text-sm text-slate-400 truncate">
                  {imageName || 'Click to select .img file…'}
                </span>
                {imageSize > 0 && (
                  <span className="ml-auto text-xs text-slate-500 shrink-0 font-mono">
                    {formatBytes(imageSize)}
                  </span>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".img"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            {/* Options */}
            <div className="flex flex-col gap-3 pt-2 border-t border-slate-700">
              <div className="flex items-center justify-between">
                <label className="text-sm text-slate-400">Slave ID (Modbus)</label>
                <input
                  type="number"
                  min={1}
                  max={247}
                  value={slaveId}
                  onChange={e => setSlaveId(Math.max(1, Math.min(247, parseInt(e.target.value) || 1)))}
                  disabled={isRunning}
                  className="w-20 bg-slate-900 text-slate-200 text-sm rounded border border-slate-600 px-2 py-1 text-right focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
                />
              </div>
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={skipModbus}
                  onChange={e => setSkipModbus(e.target.checked)}
                  disabled={isRunning}
                  className="w-4 h-4 rounded border-slate-600 bg-slate-900 text-amber-500 focus:ring-amber-500 focus:ring-offset-slate-800 disabled:opacity-50"
                />
                <span className="text-sm text-slate-400">
                  Skip Modbus phase
                  <span className="text-slate-600 ml-1">(device already in bootloader)</span>
                </span>
              </label>
            </div>

            {/* Start button */}
            <button
              onClick={handleStart}
              disabled={!canStart}
              className={`w-full py-3 rounded-lg font-semibold transition-all shadow-lg active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
                !canStart
                  ? 'bg-slate-700 text-slate-500 cursor-not-allowed focus-visible:ring-slate-600'
                  : 'bg-amber-600 text-white hover:bg-amber-500 shadow-amber-500/20 focus-visible:ring-amber-500'
              }`}
            >
              {isRunning ? (
                <span className="flex items-center justify-center gap-2">
                  <ArrowPathIcon className="w-4 h-4 animate-spin" />
                  Updating…
                </span>
              ) : (
                'Start Firmware Update'
              )}
            </button>

            {/* Status / error banner */}
            {status === 'done' && (
              <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm">
                <CheckCircleIcon className="w-4 h-4 shrink-0" />
                Update complete — device is rebooting into new firmware.
              </div>
            )}
            {status === 'error' && errorMsg && (
              <div className="flex items-start gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                <XCircleIcon className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="break-all">{errorMsg}</span>
              </div>
            )}
          </div>

          {/* Phase stepper */}
          <div className="bg-slate-800/50 rounded-2xl border border-slate-700 p-6">
            <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider mb-4">
              Update Progress
            </h3>

            {/* Progress bar — only visible during transfer */}
            {phase === 'mdfu_transferring' && (
              <div className="mb-4">
                <div className="flex justify-between text-xs text-slate-500 mb-1">
                  <span>Transferring firmware</span>
                  <span className="font-mono">{progress}%</span>
                </div>
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-amber-500 rounded-full transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              {PHASES.map(({ key, label }) => {
                const idx      = phaseIndex(key);
                const isDone    = status !== 'idle' && currentIdx > idx;
                const isCurrent = phase === key && isRunning;
                const isError   = status === 'error' && phase === key;

                return (
                  <div
                    key={key}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                      isCurrent ? 'bg-amber-500/10 border border-amber-500/20' :
                      isDone    ? 'bg-green-500/5'  :
                      isError   ? 'bg-red-500/10 border border-red-500/20' :
                      'opacity-40'
                    }`}
                  >
                    <span className="shrink-0 w-5 h-5 flex items-center justify-center">
                      {isError ? (
                        <XCircleIcon className="w-4 h-4 text-red-400" />
                      ) : isDone ? (
                        <CheckCircleIcon className="w-4 h-4 text-green-400" />
                      ) : isCurrent ? (
                        <ArrowPathIcon className="w-4 h-4 text-amber-400 animate-spin" />
                      ) : (
                        <span className="w-2 h-2 rounded-full bg-slate-600" />
                      )}
                    </span>
                    <span className={`text-sm ${
                      isCurrent ? 'text-amber-300 font-medium' :
                      isDone    ? 'text-green-400' :
                      isError   ? 'text-red-400' :
                      'text-slate-500'
                    }`}>
                      {label}
                    </span>
                    {key === 'mdfu_transferring' && isCurrent && (
                      <span className="ml-auto text-xs font-mono text-amber-400">{progress}%</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right column: Log viewer — stretches to match left column height */}
        <div className="h-[800px]">
          <LogViewer logs={logs} onClear={clearLogs} />
        </div>

      </div>
    </div>
  );
};
