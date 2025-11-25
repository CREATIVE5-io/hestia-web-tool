import { useState, useRef, useEffect, useCallback } from 'react';
import { ConnectionState, LogEntry, DongleData, MODBUS_CONSTANTS, SerialPort, DriverMode } from '../types';
import { buildReadInputRegisters, buildWriteMultipleRegisters, hexString, parseModbusString } from '../utils/modbus';
// @ts-ignore - The polyfill types aren't always perfect, ignore for build safety
import { serial as polyfillSerial } from 'web-serial-polyfill';

export const useDongleConnection = () => {
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [data, setData] = useState<DongleData>({
    modelName: '--',
    fwVersion: '--',
    imsi: '--',
    status: {
      moduleAtReady: false,
      downlinkReady: false,
      simReady: false,
      networkRegistered: false
    },
    rsrp: '--',
    sinr: '--',
    lastUpdated: 0
  });

  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const keepReadingRef = useRef<boolean>(false);
  const pollIntervalRef = useRef<number | null>(null);
  const readLoopPromiseRef = useRef<Promise<void> | null>(null);
  const lastCommandRef = useRef<string | null>(null);
  const unlockVerifiedRef = useRef<boolean>(false);

  const addLog = useCallback((direction: 'TX' | 'RX' | 'SYS', message: string, isError = false) => {
    setLogs(prev => {
      const newLog: LogEntry = {
        id: Math.random().toString(36).substring(7),
        timestamp: new Date().toLocaleTimeString(),
        direction,
        message,
        isError
      };
      return [newLog, ...prev].slice(0, 100);
    });
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  // Safe cleanup helper
  const cleanupResources = async () => {
    keepReadingRef.current = false;

    if (pollIntervalRef.current) {
      window.clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    // 1. Cancel Reader
    if (readerRef.current) {
      try {
        await readerRef.current.cancel();
      } catch (e) {
        console.debug('Reader cancel error (ignoring):', e);
      }
    }

    // 2. Wait for Read Loop to finish (it releases the lock)
    if (readLoopPromiseRef.current) {
      try {
        await readLoopPromiseRef.current;
      } catch (e) { 
        console.debug('Read loop await error:', e);
      }
      readLoopPromiseRef.current = null;
    }

    // 3. Close Port
    if (portRef.current) {
      try {
        await portRef.current.close();
      } catch (e) {
        console.warn('Port close error:', e);
      }
      portRef.current = null;
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupResources().catch(console.error);
    };
  }, []);

  const writeBytes = async (bytes: Uint8Array) => {
    if (!portRef.current || !portRef.current.writable) return;
    try {
      const writer = portRef.current.writable.getWriter();
      await writer.write(bytes);
      writer.releaseLock();
      addLog('TX', hexString(bytes));
    } catch (err) {
      addLog('SYS', `Write error: ${err}`, true);
    }
  };

  const sendModbusRequest = async (request: Uint8Array): Promise<Uint8Array | null> => {
    await writeBytes(request);
    return null; 
  };

  const disconnect = async () => {
    addLog('SYS', 'Disconnecting...');
    await cleanupResources();
    setConnectionState(ConnectionState.DISCONNECTED);
    addLog('SYS', 'Disconnected');
  };

  const processIncomingDataWithContext = (buffer: Uint8Array): string | null => {
    if (buffer.length < 5) return null;
    const funcCode = buffer[1];
    let parsedInfo: string | null = null;

    if (funcCode === MODBUS_CONSTANTS.READ_INPUT_REGISTERS) {
      const byteCount = buffer[2];
      const dataBytes = buffer.slice(3, 3 + byteCount);
      const registers: number[] = [];
      for(let i=0; i < dataBytes.length; i+=2) {
        if (i+1 < dataBytes.length) registers.push((dataBytes[i] << 8) | dataBytes[i+1]);
      }

      setData(prev => {
        const newState = { ...prev, lastUpdated: Date.now() };
        
        switch(lastCommandRef.current) {
          case 'STATUS': {
             const val = registers[0];
             const statusObj = {
                moduleAtReady: (val & 0x01) > 0,
                downlinkReady: ((val & 0x02) >> 1) > 0,
                simReady: ((val & 0x04) >> 2) > 0,
                networkRegistered: ((val & 0x08) >> 3) > 0
             };
             newState.status = statusObj;
             parsedInfo = `Status: AT=${statusObj.moduleAtReady ? 'OK' : 'NO'}, DL=${statusObj.downlinkReady ? 'OK' : 'NO'}, SIM=${statusObj.simReady ? 'OK' : 'NO'}, NET=${statusObj.networkRegistered ? 'REG' : 'NO'}`;
            break;
          }
          case 'RSRP': {
            const val = parseModbusString(registers);
            newState.rsrp = val;
            parsedInfo = `RSRP: ${val} dBm`;
            break;
          }
          case 'SINR': {
            const val = parseModbusString(registers);
            newState.sinr = val;
            parsedInfo = `SINR: ${val} dB`;
            break;
          }
          case 'MODEL': {
            const val = parseModbusString(registers);
            newState.modelName = val;
            parsedInfo = `Model: ${val}`;
            break;
          }
          case 'FW': {
            const val = parseModbusString(registers);
            newState.fwVersion = val;
            parsedInfo = `FW: ${val}`;
            break;
          }
          case 'IMSI': {
            const val = parseModbusString(registers);
            newState.imsi = val;
            parsedInfo = `IMSI: ${val}`;
            break;
          }
          case 'VERIFY_INIT': {
             const val = parseModbusString(registers);
             if (val && val.length > 0) {
                unlockVerifiedRef.current = true;
                newState.modelName = val;
                parsedInfo = `Init Verification OK (Model: ${val})`;
             } else {
                parsedInfo = `Init Verification Failed`;
             }
             break;
          }
        }
        return newState;
      });
    } else if (funcCode === MODBUS_CONSTANTS.WRITE_MULTIPLE_REGISTERS) {
      parsedInfo = "Write Command Ack";
    }

    return parsedInfo;
  };

  const readLoop = async () => {
    if (!portRef.current || !portRef.current.readable) return;
    if (readerRef.current) return;

    try {
      readerRef.current = portRef.current.readable.getReader();
      while (keepReadingRef.current) {
        const { value, done } = await readerRef.current.read();
        if (done) break;
        if (value) {
          const parsedStr = processIncomingDataWithContext(value);
          const logMsg = parsedStr 
            ? `${hexString(value)} | ${parsedStr}` 
            : hexString(value);
          addLog('RX', logMsg);
        }
      }
    } catch (error) {
       console.debug('Read loop error:', error);
    } finally {
      if (readerRef.current) {
        try {
          readerRef.current.releaseLock();
        } catch (e) { }
        readerRef.current = null;
      }
    }
  };

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const initDongle = async () => {
    let attempts = 0;
    const maxAttempts = 3;
    unlockVerifiedRef.current = false;

    while (attempts < maxAttempts && !unlockVerifiedRef.current) {
      attempts++;
      addLog('SYS', `Initializing Dongle (Password Attempt ${attempts}/${maxAttempts})...`);
      
      const passwordPayload = [0, 0, 0, 0]; 
      const frame = buildWriteMultipleRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_PASSWORD, passwordPayload);
      await sendModbusRequest(frame);
      
      await sleep(300);

      lastCommandRef.current = 'VERIFY_INIT';
      await sendModbusRequest(buildReadInputRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_MODEL_NAME, 5));
      
      await sleep(500);

      if (unlockVerifiedRef.current) {
        addLog('SYS', 'Dongle Unlocked Successfully.');
        break;
      } else {
        addLog('SYS', 'Unlock verification failed, retrying...', true);
      }
    }

    if (!unlockVerifiedRef.current) {
       addLog('SYS', 'CRITICAL: Failed to unlock dongle after multiple attempts.', true);
    }

    await pollStaticInfo();
    startPolling();
  };

  const pollStaticInfo = async () => {
    if (!keepReadingRef.current) return;
    
    lastCommandRef.current = 'MODEL';
    await sendModbusRequest(buildReadInputRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_MODEL_NAME, 5));
    await sleep(200);

    lastCommandRef.current = 'FW';
    await sendModbusRequest(buildReadInputRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_FW_VER, 2));
    await sleep(200);

    lastCommandRef.current = 'IMSI';
    await sendModbusRequest(buildReadInputRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_IMSI, 8));
    await sleep(200);
  };

  const pollStatus = async () => {
    if (!keepReadingRef.current) return;

    lastCommandRef.current = 'STATUS';
    await sendModbusRequest(buildReadInputRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_STATUS, 1));
    await sleep(150);

    lastCommandRef.current = 'SINR';
    await sendModbusRequest(buildReadInputRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_SINR, 2));
    await sleep(150);

    lastCommandRef.current = 'RSRP';
    await sendModbusRequest(buildReadInputRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_RSRP, 2));
  };

  const startPolling = () => {
    if (pollIntervalRef.current) window.clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = window.setInterval(() => {
      if (keepReadingRef.current) pollStatus();
    }, 3000); 
  };

  const connect = async (mode: DriverMode) => {
    await cleanupResources();

    // Diagnostic Logging
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
      // AUTO
      serialAPI = (navigator as any).serial || polyfillSerial;
    }

    if (!serialAPI) {
      addLog('SYS', 'No Serial API available.', true);
      return;
    }

    try {
      setConnectionState(ConnectionState.CONNECTING);
      // Pass empty object or undefined instead of filters: [] which some implementations dislike
      const port = await serialAPI.requestPort();
      
      addLog('SYS', 'Port selected, opening...');
      await port.open({ baudRate: MODBUS_CONSTANTS.BAUD_RATE });
      
      portRef.current = port;
      keepReadingRef.current = true;
      setConnectionState(ConnectionState.CONNECTED);
      
      addLog('SYS', `Connected using ${mode} mode.`);

      readLoopPromiseRef.current = readLoop();
      
      setTimeout(() => {
        if (keepReadingRef.current) initDongle();
      }, 500);

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

  return {
    connectionState,
    connect,
    disconnect,
    logs,
    clearLogs,
    data
  };
};