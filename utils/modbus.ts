// Modbus CRC16 (ANSI)
export function calculateCRC16(buffer: Uint8Array): number {
  let crc = 0xFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1;
    }
  }
  return crc;
}

export function createModbusFrame(slaveId: number, funcCode: number, data: number[]): Uint8Array {
  // Construct the full frame: SlaveID + FuncCode + Data + CRC
  const payload = [slaveId, funcCode, ...data];
  const crc = calculateCRC16(Uint8Array.from(payload));
  return Uint8Array.from([...payload, crc & 0xFF, (crc >> 8) & 0xFF]);
}

export function buildReadHoldingRegisters(slaveId: number, startAddr: number, count: number): Uint8Array {
  const payload = [
    slaveId,
    0x03,
    (startAddr >> 8) & 0xFF,
    startAddr & 0xFF,
    (count >> 8) & 0xFF,
    count & 0xFF
  ];
  const crc = calculateCRC16(Uint8Array.from(payload));
  return Uint8Array.from([...payload, crc & 0xFF, (crc >> 8) & 0xFF]);
}

export function buildReadInputRegisters(slaveId: number, startAddr: number, count: number): Uint8Array {
  const payload = [
    slaveId,
    0x04,
    (startAddr >> 8) & 0xFF,
    startAddr & 0xFF,
    (count >> 8) & 0xFF,
    count & 0xFF
  ];
  const crc = calculateCRC16(Uint8Array.from(payload));
  return Uint8Array.from([...payload, crc & 0xFF, (crc >> 8) & 0xFF]);
}

export function buildWriteMultipleRegisters(slaveId: number, startAddr: number, values: number[]): Uint8Array {
  const byteCount = values.length * 2;
  const payload = [
    slaveId,
    0x10,
    (startAddr >> 8) & 0xFF,
    startAddr & 0xFF,
    (values.length >> 8) & 0xFF,
    values.length & 0xFF,
    byteCount
  ];

  for (const val of values) {
    payload.push((val >> 8) & 0xFF);
    payload.push(val & 0xFF);
  }

  const crc = calculateCRC16(Uint8Array.from(payload));
  return Uint8Array.from([...payload, crc & 0xFF, (crc >> 8) & 0xFF]);
}

export function hexString(data: Uint8Array | number[]): string {
  return Array.from(data)
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join('');
}

/**
 * Convert bytes to a readable format showing both hex and ASCII
 * For logging purposes - shows hex without spaces and ASCII representation
 */
export function hexStringWithASCII(data: Uint8Array | number[]): string {
  const hex = hexString(data);
  const ascii = Array.from(data)
    .map(b => {
      if (b >= 32 && b <= 126) {
        return String.fromCharCode(b);
      }
      return '.';
    })
    .join('');
  return `${hex}\n${ascii}`;
}

export function parseModbusString(registers: number[]): string {
  let str = '';
  for (const reg of registers) {
    const hi = (reg >> 8) & 0xFF;
    const lo = reg & 0xFF;
    if (hi === 0) break;
    str += String.fromCharCode(hi);
    if (lo === 0) break;
    str += String.fromCharCode(lo);
  }
  return str.trim();
}

export function stringToModbusRegisters(input: string): number[] {
  // Pad with null byte if odd length
  if (input.length % 2) {
    input += '\x00';
  }

  const result: number[] = [];
  for (let i = 0; i < input.length; i += 2) {
    const pair = input.substring(i, i + 2);
    const asciiVal = (pair.charCodeAt(0) << 8) | pair.charCodeAt(1);
    result.push(asciiVal);
  }
  return result;
}

/**
 * Convert AT command string to Modbus register values
 * Appends \r\n and converts to register pairs
 */
export function atCommandToModbusRegisters(command: string): number[] {
  const atCmd = command + '\r\n';
  return stringToModbusRegisters(atCmd);
}

/**
 * Convert register values to ASCII codes array
 * Each register is split into high byte and low byte
 */
export function registersToAsciiCodes(registers: number[]): number[] {
  const asciiCodes: number[] = [];
  for (const reg of registers) {
    const highByte = (reg >> 8) & 0xFF;
    const lowByte = reg & 0xFF;
    asciiCodes.push(highByte);
    asciiCodes.push(lowByte);
  }
  return asciiCodes;
}

