
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
  lastUpdated: number;
  configApplied?: boolean;
}

export interface NTNConfig {
  apn: string;
  remoteIp: string;
  remotePort: string;
  localPort?: string;
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
