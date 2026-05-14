import { useRef, useState } from 'react';
import { serial as polyfillSerial } from 'web-serial-polyfill';
import { DriverMode, type LogEntry } from '../types';
import {
  runUpdate,
  type IoAdapter,
  type UpdatePhase,
  type LogDirection,
} from '../utils/ntnUpdate';

// ── Web Serial IoAdapter ──────────────────────────────────────────────────────

/**
 * Web Serial API implementation of IoAdapter.
 *
 * Uses a background pump loop to buffer incoming bytes. This avoids the
 * "lost data on timeout" problem: if read() times out, bytes that arrive
 * later are queued and returned on the next read() call.
 */
class WebSerialAdapter implements IoAdapter {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer: Uint8Array[] = [];
  private waitResolver: ((data: Uint8Array) => void) | null = null;

  // port typed as any to be compatible with both native and polyfill SerialPort
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private port: any) {
    this.reader = this.port.readable!.getReader();
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length > 0) {
          if (this.waitResolver) {
            const resolve = this.waitResolver;
            this.waitResolver = null;
            resolve(value);
          } else {
            this.buffer.push(value);
          }
        }
      }
    } catch {
      // Port closed or cancelled — wake any pending read
      if (this.waitResolver) {
        const resolve = this.waitResolver;
        this.waitResolver = null;
        resolve(new Uint8Array(0));
      }
    }
  }

  async write(data: Uint8Array): Promise<void> {
    const writer = this.port.writable!.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  async read(timeoutMs: number): Promise<Uint8Array> {
    if (this.buffer.length > 0) return this.buffer.shift()!;
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waitResolver = null;
        reject(new Error('timeout'));
      }, timeoutMs);
      this.waitResolver = (data) => {
        clearTimeout(timer);
        if (data.length === 0) {
          reject(new Error('timeout'));
        } else {
          resolve(data);
        }
      };
    });
  }

  async close(): Promise<void> {
    try { await this.reader.cancel(); } catch { /* already closed */ }
    try { this.reader.releaseLock(); } catch { /* already released */ }
    try { await this.port.close(); } catch { /* already closed */ }
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

const LOG_STORAGE_KEY = 'fw-serial-log';
const LOG_MAX = 500;

function loadPersistedLogs(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as LogEntry[];
  } catch { /* ignore */ }
  return [];
}

export type FirmwareUpdateStatus = 'idle' | 'running' | 'done' | 'error';

export interface StartUpdateOptions {
  slaveId?: number;
  skipModbus?: boolean;
}

export function useFirmwareUpdate() {
  const [status, setStatus]         = useState<FirmwareUpdateStatus>('idle');
  const [phase, setPhase]           = useState<UpdatePhase>('idle');
  const [progress, setProgress]     = useState(0);
  const [logs, setLogs]             = useState<LogEntry[]>(loadPersistedLogs);
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);
  const [portSelected, setPortSelected] = useState(false);

  // Holds the user-selected SerialPort across startUpdate calls
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
    // AUTO: prefer native, fall back to polyfill
    return (navigator as unknown as { serial?: typeof polyfillSerial }).serial ?? polyfillSerial;
  };

  /** Open the browser's serial port picker and store the chosen port. */
  const selectPort = async (driverMode: DriverMode): Promise<void> => {
    try {
      const serialAPI = getSerialAPI(driverMode);
      const port = await serialAPI.requestPort({});
      portRef.current = port;
      setPortSelected(true);
    } catch {
      // User cancelled the picker — leave existing selection unchanged
    }
  };

  /** Release the stored port reference (called on tab switch or explicit disconnect). */
  const releasePort = async (): Promise<void> => {
    portRef.current = null;
    setPortSelected(false);
  };

  const startUpdate = async (
    image: Uint8Array,
    opts: StartUpdateOptions,
  ): Promise<void> => {
    if (!portRef.current) return;

    setStatus('running');
    setPhase('idle');
    setProgress(0);
    localStorage.removeItem(LOG_STORAGE_KEY);
    setLogs([]);
    setErrorMsg(null);

    try {
      // Factory is called twice by runUpdate (Phase 1 then Phase 2).
      // Both calls open the same pre-selected port; it is closed between phases.
      const adapterFactory = async (): Promise<IoAdapter> => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await portRef.current.open({ baudRate: 115200 });
        return new WebSerialAdapter(portRef.current);
      };

      await runUpdate(adapterFactory, {
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
