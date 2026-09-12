// AT command line protocol helpers (RMM-T1 NTN AT Command interface)

export function encodeATCommand(command: string): Uint8Array {
  return new TextEncoder().encode(command + '\r\n');
}

/** Split a raw decoded text buffer into complete lines and the unterminated remainder. */
export function splitLines(buffer: string): { lines: string[]; remainder: string } {
  const parts = buffer.split(/\r\n|\r|\n/);
  const remainder = parts.pop() ?? '';
  const lines = parts.map(l => l.trim()).filter(l => l.length > 0);
  return { lines, remainder };
}

export interface ATTerminator {
  terminated: boolean;
  ok: boolean;
}

/** Detect whether a line ends a command's response (OK / ERROR / +CME ERROR...). */
export function detectTerminator(line: string): ATTerminator {
  if (line === 'OK') return { terminated: true, ok: true };
  if (line === 'ERROR') return { terminated: true, ok: false };
  if (/^\+CME ERROR/.test(line)) return { terminated: true, ok: false };
  return { terminated: false, ok: false };
}

/** Split a comma-separated AT parameter list, respecting double-quoted substrings. */
export function splitParams(text: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  result.push(current.trim());
  return result;
}

/** Strip a leading "+PREFIX:" / "!PREFIX:" tag from a response line and return the rest. */
export function stripPrefix(line: string): string {
  const idx = line.indexOf(':');
  return idx === -1 ? line : line.slice(idx + 1).trim();
}

/** Find the first line starting with the given tag (e.g. "!CNWSTA:", "+CPIN:") and return its stripped value. */
export function findTaggedLine(lines: string[], tag: string): string | null {
  const line = lines.find(l => l.startsWith(tag));
  return line ? stripPrefix(line) : null;
}

/**
 * Drain whatever bytes arrive on a reader within timeoutMs and return them concatenated.
 * Used for bring-up probes (e.g. detecting a Modbus ack) before the line-based AT read loop
 * is running. Cancels the reader once the window closes so no read() is left dangling.
 */
export async function readRawWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let timedOut = false;
  const timeoutPromise = new Promise<void>(resolve => setTimeout(() => { timedOut = true; resolve(); }, timeoutMs));

  const pump = (async () => {
    while (!timedOut) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        break;
      }
      if (result.done) break;
      if (result.value && result.value.length) chunks.push(result.value);
    }
  })();

  await Promise.race([timeoutPromise, pump]);

  try { await reader.cancel(); } catch { /* ignore */ }
  try { await pump; } catch { /* ignore */ }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}
