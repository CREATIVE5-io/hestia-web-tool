import React from 'react';

interface StatusBadgeProps {
  label: string;
  active: boolean;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ label, active }) => {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-700/50 last:border-0">
      <span className="text-slate-300">{label}</span>
      <span className={`px-2 py-1 rounded text-xs font-bold ${active ? 'bg-green-900/50 text-green-400 border border-green-700' : 'bg-slate-700 text-slate-500'}`}>
        {active ? 'READY' : 'OFF'}
      </span>
    </div>
  );
};