/**
 * MDFU protocol commands, packet builder/parser, and ClientInfo decoder.
 * Pure functions — no I/O, compatible with Node.js and browser.
 *
 * Ported from pymdfu/mdfu.py.
 *
 * Command packet: [seqField (1B)] [command (1B)] [payload (variable)]
 * Status packet:  [seqField (1B)] [status  (1B)] [data    (variable)]
 *
 * Sequence field (command): bits[4:0]=seq, bit6=0, bit7=sync
 * Sequence field (status):  bits[4:0]=seq, bit6=resend, bit7=0
 *
 * Note: const enum is avoided here because this file is used with
 * isolatedModules:true (Vite/esbuild cannot inline const enums cross-module).
 */

// ── Enums ─────────────────────────────────────────────────────────────────────

export enum MdfuCommand {
  GET_CLIENT_INFO = 1,
  START_TRANSFER  = 2,
  WRITE_CHUNK     = 3,
  GET_IMAGE_STATE = 4,
  END_TRANSFER    = 5,
}

export enum MdfuStatus {
  SUCCESS               = 1,
  CMD_NOT_SUPPORTED     = 2,
  NOT_AUTHORIZED        = 3,
  CMD_NOT_EXECUTED      = 4,
  ABORT_FILE_TRANSFER   = 5,
}

export enum ImageState {
  VALID   = 1,
  INVALID = 2,
}

// ── ClientInfo TLV types ──────────────────────────────────────────────────────

const enum ClientInfoType {
  PROTOCOL_VERSION        = 1,
  BUFFER_INFO             = 2,
  COMMAND_TIMEOUTS        = 3,
  INTER_TRANSACTION_DELAY = 4,
}

export interface ClientInfo {
  protocolVersion: string;     // e.g. "1.2.0"
  bufferSize:  number;         // max MDFU packet data length (bytes)
  bufferCount: number;         // number of command buffers on client
  defaultTimeoutMs: number;    // ms
  commandTimeoutsMs: Map<MdfuCommand, number>;
  interTransactionDelayMs: number | null;
}

// ── Packet builders ───────────────────────────────────────────────────────────

/**
 * Build a binary MDFU command packet.
 * @param cmd     - Command to send
 * @param seq     - Sequence number 0–31
 * @param sync    - Set sync flag (use on GET_CLIENT_INFO to sync sequence number)
 * @param payload - Optional command data
 */
export function buildCommandPacket(
  cmd: MdfuCommand,
  seq: number,
  sync: boolean,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (seq < 0 || seq > 31) throw new RangeError(`Sequence number must be 0–31, got ${seq}`);
  const seqField = (seq & 0x1f) | (sync ? 0x80 : 0x00);
  const packet = new Uint8Array(2 + payload.length);
  packet[0] = seqField;
  packet[1] = cmd;
  packet.set(payload, 2);
  return packet;
}

// ── Packet parsers ────────────────────────────────────────────────────────────

export interface ParsedStatusPacket {
  seq:    number;
  status: MdfuStatus;
  resend: boolean;
  data:   Uint8Array;
}

/** Parse a binary MDFU status packet received from the device. */
export function parseStatusPacket(raw: Uint8Array): ParsedStatusPacket {
  if (raw.length < 2) throw new Error('Status packet too short');
  const seqField = raw[0];
  const seq    = seqField & 0x1f;
  const resend = Boolean(seqField & 0x40);
  const status = raw[1] as MdfuStatus;
  const data   = raw.slice(2);
  return { seq, status, resend, data };
}

// ── ClientInfo decoder ────────────────────────────────────────────────────────

/** Parse the GET_CLIENT_INFO response payload (TLV encoding). */
export function parseClientInfo(data: Uint8Array): ClientInfo {
  let i = 0;
  let protocolVersion: string | null = null;
  let bufferSize: number | null = null;
  let bufferCount: number | null = null;
  let defaultTimeoutMs: number | null = null;
  const commandTimeoutsMs = new Map<MdfuCommand, number>();
  let interTransactionDelayMs: number | null = null;

  while (i < data.length) {
    const type   = data[i];
    const length = data[i + 1];
    const value  = data.slice(i + 2, i + 2 + length);
    i += 2 + length;

    switch (type) {
      case ClientInfoType.PROTOCOL_VERSION: {
        protocolVersion = `${value[0]}.${value[1]}.${value[2]}`;
        break;
      }
      case ClientInfoType.BUFFER_INFO: {
        bufferSize  = value[0] | (value[1] << 8);
        bufferCount = value[2];
        break;
      }
      case ClientInfoType.COMMAND_TIMEOUTS: {
        const SECONDS_PER_LSB = 0.1;
        for (let j = 0; j + 2 < value.length; j += 3) {
          const cmdCode    = value[j];
          const timeoutLSB = value[j + 1] | (value[j + 2] << 8);
          const timeoutMs  = Math.round(timeoutLSB * SECONDS_PER_LSB * 1000);
          if (cmdCode === 0) {
            defaultTimeoutMs = timeoutMs;
          } else {
            commandTimeoutsMs.set(cmdCode as MdfuCommand, timeoutMs);
          }
        }
        break;
      }
      case ClientInfoType.INTER_TRANSACTION_DELAY: {
        const ns = value[0] | (value[1] << 8) | (value[2] << 16) | (value[3] << 24);
        interTransactionDelayMs = ns / 1e6;
        break;
      }
      // Unknown TLV types: silently ignore (forward-compatible)
    }
  }

  if (protocolVersion === null) throw new Error('ClientInfo missing PROTOCOL_VERSION');
  if (bufferSize     === null) throw new Error('ClientInfo missing BUFFER_INFO');
  if (bufferCount    === null) throw new Error('ClientInfo missing BUFFER_INFO');
  if (defaultTimeoutMs === null) throw new Error('ClientInfo missing default timeout');

  return {
    protocolVersion,
    bufferSize,
    bufferCount,
    defaultTimeoutMs,
    commandTimeoutsMs,
    interTransactionDelayMs,
  };
}

// ── Firmware chunking ─────────────────────────────────────────────────────────

/**
 * Split a firmware image into chunks.
 * The last chunk may be shorter than bufferSize — no padding is added.
 */
export function chunkFirmware(image: Uint8Array, bufferSize: number): Uint8Array[] {
  if (bufferSize <= 0) throw new RangeError('bufferSize must be > 0');
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < image.length; i += bufferSize) {
    chunks.push(image.slice(i, i + bufferSize));
  }
  return chunks;
}

// ── Error descriptions ────────────────────────────────────────────────────────

export function describeAbortCause(causeCode: number): string {
  const causes: Record<number, string> = {
    0: 'Generic client error',
    1: 'Invalid file',
    2: 'Incompatible client device ID',
    3: 'Address error in file',
    4: 'Memory erase error',
    5: 'Memory write error',
    6: 'Memory read error',
    7: 'Application version incompatibility',
  };
  return causes[causeCode] ?? `Unknown abort cause (${causeCode})`;
}

export function describeCmdNotExecutedCause(causeCode: number): string {
  const causes: Record<number, string> = {
    0: 'Transport integrity check failure',
    1: 'Command too long (exceeded buffer)',
    2: 'Command too short',
    3: 'Invalid sequence number',
  };
  return causes[causeCode] ?? `Unknown cause (${causeCode})`;
}
