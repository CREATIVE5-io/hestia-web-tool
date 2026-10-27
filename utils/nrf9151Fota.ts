/**
 * nRF9151 modem firmware update (FOTA) over the dongle's UART passthrough.
 *
 *   1. Modbus RTU: set password, write 0xC350 = 3 to switch the dongle into
 *      UART passthrough (same as the NTN Dongle - AT tab). Skipped when the
 *      dongle is already in UART mode.
 *   2. AT!OTA* commands, ported from 9151_ota/fota_test/fota_test.py:
 *      AT!OTAVER? → AT!OTABEGIN=<size>,0 → AT!OTADATA=<off>,<hex> … →
 *      AT!OTAEND → AT!OTAVER? → AT!OTAREB
 *   The modem takes ~3 minutes to boot the new image, so the version is not
 *   read back after the reboot.
 *   3. Wait 2.5 minutes, send the passthrough escape sequence to return the
 *      dongle to Modbus mode, then set the password over Modbus to confirm the
 *      dongle answers again.
 */

import { buildWriteMultipleRegisters, buildWriteSingleRegister, hexString } from './modbus';
import { encodeATCommand, splitLines, detectTerminator } from './atProtocol';
import { MODBUS_CONSTANTS } from '../types';
import type { IoAdapter, LogDirection } from './ntnUpdate';

export type Fota9151Phase =
  | 'idle'
  | 'uart_switch'
  | 'wait_at_ready'
  | 'ota_version'
  | 'ota_begin'
  | 'ota_transferring'
  | 'ota_end'
  | 'ota_pending'
  | 'ota_reboot'
  | 'modbus_wait'
  | 'modbus_switch'
  | 'modbus_password'
  | 'done';

export interface Fota9151Options {
  image: Uint8Array;
  slaveId?: number;
  /** Dongle is already in UART passthrough mode: skip the Modbus switch. */
  skipModbus?: boolean;
  onPhase?: (phase: Fota9151Phase) => void;
  onProgress?: (percent: number) => void;
  onLog?: (dir: LogDirection, message: string) => void;
}

// 256 bytes -> 512 hex chars per AT!OTADATA line (fota_test.py CH)
const CHUNK_SIZE = 256;
// An OTADATA line is ~530 bytes, more than Web Serial's default 255-byte buffer.
// Write it in smaller slices so no single write exceeds the port buffer; the
// modem accepts a line split this way (checked with 64 B slices on hardware).
const WRITE_SLICE = 128;
const DATA_TIMEOUT_MS = 10_000;
const DATA_RETRIES = 2;
const BEGIN_TIMEOUT_MS = 60_000;
const END_TIMEOUT_MS = 30_000;
const REBOOT_TIMEOUT_MS = 5_000;
const MODBUS_TIMEOUT_MS = 1200;
// Default NTN dongle Modbus password (8 ASCII zero digits -> 4 zero registers)
const PASSWORD_REGISTERS = [0, 0, 0, 0];
// The modem may still be booting right after the switch: retry AT (see useDongleConnectionAT)
const AT_READY_ATTEMPTS = 40;
const AT_READY_INTERVAL_MS = 2000;
// Raw bytes that make the dongle leave UART passthrough and return to Modbus mode
const MODBUS_MODE_SEQUENCE = new Uint8Array([0x01, 0x02, 0x05, 0x01, 0x02]);
const MODBUS_RETURN_WAIT_MS = 150_000;
const MODBUS_WAIT_LOG_MS = 30_000;
const RETURN_PASSWORD_ATTEMPTS = 3;

// AT!OTAVER? swap field: 1=NONE 2=TEST 3=PERM 4=REVERT 5=FAIL
const SWAP_NAMES: Record<string, string> = { '1': 'NONE', '2': 'TEST', '3': 'PERM', '4': 'REVERT', '5': 'FAIL' };

interface OtaVersion { version: string; swap: string; confirmed: string }

/** Parse a "<ver>,<swap>,<confirmed>" AT!OTAVER? reply line (with or without a "!OTAVER:" tag). */
export function parseOtaVersion(lines: string[]): OtaVersion | null {
  for (const line of lines) {
    const value = line.includes(':') ? line.slice(line.indexOf(':') + 1).trim() : line.trim();
    const m = /^"?([^",]+)"?\s*,\s*(\d)\s*,\s*(\d)$/.exec(value);
    if (m) return { version: m[1], swap: m[2], confirmed: m[3] };
  }
  return null;
}

