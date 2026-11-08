import { useSyncExternalStore } from 'react';
import { pwaStatus, type PwaStatus } from '../lib/pwa-status';

/**
 * Tells the user when the app is ready to work offline, and when a new version is waiting. An
 * update is never applied by itself, so a reload cannot interrupt someone who is typing.
 */
export function PwaBanner({ status = pwaStatus }: { status?: PwaStatus }) {
  const { needRefresh, offlineReady } = useSyncExternalStore(status.subscribe, status.getState);
  if (needRefresh) {
    return (
      <div className="pwa-banner" role="status">
        <span>A new version is ready.</span>
        <button
          type="button"
          onClick={() => {
            status.reload();
          }}
        >
          Reload
        </button>
        <button
          type="button"
          onClick={() => {
            status.dismiss();
          }}
        >
          Later
        </button>
      </div>
    );
  }
  if (offlineReady) {
    return (
      <div className="pwa-banner" role="status">
        <span>driftboard now works offline.</span>
        <button
          type="button"
          onClick={() => {
            status.dismiss();
          }}
        >
          OK
        </button>
      </div>
    );
  }
  return null;
}
