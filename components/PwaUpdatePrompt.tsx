import React from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { ArrowPathIcon, CheckCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';

// Shows a toast when the app is ready for offline use or a new version is available.
// The update is applied only when the user clicks Reload, so an open serial session
// (e.g. a firmware update in progress) is never interrupted.
export const PwaUpdatePrompt: React.FC = () => {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!offlineReady && !needRefresh) return null;

  const close = () => {
    setOfflineReady(false);
    setNeedRefresh(false);
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 bg-slate-800 border border-slate-700 rounded-xl shadow-lg px-4 py-3 text-sm">
      {needRefresh ? (
        <>
          <ArrowPathIcon className="w-5 h-5 text-blue-400 shrink-0" />
          <span>A new version is available.</span>
          <button
            onClick={() => updateServiceWorker(true)}
            className="px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium"
          >
            Reload
          </button>
        </>
      ) : (
        <>
          <CheckCircleIcon className="w-5 h-5 text-green-400 shrink-0" />
          <span>Ready to work offline.</span>
        </>
      )}
      <button onClick={close} className="text-slate-400 hover:text-slate-200" title="Dismiss">
        <XMarkIcon className="w-5 h-5" />
      </button>
    </div>
  );
};
