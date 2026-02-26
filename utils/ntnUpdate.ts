/**
 * NTN Dongle firmware update orchestrator.
 * Implements the two-phase update flow:
 *   Phase 1 — Modbus RTU: unlock → engineering mode → bootloader → reset
 *   Phase 2 — MDFU UART: handshake → transfer chunks → verify → end
 *
 * Uses IoAdapter for all I/O, making it testable with a mock and
 * portable to browser (Web Serial API).
 */

import {
  buildWriteMultipleRegisters,
  buildWriteSingleRegister,
  hexString,
} from './modbus';
import {
  encodeFrame,
  decodeFrame,
} from './mdfuTransport';
import {
  MdfuCommand,
  MdfuStatus,
  ImageState,
  buildCommandPacket,
  parseStatusPacket,
  parseClientInfo,
  chunkFirmware,
  describeAbortCause,
  describeCmdNotExecutedCause,
  type ClientInfo,
} from './mdfu';

// ── IoAdapter interface ───────────────────────────────────────────────────────

/**
 * Minimal serial I/O interface.
 * Browser: implemented by a Web Serial API wrapper (useFirmwareUpdate hook).
 */
export interface IoAdapter {
  /** Write bytes to the serial port. */
  write(data: Uint8Array): Promise<void>;
  /**
   * Read bytes with a timeout.
   * @param timeoutMs - How long to wait for data (ms)
   * @returns Received bytes (may be a partial read)
   * @throws Error with message containing "timeout" if no data received
   */
  read(timeoutMs: number): Promise<Uint8Array>;
  /** Close the serial port. */
  close(): Promise<void>;
}

// ── Update phases ─────────────────────────────────────────────────────────────

export type UpdatePhase =
  | 'idle'
  | 'modbus_password'
  | 'modbus_engineering'
  | 'modbus_bootloader'
  | 'modbus_reset'
  | 'waiting_for_bootloader'
  | 'mdfu_handshake'
  | 'mdfu_start_transfer'
  | 'mdfu_transferring'
  | 'mdfu_verify'
  | 'mdfu_end_transfer'
  | 'done'
  | 'error';

export type LogDirection = 'TX' | 'RX' | 'SYS';

export interface UpdateOptions {
  /** Firmware image binary. */
  image: Uint8Array;
  /** Modbus slave ID (default 1). */
  slaveId?: number;
  /** Skip Phase 1 Modbus setup — device already in bootloader mode. */
  skipModbus?: boolean;
  /** Max MDFU retry attempts per command (default 5). */
  mdfuRetries?: number;
  /** Called when the current phase changes. */
  onPhase?: (phase: UpdatePhase) => void;
  /** Called with progress 0–100 during the WRITE_CHUNK phase. */
  onProgress?: (percent: number) => void;
  /** Called for each log entry. */
  onLog?: (dir: LogDirection, message: string) => void;
}

// ── Modbus register addresses ─────────────────────────────────────────────────

const REG_PASSWORD    = 0x0000;
const REG_ENGINEERING = 0xffd0;
const REG_BOOTLOADER  = 0xd000;
const REG_RESET       = 0xfd00;

const MAGIC = 0xaa55;

// Modbus response timeouts
const MODBUS_TIMEOUT_MS    = 2000;
const MCU_RESET_WAIT_MS    = 1000;
const PORT_RELEASE_WAIT_MS = 500;

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the complete firmware update.
 * adapterFactory is called twice: once for Phase 1 (Modbus) and once for
 * Phase 2 (MDFU). The factory must handle re-opening the same port object.
 */
export async function runUpdate(
  adapterFactory: () => Promise<IoAdapter>,
  opts: UpdateOptions,
): Promise<void> {
  const {
    image,
    slaveId  = 1,
    skipModbus = false,
    mdfuRetries = 5,
    onPhase   = () => undefined,
    onProgress = () => undefined,
    onLog     = () => undefined,
  } = opts;

  const log = (dir: LogDirection, msg: string) => onLog(dir, msg);
  const phase = (p: UpdatePhase) => { onPhase(p); log('SYS', `Phase: ${p}`); };

  // ── Phase 1: Modbus bootloader entry ──────────────────────────────────────
  if (!skipModbus) {
    const modbusAdapter = await adapterFactory();
    try {
      await runModbusPhase(modbusAdapter, slaveId, phase, log);
    } finally {
      await modbusAdapter.close();
      log('SYS', 'Modbus port closed. Waiting for port release…');
    }
    phase('waiting_for_bootloader');
    await sleep(PORT_RELEASE_WAIT_MS);
  } else {
    log('SYS', 'Skipping Modbus phase — device assumed already in bootloader mode');
  }

  // ── Phase 2: MDFU firmware flash ──────────────────────────────────────────
  const mdfuAdapter = await adapterFactory();
  try {
    await runMdfuPhase(mdfuAdapter, image, mdfuRetries, phase, onProgress, log);
  } finally {
    await mdfuAdapter.close();
    log('SYS', 'MDFU port closed.');
  }

  phase('done');
  log('SYS', 'Firmware update complete. Device is rebooting into new firmware.');
}