function describeVersion(v: OtaVersion | null): string {
  if (!v) return 'unknown';
  return `version ${v.version}, swap ${v.swap} (${SWAP_NAMES[v.swap] ?? '?'}), confirmed ${v.confirmed}`;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// The OTA commands add detail to their final line: AT!OTADATA answers
// "OK:<total bytes received>", AT!OTAEND "OK: scheduled(test)".
const OK_COUNT_RE = /^OK:(\d+)$/;

function terminatorOf(line: string) {
  if (/^OK:/.test(line)) return { terminated: true, ok: true };
  if (/^ERROR:/.test(line)) return { terminated: true, ok: false };
  return detectTerminator(line);
}

export async function runNrf9151Update(io: IoAdapter, opts: Fota9151Options): Promise<void> {
  const {
    image,
    slaveId = MODBUS_CONSTANTS.SLAVE_ID,
    skipModbus = false,
    onPhase = () => undefined,
    onProgress = () => undefined,
    onLog = () => undefined,
  } = opts;
  const log = onLog;
  const phase = (p: Fota9151Phase) => { onPhase(p); log('SYS', `Phase: ${p}`); };

  // Drop anything already buffered (fota_test.py reset_input_buffer). read(0)
  // returns buffered bytes immediately and rejects once the buffer is empty.
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      try { await io.read(0); } catch { return; }
    }
  };

  // Send an AT command and collect lines until OK / ERROR / +CME ERROR.
  // Returns null on timeout. `quiet` suppresses TX/RX logging (AT polling, OTADATA).
  // Text received for the last command that did not end in OK/ERROR, for diagnostics.
  let lastPartial = '';

  const writeSliced = async (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i += WRITE_SLICE) {
      await io.write(bytes.subarray(i, i + WRITE_SLICE));
    }
  };

  // `status` is the terminating line (OK / OK:<n> / ERROR / +CME ERROR...).
  const sendAt = async (cmd: string, timeoutMs: number, quiet = false): Promise<{ ok: boolean; lines: string[]; status: string } | null> => {
    await drain();
    lastPartial = '';
    if (!quiet) log('TX', cmd);
    await writeSliced(encodeATCommand(cmd));
    const decoder = new TextDecoder();
    const lines: string[] = [];
    let text = '';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let chunk: Uint8Array;
      try {
        chunk = await io.read(Math.max(1, deadline - Date.now()));
      } catch {
        break;
      }
      text += decoder.decode(chunk, { stream: true });
      const split = splitLines(text);
      text = split.remainder;
      for (const line of split.lines) {
        if (!quiet) log('RX', line);
        const term = terminatorOf(line);
        if (term.terminated) return { ok: term.ok, lines, status: line };
        lines.push(line);
      }
      // Only complete lines count: a reply can arrive split mid-line, e.g. "OK:1" + "98912\r\n"
    }
    lastPartial = [...lines, text.trim()].filter(Boolean).join(' | ');
    if (!quiet) log('SYS', `No complete response to ${cmd.length > 40 ? cmd.slice(0, 40) + '…' : cmd} within ${Math.round(timeoutMs / 1000)}s`);
    return null;
  };

  const modbusWrite = async (frame: Uint8Array, label: string, fc: number): Promise<boolean> => {
    await drain();
    log('TX', `[MODBUS] ${label}: ${hexString(frame)}`);
    await io.write(frame);
    let resp = new Uint8Array(0);
    const deadline = Date.now() + MODBUS_TIMEOUT_MS;
    while (resp.length < 8 && Date.now() < deadline) {
      try {
        const chunk = await io.read(Math.max(1, deadline - Date.now()));
        const merged = new Uint8Array(resp.length + chunk.length);
        merged.set(resp);
        merged.set(chunk, resp.length);
        resp = merged;
      } catch {
        break;
      }
    }
    if (resp.length >= 8 && resp[0] === slaveId && resp[1] === fc) {
      log('RX', `[MODBUS] ${label} ack: ${hexString(resp)}`);
      return true;
    }
    log('SYS', `${label}: no valid Modbus response${resp.length ? ` (got ${hexString(resp)})` : ''}`);
    return false;
  };

  // ── 1. Switch to UART passthrough ─────────────────────────────────────────
  if (!skipModbus) {
    phase('uart_switch');
    let pwAcked = false;
    for (let attempt = 1; attempt <= 2 && !pwAcked; attempt++) {
      pwAcked = await modbusWrite(
        buildWriteMultipleRegisters(slaveId, MODBUS_CONSTANTS.ADDR_PASSWORD, PASSWORD_REGISTERS),
        `Set password (attempt ${attempt}/2)`, MODBUS_CONSTANTS.WRITE_MULTIPLE_REGISTERS);
      if (!pwAcked && attempt < 2) await sleep(400);
    }
    if (!pwAcked) {
      // Dongle may already be in UART passthrough (it ignores Modbus there)
      log('SYS', 'No Modbus response - probing for an existing UART passthrough session...');
      const probe = await sendAt('AT', 1200);
      if (!probe) {
        throw new Error('NTN dongle is not responding (Modbus and AT probe both failed). Check device power/connection and Slave ID.');
      }
      log('SYS', 'Device is already in UART passthrough mode - skipping Modbus switch.');
    } else {
      await sleep(300);
      let modeAcked = false;
      for (let attempt = 1; attempt <= 3 && !modeAcked; attempt++) {
        modeAcked = await modbusWrite(
          buildWriteSingleRegister(slaveId, MODBUS_CONSTANTS.ADDR_UART_MODE, 0x03),
          `Set UART passthrough mode / MODE 3 (attempt ${attempt}/3)`, MODBUS_CONSTANTS.WRITE_SINGLE_REGISTER);
        if (!modeAcked && attempt < 3) await sleep(400);
      }
      if (!modeAcked) {
        throw new Error('Password was accepted, but the dongle did not ack the switch to UART passthrough mode.');
      }
      log('SYS', 'Device switched to UART passthrough mode.');
      await sleep(400);
    }
  } else {
    log('SYS', 'Skipping Modbus phase - device assumed already in UART passthrough mode');
  }

  // ── 2. Wait for the modem to answer AT commands ───────────────────────────
  phase('wait_at_ready');
  let ready = false;
  for (let attempt = 1; attempt <= AT_READY_ATTEMPTS && !ready; attempt++) {
    const r = await sendAt('AT', AT_READY_INTERVAL_MS, true);
    ready = !!r?.ok;
    // Show what came back instead of OK (a reply hidden by quiet mode looks like silence)
    const got = r ? [...r.lines, r.status].join(' | ') : lastPartial;
    if (ready) log('SYS', `Modem AT Ready (AT -> OK, attempt ${attempt}/${AT_READY_ATTEMPTS}).`);
    else if (attempt % 5 === 0) log('SYS', `Still waiting for Modem AT Ready... (attempt ${attempt}/${AT_READY_ATTEMPTS}${got ? `, received: ${got}` : ', no reply'})`);
  }
  if (!ready) {
    throw new Error(`Modem did not answer AT after ${AT_READY_ATTEMPTS} attempts (~${AT_READY_ATTEMPTS * AT_READY_INTERVAL_MS / 1000}s).`);
  }

  // ── 3. OTA ────────────────────────────────────────────────────────────────
  const size = image.length;
  log('SYS', `Image size: ${size} bytes (${Math.ceil(size / CHUNK_SIZE)} chunks of ${CHUNK_SIZE} B)`);

  phase('ota_version');
  const before = await sendAt('AT!OTAVER?', DATA_TIMEOUT_MS);
  log('SYS', `Current modem image: ${describeVersion(before ? parseOtaVersion(before.lines) : null)}`);

  phase('ota_begin');
  const begin = await sendAt(`AT!OTABEGIN=${size},0`, BEGIN_TIMEOUT_MS);
  if (!begin?.ok) throw new Error(`AT!OTABEGIN failed (${begin ? begin.status : 'no response'}) - the modem did not accept the image size.`);

  phase('ota_transferring');
  onProgress(0);
  let off = 0;
  let lastPct = -1;
  while (off < size) {
    const chunk = image.subarray(off, off + CHUNK_SIZE);
    let hex = '';
    for (const b of chunk) hex += b.toString(16).padStart(2, '0');
    const cmd = `AT!OTADATA=${off},${hex}`;
    if (off === 0) log('TX', `AT!OTADATA=0,${hex.slice(0, 16)}… (${cmd.length + 2} bytes per line, logged for the first chunk only)`);
    let r = await sendAt(cmd, DATA_TIMEOUT_MS, true);
    // Resend only when nothing came back (e.g. the line was cut off); the byte
    // count check below catches a chunk the modem had already received.
    for (let retry = 1; r === null && retry <= DATA_RETRIES; retry++) {
      log('SYS', `No reply for chunk @ ${off}${lastPartial ? ` (received: ${lastPartial})` : ''}, retrying (${retry}/${DATA_RETRIES})...`);
      // Terminate any partial line the modem is still holding before resending
      await io.write(encodeATCommand(''));
      await sleep(300);
      r = await sendAt(cmd, DATA_TIMEOUT_MS, true);
    }
    if (!r?.ok) {
      const detail = r ? [...r.lines, r.status].join(' ') : `no response${lastPartial ? ` (received: ${lastPartial})` : ''}`;
      throw new Error(`AT!OTADATA failed @ offset ${off}: ${detail}`);
    }
    // The modem reports its running byte count; a resent chunk it had already
    // received is counted twice, which would corrupt the image.
    const count = OK_COUNT_RE.exec(r.status);
    if (count && Number(count[1]) !== off + chunk.length) {
      throw new Error(`Modem byte count mismatch @ offset ${off}: modem reports ${count[1]} bytes, expected ${off + chunk.length}. Restart the update.`);
    }
    if (off === 0) log('RX', `${r.status} (logged for the first chunk only)`);
    off += chunk.length;
    const pct = Math.floor(off * 100 / size);
    if (pct !== lastPct) { onProgress(pct); lastPct = pct; }
    if (off % (CHUNK_SIZE * 40) === 0 || off >= size) log('SYS', `Transferred ${off}/${size} bytes (${pct}%)`);
  }

  phase('ota_end');
  const end = await sendAt('AT!OTAEND', END_TIMEOUT_MS);
  if (!end?.ok) throw new Error(`AT!OTAEND failed (${end ? end.status : 'no response'}).`);

  phase('ota_pending');
  const pending = await sendAt('AT!OTAVER?', DATA_TIMEOUT_MS);
  log('SYS', `Pending image: ${describeVersion(pending ? parseOtaVersion(pending.lines) : null)} (expected swap 2 = TEST)`);

  phase('ota_reboot');
  await sendAt('AT!OTAREB', REBOOT_TIMEOUT_MS);
  log('SYS', 'Modem is rebooting into the new image. This takes about 3 minutes; '
    + 'afterwards AT!OTAVER? should report the new version with swap 1 (NONE).');

  // ── 4. Return to Modbus mode ──────────────────────────────────────────────
  phase('modbus_wait');
  for (let waited = 0; waited < MODBUS_RETURN_WAIT_MS; waited += MODBUS_WAIT_LOG_MS) {
    log('SYS', `Waiting for the modem to boot the new image... ${Math.round((MODBUS_RETURN_WAIT_MS - waited) / 1000)}s left`);
    await sleep(Math.min(MODBUS_WAIT_LOG_MS, MODBUS_RETURN_WAIT_MS - waited));
  }

  phase('modbus_switch');
  log('TX', `[UART] Switch to Modbus mode: ${hexString(MODBUS_MODE_SEQUENCE)}`);
  await io.write(MODBUS_MODE_SEQUENCE);

  phase('modbus_password');
  let pwAcked = false;
  for (let attempt = 1; attempt <= RETURN_PASSWORD_ATTEMPTS && !pwAcked; attempt++) {
    pwAcked = await modbusWrite(
      buildWriteMultipleRegisters(slaveId, MODBUS_CONSTANTS.ADDR_PASSWORD, PASSWORD_REGISTERS),
      `Set password (attempt ${attempt}/${RETURN_PASSWORD_ATTEMPTS})`, MODBUS_CONSTANTS.WRITE_MULTIPLE_REGISTERS);
    if (!pwAcked && attempt < RETURN_PASSWORD_ATTEMPTS) await sleep(1000);
  }
  if (!pwAcked) {
    throw new Error('Firmware was sent and the modem rebooted, but the dongle did not answer the Modbus password after switching back to Modbus mode. Re-plug the dongle to return it to Modbus mode.');
  }
  log('SYS', 'Dongle is back in Modbus mode.');

  phase('done');
  log('SYS', 'nRF9151 firmware update complete.');
}
