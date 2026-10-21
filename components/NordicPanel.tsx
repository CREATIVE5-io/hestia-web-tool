import React, { useEffect, useState } from 'react';
import {
  SignalIcon,
  ArrowPathIcon,
  ChevronDownIcon,
} from '@heroicons/react/24/outline';
import { DashboardCard } from './DashboardCard';
import { StatusBadge } from './StatusBadge';
import { CollapsibleSection } from './CollapsibleSection';
import {
  NTN_QUERY_CMDS, NTN_QUERY_WIRE_CMD, NTN_TRIGGERS, MOCOUNT_MAX, NTN_CMD_MAX_CHARS,
  parseNtnQueryReply, parseTleText, searchTleCelestrak, buildSetTleCommand,
  getFirmwareOrbit, getModeFromState, NSTATE_LABELS,
} from '../utils/nrf9151';
import type { NtnQueryCmd, NtnQueryResult, NtnTrigger, TleInfo } from '../utils/nrf9151';

interface NordicPanelProps {
  isReady: boolean;
  sendCommand: (command: string, timeoutMs?: number) => Promise<string | null>;
}

type CardKey = 'readiness' | 'mode' | 'leo' | 'queue' | 'advanced';

interface QueryEntry {
  parsed: NtnQueryResult;
  raw: string | null;
  at: string;
}

// Read once the dongle is ready: NVER for GEO/LEO firmware (disables LEO/GEO), NSTATE for the current mode
const MODE_QUERIES: NtnQueryCmd[] = ['NVER', 'NSTATE'];

// NCHECK bits shown as readiness rows (mo_queue_pending is shown in the queue card instead)
const READINESS_ROWS: { key: string; label: string }[] = [
  { key: 'provider_resolved', label: 'Provider Resolved' },
  { key: 'gnss_fix_valid', label: 'GNSS Fix' },
  { key: 'tle_valid', label: 'Satellite Orbit (TLE)' },
  { key: 'ntn_registered', label: 'NTN Registered' },
  { key: 'socket_open', label: 'Socket Open' },
];

// Only Sateliot satellites are supported for now, so the lookup always searches this name
const TLE_SEARCH_NAME = 'SATELIOT';

const MODE_LABELS: Record<NtnTrigger, { label: string; desc: string }> = {
  sgp4: { label: 'LEO', desc: 'Track the LEO satellite configured below.' },
  ntn: { label: 'GEO', desc: 'Connect via GEO satellite. Run GNSS first and wait for a GNSS fix.' },
  gnss: { label: 'GNSS', desc: 'Get a GNSS position fix.' },
  tn: { label: 'Terrestrial', desc: 'Use the terrestrial (cellular) network.' },
};
const MODE_ORDER: NtnTrigger[] = ['sgp4', 'ntn', 'gnss', 'tn'];

const inputClass = (disabled: boolean) =>
  `w-full border border-slate-600 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 focus:border-transparent ${
    disabled ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-slate-900 text-white'
  }`;

const primaryButton = (enabled: boolean) =>
  `w-full px-3 py-2 rounded font-semibold text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
    enabled
      ? 'bg-blue-600 text-white hover:bg-blue-500 active:scale-95 focus-visible:ring-blue-500'
      : 'bg-slate-700 text-slate-500 cursor-not-allowed focus-visible:ring-slate-600'
  }`;

const secondaryButton = (enabled: boolean) =>
  `px-3 py-1.5 rounded font-semibold text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
    enabled ? 'bg-slate-700 text-slate-200 hover:bg-slate-600 active:scale-95' : 'bg-slate-700/50 text-slate-600 cursor-not-allowed'
  }`;

const fieldOf = (entry: QueryEntry | undefined, key: string): string | undefined =>
  entry && entry.parsed && entry.parsed !== 'NONE' ? entry.parsed[key] : undefined;

