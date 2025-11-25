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
    .join(' ');
}

export function parseModbusString(registers: number[]): string {
  let str = '';
  for (const reg of registers) {
    // Big Endian bytes in register
    const hi = (reg >> 8) & 0xFF;
    const lo = reg & 0xFF;
    if (hi !== 0) str += String.fromCharCode(hi);
    if (lo !== 0) str += String.fromCharCode(lo);
  }
  // Trim null terminators or garbage
  return str.replace(/\0/g, '').trim();
}