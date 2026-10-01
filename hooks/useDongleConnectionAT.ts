import { useState, useRef, useEffect, useCallback } from 'react';
import { ConnectionState, LogEntry, SerialPort, DriverMode, MODBUS_CONSTANTS } from '../types';
import { buildWriteMultipleRegisters, buildWriteSingleRegister, hexString } from '../utils/modbus';
import { encodeATCommand, splitLines, detectTerminator, readRawWithTimeout, formatRawBytes, getATCommandTimeoutMs, getATResultTag, DEFAULT_AT_TIMEOUT_MS } from '../utils/atProtocol';
// @ts-ignore - The polyfill types aren't always perfect, ignore for build safety
import { serial as polyfillSerial } from 'web-serial-polyfill';

const LOG_STORAGE_KEY = 'ntn-serial-log-at';
const LOG_MAX = 500;
const BAUD_RATE = 115200;

function loadPersistedLogs(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as LogEntry[];
  } catch { /* ignore */ }
  return [];
}

interface PendingCommand {
  lines: string[];
  resolve: (result: { lines: string[]; ok: boolean } | null) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  // Tag of the command's own result line (see getATResultTag). Once a line with it
  // arrives, the command also completes after RESULT_IDLE_MS of silence, for
  // modules that never send the trailing OK.
  resultTag: string | null;
  idleTimerId: ReturnType<typeof setTimeout> | null;
}

const RESULT_IDLE_MS = 500;

const clearPendingTimers = (pending: PendingCommand) => {
  clearTimeout(pending.timeoutId);
  if (pending.idleTimerId) clearTimeout(pending.idleTimerId);
};

/** The manually-sent command currently awaiting OK/ERROR, for the UI's elapsed-time indicator. */
export interface InFlightATCommand {
  command: string;
  startedAt: number;
  timeoutMs: number;
}

/** Outcome of the Modbus->UART-passthrough bootstrap run before the AT session starts. */
type BootstrapResult = 'ready' | 'already-at' | 'device-failed';

// Default NTN dongle Modbus password (8 ASCII zero digits -> 4 zero registers), per ntn_modbus_to_atCmd.py.
const DEFAULT_PASSWORD_REGISTERS = [0, 0, 0, 0];