// ── Phase 1: Modbus ───────────────────────────────────────────────────────────

async function runModbusPhase(
  adapter: IoAdapter,
  slaveId: number,
  phase: (p: UpdatePhase) => void,
  log: (dir: LogDirection, msg: string) => void,
): Promise<void> {
  // ── Password unlock: WRITE_MULTIPLE_REGISTERS (fc 0x10) ─────────────────
  phase('modbus_password');
  const pwFrame = buildWriteMultipleRegisters(slaveId, REG_PASSWORD, [0, 0, 0, 0]);
  log('TX', `Modbus write [password unlock]: ${hexString(pwFrame)}`);
  await adapter.write(pwFrame);
  const pwResp = await adapter.read(MODBUS_TIMEOUT_MS);
  log('RX', `Modbus response: ${hexString(pwResp)}`);
  if (pwResp[1] === (0x80 | 0x10)) {
    throw new Error(`Modbus exception on [password unlock]: 0x${pwResp[2].toString(16)}`);
  }

  // ── Engineering mode, bootloader, reset: WRITE_SINGLE_REGISTER (fc 0x06) ─
  const singles: Array<{ ph: UpdatePhase; reg: number; desc: string }> = [
    { ph: 'modbus_engineering', reg: REG_ENGINEERING, desc: 'engineering mode' },
    { ph: 'modbus_bootloader',  reg: REG_BOOTLOADER,  desc: 'bootloader mode'  },
    { ph: 'modbus_reset',       reg: REG_RESET,       desc: 'MCU reset'        },
  ];

  for (const w of singles) {
    phase(w.ph);
    const frame = buildWriteSingleRegister(slaveId, w.reg, MAGIC);
    log('TX', `Modbus write [${w.desc}]: ${hexString(frame)}`);
    await adapter.write(frame);
    try {
      const resp = await adapter.read(MODBUS_TIMEOUT_MS);
      log('RX', `Modbus response: ${hexString(resp)}`);
      if (resp[1] === (0x80 | 0x06)) {
        throw new Error(`Modbus exception on [${w.desc}]: 0x${resp[2].toString(16)}`);
      }
    } catch (err: unknown) {
      if (w.reg === REG_RESET) {
        // Device stops responding immediately after reset — timeout is expected
        log('SYS', 'No Modbus response after reset (expected — device is rebooting)');
      } else {
        throw err;
      }
    }
  }

  log('SYS', `Waiting ${MCU_RESET_WAIT_MS}ms for MCU reboot…`);
  await sleep(MCU_RESET_WAIT_MS);
}

// ── Phase 2: MDFU ─────────────────────────────────────────────────────────────

