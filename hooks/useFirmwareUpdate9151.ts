import { useRef, useState } from 'react';
import { serial as polyfillSerial } from 'web-serial-polyfill';
import { DriverMode, type LogEntry } from '../types';
import { getSerialUnsupportedReason } from '../utils/serialSupport';
import type { LogDirection } from '../utils/ntnUpdate';
import { runNrf9151Update, type Fota9151Phase } from '../utils/nrf9151Fota';
import { WebSerialAdapter, type FirmwareUpdateStatus, type StartUpdateOptions } from './useFirmwareUpdate';

const LOG_STORAGE_KEY = 'fw9151-serial-log';
const LOG_MAX = 500;

function loadPersistedLogs(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as LogEntry[];
  } catch { /* ignore */ }
  return [];
}

/** nRF9151 modem firmware update (A1+ / A2+) through the dongle's UART passthrough. */
export function useFirmwareUpdate9151() {
  const [status, setStatus]         = useState<FirmwareUpdateStatus>('idle');
  const [phase, setPhase]           = useState<Fota9151Phase>('idle');
  const [progress, setProgress]     = useState(0);
  const [logs, setLogs]             = useState<LogEntry[]>(loadPersistedLogs);
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);
  const [portSelected, setPortSelected] = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const portRef = useRef<any>(null);

  const addLog = (dir: LogDirection, message: string) => {
    setLogs(prev => {
      const updated = [...prev.slice(-(LOG_MAX - 1)), {
        id: crypto.randomUUID(),
        timestamp: new Date().toLocaleTimeString(),
        direction: dir,
        message,
      }];
      try { localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(updated)); } catch { /* quota exceeded */ }
      return updated;
    });
  };

  const getSerialAPI = (driverMode: DriverMode): typeof polyfillSerial => {
    if (driverMode === DriverMode.NATIVE) {
      return (navigator as unknown as { serial: typeof polyfillSerial }).serial;
    } else if (driverMode === DriverMode.POLYFILL) {
      return polyfillSerial;
    }
    return (navigator as unknown as { serial?: typeof polyfillSerial }).serial ?? polyfillSerial;
  };

  const selectPort = async (driverMode: DriverMode): Promise<void> => {
    const unsupportedReason = getSerialUnsupportedReason(driverMode);
    if (unsupportedReason) {
      setStatus('error');
      setErrorMsg(unsupportedReason);
      return;
    }
    try {
      const port = await getSerialAPI(driverMode).requestPort({});
      portRef.current = port;
      setPortSelected(true);
    } catch {
      // User cancelled the picker — leave existing selection unchanged
    }
  };

  const releasePort = async (): Promise<void> => {
    portRef.current = null;
    setPortSelected(false);
  };

  const startUpdate = async (image: Uint8Array, opts: StartUpdateOptions): Promise<void> => {
    if (!portRef.current) return;

    setStatus('running');
    setPhase('idle');
    setProgress(0);
    localStorage.removeItem(LOG_STORAGE_KEY);
    setLogs([]);
    setErrorMsg(null);

    let adapter: WebSerialAdapter | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      // AT!OTADATA lines (~530 B) exceed Web Serial's default 255-byte buffer
      await portRef.current.open({ baudRate: 115200, bufferSize: 4096 });
      adapter = new WebSerialAdapter(portRef.current);

      await runNrf9151Update(adapter, {
        image,
        slaveId:    opts.slaveId    ?? 1,
        skipModbus: opts.skipModbus ?? false,
        onPhase:    (p) => setPhase(p),
        onProgress: (pct) => setProgress(pct),
        onLog:      addLog,
      });

      setStatus('done');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
      addLog('SYS', `Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (adapter) {
        await adapter.close();
        addLog('SYS', 'Serial port closed.');
      }
    }
  };

  const clearLogs = () => {
    localStorage.removeItem(LOG_STORAGE_KEY);
    setLogs([]);
  };

  return {
    status, phase, progress, logs, errorMsg,
    portSelected, selectPort, releasePort,
    startUpdate, clearLogs,
  };
}
