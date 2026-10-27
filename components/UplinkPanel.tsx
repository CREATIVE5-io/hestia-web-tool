import React, { useState } from 'react';
import { DashboardCard } from './DashboardCard';

interface UplinkPanelProps {
  isReady: boolean;
  sendUplink: (text: string, timeoutMs?: number) => Promise<string | null>;
}

type UplinkResult =
  | { kind: 'ack'; reply: string; at: string }
  | { kind: 'no-ack'; at: string }
  | { kind: 'error'; message: string; at: string };

/** Upload a text payload to the cloud through the dongle (0xC550, ACK on 0xF060/0xF061). */
export const UplinkPanel: React.FC<UplinkPanelProps> = ({ isReady, sendUplink }) => {
  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [result, setResult] = useState<UplinkResult | null>(null);

  const byteLength = new TextEncoder().encode(text).length;
  const canSend = isReady && !isSending && text.length > 0;

  const handleSend = async () => {
    if (!canSend) return;
    setIsSending(true);
    setResult(null);
    try {
      const reply = await sendUplink(text);
      const at = new Date().toLocaleTimeString();
      setResult(reply === null ? { kind: 'no-ack', at } : { kind: 'ack', reply, at });
    } catch (err) {
      setResult({ kind: 'error', message: err instanceof Error ? err.message : String(err), at: new Date().toLocaleTimeString() });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <DashboardCard title="Data Upload" accent="blue">
      <form
        className="flex gap-3"
        onSubmit={(e) => { e.preventDefault(); handleSend(); }}
      >
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'e.g., {"c":[42,-80]}'}
          disabled={!isReady || isSending}
          className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:text-slate-600 disabled:cursor-not-allowed"
        />
        <button
          type="submit"
          disabled={!canSend}
          className={`shrink-0 px-6 py-2 rounded font-semibold text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800 ${
            !canSend
              ? 'bg-slate-700 text-slate-500 cursor-not-allowed focus-visible:ring-slate-600'
              : 'bg-blue-600 text-white hover:bg-blue-500 active:scale-95 focus-visible:ring-blue-500'
          }`}
        >
          {isSending ? 'Sending...' : 'Send'}
        </button>
      </form>

      <div className="flex justify-between gap-3 mt-2 text-xs">
        <span className="text-slate-500">
          {isReady ? 'Sent as-is through the dongle to the configured remote server.' : 'Connect to dongle first'}
        </span>
        <span className="font-mono text-slate-500 shrink-0">{byteLength} B</span>
      </div>

      {isSending && (
        <p className="text-xs text-amber-400 mt-2">Waiting for uplink ACK (up to 60 s)...</p>
      )}
      {result?.kind === 'ack' && (
        <p className="text-xs text-green-400 mt-2 break-all">
          <span className="text-slate-500">{result.at}</span> ACK: <span className="font-mono">{result.reply || '(empty)'}</span>
        </p>
      )}
      {result?.kind === 'no-ack' && (
        <p className="text-xs text-orange-400 mt-2">
          <span className="text-slate-500">{result.at}</span> Data written, but no uplink ACK within 60 s.
        </p>
      )}
      {result?.kind === 'error' && (
        <p className="text-xs text-red-400 mt-2 break-all">
          <span className="text-slate-500">{result.at}</span> {result.message}
        </p>
      )}
    </DashboardCard>
  );
};
