import React, { useEffect, useRef } from 'react';
import { LogEntry } from '../types';

interface LogViewerProps {
  logs: LogEntry[];
  onClear?: () => void;
}

export const LogViewer: React.FC<LogViewerProps> = ({ logs, onClear }) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  return (
    <div className="flex flex-col h-full bg-slate-950 rounded-lg border border-slate-800 font-mono text-xs overflow-hidden">
      <div className="bg-slate-900 px-4 py-2 border-b border-slate-800 text-slate-400 font-semibold flex justify-between items-center">
        <span>SERIAL LOG</span>
        <div className="flex items-center gap-4">
          <span className="text-slate-600 text-[10px] uppercase tracking-wider">Autoscroll ON</span>
          {onClear && (
            <button 
              onClick={onClear}
              className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white px-2 py-1 rounded transition-colors border border-slate-700 hover:border-slate-600"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-1 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900">
        {logs.length === 0 && <div className="text-slate-600 italic">No activity...</div>}
        {logs.map((log) => (
          <div key={log.id} className="flex gap-2">
            <span className="text-slate-600 shrink-0">[{log.timestamp}]</span>
            <span className={`font-bold w-10 shrink-0 ${
              log.direction === 'TX' ? 'text-blue-400' : 
              log.direction === 'RX' ? 'text-green-400' : 'text-yellow-400'
            }`}>
              {log.direction}
            </span>
            <span className={`break-all ${log.isError ? 'text-red-400' : 'text-slate-300'}`}>
              {log.message}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};