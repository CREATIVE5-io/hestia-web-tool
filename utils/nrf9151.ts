// Nordic nRF9151 (A1+/A2+) NTN/TN module command channel helpers.
// Ported from Hestia-sample-Python/ntn_modbus_master_sample.py: commands are written
// as ASCII + CRLF to 0x9C40; replies come back on 0xF060 (length) / 0xF061 (data).

export type NtnQueryCmd =
  | 'NSTATE' | 'NCHECK' | 'NGNSS' | 'NSIGNAL' | 'NREG' | 'NMO' | 'NTLE'
  | 'NCFG' | 'NVER' | 'NERR' | 'NEXTPASS' | 'MOBUF' | 'SIB32';

// Command -> reply field names, in reply order ('!<CMD>: f1,f2,...\r\n\r\nOK\r\n').
// null = reply body kept whole as { raw: body } (SIB32 ephemeris may itself contain commas).
export const NTN_QUERY_FIELDS: Record<NtnQueryCmd, string[] | null> = {
  NSTATE: ['state', 'exit_reason', 'registered', 'sock_open'],
  NCHECK: ['bitmap'],
  NGNSS: ['fix_status', 'lat', 'lon', 'alt', 'accuracy', 'valid_until'],
  NSIGNAL: ['rsrp', 'sinr', 'rsrq', 'band', 'earfcn', 'pci', 'cellid', 'tac'],
  NREG: ['cereg_stat', 'ip', 'sock', 'mo_sent', 'mt_rcvd'],
  NMO: ['queue_depth', 'queue_bytes', 'mo_sent_count', 'last_sent_ts'],
  NTLE: ['num_sats', 'target_id', 'valid', 'dirty', 'aos', 'los'],
  NCFG: ['apn', 'udp_ip', 'port', 'bind', 'pdp'],
  NVER: ['app_version', 'zephyr', 'modem_fw', 'provider'],
  NERR: ['exit_reason', 'ceer', 'fail_cnt', 'rrc_idle'],
  NEXTPASS: ['sat', 'aos', 'tca', 'los', 'max_el'],
  MOBUF: ['queue_depth', 'queue_bytes'],
  SIB32: null,
};

export const NTN_QUERY_CMDS = Object.keys(NTN_QUERY_FIELDS) as NtnQueryCmd[];

// Query name -> wire command, where they differ (bare 'MOBUF' would clear the queue).
export const NTN_QUERY_WIRE_CMD: Partial<Record<NtnQueryCmd, string>> = { MOBUF: 'MOBUF?' };

export const NCHECK_BITS = [
  'module_ready', 'sim_ready', 'provider_resolved', 'gnss_fix_valid',
  'tle_valid', 'ntn_registered', 'socket_open', 'mo_queue_pending',
];

export type NtnTrigger = 'sgp4' | 'gnss' | 'tn' | 'ntn';

export const NTN_TRIGGERS: { key: NtnTrigger; cmd: string; label: string; desc: string }[] = [
  { key: 'sgp4', cmd: 'SGP4_TRIGGER', label: 'LEO', desc: 'LEO tracking (configure the LEO satellite first)' },
  { key: 'gnss', cmd: 'GNSS_TRIGGER', label: 'GNSS', desc: 'GNSS fix' },
  { key: 'tn', cmd: 'TN_TRIGGER', label: 'TN', desc: 'Terrestrial network' },
  { key: 'ntn', cmd: 'NTN_TRIGGER', label: 'GEO', desc: 'GEO satellite (trigger GNSS first and confirm the fix via NGNSS)' },
];

export const MOCOUNT_MAX = 100;

// 0x9C40 is written with FC 0x10, which carries at most 123 registers (246 bytes incl. CRLF).
export const NTN_CMD_MAX_CHARS = 246 - 2;

export type NtnQueryResult = Record<string, string> | 'NONE' | null;

// Minimal CSV field split (double quotes, "" escapes), like Python csv.reader(skipinitialspace=True).
function splitCsv(body: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  let atFieldStart = true;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inQuotes) {
      if (c === '"' && body[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === ',') {
      out.push(cur); cur = ''; atFieldStart = true; continue;
    } else if (c === ' ' && atFieldStart) {
      continue;
    } else if (c === '"' && atFieldStart) {
      inQuotes = true;
    } else {
      cur += c;
    }
    atFieldStart = false;
  }
  out.push(cur);
  return out;
}

/**
 * Parse '!<CMD>: v1,v2,...\r\n\r\nOK\r\n' into { field: value }.
 * Returns 'NONE' for a no-data reply, null if the reply is missing/ERROR/unrecognized.
 */
