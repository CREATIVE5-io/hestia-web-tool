
export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export enum DriverMode {
  AUTO = 'AUTO',
  NATIVE = 'NATIVE',
  POLYFILL = 'POLYFILL'
}

export interface LogEntry {
  id: string;
  timestamp: string;
  direction: 'TX' | 'RX' | 'SYS';
  message: string;
  isError?: boolean;
}

export interface DongleStatus {
  moduleAtReady: boolean;
  downlinkReady: boolean;
  simReady: boolean;
  networkRegistered: boolean;
  socketReady: boolean;
}

export interface DongleData {
  modelName: string;
  fwVersion: string;
  imsi: string;
  status: DongleStatus;
  rsrp: string;
  sinr: string;
  loraData: string;
  lastUpdated: number;
  configApplied?: boolean;
  currentConfig?: NTNConfig;
  activeMode?: 0 | 1 | 2 | 3;
  csqGpsInterval?: number;
}

export interface NTNConfig {
  apn: string;
  remoteIp: string;
  remotePort: string;
  localPort?: string;
}

export interface PCIE2CommandResult {
  success: boolean;
  data: string | null;
  dataLength: number;
  error?: string;
}

export interface DongleConnectionHandle {
  connectionState: ConnectionState;
  connect: (mode: DriverMode) => Promise<void>;
  disconnect: () => Promise<void>;
  logs: LogEntry[];
  clearLogs: () => void;
  data: DongleData;
  applyNTNConfig: (config: NTNConfig) => Promise<boolean>;
  applyActiveMode: (mode: 0 | 1) => Promise<void>;
  applyCsqGpsInterval: (value: number) => Promise<void>;
  sendNtnModuleCommand: (command: string, timeoutMs?: number) => Promise<string | null>;
  sendUplinkData: (text: string, timeoutMs?: number) => Promise<string | null>;
  isReadLoopActive: boolean;
  isDeviceReady: boolean;
  startReadLoop: () => Promise<void>;
  startReadLoopOnly: () => Promise<void>;
  stopReadLoop: () => void;
  writeBytes?: (bytes: Uint8Array) => Promise<void>;
  sendPCIE2Command?: (command: string) => Promise<PCIE2CommandResult>;
  readPCIE2Response?: () => Promise<PCIE2CommandResult>;
  testLoRaCommands?: () => Promise<void>;
}

export const MODBUS_CONSTANTS = {
  SLAVE_ID: 1,
  BAUD_RATE: 115200,
  READ_HOLDING_REGISTERS: 0x03,
  READ_INPUT_REGISTERS: 0x04,
  WRITE_SINGLE_REGISTER: 0x06,
  WRITE_MULTIPLE_REGISTERS: 0x10,
  
  // Register Addresses
  ADDR_PASSWORD: 0x0000,
  ADDR_MODEL_NAME: 0xEA66,
  ADDR_FW_VER: 0xEA6B,
  ADDR_STATUS: 0xEA71,
  ADDR_IMSI: 0xEB00,
  ADDR_SINR: 0xEB13,
  ADDR_RSRP: 0xEB15,

  // Configuration Addresses
  ADDR_REMOTE_PORT: 0xC3B8,
  ADDR_APN: 0xC3BB,
  ADDR_REMOTE_IP: 0xC3CA,
  ADDR_LOCAL_PORT: 0xC3D5,
  ADDR_ACTIVE_MODE: 0xC358,
  // How often the dongle refreshes CSQ (RSRP/SINR) and GPS from the NTN module. Saved to EEPROM.
  ADDR_CSQ_GPS_INTERVAL: 0xC35B,
  // UART passthrough switch: write 0x03 (MODE 3) to drop the dongle into direct AT command mode.
  ADDR_UART_MODE: 0xC350,

  // nRF9151 (A1+/A2+) NTN/TN module command channel: write ASCII + CRLF to ADDR_NTN_CMD,
  // then poll the reply length (registers) and read the reply data.
  ADDR_NTN_CMD: 0x9C40,
  ADDR_NTN_REPLY_LEN: 0xF060,
  ADDR_NTN_REPLY_DATA: 0xF061,

  // Uplink to the cloud: write the payload as hex text + CRLF from ADDR_UPLINK_DATA (64 registers
  // per write); the ACK comes back on ADDR_NTN_REPLY_LEN / ADDR_NTN_REPLY_DATA.
  // ADDR_UPLINK_AVAILABLE reads 0 when the uplink buffer is free.
  ADDR_UPLINK_DATA: 0xC550,
  ADDR_UPLINK_AVAILABLE: 0xEA7D,

  // PCIE2 CMD Addresses
  PCIE2_CMD_START: 0xC700,
  PCIE2_MOD_LEN: 0xF860,
  PCIE2_MOD_START: 0xF861,
  PCIE2_DATA_LEN: 0xF460,
  PCIE2_DATA_START: 0xF461,
};

// Values accepted by ADDR_CSQ_GPS_INTERVAL; anything else returns Modbus exception 0x03.
export const CSQ_GPS_INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 0xFE, label: 'Default (~0.9 s)' },
  { value: 1, label: '1 min' },
  { value: 2, label: '10 min' },
  { value: 3, label: '30 min' },
  { value: 4, label: '60 min' },
  { value: 0, label: 'Disabled' },
];

export const getCsqGpsIntervalLabel = (value?: number): string =>
  CSQ_GPS_INTERVAL_OPTIONS.find(o => o.value === value)?.label ?? 'Unknown';

// How often the web tool reads RSRP/SINR for a given ADDR_CSQ_GPS_INTERVAL value.
// Reading faster than the dongle refreshes just returns the same cached value.
// null = CSQ disabled (don't read); 0 = every poll tick (10 s).
export const getSignalPollMs = (value?: number): number | null => {
  switch (value) {
    case 0: return null;
    case 1: return 60_000;
    case 2: return 600_000;
    case 3: return 1_800_000;
    case 4: return 3_600_000;
    default: return 0;
  }
};

// Web Serial API Type Definitions
export interface SerialPort {
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

export interface SerialOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

export interface Serial {
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
}

export interface SerialPortRequestOptions {
  filters?: SerialPortFilter[];
}

export interface SerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

// LoRa Configuration Types
export interface LoRaDevice {
  idx: string;
  id: string;
  nsKey: string;
  appKey: string;
  transmit_interval: string;
  otaaMode?: boolean;
  devEUI?: string;
  appEUI?: string;
  otaaAppKey?: string;
}

export interface LoRaConfig {
  frequency: string;
  sf: string;
  ch_plan: string;
  serial_interface: string;
  dongle_id?: string;
}

export interface EightChDevice {
  devEUI: string;
  devAddr: string;
  nwkSKey: string;
  appSKey: string;
  appEUI: string;
  appKey: string;
  mode: 'ABP' | 'OTAA';
}

export interface LoRaSetupProgress {
  stage?: string;
  current?: number;
  total?: number;
  percentage?: number;
  message: string;
  setup_status?: string;
  failed_devices?: string[];
  completed?: boolean;
  error?: boolean;
  timestamp?: number;
}

export interface SerialPortInfo {
  device: string;
  description: string;
  hwid: string;
}
