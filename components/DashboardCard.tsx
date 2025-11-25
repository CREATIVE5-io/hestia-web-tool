import React from 'react';

interface DashboardCardProps {
  title: string;
  children: React.ReactNode;
  className?: string;
}

export const DashboardCard: React.FC<DashboardCardProps> = ({ title, children, className = '' }) => {
  return (
    <div className={`bg-slate-800 rounded-lg border border-slate-700 shadow-sm p-4 ${className}`}>
      <h3 className="text-slate-400 text-sm font-semibold uppercase tracking-wider mb-2">{title}</h3>
      <div>{children}</div>
    </div>
  );
};