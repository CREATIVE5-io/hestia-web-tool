import React, { useState } from 'react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';

interface CollapsibleSectionProps {
  title: string;
  summary?: React.ReactNode; // shown next to the title, e.g. current values while collapsed
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({ title, summary, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 shadow-sm">
      <button
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-4 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-lg group"
      >
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 min-w-0">
          <span className="text-sm font-semibold uppercase tracking-wider text-blue-400">{title}</span>
          {summary && <span className="text-xs text-slate-400">{summary}</span>}
        </span>
        <ChevronDownIcon className={`w-4 h-4 shrink-0 text-slate-400 group-hover:text-slate-200 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="px-4 pb-4 pt-4 border-t border-slate-700/50">{children}</div>}
    </div>
  );
};