/**
 * Extract quoted string from ASCII codes array (for BISGET responses)
 * Finds first and second occurrence of ASCII code 34 (double quote)
 */
export function extractQuotedString(asciiCodes: number[]): string {
  try {
    const idx_1st = asciiCodes.indexOf(34);
    if (idx_1st === -1) return '';
    
    const idx_2nd = asciiCodes.indexOf(34, idx_1st + 1);
    if (idx_2nd === -1) return '';
    
    const quotedCodes = asciiCodes.slice(idx_1st + 1, idx_2nd);
    return String.fromCharCode(...quotedCodes);
  } catch (e) {
    console.error('Error extracting quoted string:', e);
    return '';
  }
}

export function buildWriteSingleRegister(slaveId: number, reg: number, value: number): Uint8Array {
  const payload = [
    slaveId, 0x06,
    (reg >> 8) & 0xFF, reg & 0xFF,
    (value >> 8) & 0xFF, value & 0xFF,
  ];
  const crc = calculateCRC16(Uint8Array.from(payload));
  return Uint8Array.from([...payload, crc & 0xFF, (crc >> 8) & 0xFF]);
}

export function generateModbusFrame(command: string, slaveId: number = 1): Uint8Array {
  // Convert AT command to Modbus registers
  const registers = stringToModbusRegisters(command);
  // Build write multiple registers frame for command execution
  return buildWriteMultipleRegisters(slaveId, 0xC700, registers);
}

/**
 * Parse Modbus Read Input Registers response
 * Response format: [SlaveID] [FuncCode=0x04] [ByteCount] [Data...] [CRC_LO] [CRC_HI]
 * Returns: { registers: number[], success: boolean }
 */
export function parseReadInputRegistersResponse(response: Uint8Array): { registers: number[]; success: boolean } {
  if (response.length < 5) {
    return { registers: [], success: false };
  }
  
  const funcCode = response[1];
  if (funcCode !== 0x04) {
    return { registers: [], success: false };
  }
  
  const byteCount = response[2];
  if (response.length < 3 + byteCount + 2) {
    return { registers: [], success: false };
  }
  
  const dataBytes = response.slice(3, 3 + byteCount);
  const registers: number[] = [];
  
  for (let i = 0; i < dataBytes.length; i += 2) {
    if (i + 1 < dataBytes.length) {
      registers.push((dataBytes[i] << 8) | dataBytes[i + 1]);
    }
  }
  
  return { registers, success: true };
}

/**
 * Parse Modbus Read Holding Registers response (funcCode 0x03)
 * Same frame layout as Read Input Registers but funcCode differs.
 */
export function parseHoldingRegistersResponse(response: Uint8Array): { registers: number[]; success: boolean } {
  if (response.length < 5) return { registers: [], success: false };
  if (response[1] !== 0x03) return { registers: [], success: false };
  const byteCount = response[2];
  if (response.length < 3 + byteCount + 2) return { registers: [], success: false };
  const dataBytes = response.slice(3, 3 + byteCount);
  const registers: number[] = [];
  for (let i = 0; i + 1 < dataBytes.length; i += 2) {
    registers.push((dataBytes[i] << 8) | dataBytes[i + 1]);
  }
  return { registers, success: true };
}

/**
 * Parse Modbus Write Multiple Registers response (echo)
 * Response format: [SlaveID] [FuncCode=0x10] [StartAddr_HI] [StartAddr_LO] [Quantity_HI] [Quantity_LO] [CRC_LO] [CRC_HI]
 * Returns: { success: boolean, startAddr: number, quantity: number }
 */
export function parseWriteMultipleRegistersResponse(response: Uint8Array): { success: boolean; startAddr: number; quantity: number } {
  if (response.length < 8) {
    return { success: false, startAddr: 0, quantity: 0 };
  }
  
  const funcCode = response[1];
  if (funcCode !== 0x10) {
    return { success: false, startAddr: 0, quantity: 0 };
  }
  
  const startAddr = (response[2] << 8) | response[3];
  const quantity = (response[4] << 8) | response[5];
  
  return { success: true, startAddr, quantity };
}