export const NordicPanel: React.FC<NordicPanelProps> = ({ isReady, sendCommand }) => {
  const [busy, setBusy] = useState<CardKey | null>(null);
  const [errors, setErrors] = useState<Partial<Record<CardKey, string>>>({});
  const [notes, setNotes] = useState<Partial<Record<CardKey, string>>>({});
  const [results, setResults] = useState<Partial<Record<NtnQueryCmd, QueryEntry>>>({});
  const [readinessUpdatedAt, setReadinessUpdatedAt] = useState<string | null>(null);

  const [mode, setMode] = useState<NtnTrigger | null>(null);

  // Name search results (3-line TLE text each); shown as a picker when there is more than one
  const [tleMatches, setTleMatches] = useState<string[]>([]);
  const [tleText, setTleText] = useState('');
  const [tle, setTle] = useState<TleInfo | null>(null);
  const [showManualTle, setShowManualTle] = useState(false);

  const [mobufText, setMobufText] = useState('');
  const [mocount, setMocount] = useState('5');

  const [rawCmd, setRawCmd] = useState('');
  const [lastReply, setLastReply] = useState<{ cmd: string; reply: string | null } | null>(null);
  // Advanced Diagnostics shows only the results of the last query button pressed
  const [lastAdvancedQueries, setLastAdvancedQueries] = useState<NtnQueryCmd[]>([]);

  const enabled = isReady && busy === null;

  // On connect, read firmware type and current mode; on disconnect, forget the old dongle's results.
  useEffect(() => {
    if (isReady) {
      run('mode', () => query(MODE_QUERIES));
    } else {
      setResults({});
      setMode(null);
      setLastAdvancedQueries([]);
      setReadinessUpdatedAt(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  // Run one card action; errors and success notes are shown in that card.
  const run = async (card: CardKey, fn: () => Promise<string | void>) => {
    if (!enabled) return;
    setErrors(prev => ({ ...prev, [card]: undefined }));
    setNotes(prev => ({ ...prev, [card]: undefined }));
    setBusy(card);
    try {
      const note = await fn();
      if (note) setNotes(prev => ({ ...prev, [card]: note }));
    } catch (err) {
      setErrors(prev => ({ ...prev, [card]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(null);
    }
  };

  // Send a command and fail on an ERROR reply. No reply is not treated as an error.
  const sendChecked = async (cmd: string): Promise<string | null> => {
    const reply = await sendCommand(cmd);
    setLastReply({ cmd, reply });
    if (reply !== null && reply.includes('ERROR')) throw new Error(`The modem rejected the command (${cmd.split(' ')[0]})`);
    return reply;
  };

  const query = async (cmds: NtnQueryCmd[]) => {
    for (const cmd of cmds) {
      const raw = await sendCommand(NTN_QUERY_WIRE_CMD[cmd] ?? cmd);
      const entry: QueryEntry = { parsed: parseNtnQueryReply(cmd, raw), raw, at: new Date().toLocaleTimeString() };
      setResults(prev => ({ ...prev, [cmd]: entry }));
    }
  };

  const refreshReadiness = () => run('readiness', async () => {
    await query(['NCHECK']);
    setReadinessUpdatedAt(new Date().toLocaleTimeString());
  });

  const handleFetchTle = async () => {
    setErrors(prev => ({ ...prev, leo: undefined }));
    setNotes(prev => ({ ...prev, leo: undefined }));
    setTleMatches([]);
    setBusy('leo');
    try {
      const matches = await searchTleCelestrak(TLE_SEARCH_NAME);
      if (matches.length > 1) setTleMatches(matches);
      handleTleTextChange(matches[0]);
    } catch (err) {
      setTle(null);
      setErrors(prev => ({ ...prev, leo: `Could not fetch from CelesTrak (${err instanceof Error ? err.message : String(err)}). Paste the TLE manually instead.` }));
    } finally {
      setBusy(null);
    }
  };

  const handleTleTextChange = (text: string) => {
    setTleText(text);
    setErrors(prev => ({ ...prev, leo: undefined }));
    if (!text.trim()) { setTle(null); return; }
    try {
      setTle(parseTleText(text));
    } catch (err) {
      setTle(null);
      setErrors(prev => ({ ...prev, leo: err instanceof Error ? err.message : String(err) }));
    }
  };

  // Derived status values
  const ncheck = results.NCHECK;
  const ncheckParsed = ncheck?.parsed && ncheck.parsed !== 'NONE' ? ncheck.parsed : null;
  const queueDepth = fieldOf(results.MOBUF, 'queue_depth');
  const provider = fieldOf(results.NVER, 'provider');
  const orbit = getFirmwareOrbit(provider);
  const nstate = fieldOf(results.NSTATE, 'state');
  const currentMode = getModeFromState(nstate, orbit);
  // GEO firmware can't do LEO tracking and vice versa
  const modeUnavailable = (m: NtnTrigger) => (m === 'sgp4' && orbit === 'GEO') || (m === 'ntn' && orbit === 'LEO');
  // Readiness (NCHECK), the auto-MO queue and sending a TLE need LEO firmware (NVER provider '...-LEO')
  const leoFirmware = orbit === 'LEO';
  const leoEnabled = enabled && leoFirmware;

  // Preselect the modem's current mode once it's known
  useEffect(() => {
    if (currentMode) setMode(currentMode);
  }, [currentMode]);

  const mocountNum = Number(mocount);
  const mocountValid = /^\d+$/.test(mocount) && mocountNum >= 0 && mocountNum <= MOCOUNT_MAX;

  const footer = (card: CardKey) => (
    <>
      {!isReady && <p className="text-xs text-slate-500 mt-2 text-center">Connect to dongle first</p>}
      {busy === card && <p className="text-xs text-blue-400 mt-2 text-center">Waiting for modem...</p>}
      {errors[card] && <p className="text-xs text-red-400 mt-2 text-center">{errors[card]}</p>}
      {notes[card] && !errors[card] && <p className="text-xs text-green-400 mt-2 text-center">{notes[card]}</p>}
    </>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <div className="p-1.5 bg-blue-600/20 rounded border border-blue-500/30">
          <SignalIcon className="w-4 h-4 text-blue-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-white">Satellite Modem</h2>
          <p className="text-slate-400 text-xs">nRF9151 features for A1+ / A2+</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Network mode */}
        <DashboardCard title="Network Mode" accent="blue">
          <div className="mb-3">
            <div className="flex items-center justify-between py-2">
              <span className="text-slate-300 text-sm">Current Mode</span>
              <span className="flex items-center gap-2">
                <span className="font-mono text-sm text-white">{nstate ? NSTATE_LABELS[nstate] ?? nstate : '--'}</span>
                <button
                  onClick={() => run('mode', () => query(['NSTATE']))}
                  disabled={!enabled}
                  title="Refresh current mode"
                  className={`p-1 rounded ${enabled ? 'text-slate-400 hover:text-slate-200' : 'text-slate-600 cursor-not-allowed'}`}
                >
                  <ArrowPathIcon className={`w-3.5 h-3.5 ${busy === 'mode' ? 'animate-spin' : ''}`} />
                </button>
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 bg-slate-900 p-1 rounded-lg border border-slate-700">
            {MODE_ORDER.map(m => {
              const unavailable = modeUnavailable(m);
              const selectable = isReady && busy === null && !unavailable;
              return (
                <button
                  key={m}
                  onClick={() => { if (selectable) setMode(m); }}
                  disabled={!selectable}
                  title={unavailable ? `Not available on ${orbit} firmware` : undefined}
                  className={`relative px-3 py-2 rounded-lg font-semibold text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                    !isReady || unavailable
                      ? 'text-slate-600 cursor-not-allowed'
                      : mode === m
                      ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                      : 'text-slate-400 hover:text-slate-200'
                  } ${unavailable ? 'line-through' : ''}`}
                >
                  {MODE_LABELS[m].label}
                  {currentMode === m && (
                    <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-green-400" title="Current mode" />
                  )}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-slate-500 mt-2 text-center min-h-[2rem]">
            {orbit ? `${orbit} firmware: ${orbit === 'GEO' ? 'LEO' : 'GEO'} is not available. ` : ''}
            {mode ? MODE_LABELS[mode].desc : 'Select a mode to switch the modem to.'}
          </p>
          <button
            onClick={() => mode && run('mode', async () => {
              const t = NTN_TRIGGERS.find(x => x.key === mode)!;
              await sendChecked(t.cmd);
              await query(['NSTATE']);
              return `${t.cmd} sent`;
            })}
            disabled={!enabled || mode === null || mode === currentMode}
            className={`${primaryButton(enabled && mode !== null && mode !== currentMode)} mt-3`}
          >
            {busy === 'mode' ? 'Switching...' : 'Switch Mode'}
          </button>
          {footer('mode')}
        </DashboardCard>

        {/* Readiness checklist */}
        <DashboardCard title="Modem Readiness" accent="blue">
          <div className={leoFirmware ? '' : 'opacity-50'}>
            {READINESS_ROWS.map(row => (
              <StatusBadge key={row.key} label={row.label} active={leoFirmware && ncheckParsed?.[row.key] === '1'} />
            ))}
          </div>
          <button onClick={refreshReadiness} disabled={!leoEnabled} className={`${primaryButton(leoEnabled)} flex items-center justify-center gap-2 mt-3`}>
            <ArrowPathIcon className={`w-4 h-4 ${busy === 'readiness' ? 'animate-spin' : ''}`} />
            {busy === 'readiness' ? 'Refreshing...' : 'Refresh'}
          </button>
          {isReady && !leoFirmware && <p className="text-xs text-slate-500 mt-2 text-center">Requires LEO firmware</p>}
          {leoFirmware && readinessUpdatedAt && busy !== 'readiness' && <p className="text-xs text-slate-500 mt-2 text-center">Updated {readinessUpdatedAt}</p>}
          {footer('readiness')}
        </DashboardCard>

        {/* Auto-MO queue */}
        <DashboardCard title="Auto Message Queue" accent="blue">
          <div className="space-y-3 mb-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Message</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={mobufText}
                  onChange={e => setMobufText(e.target.value)}
                  placeholder="e.g., hello"
                  maxLength={NTN_CMD_MAX_CHARS - 6}
                  disabled={busy !== null || !leoFirmware}
                  className={inputClass(busy !== null || !leoFirmware)}
                />
                <button
                  onClick={() => run('queue', async () => { await sendChecked(`MOBUF ${mobufText}`); setMobufText(''); return 'Message added'; })}
                  disabled={!leoEnabled || mobufText.trim() === ''}
                  className={secondaryButton(leoEnabled && mobufText.trim() !== '')}
                >
                  Add
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Sends per Pass (0–{MOCOUNT_MAX})</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={mocount}
                  onChange={e => setMocount(e.target.value)}
                  disabled={busy !== null || !leoFirmware}
                  className={inputClass(busy !== null || !leoFirmware)}
                />
                <button
                  onClick={() => run('queue', async () => { await sendChecked(`MOCOUNT ${mocountNum}`); return `Sends per pass set to ${mocountNum}`; })}
                  disabled={!leoEnabled || !mocountValid}
                  className={secondaryButton(leoEnabled && mocountValid)}
                >
                  Set
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between py-2 border-t border-slate-700/50">
              <span className="text-slate-300 text-sm">Queued Messages</span>
              <span className="font-mono text-sm text-white">{queueDepth ?? '--'}</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => run('queue', async () => { await query(['MOBUF']); })} disabled={!leoEnabled} className={secondaryButton(leoEnabled)}>
              Check
            </button>
            <button
              onClick={() => run('queue', async () => { await sendChecked('MOBUF'); await query(['MOBUF']); return 'Queue cleared'; })}
              disabled={!leoEnabled}
              className={secondaryButton(leoEnabled)}
            >
              Clear Queue
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-2 text-center">
            {isReady && !leoFirmware ? 'Requires LEO firmware' : 'Messages are kept on the modem and sent on each LEO pass.'}
          </p>
          {footer('queue')}
        </DashboardCard>
      </div>

      {/* LEO satellite */}
      <DashboardCard title="LEO Satellite" accent="blue">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Satellite</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={TLE_SEARCH_NAME}
                  readOnly
                  disabled
                  className={inputClass(true)}
                />
                <button onClick={handleFetchTle} disabled={busy !== null} className={`${secondaryButton(busy === null)} whitespace-nowrap`}>
                  Look Up
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-1">Looks up the latest Sateliot orbit data (TLE) from CelesTrak. Needs internet.</p>
            </div>

            {tleMatches.length > 1 && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">{tleMatches.length} matches</label>
                <select
                  value={tleText}
                  onChange={e => handleTleTextChange(e.target.value)}
                  disabled={busy !== null}
                  className={inputClass(busy !== null)}
                >
                  {tleMatches.map(m => {
                    const [name, line1] = m.split('\n');
                    return <option key={m} value={m}>{name} ({line1.substring(2, 7).trim()})</option>;
                  })}
                </select>
              </div>
            )}

            <button
              onClick={() => setShowManualTle(v => !v)}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
            >
              <ChevronDownIcon className={`w-3.5 h-3.5 transition-transform ${showManualTle ? 'rotate-180' : ''}`} />
              Enter TLE manually
            </button>
            {showManualTle && (
              <textarea
                value={tleText}
                onChange={e => handleTleTextChange(e.target.value)}
                placeholder={'SATELIOT_2\n1 60534U ...\n2 60534 ...'}
                disabled={busy !== null}
                className={`${inputClass(busy !== null)} font-mono text-xs h-20`}
              />
            )}
          </div>

          <div className="flex flex-col">
            <div className="space-y-3 mb-3">
              <div className="flex items-center justify-between py-2 border-b border-slate-700/50">
                <span className="text-slate-300 text-sm">Satellite</span>
                <span className="font-mono text-sm text-white">{tle?.name ?? '--'}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-700/50">
                <span className="text-slate-300 text-sm">Target ID</span>
                <span className="font-mono text-sm text-white">{tle?.targetId ?? '--'}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-slate-300 text-sm">Orbit Data</span>
                <span className={`px-2 py-1 rounded text-xs font-bold ${tle ? 'bg-green-900/50 text-green-400 border border-green-700' : 'bg-slate-700 text-slate-500 border border-transparent'}`}>
                  {tle ? 'VALID' : 'NONE'}
                </span>
              </div>
            </div>
            <button
              onClick={() => tle && run('leo', async () => {
                await sendChecked(`SET_TARGET_ID ${tle.targetId}`);
                await sendChecked(buildSetTleCommand(tle));
                return `${tle.name} sent`;
              })}
              disabled={!leoEnabled || tle === null}
              className={`${primaryButton(leoEnabled && tle !== null)} mt-auto`}
            >
              {busy === 'leo' ? 'Sending...' : 'Send to Dongle'}
            </button>
            {isReady && !leoFirmware && <p className="text-xs text-slate-500 mt-2 text-center">Sending requires LEO firmware</p>}
            {footer('leo')}
          </div>
        </div>
      </DashboardCard>

      {/* Advanced diagnostics (collapsed by default) */}
      <CollapsibleSection title="Advanced Diagnostics">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Modem Queries</label>
              <div className="flex flex-wrap gap-2 mb-3">
                {NTN_QUERY_CMDS.map(cmd => (
                  <button key={cmd} onClick={() => run('advanced', () => { setLastAdvancedQueries([cmd]); return query([cmd]); })} disabled={!enabled} className={secondaryButton(enabled)}>
                    {cmd}
                  </button>
                ))}
                <button onClick={() => run('advanced', () => { setLastAdvancedQueries(NTN_QUERY_CMDS); return query(NTN_QUERY_CMDS); })} disabled={!enabled} className={secondaryButton(enabled)}>
                  All
                </button>
              </div>
              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {lastAdvancedQueries.filter(cmd => results[cmd]).map(cmd => {
                  const entry = results[cmd]!;
                  return (
                    <div key={cmd} className="bg-slate-900 border border-slate-700 rounded p-2">
                      <div className="flex justify-between mb-1">
                        <span className="text-xs font-semibold text-blue-400">{cmd}</span>
                        <span className="text-xs text-slate-500">{entry.at}</span>
                      </div>
                      {entry.parsed === null ? (
                        <div className="text-xs text-red-400">No valid reply</div>
                      ) : entry.parsed === 'NONE' ? (
                        <div className="text-xs text-slate-500">None</div>
                      ) : (
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                          {Object.entries(entry.parsed).map(([k, v]) => (
                            <React.Fragment key={k}>
                              <dt className="text-slate-500">{k}</dt>
                              <dd className="font-mono text-white break-all">{v}</dd>
                            </React.Fragment>
                          ))}
                        </dl>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Raw Command</label>
              <div className="flex gap-2 mb-3">
                <input
                  type="text"
                  value={rawCmd}
                  onChange={e => setRawCmd(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && rawCmd.trim()) run('advanced', async () => { await sendChecked(rawCmd.trim()); }); }}
                  placeholder="e.g., AT+CEREG?"
                  maxLength={NTN_CMD_MAX_CHARS}
                  disabled={busy !== null}
                  className={`${inputClass(busy !== null)} font-mono`}
                />
                <button
                  onClick={() => run('advanced', async () => { await sendChecked(rawCmd.trim()); })}
                  disabled={!enabled || rawCmd.trim() === ''}
                  className={secondaryButton(enabled && rawCmd.trim() !== '')}
                >
                  Send
                </button>
              </div>
              {lastReply && (
                <div className="bg-slate-900 border border-slate-700 rounded p-2">
                  <div className="text-xs text-slate-500 mb-1 truncate">Last reply · {lastReply.cmd}</div>
                  <pre className="text-xs font-mono text-white whitespace-pre-wrap break-all">{lastReply.reply ?? '(no reply)'}</pre>
                </div>
              )}
              {footer('advanced')}
            </div>
          </div>
      </CollapsibleSection>
    </div>
  );
};
