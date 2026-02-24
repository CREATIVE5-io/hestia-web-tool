import React from 'react';

type AccentColor = 'blue' | 'purple' | 'green' | 'cyan';

const titleColors: Record<AccentColor, string> = {
  blue: 'text-blue-400',
  purple: 'text-purple-400',
  green: 'text-green-400',
  cyan: 'text-cyan-400',
};

interface DashboardCardProps {
  title: string;
  children: React.ReactNode;
  className?: string;
  accent?: AccentColor;
}

export const DashboardCard: React.FC<DashboardCardProps> = ({ title, children, className = '', accent }) => {
  return (
    <div className={`bg-slate-800 rounded-lg border border-slate-700 shadow-sm p-4 ${className}`}>
      <h3 className={`text-sm font-semibold uppercase tracking-wider mb-3 pb-2 border-b border-slate-700/50 ${accent ? titleColors[accent] : 'text-slate-400'}`}>{title}</h3>
      <div>{children}</div>
    </div>
  );
};
