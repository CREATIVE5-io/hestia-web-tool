import { useState, useRef, useEffect, useCallback } from 'react';
import { ConnectionState, LogEntry, DongleData, MODBUS_CONSTANTS, SerialPort, DriverMode, NTNConfig, PCIE2CommandResult } from '../types';
import type { DongleModel } from '../components/DongleModelPanel';
import { buildReadInputRegisters, buildReadHoldingRegisters, buildWriteMultipleRegisters, hexString, parseModbusString, stringToModbusRegisters, atCommandToModbusRegisters, parseReadInputRegistersResponse, parseHoldingRegistersResponse } from '../utils/modbus';
// @ts-ignore - The polyfill types aren't always perfect, ignore for build safety
import { serial as polyfillSerial } from 'web-serial-polyfill';

const LOG_STORAGE_KEY = 'ntn-serial-log';
const LOG_MAX = 500;

function loadPersistedLogs(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as LogEntry[];
  } catch { /* ignore */ }
  return [];
}

export const useDongleConnection = (dongleModel: DongleModel = 'A1') => {
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [logs, setLogs] = useState<LogEntry[]>(loadPersistedLogs);
  const [isReadLoopActive, setIsReadLoopActive] = useState(false);
  const [data, setData] = useState<DongleData>({
    modelName: '--',
    fwVersion: '--',
    imsi: '--',
    status: {
      moduleAtReady: false,
      downlinkReady: false,
      simReady: false,
      networkRegistered: false,
      socketReady: false
    },
    rsrp: '--',
    sinr: '--',
    loraData: '--',
    lastUpdated: 0,
    configApplied: false
  });

  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const keepReadingRef = useRef<boolean>(false);
  const pollIntervalRef = useRef<number | null>(null);
  const readLoopPromiseRef = useRef<Promise<void> | null>(null);
  const lastCommandRef = useRef<string | null>(null);
  const unlockVerifiedRef = useRef<boolean>(false);
  const pcie2ResponseRef = useRef<{ length: number; data: Uint8Array | null }>({ length: 0, data: null });
  const isClosingRef = useRef<boolean>(false);
  const dongleModelRef = useRef<DongleModel>(dongleModel);

  // Response queue for request/response matching - supports multiple pending requests
  const responseResolveQueueRef = useRef<Array<(data: Uint8Array) => void>>([]);
  const responseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const responseBufferRef = useRef<Uint8Array>(new Uint8Array(0));

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

  // Safe cleanup helper
  const cleanupResources = async () => {
    // Prevent multiple simultaneous close operations
    if (isClosingRef.current) {
      console.debug('Close already in progress, skipping');
      return;
    }
    isClosingRef.current = true;

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
        console.debug('Port close error (ignoring):', e);
      }
      portRef.current = null;
    }

    isClosingRef.current = false;
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupResources().catch(console.error);
    };
  }, []);

  useEffect(() => {
    dongleModelRef.current = dongleModel;
  }, [dongleModel]);

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

  const sendModbusRequest = async (request: Uint8Array, timeout: number = 2000): Promise<Uint8Array | null> => {
    await writeBytes(request);
    
    // Check if read loop is active
    if (!keepReadingRef.current) {
      addLog('SYS', 'Warning: Read loop not active, response may not be captured', true);
    }
    
    // Wait for response with timeout
    return new Promise((resolve) => {
      const resolver = (data: Uint8Array) => {
        // Remove this resolver from queue
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
      
      // Add resolver to queue
      responseResolveQueueRef.current.push(resolver);
      
      responseTimeoutRef.current = window.setTimeout(() => {
        responseTimeoutRef.current = null;
        // Remove from queue if still there
        const idx = responseResolveQueueRef.current.indexOf(resolver);
        if (idx !== -1) {
          responseResolveQueueRef.current.splice(idx, 1);
        }
        addLog('SYS', 'Modbus response timeout (no data received)', true);
        resolve(null);
      }, timeout);
    });
  };

  const disconnect = async () => {
    addLog('SYS', 'Disconnecting...');
    
    // Stop read loop first if active
    if (isReadLoopActive) {
      await stopReadLoop();
      // Wait for operations to complete
      await new Promise(r => setTimeout(r, 300));
    }
    
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

      const command = lastCommandRef.current;
      setData(prev => {
        const newState = { ...prev, lastUpdated: Date.now() };

        switch(command) {
          case 'STATUS': {
             const val = registers[0];
             const statusObj = {
                moduleAtReady: (val & 0x01) > 0,
                downlinkReady: ((val & 0x02) >> 1) > 0,
                simReady: ((val & 0x04) >> 2) > 0,
                networkRegistered: ((val & 0x08) >> 3) > 0,
                socketReady: ((val & 0x10) >> 4) > 0
             };
             newState.status = statusObj;
             const netStatus = val === 0x1F;
             parsedInfo = `Status: AT=${statusObj.moduleAtReady ? 'OK' : 'NO'}, IP=${statusObj.downlinkReady ? 'OK' : 'NO'}, SIM=${statusObj.simReady ? 'OK' : 'NO'}, NET=${statusObj.networkRegistered ? 'REG' : 'NO'}, SOCK=${statusObj.socketReady ? 'OK' : 'NO'} (${netStatus ? 'ALL_READY' : 'PARTIAL'})`;
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
          case 'PCIE2_LENGTH': {
            // Extract response length from first register
            const length = registers[0] || 0;
            pcie2ResponseRef.current.length = length;
            parsedInfo = `PCIE2 Response Length: ${length} bytes`;
            break;
          }
          case 'PCIE2_DATA': {
            // Store raw response data for later conversion
            pcie2ResponseRef.current.data = dataBytes;
            parsedInfo = `PCIE2 Response Data: ${dataBytes.length} bytes received`;
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
    } else if (funcCode === MODBUS_CONSTANTS.READ_HOLDING_REGISTERS) {
      parsedInfo = `Holding Reg: ${lastCommandRef.current ?? '?'}`;
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
          // Accumulate data in buffer
          const combined = new Uint8Array(responseBufferRef.current.length + value.length);
          combined.set(responseBufferRef.current);
          combined.set(value, responseBufferRef.current.length);
          responseBufferRef.current = combined;
          
          // Check if we have a complete Modbus frame
          if (responseBufferRef.current.length >= 5) {
            const funcCode = responseBufferRef.current[1];
            let expectedLength = 0;
            
            if (funcCode === 0x04 || funcCode === 0x03) { // Read Input / Holding Registers
              const byteCount = responseBufferRef.current[2];
              expectedLength = 3 + byteCount + 2; // header + data + CRC
            } else if (funcCode === 0x10) { // Write Multiple Registers
              expectedLength = 8; // fixed length
            }
            
            // If we have complete frame, dispatch it
            if (expectedLength > 0 && responseBufferRef.current.length >= expectedLength) {
              const completeFrame = responseBufferRef.current.slice(0, expectedLength);
              responseBufferRef.current = responseBufferRef.current.slice(expectedLength);
              
              // Dispatch to pending response handler
              if (responseResolveQueueRef.current.length > 0) {
                const resolver = responseResolveQueueRef.current.shift();
                if (resolver) {
                  resolver(completeFrame);
                }
              }
              
              // Process for context-based parsing
              const parsedStr = processIncomingDataWithContext(completeFrame);
              const ascii = Array.from(completeFrame)
                .map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.')
                .join('');
              const logMsg = parsedStr 
                ? `${hexString(completeFrame)} (${ascii}) | ${parsedStr}` 
                : `${hexString(completeFrame)} (${ascii})`;
              addLog('RX', logMsg);
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

    await pollCurrentConfig();
  };

  const pollCurrentConfig = async () => {
    if (!keepReadingRef.current) return;
    addLog('SYS', 'Reading current device configuration...');

    const cfg = { apn: '', remoteIp: '', remotePort: '', localPort: '' };

    lastCommandRef.current = 'CONFIG_REMOTE_PORT';
    const portResp = await sendModbusRequest(buildReadHoldingRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_REMOTE_PORT, 3));
    if (portResp) {
      const { registers, success } = parseHoldingRegistersResponse(portResp);
      if (success) cfg.remotePort = parseModbusString(registers);
    }
    await sleep(200);

    lastCommandRef.current = 'CONFIG_APN';
    const apnResp = await sendModbusRequest(buildReadHoldingRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_APN, 15));
    if (apnResp) {
      const { registers, success } = parseHoldingRegistersResponse(apnResp);
      if (success) cfg.apn = parseModbusString(registers);
    }
    await sleep(200);

    lastCommandRef.current = 'CONFIG_REMOTE_IP';
    const ipResp = await sendModbusRequest(buildReadHoldingRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_REMOTE_IP, 11));
    if (ipResp) {
      const { registers, success } = parseHoldingRegistersResponse(ipResp);
      if (success) cfg.remoteIp = parseModbusString(registers);
    }
    await sleep(200);

    lastCommandRef.current = 'CONFIG_LOCAL_PORT';
    const localPortResp = await sendModbusRequest(buildReadHoldingRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_LOCAL_PORT, 3));
    if (localPortResp) {
      const { registers, success } = parseHoldingRegistersResponse(localPortResp);
      if (success) cfg.localPort = parseModbusString(registers);
    }
    await sleep(200);

    setData(prev => ({ ...prev, currentConfig: cfg }));
    addLog('SYS', `Device config: APN=${cfg.apn}, IP=${cfg.remoteIp}, Port=${cfg.remotePort}, LocalPort=${cfg.localPort}`);
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

    if (dongleModelRef.current === 'A2') {
      await sleep(200);
      await pollLoraData();
    }
  };

  const startPolling = () => {
    if (pollIntervalRef.current) window.clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = window.setInterval(() => {
      if (keepReadingRef.current) pollStatus();
    }, 3000); 
  };

  const applyNTNConfig = async (config: NTNConfig): Promise<void> => {
    if (!keepReadingRef.current || !unlockVerifiedRef.current) {
      throw new Error('Device not ready for configuration');
    }

    addLog('SYS', 'Applying NTN Configuration...');

    try {
      // Set Remote Port
      const remotePortData = stringToModbusRegisters(config.remotePort);
      await sendModbusRequest(buildWriteMultipleRegisters(
        MODBUS_CONSTANTS.SLAVE_ID,
        MODBUS_CONSTANTS.ADDR_REMOTE_PORT,
        remotePortData
      ));
      await sleep(200);
      addLog('SYS', `Remote Port set: ${config.remotePort}`);

      // Set APN
      const apnData = stringToModbusRegisters(config.apn);
      await sendModbusRequest(buildWriteMultipleRegisters(
        MODBUS_CONSTANTS.SLAVE_ID,
        MODBUS_CONSTANTS.ADDR_APN,
        apnData
      ));
      await sleep(200);
      addLog('SYS', `APN set: ${config.apn}`);

      // Set Remote IP
      const remoteIpData = stringToModbusRegisters(config.remoteIp);
      await sendModbusRequest(buildWriteMultipleRegisters(
        MODBUS_CONSTANTS.SLAVE_ID,
        MODBUS_CONSTANTS.ADDR_REMOTE_IP,
        remoteIpData
      ));
      await sleep(200);
      addLog('SYS', `Remote IP set: ${config.remoteIp}`);

      // Set Local Port (default to 55001 if not provided)
      const localPort = config.localPort || '55001';
      const localPortData = stringToModbusRegisters(localPort);
      await sendModbusRequest(buildWriteMultipleRegisters(
        MODBUS_CONSTANTS.SLAVE_ID,
        MODBUS_CONSTANTS.ADDR_LOCAL_PORT,
        localPortData
      ));
      await sleep(200);
      addLog('SYS', `Local Port set: ${localPort}`);

      setData(prev => ({ ...prev, configApplied: true }));
      addLog('SYS', 'Configuration applied successfully!');

    } catch (error) {
      addLog('SYS', `Configuration failed: ${error}`, true);
      throw error;
    }
  };

  /**
   * PCIE2 CMD: Send AT command to PCIe2 module
   * Follows the protocol:
   * 1. Write command to PCIE2_CMD_START (0xC700)
   * 2. Wait for response (1-5 seconds depending on command)
   * 3. Read response length from PCIE2_MOD_LEN (0xF860) or PCIE2_DATA_LEN (0xF460)
   * 4. Read response data starting from PCIE2_MOD_START (0xF861) or PCIE2_DATA_START (0xF461)
   */
  const sendPCIE2Command = async (command: string, maxRetries: number = 10): Promise<PCIE2CommandResult> => {
    addLog('SYS', `PCIE2 CMD: Sending "${command}"`);

    try {
      // Diagnostic: Check if read loop is active
      if (!keepReadingRef.current) {
        addLog('SYS', 'WARNING: Read loop is not active. Start it before sending PCIE2 commands.', true);
      }
      
      // Step 1: Write AT command to PCIE2_CMD_START
      const atCmdRegisters = atCommandToModbusRegisters(command);
      const cmdFrame = buildWriteMultipleRegisters(
        MODBUS_CONSTANTS.SLAVE_ID,
        MODBUS_CONSTANTS.PCIE2_CMD_START,
        atCmdRegisters
      );
      
      const cmdResponse = await sendModbusRequest(cmdFrame, 1000);
      if (cmdResponse) {
        addLog('SYS', `PCIE2 CMD: Command write acknowledged`);
      }
      
      // Step 2: Determine wait time and response register addresses
      let waitTime = 3000;
      let respLenReg = MODBUS_CONSTANTS.PCIE2_MOD_LEN;
      let respDataReg = MODBUS_CONSTANTS.PCIE2_MOD_START;

      if (command === 'ATZ') {
        waitTime = 5000;
      } else if (command.includes('AT+BISGET=')) {
        waitTime = 1000;
        respLenReg = MODBUS_CONSTANTS.PCIE2_DATA_LEN;
        respDataReg = MODBUS_CONSTANTS.PCIE2_DATA_START;
      }

      addLog('SYS', `PCIE2 CMD: Waiting ${waitTime}ms for device to process...`);
      await sleep(waitTime);

      // Step 3: Poll for response length (retry if needed)
      let dataLength = 0;
      let retries = 0;
      lastCommandRef.current = 'PCIE2_LENGTH';

      while (retries < maxRetries && dataLength === 0) {
        const lenResponse = await sendModbusRequest(buildReadInputRegisters(
          MODBUS_CONSTANTS.SLAVE_ID,
          respLenReg,
          1
        ), 1000);
        
        if (lenResponse) {
          const parsed = parseReadInputRegistersResponse(lenResponse);
          if (parsed.success && parsed.registers.length > 0) {
            dataLength = parsed.registers[0];
            addLog('SYS', `PCIE2 CMD: Response length = ${dataLength} bytes`);
          } else {
            addLog('SYS', `PCIE2 CMD: Parse failed for response (retry ${retries + 1}/${maxRetries})`);
          }
        } else {
          addLog('SYS', `PCIE2 CMD: No response for length query (retry ${retries + 1}/${maxRetries})`);
        }
        
        retries++;
        
        if (retries < maxRetries && dataLength === 0) {
          addLog('SYS', `PCIE2 CMD: Waiting for data (attempt ${retries}/${maxRetries})...`);
          await sleep(200);
        }
      }

      // Step 4: Read response data if length > 0
      let responseData = '';
      if (dataLength > 0) {
        addLog('SYS', `PCIE2 CMD: Reading ${dataLength} bytes of response data...`);
        
        const numRegisters = dataLength;

        lastCommandRef.current = 'PCIE2_DATA';
        const dataResponse = await sendModbusRequest(buildReadInputRegisters(
          MODBUS_CONSTANTS.SLAVE_ID,
          respDataReg,
          numRegisters
        ), 2000);
        
        // Convert response data to string
        if (dataResponse) {
          const parsed = parseReadInputRegistersResponse(dataResponse);
          if (parsed.success && parsed.registers.length > 0) {
            // Each register contains 2 bytes (hi and lo)
            const dataBytes: number[] = [];
            for (const reg of parsed.registers) {
              dataBytes.push((reg >> 8) & 0xFF);
              dataBytes.push(reg & 0xFF);
            }
            const rawStr = dataBytes.slice(0, dataLength * 2)
              .map(byte => String.fromCharCode(byte))
              .join('');

            if (command.startsWith('AT+BISGET=')) {
              // Response format: AT!CULMSG=..,<count>,"<hex_payload>",..
              // Empty "" means no LoRa data waiting; responseData stays '' so we return null below
              const hexMatch = rawStr.match(/"([0-9a-fA-F]*)"/i);
              if (hexMatch && hexMatch[1].length > 0) {
                const hexStr = hexMatch[1];
                const decoded: number[] = [];
                for (let i = 0; i + 1 < hexStr.length; i += 2) {
                  decoded.push(parseInt(hexStr.substring(i, i + 2), 16));
                }
                responseData = new TextDecoder().decode(new Uint8Array(decoded));
              }
            } else {
              const match = rawStr.match(/:\s*(\S+)/);
              responseData = match ? match[1] : rawStr.trim();
            }
            
            addLog('SYS', `PCIE2 CMD: Response received: ${responseData}`);
          }
        }
      }

      addLog('SYS', `PCIE2 CMD: Completed successfully`);

      // AT+BISGET=? returns null when payload is empty ("") — caller must not update state
      const resultData = command.startsWith('AT+BISGET=')
        ? (responseData || null)
        : (responseData || 'OK');
      return {
        success: true,
        data: resultData,
        dataLength: dataLength,
      };

    } catch (error) {
      const errorMsg = `PCIE2 CMD failed: ${error}`;
      addLog('SYS', errorMsg, true);
      return { success: false, data: null, dataLength: 0, error: errorMsg };
    }
  };

  /**
   * Test LoRa AT commands
   * Sends query commands to get frequency, spreading factor, and channel plan
   */
  const testLoRaCommands = async (): Promise<void> => {
    try {
      addLog('SYS', 'Testing LoRa AT commands...');
      
      // Check if read loop is running
      if (!keepReadingRef.current) {
        addLog('SYS', 'Starting read loop for LoRa tests...');
        keepReadingRef.current = true;
        setIsReadLoopActive(true);
        readLoopPromiseRef.current = readLoop();
        
        // Wait for reader to be acquired
        let attempts = 0;
        while (attempts < 20 && !readerRef.current) {
          await new Promise(r => setTimeout(r, 100));
          attempts++;
        }
        
        if (!readerRef.current) {
          throw new Error('Failed to start read loop');
        }
        addLog('SYS', 'Read loop is now listening');
      }

      // Test 1: Frequency command
      addLog('SYS', 'Test 1: AT+BISRXF=?');
      const freqResult = await sendPCIE2Command('AT+BISRXF=?');
      if (freqResult.success && freqResult.data) {
        addLog('SYS', `Frequency response: ${freqResult.data}`);
      } else {
        addLog('SYS', 'Frequency query failed', true);
      }
      await sleep(500);

      // Test 2: Spreading Factor command
      addLog('SYS', 'Test 2: AT+BISRXSF=?');
      const sfResult = await sendPCIE2Command('AT+BISRXSF=?');
      if (sfResult.success && sfResult.data) {
        addLog('SYS', `Spreading Factor response: ${sfResult.data}`);
      } else {
        addLog('SYS', 'Spreading Factor query failed', true);
      }
      await sleep(500);

      // Test 3: Channel Plan command
      addLog('SYS', 'Test 3: AT+BISCHPLAN=?');
      const chResult = await sendPCIE2Command('AT+BISCHPLAN=?');
      if (chResult.success && chResult.data) {
        addLog('SYS', `Channel Plan response: ${chResult.data}`);
      } else {
        addLog('SYS', 'Channel Plan query failed', true);
      }

      addLog('SYS', 'LoRa command tests completed');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      addLog('SYS', `LoRa test error: ${errorMsg}`, true);
    }
  };

  const pollLoraData = async () => {
    if (!keepReadingRef.current) return;
    const result = await sendPCIE2Command('AT+BISGET=?', 3);
    // Only update when there is actual decoded payload; null means "" (empty) — keep last known value
    if (result.success && result.data !== null) {
      setData(prev => ({ ...prev, loraData: result.data as string, lastUpdated: Date.now() }));
    }
  };

  const startReadLoop = useCallback(async () => {
    if (connectionState !== ConnectionState.CONNECTED || !portRef.current) {
      addLog('SYS', 'Not connected to device', true);
      return;
    }

    if (isReadLoopActive) {
      addLog('SYS', 'Read loop already active');
      return;
    }

    keepReadingRef.current = true;
    setIsReadLoopActive(true);
    addLog('SYS', 'Starting read loop...');

    readLoopPromiseRef.current = readLoop();

    // Wait for reader to be acquired before proceeding with init
    let attempts = 0;
    while (attempts < 20 && !readerRef.current) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }

    if (readerRef.current) {
      addLog('SYS', 'Read loop is now listening, initializing device...');
      if (keepReadingRef.current) await initDongle();
    } else {
      addLog('SYS', 'Warning: Read loop started but reader not ready', true);
    }
  }, [connectionState, isReadLoopActive, addLog, readLoop, initDongle]);

  /**
   * Start read loop WITHOUT full device initialization
   * Use this for LoRa PCIE2 commands when device is already initialized
   */
  const startReadLoopOnly = useCallback(async () => {
    if (connectionState !== ConnectionState.CONNECTED || !portRef.current) {
      addLog('SYS', 'Not connected to device', true);
      return;
    }

    if (isReadLoopActive) {
      addLog('SYS', 'Read loop already active');
      return;
    }

    keepReadingRef.current = true;
    setIsReadLoopActive(true);
    addLog('SYS', 'Starting read loop (monitoring only)...');

    readLoopPromiseRef.current = readLoop();
    
    // Wait for reader to be acquired (up to 2 seconds)
    let attempts = 0;
    while (attempts < 20 && !readerRef.current) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }
    
    if (readerRef.current) {
      addLog('SYS', 'Read loop is now listening for responses');
    } else {
      addLog('SYS', 'Warning: Read loop started but reader not ready yet', true);
    }
  }, [connectionState, isReadLoopActive, addLog, readLoop]);

  const stopReadLoop = async () => {
    if (!isReadLoopActive) {
      addLog('SYS', 'Read loop not active');
      return;
    }

    keepReadingRef.current = false;
    setIsReadLoopActive(false);
    addLog('SYS', 'Stopping read loop...');

    if (pollIntervalRef.current) {
      window.clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
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
      try {
        await port.open({ baudRate: MODBUS_CONSTANTS.BAUD_RATE });
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
      setConnectionState(ConnectionState.CONNECTED);
      
      addLog('SYS', `Serial connected using ${mode} mode.`);
      addLog('SYS', 'Setting device password...');
      
      // Set password once after serial connection
      await setDevicePassword();
      
      addLog('SYS', 'Use Connect button to start communication.');

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

  /**
   * Set device password (called once after serial connection)
   * Required before any NTN or LoRa operations
   */
  const setDevicePassword = async () => {
    try {
      addLog('SYS', 'Configuring device password...');
      const passwordPayload = [0, 0, 0, 0];
      const frame = buildWriteMultipleRegisters(MODBUS_CONSTANTS.SLAVE_ID, MODBUS_CONSTANTS.ADDR_PASSWORD, passwordPayload);
      await writeBytes(frame);
      addLog('SYS', 'Device password configured successfully');
    } catch (err) {
      addLog('SYS', `Failed to set device password: ${err}`, true);
    }
  };

  return {
    connectionState,
    connect,
    disconnect,
    logs,
    clearLogs,
    data,
    applyNTNConfig,
    isReadLoopActive,
    startReadLoop,
    startReadLoopOnly,
    stopReadLoop,
    writeBytes,
    sendPCIE2Command,
    testLoRaCommands
  };
};