export function parseNtnQueryReply(cmd: NtnQueryCmd, reply: string | null): NtnQueryResult {
  if (!reply) return null;
  if (cmd === 'MOBUF') {
    // MOBUF? replies 'MOBUF_Q:<count>/<bytes>B\r\nOK\r\n' (no '!' prefix)
    const q = reply.match(/MOBUF_Q:\s*(\d+)\s*\/\s*(\d+)\s*B/);
    return q ? { queue_depth: q[1], queue_bytes: q[2] } : null;
  }
  const m = reply.match(new RegExp(`!${cmd}:\\s*(.*?)\\s*(?:\\r?\\n|$)`));
  if (!m) return null;
  const body = m[1];
  if (body === 'NONE') return 'NONE';
  const fields = NTN_QUERY_FIELDS[cmd];
  if (fields === null) return { raw: body };

  const values = splitCsv(body);
  const parsed: Record<string, string> = {};
  fields.forEach((f, i) => { if (i < values.length) parsed[f] = values[i]; });
  // Keep any unexpected extra values visible instead of dropping them
  values.slice(fields.length).forEach((v, i) => { parsed[`extra_${i + 1}`] = v; });

  if (cmd === 'NCHECK' && parsed.bitmap !== undefined) {
    const bits = parseInt(parsed.bitmap, 16);
    if (!Number.isNaN(bits)) {
      NCHECK_BITS.forEach((name, i) => { parsed[name] = String((bits >> i) & 1); });
    }
  }
  return parsed;
}

export interface TleInfo {
  targetId: number;
  name: string;
  line1: string;
  line2: string;
}

const SATELIOT_NAME_RE = /^SATELIOT_(\d+)$/i;

/** Validate [name, line1, line2]; target ID comes from the name (only 'SATELIOT_<id>' is supported). */
export function parseTleLines(lines: string[]): TleInfo {
  if (lines.length < 3) {
    throw new Error(`TLE requires 3 lines (name + line1 + line2), got ${lines.length}`);
  }
  const [name, line1, line2] = lines;
  if (!(line1.startsWith('1 ') && line2.startsWith('2 ') && line1.length === 69 && line2.length === 69)) {
    throw new Error('Invalid TLE lines (expected two 69-char lines starting "1 " / "2 ")');
  }
  const m = name.match(SATELIOT_NAME_RE);
  if (!m) {
    throw new Error(`Unsupported satellite name '${name}': only 'SATELIOT_<id>' is currently supported`);
  }
  return { targetId: parseInt(m[1], 10), name, line1, line2 };
}

export function parseTleText(text: string): TleInfo {
  return parseTleLines(text.split(/\r?\n/).map(l => l.trim()).filter(Boolean));
}

const CELESTRAK_TLE_URL = 'https://celestrak.org/NORAD/elements/gp.php';

/** Fetch a satellite's 3-line TLE from CelesTrak by NORAD catalog number. */
export async function fetchTleCelestrak(catnr: number): Promise<TleInfo> {
  const url = `${CELESTRAK_TLE_URL}?CATNR=${catnr}&FORMAT=TLE`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`CelesTrak HTTP ${resp.status}`);
  const text = await resp.text();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) throw new Error(`No TLE found for catalog number ${catnr}: ${text.trim() || '(empty)'}`);
  const tle = parseTleLines(lines);
  const tleCatnr = parseInt(tle.line1.substring(2, 7), 10);
  if (tleCatnr !== catnr) throw new Error(`TLE is for catalog number ${tleCatnr}, not ${catnr}`);
  return tle;
}

/** Search CelesTrak by satellite name (partial match). Returns each match as 3-line TLE text, unvalidated. */
export async function searchTleCelestrak(name: string): Promise<string[]> {
  const url = `${CELESTRAK_TLE_URL}?NAME=${encodeURIComponent(name)}&FORMAT=TLE`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`CelesTrak HTTP ${resp.status}`);
  const lines = (await resp.text()).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const matches: string[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) matches.push(lines.slice(i, i + 3).join('\n'));
  if (matches.length === 0) throw new Error(`No satellite found matching '${name}'`);
  return matches;
}

export const buildSetTleCommand = (tle: TleInfo): string =>
  `SET_TLE "${tle.name}" "${tle.line1}" "${tle.line2}"`;

export type FirmwareOrbit = 'GEO' | 'LEO';

/** GEO or LEO firmware, from the NVER provider field (e.g. 'Monogoto-GEO', 'Sateliot-LEO (override)'). */
export function getFirmwareOrbit(provider?: string): FirmwareOrbit | null {
  if (!provider) return null;
  if (/\bGEO\b/i.test(provider)) return 'GEO';
  if (/\bLEO\b/i.test(provider)) return 'LEO';
  return null;
}

// NSTATE <state> -> readable description
export const NSTATE_LABELS: Record<string, string> = {
  boot: 'Booting',
  tn: 'Terrestrial',
  gnss: 'GNSS fix',
  sgp4: 'LEO tracking (waiting for pass)',
  ntn: 'Satellite connected',
  idle: 'Idle',
};

/** Which Network Mode trigger matches the NSTATE state ('ntn' depends on GEO/LEO firmware). */
export function getModeFromState(state: string | undefined, orbit: FirmwareOrbit | null): NtnTrigger | null {
  switch (state) {
    case 'tn': return 'tn';
    case 'gnss': return 'gnss';
    case 'sgp4': return 'sgp4';
    case 'ntn': return orbit === 'LEO' ? 'sgp4' : 'ntn';
    default: return null;
  }
}
