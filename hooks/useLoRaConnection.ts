import { useState, useCallback, useRef } from 'react';
import { LoRaConfig, LoRaDevice, LoRaSetupProgress, MODBUS_CONSTANTS, ConnectionState, SerialPort, PCIE2CommandResult, LogEntry } from '../types';
import { buildWriteMultipleRegisters, buildReadInputRegisters, atCommandToModbusRegisters, parseReadInputRegistersResponse } from '../utils/modbus';
// @ts-ignore
import { serial as polyfillSerial } from 'web-serial-polyfill';

const LOG_STORAGE_KEY = 'lora-serial-log';
const LOG_MAX = 500;

function loadPersistedLogs(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as LogEntry[];
  } catch { /* ignore */ }
  return [];
}

export const useLoRaConnection = () => {
  // Independent serial connection state
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const keepReadingRef = useRef<boolean>(false);
  const readLoopPromiseRef = useRef<Promise<void> | null>(null);
  const responseResolveQueueRef = useRef<Array<(data: Uint8Array) => void>>([]);
  const responseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const responseBufferRef = useRef<Uint8Array>(new Uint8Array(0));
  const autoTestTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const [config, setConfig] = useState<LoRaConfig | null>(null);
  const [devices, setDevices] = useState<Record<string, LoRaDevice>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupProgress, setSetupProgress] = useState<LoRaSetupProgress | null>(null);
  const [isSetupInProgress, setIsSetupInProgress] = useState(false);
  const [serialPorts, setSerialPorts] = useState<Array<{ port: string; description: string }>>([]);
  const [loraStatus, setLoraStatus] = useState<{ frequency: string; sf: string; channelPlan: string }>({ frequency: '--', sf: '--', channelPlan: '--' });
  const [logs, setLogs] = useState<LogEntry[]>(loadPersistedLogs);

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const addLog = useCallback((direction: 'TX' | 'RX' | 'SYS', message: string, isError = false) => {
    const now = new Date();
    const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    const newLog: LogEntry = {
      id: `${Date.now()}-${Math.random()}`,
      timestamp,
      direction,
      message,
      isError,
    };
    setLogs(prev => {
      const updated = [...prev.slice(-(LOG_MAX - 1)), newLog];
      try { localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(updated)); } catch { /* quota exceeded */ }
      return updated;
    });
  }, []);

  const clearLogs = useCallback(() => {
    localStorage.removeItem(LOG_STORAGE_KEY);
    setLogs([]);
  }, []);

  // Serial write function
  const writeBytes = async (bytes: Uint8Array) => {
    if (!portRef.current || !portRef.current.writable) return;
    try {
      const writer = portRef.current.writable.getWriter();
      await writer.write(bytes);
      writer.releaseLock();
    } catch (err) {
      console.error('Write error:', err);
      addLog('SYS', `Write error: ${err}`, true);
    }
  };

  // Send Modbus request and wait for response
  const sendModbusRequest = async (request: Uint8Array, timeout: number = 2000): Promise<Uint8Array | null> => {
    await writeBytes(request);
    
    if (!keepReadingRef.current) {
      console.warn('Read loop not active');
    }
    
    return new Promise((resolve) => {
      const resolver = (data: Uint8Array) => {
        const idx = responseResolveQueueRef.current.indexOf(resolver);
        if (idx !== -1) {
          responseResolveQueueRef.current.splice(idx, 1);
        }
        if (responseTimeoutRef.current) {
          clearTimeout(responseTimeoutRef.current);
          responseTimeoutRef.current = null;
        }
        resolve(data);
      };
      
      responseResolveQueueRef.current.push(resolver);
      
      responseTimeoutRef.current = window.setTimeout(() => {
        responseTimeoutRef.current = null;
        const idx = responseResolveQueueRef.current.indexOf(resolver);
        if (idx !== -1) {
          responseResolveQueueRef.current.splice(idx, 1);
        }
        console.error('Modbus response timeout');
        addLog('SYS', 'Modbus response timeout', true);
        resolve(null);
      }, timeout);
    });
  };

  // Read loop with buffering
  const readLoop = async () => {
    if (!portRef.current || !portRef.current.readable) return;
    if (readerRef.current) return;

    try {
      readerRef.current = portRef.current.readable.getReader();
      while (keepReadingRef.current) {
        const { value, done } = await readerRef.current.read();
        if (done) break;
        if (value) {
          const combined = new Uint8Array(responseBufferRef.current.length + value.length);
          combined.set(responseBufferRef.current);
          combined.set(value, responseBufferRef.current.length);
          responseBufferRef.current = combined;
          
          if (responseBufferRef.current.length >= 5) {
            const funcCode = responseBufferRef.current[1];
            let expectedLength = 0;
            
            if (funcCode === 0x04) {
              const byteCount = responseBufferRef.current[2];
              expectedLength = 3 + byteCount + 2;
            } else if (funcCode === 0x10) {
              expectedLength = 8;
            }
            
            if (expectedLength > 0 && responseBufferRef.current.length >= expectedLength) {
              const completeFrame = responseBufferRef.current.slice(0, expectedLength);
              responseBufferRef.current = responseBufferRef.current.slice(expectedLength);
              
              if (responseResolveQueueRef.current.length > 0) {
                const resolver = responseResolveQueueRef.current.shift();
                if (resolver) {
                  resolver(completeFrame);
                }
              }
            }
          }
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

  // Start read loop
  const startReadLoop = async () => {
    if (keepReadingRef.current) return;
    keepReadingRef.current = true;
    readLoopPromiseRef.current = readLoop();
    await sleep(500);
  };

  // Stop read loop
  const stopReadLoop = async () => {
    keepReadingRef.current = false;
    if (readerRef.current) {
      try {
        await readerRef.current.cancel();
      } catch (e) { }
    }
    if (readLoopPromiseRef.current) {
      try {
        await readLoopPromiseRef.current;
      } catch (e) { }
      readLoopPromiseRef.current = null;
    }
  };

  // Connect to serial port
  const connect = async () => {
    try {
      const serialAPI = (navigator as any).serial || polyfillSerial;
      const port = await serialAPI.requestPort();
      
      // Always close port first if it has any streams
      try {
        if ((port as any).readable || (port as any).writable) {
          await port.close();
          await sleep(500);
        }
      } catch (e) {
        console.debug('Port close before open:', e);
      }
      
      await port.open({ baudRate: MODBUS_CONSTANTS.BAUD_RATE });

      portRef.current = port;
      setConnectionState(ConnectionState.CONNECTED);
      addLog('SYS', `Connected at ${MODBUS_CONSTANTS.BAUD_RATE} baud`);

      // Set password
      const passwordPayload = [0, 0, 0, 0];
      const frame = buildWriteMultipleRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_PASSWORD, passwordPayload);
      await writeBytes(frame);
      await sleep(300);
      
      // Auto-run test commands after connection
      autoTestTimeoutRef.current = setTimeout(() => {
        testLoRaCommands();
      }, 1000);
    } catch (err) {
      console.error('Connection failed:', err);
      addLog('SYS', `Connection failed: ${err}`, true);
      setConnectionState(ConnectionState.ERROR);
    }
  };

  // Disconnect
  const disconnect = async () => {
    // Cancel auto-test if pending
    if (autoTestTimeoutRef.current) {
      clearTimeout(autoTestTimeoutRef.current);
      autoTestTimeoutRef.current = null;
    }
    
    // Stop read loop first if active
    keepReadingRef.current = false;
    if (readLoopPromiseRef.current) {
      await stopReadLoop();
      await sleep(300);
    }
    
    if (portRef.current) {
      try {
        await portRef.current.close();
      } catch (e) {
        console.debug('Port close error:', e);
      }
      portRef.current = null;
    }
    setConnectionState(ConnectionState.DISCONNECTED);
    addLog('SYS', 'Disconnected');
  };

  // Send PCIE2 command
  const sendPCIE2Command = async (command: string, maxRetries: number = 10): Promise<PCIE2CommandResult> => {
    try {
      if (!keepReadingRef.current) {
        await startReadLoop();
      }

      addLog('TX', command);

      const atCmdRegisters = atCommandToModbusRegisters(command);
      const cmdFrame = buildWriteMultipleRegisters(
        MODBUS_CONSTANTS.SLAVE_ID,
        MODBUS_CONSTANTS.PCIE2_CMD_START,
        atCmdRegisters
      );

      await sendModbusRequest(cmdFrame, 1000);
      await sleep(3000);

      let dataLength = 0;
      let retries = 0;

      while (retries < maxRetries && dataLength === 0 && keepReadingRef.current) {
        const lenResponse = await sendModbusRequest(buildReadInputRegisters(
          MODBUS_CONSTANTS.SLAVE_ID,
          MODBUS_CONSTANTS.PCIE2_MOD_LEN,
          1
        ), 1000);
        
        if (lenResponse) {
          const parsed = parseReadInputRegistersResponse(lenResponse);
          if (parsed.success && parsed.registers.length > 0) {
            dataLength = parsed.registers[0];
          }
        }
        
        retries++;
        if (retries < maxRetries && dataLength === 0) {
          await sleep(200);
        }
      }

      let responseData = '';
      if (dataLength > 0) {
        const dataResponse = await sendModbusRequest(buildReadInputRegisters(
          MODBUS_CONSTANTS.SLAVE_ID,
          MODBUS_CONSTANTS.PCIE2_MOD_START,
          dataLength
        ), 2000);
        
        if (dataResponse) {
          const parsed = parseReadInputRegistersResponse(dataResponse);
          if (parsed.success && parsed.registers.length > 0) {
            const dataBytes: number[] = [];
            for (const reg of parsed.registers) {
              dataBytes.push((reg >> 8) & 0xFF);
              dataBytes.push(reg & 0xFF);
            }
            responseData = dataBytes.slice(0, dataLength*2)
              .map(byte => String.fromCharCode(byte))
              .join('');
            
            // Only extract value after colon for query commands (not BISDEV/BISOTAA — return full raw data)
            if (!command.includes('BISDEV') && !command.includes('BISOTAA')) {
              const match = responseData.match(/:\s*(\S+)/);
              if (match) {
                responseData = match[1];
              }
            }
          }
        }
      }
      
      const result = responseData || 'OK';
      addLog('RX', result);
      return {
        success: true,
        data: result,
        dataLength: dataLength,
      };
    } catch (error) {
      addLog('SYS', `Command error: ${error}`, true);
      return { success: false, data: null, dataLength: 0, error: String(error) };
    }
  };


  const validateDevice = (device: LoRaDevice): { valid: boolean; error?: string } => {
    if (!device.id || device.id.length !== 8) {
      return { valid: false, error: 'Device ID must be exactly 8 characters' };
    }
    if (!device.nsKey || device.nsKey.length !== 32) {
      return { valid: false, error: 'Network Session Key must be exactly 32 hex characters' };
    }
    if (!device.appKey || device.appKey.length !== 32) {
      return { valid: false, error: 'Application Session Key must be exactly 32 hex characters' };
    }
    const idx = parseInt(device.idx);
    if (isNaN(idx) || idx < 0 || idx > 15) {
      return { valid: false, error: 'Device index must be between 0 and 15' };
    }
    if (device.otaaMode) {
      if (!device.devEUI || device.devEUI.length !== 16) {
        return { valid: false, error: 'DevEUI must be exactly 16 hex characters' };
      }
      if (!device.appEUI || device.appEUI.length !== 16) {
        return { valid: false, error: 'AppEUI must be exactly 16 hex characters' };
      }
    }
    return { valid: true };
  };

  // Validate LoRa config
  const validateConfig = (cfg: LoRaConfig): { valid: boolean; error?: string } => {
    if (!cfg.frequency || cfg.frequency.length !== 9) {
      return { valid: false, error: 'Frequency must be 9 digits' };
    }
    if (!['7', '8', '9', '10', '11', '12'].includes(cfg.sf)) {
      return { valid: false, error: 'Spreading Factor must be 7-12' };
    }
    if (!['0', '1', '2', '3', '4', '5', '6'].includes(cfg.ch_plan)) {
      return { valid: false, error: 'Channel plan must be 0-6' };
    }
    return { valid: true };
  };

  // Validate device data according to Python constraints
  const testLoRaCommands = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      if (!keepReadingRef.current) {
        await startReadLoop();
      }

      if (!keepReadingRef.current) return;
      const freqResult = await sendPCIE2Command('AT+BISRXF=?');
      const frequency = freqResult.data || '--';
      await sleep(500);

      if (!keepReadingRef.current) return;
      const sfResult = await sendPCIE2Command('AT+BISRXSF=?');
      const sf = sfResult.data || '--';
      await sleep(500);

      if (!keepReadingRef.current) return;
      const chResult = await sendPCIE2Command('AT+BISCHPLAN=?');
      const channelPlan = chResult.data || '--';
      
      // Update loraStatus with results
      setLoraStatus({ frequency, sf, channelPlan });

      setError(null);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to test LoRa commands';
      console.error('LoRa test error:', err);
      setError(errorMsg);
    } finally {
      setIsLoading(false);
    }
  }, []);


  const updateLoRaSettings = useCallback(
    async (frequency: string, sf: string, ch_plan: string): Promise<boolean> => {
      const newConfig: LoRaConfig = {
        frequency,
        sf,
        ch_plan,
        serial_interface: config?.serial_interface || '',
      };

      const validation = validateConfig(newConfig);
      if (!validation.valid) {
        setError(validation.error || 'Invalid configuration');
        return false;
      }

      setConfig(newConfig);
      setError(null);
      return true;
    },
    [config]
  );

  // Update serial interface
  const updateSerialInterface = useCallback(
    async (serialInterface: string): Promise<boolean> => {
      if (!config) {
        setConfig({
          frequency: '',
          sf: '7',
          ch_plan: '0',
          serial_interface: serialInterface,
        });
      } else {
        setConfig({
          ...config,
          serial_interface: serialInterface,
        });
      }
      return true;
    },
    [config]
  );

  // Add a LoRa device with validation
  const addDevice = useCallback(
    async (device: LoRaDevice): Promise<boolean> => {
      const validation = validateDevice(device);
      if (!validation.valid) {
        setError(validation.error || 'Invalid device data');
        return false;
      }

      // Check if device index already exists
      if (devices[device.idx]) {
        setError(`Device with index ${device.idx} already exists`);
        return false;
      }

      // Check device count limit
      if (Object.keys(devices).length >= 16) {
        setError('Maximum of 16 devices allowed');
        return false;
      }

      if (!keepReadingRef.current) {
        setError('Not connected to device');
        return false;
      }

      try {
        // Send AT command to add device
        const cmd = `AT+BISDEV=${device.idx}:${device.id}:${device.nsKey}:${device.appKey}`;
        const result = await sendPCIE2Command(cmd);
        if (!result.success) throw new Error('Failed to add device to hardware');
        await sleep(500);

        // Send OTAA parameters if OTAA mode is enabled
        // Format: AT+BISOTAA={idx}:{AppEUI 16chars}:{DevEUI 16chars}:{AppKey 32chars}
        if (device.otaaMode && device.appEUI && device.devEUI) {
          const otaaCmd = `AT+BISOTAA=${device.idx}:${device.appEUI}:${device.devEUI}:${device.appKey}`;
          const otaaResult = await sendPCIE2Command(otaaCmd);
          if (!otaaResult.success) throw new Error('Failed to set OTAA parameters');
          await sleep(500);
        }

        // Save parameters
        const saveResult = await sendPCIE2Command('AT+BISS');
        if (!saveResult.success) throw new Error('Failed to save parameters');
        await sleep(500);

        setDevices(prev => ({
          ...prev,
          [device.idx]: device,
        }));
        setError(null);
        return true;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to add device';
        setError(errorMsg);
        return false;
      }
    },
    [devices]
  );

  // Delete devices
  const deleteDevices = useCallback(
    async (deviceIndices: (string | number)[]): Promise<boolean> => {
      if (!keepReadingRef.current) {
        setError('Not connected to device');
        return false;
      }

      try {
        for (const idx of deviceIndices) {
          const cmd = `AT+BISDEV=${idx}:ffffffff:ffffffffffffffffffffffffffffffff:ffffffffffffffffffffffffffffffff`;
          const result = await sendPCIE2Command(cmd);
          if (!result.success) throw new Error(`Failed to delete device ${idx} from hardware`);
          await sleep(500);

          // Also clean OTAA slot if this device had OTAA enabled
          if (devices[idx]?.otaaMode) {
            const otaaCmd = `AT+BISOTAA=${idx}:ffffffffffffffff:ffffffffffffffff:ffffffffffffffffffffffffffffffff`;
            await sendPCIE2Command(otaaCmd);
            await sleep(500);
          }
        }

        // Save parameters
        const saveResult = await sendPCIE2Command('AT+BISS');
        if (!saveResult.success) throw new Error('Failed to save parameters after deletion');
        await sleep(500);

        const newDevices = { ...devices };
        deviceIndices.forEach(idx => {
          delete newDevices[idx];
        });
        setDevices(newDevices);
        setError(null);
        return true;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to delete device';
        setError(errorMsg);
        return false;
      }
    },
    [devices]
  );

  // Clear all devices
  const clearDevices = useCallback(() => {
    setDevices({});
    return true;
  }, []);


  const fetchLoRaData = useCallback(async () => {
    setIsLoading(true);
    try {
      // Initialize with empty config if not already set
      if (!config) {
        setConfig({
          frequency: '',
          sf: '7',
          ch_plan: '0',
          serial_interface: '',
        });
      }
      // Query current settings from device is disabled on page load
      // Use testLoRaCommands button to manually query device settings
      // await queryLoRaSettings();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch LoRa data');
    } finally {
      setIsLoading(false);
    }
  }, [config]);

  // Fetch available serial ports
  const fetchSerialPorts = useCallback(async () => {
    try {
      // Mock serial ports - in real implementation, query from backend
      setSerialPorts([
        { port: '/dev/ttyUSB0', description: 'USB Serial Device' },
        { port: '/dev/ttyUSB1', description: 'USB Serial Device' },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch serial ports');
    }
  }, []);

  // Start LoRa config setup with progress polling
  const startLoRaConfigSetup = useCallback(async (configToApply?: LoRaConfig) => {
    const targetConfig = configToApply || config;
    
    if (!targetConfig) {
      setError('No configuration to apply');
      return;
    }

    const validation = validateConfig(targetConfig);
    if (!validation.valid) {
      setError(validation.error || 'Invalid configuration');
      return;
    }

    if (!keepReadingRef.current) {
      setError('Not connected to device');
      return;
    }

    setIsSetupInProgress(true);
    setError(null);
    
    try {
      setSetupProgress({ stage: 'config', current: 0, total: 3, message: 'Setting frequency...' });
      const freqResult = await sendPCIE2Command(`AT+BISRXF=${targetConfig.frequency}`);
      if (!freqResult.success) throw new Error('Failed to set frequency');
      await sleep(500);

      setSetupProgress({ stage: 'config', current: 1, total: 3, message: 'Setting spreading factor...' });
      const sfResult = await sendPCIE2Command(`AT+BISRXSF=${targetConfig.sf}`);
      if (!sfResult.success) throw new Error('Failed to set spreading factor');
      await sleep(500);

      setSetupProgress({ stage: 'config', current: 2, total: 3, message: 'Setting channel plan...' });
      const chResult = await sendPCIE2Command(`AT+BISCHPLAN=${targetConfig.ch_plan}`);
      if (!chResult.success) throw new Error('Failed to set channel plan');
      await sleep(500);

      const saveResult = await sendPCIE2Command('AT+BISS');
      if (!saveResult.success) throw new Error('Failed to save configuration');
      await sleep(500);

      const resetResult = await sendPCIE2Command('ATZ');
      if (!resetResult.success) throw new Error('Failed to reset module');
      await sleep(500);

      setSetupProgress({ stage: 'config', current: 3, total: 3, message: 'Configuration complete!' });
      setConfig(targetConfig);
      await testLoRaCommands();
      
      setTimeout(() => {
        setIsSetupInProgress(false);
        setSetupProgress(null);
      }, 2000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Configuration failed';
      setError(errorMsg);
      setIsSetupInProgress(false);
      setSetupProgress(null);
    }
  }, [config, testLoRaCommands]);

  // List LoRa devices from hardware
  const listLoRaDevices = useCallback(async () => {
    if (!keepReadingRef.current) {
      setError('Not connected to device');
      return;
    }

    setIsLoading(true);
    setError(null);
    const foundDevices: Record<string, LoRaDevice> = {};

    try {
      // Pass 1: scan all 16 BISDEV slots — OTAA queries are deferred so they don't
      // block the hardware and cause subsequent BISDEV writes to time out.
      for (let i = 0; i < 16; i++) {
        const result = await sendPCIE2Command(`AT+BISDEV=${i}?`);
        await sleep(300);

        if (result.success && result.data) {
          // Parse format: [index] deviceID:nsKey:appKey
          const match = result.data.match(/\[(\d+)\]\s*([^:]+):([^:]+):(.+)/);
          if (match) {
            const [,, id, nsKey, appKey] = match;
            if (id !== 'ffffffff' && id.toLowerCase() !== '0xffffffff' && nsKey !== 'ffffffffffffffffffffffffffffffff') {
              foundDevices[i] = {
                idx: String(i),
                id: id.replace('0x', ''),
                nsKey,
                appKey,
                transmit_interval: '60',
              };
            }
          }
        }
      }

      // Pass 2: query OTAA params for every found device (0–15)
      for (const idxStr of Object.keys(foundDevices)) {
        const i = parseInt(idxStr);
        const otaaResult = await sendPCIE2Command(`AT+BISOTAA=${i}?`);
        await sleep(300);
        if (otaaResult.success && otaaResult.data) {
          // Response format: [idx] DevEUI:value,AppEUI:value,AppKey:value OK
          const otaaMatch = otaaResult.data.match(/DevEUI:([0-9a-fA-F]{16}),AppEUI:([0-9a-fA-F]{16})/i);
          if (otaaMatch) {
            const [, devEUI, appEUI] = otaaMatch;
            const nullEUI = 'ffffffffffffffff';
            if (appEUI.toLowerCase() !== nullEUI && devEUI.toLowerCase() !== nullEUI) {
              foundDevices[i].appEUI = appEUI;
              foundDevices[i].devEUI = devEUI;
              foundDevices[i].otaaMode = true;
            }
          }
        }
      }

      setDevices(foundDevices);
      setError(null);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to list devices';
      setError(errorMsg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Start LoRa devices setup with progress polling
  const startLoRaDevicesSetup = useCallback(async () => {
    if (!keepReadingRef.current) {
      setError('Not connected to device');
      return;
    }

    const deviceList = Object.values(devices);
    if (deviceList.length === 0) {
      setError('No devices to setup');
      return;
    }

    setIsSetupInProgress(true);
    setError(null);

    try {
      for (let i = 0; i < deviceList.length; i++) {
        const device = deviceList[i];
        setSetupProgress({ 
          stage: 'devices', 
          current: i, 
          total: deviceList.length, 
          message: `Setting up device ${device.idx}...` 
        });

        const cmd = `AT+BISDEV=${device.idx}:${device.id}:${device.nsKey}:${device.appKey}`;
        const result = await sendPCIE2Command(cmd);
        if (!result.success) throw new Error(`Failed to setup device ${device.idx}`);
        await sleep(500);
      }

      setSetupProgress({ 
        stage: 'devices', 
        current: deviceList.length, 
        total: deviceList.length, 
        message: 'All devices setup complete!' 
      });

      setTimeout(() => {
        setIsSetupInProgress(false);
        setSetupProgress(null);
      }, 2000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Device setup failed';
      setError(errorMsg);
      setIsSetupInProgress(false);
      setSetupProgress(null);
    }
  }, [devices]);

  // Clear setup progress
  const clearSetupProgress = useCallback(() => {
    setSetupProgress(null);
    setIsSetupInProgress(false);
  }, []);

  return {
    connectionState,
    connect,
    disconnect,
    config,
    devices,
    isLoading,
    error,
    setupProgress,
    isSetupInProgress,
    serialPorts,
    loraStatus,
    logs,
    clearLogs,
    validateDevice,
    validateConfig,
    testLoRaCommands,
    updateLoRaSettings,
    updateSerialInterface,
    addDevice,
    deleteDevices,
    clearDevices,
    fetchLoRaData,
    fetchSerialPorts,
    startLoRaConfigSetup,
    startLoRaDevicesSetup,
    clearSetupProgress,
    sendPCIE2Command,
    listLoRaDevices,
  };
};