export const useDongleConnectionAT = () => {
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [logs, setLogs] = useState<LogEntry[]>(loadPersistedLogs);
  const [isReadLoopActive, setIsReadLoopActive] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [inFlightCommand, setInFlightCommand] = useState<InFlightATCommand | null>(null);
  // Set after Cancel: the module is likely still executing the abandoned command
  // and may ignore new ones. Cleared when its late OK/ERROR arrives.
  const [cancelledCommand, setCancelledCommand] = useState<string | null>(null);
  const [isWaitingAtReady, setIsWaitingAtReady] = useState(false);
  const isWaitingAtReadyRef = useRef<boolean>(false);

  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const keepReadingRef = useRef<boolean>(false);
  const readLoopPromiseRef = useRef<Promise<void> | null>(null);
  const isClosingRef = useRef<boolean>(false);

  const lineRemainderRef = useRef<string>('');
  const pendingCommandRef = useRef<PendingCommand | null>(null);
  const inFlightCommandRef = useRef<InFlightATCommand | null>(null);
  // Set when a command completed on idle after its result line; a trailing
  // OK/ERROR that arrives late then belongs to it rather than being a URC.
  const expectTrailingTerminatorRef = useRef<boolean>(false);
  // Debug: log every received chunk byte-for-byte before line splitting.
  const [showRawRx, setShowRawRx] = useState(false);
  const showRawRxRef = useRef<boolean>(false);
  showRawRxRef.current = showRawRx;

  const addLog = useCallback((direction: 'TX' | 'RX' | 'SYS', message: string, isError = false) => {
    setLogs(prev => {
      const newLog: LogEntry = {
        id: Math.random().toString(36).substring(7),
        timestamp: new Date().toLocaleTimeString(),
        direction,
        message,
        isError
      };
      const updated = [...prev.slice(-(LOG_MAX - 1)), newLog];
      try { localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(updated)); } catch { /* quota exceeded */ }
      return updated;
    });
  }, []);

  const clearLogs = useCallback(() => {
    localStorage.removeItem(LOG_STORAGE_KEY);
    setLogs([]);
  }, []);

  const cleanupResources = async () => {
    if (isClosingRef.current) {
      console.debug('Close already in progress, skipping');
      return;
    }
    isClosingRef.current = true;

    keepReadingRef.current = false;

    if (pendingCommandRef.current) {
      clearPendingTimers(pendingCommandRef.current);
      pendingCommandRef.current.resolve(null);
      pendingCommandRef.current = null;
    }

    if (readerRef.current) {
      try {
        await readerRef.current.cancel();
      } catch (e) {
        console.debug('Reader cancel error (ignoring):', e);
      }
    }

    if (readLoopPromiseRef.current) {
      try {
        await readLoopPromiseRef.current;
      } catch (e) {
        console.debug('Read loop await error:', e);
      }
      readLoopPromiseRef.current = null;
    }

    if (portRef.current) {
      try {
        await portRef.current.close();
      } catch (e) {
        console.debug('Port close error (ignoring):', e);
      }
      portRef.current = null;
    }

    isClosingRef.current = false;
  };

  useEffect(() => {
    return () => {
      cleanupResources().catch(console.error);
    };
  }, []);

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // ---- Raw byte helpers (used for the one-shot Modbus bootstrap, before the
  // line-based AT read loop takes over the reader) ----

  const writeRawBytes = async (bytes: Uint8Array) => {
    if (!portRef.current?.writable) return;
    const writer = portRef.current.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  };

  // Grabs a fresh reader each call - readRawWithTimeout cancels the reader it's
  // given once its window closes, so a new one must be acquired for every read.
  const readRawFresh = async (timeoutMs: number): Promise<Uint8Array> => {
    if (!portRef.current?.readable) return new Uint8Array(0);
    const reader = portRef.current.readable.getReader();
    return readRawWithTimeout(reader, timeoutMs);
  };

  const isValidModbusAck = (resp: Uint8Array, funcCode: number): boolean =>
    resp.length >= 8 && resp[0] === MODBUS_CONSTANTS.SLAVE_ID && resp[1] === funcCode;

  const modbusWriteAndWait = async (frame: Uint8Array, label: string, timeoutMs = 1200): Promise<Uint8Array> => {
    addLog('TX', `[MODBUS] ${label}: ${hexString(frame)}`);
    await writeRawBytes(frame);
    return readRawFresh(timeoutMs);
  };

  // If the password write goes unanswered, the dongle may simply already be
  // sitting in UART passthrough mode (it won't speak Modbus at all in that
  // state). Probe with a plain "AT" and treat any OK/ERROR reply as "alive,
  // already in AT mode" rather than a hard failure.
  const probeAtAlive = async (): Promise<boolean> => {
    addLog('SYS', 'No Modbus response - probing for an existing AT/UART passthrough session...');
    addLog('TX', 'AT');
    await writeRawBytes(encodeATCommand('AT'));
    const resp = await readRawFresh(1200);
    const text = new TextDecoder().decode(resp).trim();
    if (text) addLog('RX', text);
    return /\bOK\b/i.test(text) || /ERROR/i.test(text);
  };

  // Mirrors ntn_modbus_to_atCmd.py: set the default password over Modbus RTU,
  // then write register 0xC350 = 3 to switch the dongle into UART passthrough
  // (AT command) mode.
  const switchToUartPassthrough = async (): Promise<BootstrapResult> => {
    addLog('SYS', 'Bootstrapping UART passthrough mode via Modbus RTU...');

    const PASSWORD_ATTEMPTS = 2;
    let pwAcked = false;
    for (let attempt = 1; attempt <= PASSWORD_ATTEMPTS && !pwAcked; attempt++) {
      addLog('SYS', `Set password (attempt ${attempt}/${PASSWORD_ATTEMPTS})...`);
      const resp = await modbusWriteAndWait(
        buildWriteMultipleRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_PASSWORD, DEFAULT_PASSWORD_REGISTERS),
        'Set password'
      );
      if (isValidModbusAck(resp, MODBUS_CONSTANTS.WRITE_MULTIPLE_REGISTERS)) {
        addLog('RX', `[MODBUS] Set password ack: ${hexString(resp)}`);
        pwAcked = true;
      } else {
        addLog('SYS', `Set password: no valid Modbus response${resp.length ? ` (got ${hexString(resp)})` : ''}`, true);
        if (attempt < PASSWORD_ATTEMPTS) await sleep(400);
      }
    }

    if (!pwAcked) {
      // Condition 2: dongle may already be in UART/AT passthrough mode (it won't
      // ack Modbus frames in that state) - fall back to an AT probe before
      // declaring the device dead.
      if (await probeAtAlive()) {
        addLog('SYS', 'Device is already in UART passthrough mode - skipping Modbus bootstrap.');
        return 'already-at';
      }
      // Condition 1: no reply to Modbus or AT - treat as a real device failure.
      addLog('SYS', 'CRITICAL: NTN dongle is not responding (Modbus and AT probe both failed). Check device power/connection.', true);
      return 'device-failed';
    }

    await sleep(300);

    const MODE_ATTEMPTS = 3;
    let modeAcked = false;
    for (let attempt = 1; attempt <= MODE_ATTEMPTS && !modeAcked; attempt++) {
      addLog('SYS', `Set UART passthrough mode / MODE 3 (attempt ${attempt}/${MODE_ATTEMPTS})...`);
      const resp = await modbusWriteAndWait(
        buildWriteSingleRegister(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_UART_MODE, 0x03),
        'Set UART mode'
      );
      if (isValidModbusAck(resp, MODBUS_CONSTANTS.WRITE_SINGLE_REGISTER)) {
        addLog('RX', `[MODBUS] Set UART mode ack: ${hexString(resp)}`);
        modeAcked = true;
      } else {
        addLog('SYS', `Set UART mode: no valid Modbus response${resp.length ? ` (got ${hexString(resp)})` : ''}`, true);
        if (attempt < MODE_ATTEMPTS) await sleep(400);
      }
    }

    if (!modeAcked) {
      addLog('SYS', 'CRITICAL: Password was accepted, but the dongle did not ack the switch to UART passthrough mode.', true);
      return 'device-failed';
    }

    addLog('SYS', 'Device switched to UART passthrough mode.');
    return 'ready';
  };

  // ---- Line-based AT protocol (once passthrough mode is active) ----

  const writeATCommand = async (command: string) => {
    if (!portRef.current?.writable) return;
    try {
      await writeRawBytes(encodeATCommand(command));
      addLog('TX', command);
    } catch (err) {
      addLog('SYS', `Write error: ${err}`, true);
    }
  };

  // Sends a single AT command line and waits for the terminating OK/ERROR/+CME
  // ERROR line, returning every line received in between. Unsolicited lines
  // (URCs) that arrive while nothing is pending are just logged (see readLoop).
  const sendATCommand = async (command: string, timeoutMs: number = 5000, quiet = false): Promise<{ lines: string[]; ok: boolean } | null> => {
    if (pendingCommandRef.current && !quiet) {
      addLog('SYS', 'Warning: previous AT command still pending, response may be misrouted', true);
    }

    if (!keepReadingRef.current && !quiet) {
      addLog('SYS', 'Warning: AT session not active, response may not be captured', true);
    }

    expectTrailingTerminatorRef.current = false;
    await writeATCommand(command);

    return new Promise((resolve) => {
      const pending: PendingCommand = {
        lines: [],
        resolve,
        resultTag: getATResultTag(command),
        idleTimerId: null,
        timeoutId: setTimeout(() => {
          if (pendingCommandRef.current === pending) {
            pendingCommandRef.current = null;
          }
          if (!quiet) addLog('SYS', `AT command timeout: ${command}`, true);
          resolve(null);
        }, timeoutMs)
      };
      pendingCommandRef.current = pending;
    });
  };

  // Per the NTN_RMM-T1 AT manual (sec 7.9 "IP Network Attach Procedure"), the module
  // does not answer AT commands at all until its own boot/attach finishes - the
  // manual's own documented procedure is a bare retry loop on ATI until OK, not a
  // single request. 40 attempts * 2s = ~80s budget, well above the ~34s of silence
  // observed on real hardware before Module AT Ready.
  const ATI_READY_MAX_ATTEMPTS = 40;
  const ATI_READY_INTERVAL_MS = 2000;

  const waitForAtReady = async (
    maxAttempts = ATI_READY_MAX_ATTEMPTS,
    intervalMs = ATI_READY_INTERVAL_MS
  ): Promise<boolean> => {
    addLog('SYS', 'Waiting for Module AT Ready (polling ATI per NTN_RMM-T1 manual sec 7.9)...');
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!keepReadingRef.current) return false;
      const result = await sendATCommand('ATI', intervalMs, true);
      if (result?.ok) {
        addLog('SYS', `Module AT Ready (ATI -> OK, attempt ${attempt}/${maxAttempts}).`);
        return true;
      }
      if (attempt % 5 === 0 && attempt < maxAttempts) {
        addLog('SYS', `Still waiting for Module AT Ready... (attempt ${attempt}/${maxAttempts})`);
      }
    }
    addLog('SYS', `Module AT Ready timed out after ${maxAttempts} attempts (~${Math.round(maxAttempts * intervalMs / 1000)}s). Device may need longer to boot, or check power/connection.`, true);
    return false;
  };

  const readLoop = async () => {
    if (!portRef.current?.readable) return;
    if (readerRef.current) return;

    const decoder = new TextDecoder();

    try {
      readerRef.current = portRef.current.readable.getReader();
      while (keepReadingRef.current) {
        const { value, done } = await readerRef.current.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        if (showRawRxRef.current) addLog('RX', `[RAW ${value.length}B] ${formatRawBytes(value)}`);

        const text = lineRemainderRef.current + decoder.decode(value, { stream: true });
        const { lines, remainder } = splitLines(text);
        lineRemainderRef.current = remainder;

        for (const line of lines) {
          const pending = pendingCommandRef.current;
          if (pending) {
            const terminator = detectTerminator(line);
            addLog('RX', line);
            if (terminator.terminated) {
              pendingCommandRef.current = null;
              clearPendingTimers(pending);
              pending.resolve({ lines: pending.lines, ok: terminator.ok });
            } else {
              pending.lines.push(line);
              // Result line seen (or more lines after it): (re)arm the idle completion.
              if (pending.idleTimerId || (pending.resultTag && line.toUpperCase().startsWith(pending.resultTag))) {
                if (pending.idleTimerId) clearTimeout(pending.idleTimerId);
                pending.idleTimerId = setTimeout(() => {
                  if (pendingCommandRef.current !== pending) return;
                  pendingCommandRef.current = null;
                  clearPendingTimers(pending);
                  expectTrailingTerminatorRef.current = true;
                  pending.resolve({ lines: pending.lines, ok: true });
                }, RESULT_IDLE_MS);
              }
            }
          } else if (expectTrailingTerminatorRef.current && detectTerminator(line).terminated) {
            expectTrailingTerminatorRef.current = false;
            addLog('RX', line);
          } else {
            addLog('RX', `${line} (URC)`);
            if (detectTerminator(line).terminated) setCancelledCommand(null);
          }
        }
      }
    } catch (error) {
      console.debug('Read loop error:', error);
    } finally {
      if (readerRef.current) {
        try {
          readerRef.current.releaseLock();
        } catch (e) { /* ignore */ }
        readerRef.current = null;
      }
    }
  };

  const startReadLoop = useCallback(async () => {
    if (connectionState !== ConnectionState.CONNECTED || !portRef.current) {
      addLog('SYS', 'Not connected to device', true);
      return;
    }

    if (isReadLoopActive) {
      addLog('SYS', 'AT session already active');
      return;
    }

    setIsBootstrapping(true);
    let result: BootstrapResult;
    try {
      result = await switchToUartPassthrough();
    } finally {
      setIsBootstrapping(false);
    }

    if (result === 'device-failed') {
      setConnectionState(ConnectionState.ERROR);
      return;
    }

    await sleep(400);
    try {
      const stray = await readRawFresh(300);
      if (stray.length > 0) addLog('SYS', `Drained ${stray.length} stray byte(s) before starting AT session`);
    } catch (e) {
      console.debug('Stray byte drain error (ignoring):', e);
    }

    keepReadingRef.current = true;
    setIsReadLoopActive(true);
    addLog('SYS', 'Starting AT command session...');

    readLoopPromiseRef.current = readLoop();

    let attempts = 0;
    while (attempts < 20 && !readerRef.current) {
      await sleep(100);
      attempts++;
    }

    if (readerRef.current) {
      addLog('SYS', 'Ready for AT commands.');
      isWaitingAtReadyRef.current = true;
      setIsWaitingAtReady(true);
      try {
        await waitForAtReady();
      } finally {
        isWaitingAtReadyRef.current = false;
        setIsWaitingAtReady(false);
      }
    } else {
      addLog('SYS', 'Warning: AT session started but reader not ready', true);
    }
  }, [connectionState, isReadLoopActive, addLog]);

  const stopReadLoop = async () => {
    if (!isReadLoopActive) {
      addLog('SYS', 'AT session not active');
      return;
    }

    keepReadingRef.current = false;
    setIsReadLoopActive(false);
    addLog('SYS', 'Stopping AT session...');
    setCancelledCommand(null);

    if (pendingCommandRef.current) {
      clearPendingTimers(pendingCommandRef.current);
      pendingCommandRef.current.resolve(null);
      pendingCommandRef.current = null;
    }

    if (readerRef.current) {
      try {
        await readerRef.current.cancel();
      } catch (e) {
        console.debug('Reader cancel error:', e);
      }
    }

    if (readLoopPromiseRef.current) {
      try {
        await readLoopPromiseRef.current;
      } catch (e) {
        console.debug('Read loop stop error:', e);
      }
      readLoopPromiseRef.current = null;
    }
  };

  const disconnect = async () => {
    addLog('SYS', 'Disconnecting...');

    if (isReadLoopActive) {
      await stopReadLoop();
      await new Promise(r => setTimeout(r, 300));
    }

    await cleanupResources();
    setConnectionState(ConnectionState.DISCONNECTED);
    addLog('SYS', 'Disconnected');
  };

  const connect = async (mode: DriverMode) => {
    await cleanupResources();

    addLog('SYS', `Initiating Connection... Mode: ${mode}`);
    const hasNative = 'serial' in navigator;
    const isSecure = window.isSecureContext;
    addLog('SYS', `Env: Secure=${isSecure}, NativeSupported=${hasNative}`);

    let serialAPI;

    if (mode === DriverMode.NATIVE) {
      if (!hasNative) {
        addLog('SYS', 'Native Serial API not supported in this browser/context.', true);
        return;
      }
      serialAPI = (navigator as any).serial;
    } else if (mode === DriverMode.POLYFILL) {
      serialAPI = polyfillSerial;
    } else {
      serialAPI = (navigator as any).serial || polyfillSerial;
    }

    if (!serialAPI) {
      addLog('SYS', 'No Serial API available.', true);
      return;
    }

    try {
      setConnectionState(ConnectionState.CONNECTING);
      const port = await serialAPI.requestPort();

      addLog('SYS', 'Port selected, opening...');
      try {
        await port.open({ baudRate: BAUD_RATE });
      } catch (openErr: any) {
        const errorDetail = openErr.message || String(openErr);
        addLog('SYS', `Failed to open port: ${errorDetail}`, true);
        addLog('SYS', 'Troubleshooting tips:', true);
        addLog('SYS', '1. Check device is connected via USB', true);
        addLog('SYS', '2. Unplug device and wait 2 seconds, then replug', true);
        addLog('SYS', '3. Close other applications using the port', true);
        addLog('SYS', '4. Try a different USB cable or USB port', true);
        setConnectionState(ConnectionState.ERROR);
        return;
      }

      portRef.current = port;

      // Drain any stray bytes left over from a previous session before doing anything else.
      if (port.readable) {
        try {
          const stray = await readRawFresh(300);
          if (stray.length > 0) {
            addLog('SYS', `Drained ${stray.length} stray byte(s) from port before bootstrap`);
          }
        } catch (e) {
          console.debug('Stray byte drain error (ignoring):', e);
        }
      }

      setConnectionState(ConnectionState.CONNECTED);

      addLog('SYS', `Serial connected using ${mode} mode.`);
      addLog('SYS', 'Use Connect to switch the dongle into UART passthrough mode.');
    } catch (err: any) {
      console.error(err);

      if (err.name === 'NotFoundError' || String(err).includes('No device selected')) {
        addLog('SYS', 'Device selection cancelled.');
        setConnectionState(ConnectionState.DISCONNECTED);
        return;
      }

      setConnectionState(ConnectionState.ERROR);

      let errorMsg = `Connection failed: ${err.message || err}`;
      if (String(err).includes('NetworkError') || String(err).includes('Failed to open')) {
        errorMsg = 'Port busy/locked. Unplug device or close other apps.';
      }
      addLog('SYS', errorMsg, true);
      await cleanupResources();
    }
  };

  const sendCommand = useCallback(async (command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    if (!keepReadingRef.current) {
      addLog('SYS', 'Not ready: click Connect to start an AT session first.', true);
      return;
    }
    if (isWaitingAtReadyRef.current) {
      addLog('SYS', 'Still waiting for Module AT Ready - please wait for the automatic ATI check to finish.', true);
      return;
    }
    const timeoutMs = getATCommandTimeoutMs(trimmed);
    if (timeoutMs > DEFAULT_AT_TIMEOUT_MS) {
      addLog('SYS', `${trimmed} can take a while - waiting up to ${Math.round(timeoutMs / 1000)}s for a response...`);
    }
    setIsSending(true);
    setCancelledCommand(null);
    const inFlight = { command: trimmed, startedAt: Date.now(), timeoutMs };
    inFlightCommandRef.current = inFlight;
    setInFlightCommand(inFlight);
    try {
      await sendATCommand(trimmed, timeoutMs);
    } finally {
      setIsSending(false);
      inFlightCommandRef.current = null;
      setInFlightCommand(null);
    }
  }, [addLog]);

  // Stops waiting for the in-flight command. The module itself may still be
  // busy (e.g. mid operator scan); its late reply will show up in the log as a URC.
  const cancelCommand = useCallback(() => {
    const pending = pendingCommandRef.current;
    if (!pending) return;
    clearPendingTimers(pending);
    pendingCommandRef.current = null;
    pending.resolve(null);
    setCancelledCommand(inFlightCommandRef.current?.command ?? null);
    addLog('SYS', 'Stopped waiting for response. The module may still be busy - a late reply will appear as a URC.', true);
  }, [addLog]);

  return {
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
  };
};
