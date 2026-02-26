/**
 * MDFU UART transport framing.
 * Pure functions — no I/O, compatible with Node.js and browser.
 *
 * Ported from pymdfu/transport/uart_transport.py and pymdfu/utils.py.
 *
 * Frame format:
 *   [FRAME_START (0x56)] + escape(packet + FCS_LE_2bytes) + [FRAME_END (0x9E)]
 *
 * Escape rule: reserved bytes inside payload are replaced with [ESCAPE (0xCC), (~byte) & 0xFF]
 *   0x56 → CC A9
 *   0x9E → CC 61
 *   0xCC → CC 33
 *
 * FCS: two's complement 16-bit addition of LE uint16 words over the packet bytes.
 *   checksum = sum(LE_uint16_words) then (~checksum) & 0xFFFF, stored LE.
 */

export const FRAME_START  = 0x56;
export const FRAME_END    = 0x9e;
export const FRAME_ESCAPE = 0xcc;

// ── Frame Check Sequence ──────────────────────────────────────────────────────

/**
 * Compute the 16-bit Frame Check Sequence for a packet.
 * Matches pymdfu's calculate_checksum().
 */
export function computeFCS(data: Uint8Array): number {
  let checksum = 0;
  // Process pairs of bytes as LE uint16
  const len = data.length;
  for (let i = 0; i < len - (len % 2); i += 2) {
    checksum = (checksum + data[i] + (data[i + 1] << 8)) & 0xffff;
  }
  // Pad with zero byte if odd length
  if (len % 2 === 1) {
    checksum = (checksum + data[len - 1]) & 0xffff;
  }
  return (~checksum) & 0xffff;
}

// ── Escape / Unescape ─────────────────────────────────────────────────────────

/** Escape reserved bytes in data. */
export function escapeBytes(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const byte of data) {
    if (byte === FRAME_START || byte === FRAME_END || byte === FRAME_ESCAPE) {
      out.push(FRAME_ESCAPE);
      out.push((~byte) & 0xff);
    } else {
      out.push(byte);
    }
  }
  return Uint8Array.from(out);
}

/** Unescape a payload (removes escape sequences). */
export function unescapeBytes(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let escaping = false;
  for (const byte of data) {
    if (escaping) {
      out.push((~byte) & 0xff);
      escaping = false;
    } else if (byte === FRAME_ESCAPE) {
      escaping = true;
    } else {
      out.push(byte);
    }
  }
  if (escaping) {
    throw new Error('Incomplete escape sequence at end of data');
  }
  return Uint8Array.from(out);
}

// ── Encode / Decode ───────────────────────────────────────────────────────────

/**
 * Encode an MDFU packet into a complete UART frame ready to send.
 * packet → [FRAME_START] + escape(packet + FCS_LE) + [FRAME_END]
 */
export function encodeFrame(packet: Uint8Array): Uint8Array {
  const fcs = computeFCS(packet);
  const fcsBytes = Uint8Array.from([fcs & 0xff, (fcs >> 8) & 0xff]);
  const payload = new Uint8Array(packet.length + 2);
  payload.set(packet, 0);
  payload.set(fcsBytes, packet.length);
  const escaped = escapeBytes(payload);
  const frame = new Uint8Array(1 + escaped.length + 1);
  frame[0] = FRAME_START;
  frame.set(escaped, 1);
  frame[frame.length - 1] = FRAME_END;
  return frame;
}

export interface DecodeResult {
  /** The extracted MDFU packet (without FCS). */
  packet: Uint8Array;
  /** Number of bytes consumed from `buf`, including start and end codes. */
  consumed: number;
}

/**
 * Attempt to decode one MDFU frame from a byte buffer.
 * Returns null if no complete frame is present yet (keep buffering).
 * Throws on framing errors (bad start code, FCS mismatch, escape error).
 *
 * Scans for FRAME_START, then FRAME_END.  Silently skips leading garbage
 * bytes before FRAME_START so partial/corrupt previous frames don't stall.
 */
export function decodeFrame(buf: Uint8Array): DecodeResult | null {
  // Find FRAME_START
  let startIdx = -1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === FRAME_START) { startIdx = i; break; }
  }
  if (startIdx === -1) return null; // No start code yet

  // Find FRAME_END after startIdx+1, respecting escape sequences
  let i = startIdx + 1;
  while (i < buf.length) {
    const b = buf[i];
    if (b === FRAME_ESCAPE) {
      i += 2; // skip escape + escaped byte
    } else if (b === FRAME_END) {
      // We have a complete frame: buf[startIdx..i] inclusive
      const rawPayload = buf.slice(startIdx + 1, i); // between start and end codes
      const unescaped = unescapeBytes(rawPayload);

      // Last 2 bytes are FCS
      if (unescaped.length < 2) {
        throw new Error('Frame too short: no FCS');
      }
      const packet = unescaped.slice(0, unescaped.length - 2);
      const receivedFCS = unescaped[unescaped.length - 2] | (unescaped[unescaped.length - 1] << 8);
      const expectedFCS = computeFCS(packet);
      if (receivedFCS !== expectedFCS) {
        throw new Error(`FCS mismatch: got 0x${receivedFCS.toString(16)}, expected 0x${expectedFCS.toString(16)}`);
      }
      return { packet, consumed: i + 1 - startIdx };
    } else {
      i++;
    }
  }
  return null; // FRAME_END not yet received
}