async function runMdfuPhase(
  adapter: IoAdapter,
  image: Uint8Array,
  maxRetries: number,
  phase: (p: UpdatePhase) => void,
  onProgress: (pct: number) => void,
  log: (dir: LogDirection, msg: string) => void,
): Promise<void> {
  let seq = 0;
  const incSeq = () => { seq = (seq + 1) & 0x1f; };

  const sendCmd = async (
    cmd: MdfuCommand,
    payload: Uint8Array,
    sync: boolean,
    timeoutMs: number,
  ): Promise<ReturnType<typeof parseStatusPacket>> => {
    let attempts = 1 + maxRetries;
    while (attempts-- > 0) {
      const packet = buildCommandPacket(cmd, seq, sync, payload);
      const frame  = encodeFrame(packet);
      log('TX', `MDFU cmd=${cmd} seq=${seq} sync=${sync} payload=${hexString(payload)} frame=${hexString(frame)}`);
      await adapter.write(frame);

      let statusPacket: ReturnType<typeof parseStatusPacket>;
      try {
        statusPacket = await readMdfuResponse(adapter, timeoutMs, log);
      } catch (err: unknown) {
        log('SYS', `Transport error (${attempts} retries left): ${err}`);
        continue;
      }

      if (statusPacket.resend) {
        log('SYS', `Device requested resend (attempts left: ${attempts})`);
        continue;
      }

      if (statusPacket.status === MdfuStatus.SUCCESS) {
        incSeq();
        return statusPacket;
      }

      // Non-success, non-resend → error
      const errMsg = buildStatusErrorMessage(cmd, statusPacket);
      incSeq();
      throw new Error(errMsg);
    }
    throw new Error(`MDFU command ${cmd} failed after all retries`);
  };

  // ── Handshake: GET_CLIENT_INFO ──────────────────────────────────────────
  phase('mdfu_handshake');
  const clientInfoResponse = await sendCmd(
    MdfuCommand.GET_CLIENT_INFO,
    new Uint8Array(0),
    true,
    5000,
  );
  const clientInfo: ClientInfo = parseClientInfo(clientInfoResponse.data);
  log('SYS', `Client info: bufferSize=${clientInfo.bufferSize} bufferCount=${clientInfo.bufferCount} timeout=${clientInfo.defaultTimeoutMs}ms protocol=${clientInfo.protocolVersion}`);

  const cmdTimeout = (cmd: MdfuCommand): number =>
    clientInfo.commandTimeoutsMs.get(cmd) ?? clientInfo.defaultTimeoutMs;

  // ── START_TRANSFER ─────────────────────────────────────────────────────
  phase('mdfu_start_transfer');
  await sendCmd(MdfuCommand.START_TRANSFER, new Uint8Array(0), false, cmdTimeout(MdfuCommand.START_TRANSFER));

  // ── WRITE_CHUNK × N ────────────────────────────────────────────────────
  phase('mdfu_transferring');
  const chunks = chunkFirmware(image, clientInfo.bufferSize);
  log('SYS', `Transferring ${image.length} bytes in ${chunks.length} chunks of up to ${clientInfo.bufferSize} bytes`);

  for (let i = 0; i < chunks.length; i++) {
    await sendCmd(MdfuCommand.WRITE_CHUNK, chunks[i], false, cmdTimeout(MdfuCommand.WRITE_CHUNK));
    const pct = Math.round(((i + 1) / chunks.length) * 100);
    onProgress(pct);
    if (i % 10 === 0 || i === chunks.length - 1) {
      log('SYS', `Chunk ${i + 1}/${chunks.length} (${pct}%)`);
    }
  }

  // ── GET_IMAGE_STATE ────────────────────────────────────────────────────
  phase('mdfu_verify');
  const imageStateResponse = await sendCmd(
    MdfuCommand.GET_IMAGE_STATE,
    new Uint8Array(0),
    false,
    cmdTimeout(MdfuCommand.GET_IMAGE_STATE),
  );
  if (imageStateResponse.data.length < 1 || imageStateResponse.data[0] !== ImageState.VALID) {
    const stateCode = imageStateResponse.data[0];
    throw new Error(`Image validation failed: state=${stateCode === ImageState.INVALID ? 'INVALID' : stateCode}`);
  }
  log('SYS', 'Image state: VALID');

  // ── END_TRANSFER ───────────────────────────────────────────────────────
  phase('mdfu_end_transfer');
  await sendCmd(MdfuCommand.END_TRANSFER, new Uint8Array(0), false, cmdTimeout(MdfuCommand.END_TRANSFER));
  log('SYS', 'END_TRANSFER sent — device will reboot into new firmware');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readMdfuResponse(
  adapter: IoAdapter,
  timeoutMs: number,
  log: (dir: LogDirection, msg: string) => void,
): Promise<ReturnType<typeof parseStatusPacket>> {
  let buf = new Uint8Array(0);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const chunk = await adapter.read(Math.max(1, deadline - Date.now()));
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf);
    merged.set(chunk, buf.length);
    buf = merged;

    const result = decodeFrame(buf);
    if (result !== null) {
      log('RX', `MDFU frame: ${hexString(buf.slice(0, result.consumed))}`);
      return parseStatusPacket(result.packet);
    }
  }
  throw new Error('MDFU read timeout: no complete frame received');
}

function buildStatusErrorMessage(
  cmd: MdfuCommand,
  pkt: ReturnType<typeof parseStatusPacket>,
): string {
  const statusName: Record<MdfuStatus, string> = {
    [MdfuStatus.SUCCESS]:             'SUCCESS',
    [MdfuStatus.CMD_NOT_SUPPORTED]:   'CMD_NOT_SUPPORTED',
    [MdfuStatus.NOT_AUTHORIZED]:      'NOT_AUTHORIZED',
    [MdfuStatus.CMD_NOT_EXECUTED]:    'CMD_NOT_EXECUTED',
    [MdfuStatus.ABORT_FILE_TRANSFER]: 'ABORT_FILE_TRANSFER',
  };
  let msg = `MDFU command ${cmd} failed with status ${statusName[pkt.status] ?? pkt.status}`;
  if (pkt.data.length > 0) {
    const cause = pkt.status === MdfuStatus.ABORT_FILE_TRANSFER
      ? describeAbortCause(pkt.data[0])
      : pkt.status === MdfuStatus.CMD_NOT_EXECUTED
        ? describeCmdNotExecutedCause(pkt.data[0])
        : `data=0x${hexString(pkt.data)}`;
    msg += `: ${cause}`;
  }
  return msg;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
