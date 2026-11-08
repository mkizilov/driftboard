import { useSaveError, useSyncState } from '../hooks/use-board';
import { describeSync } from '../lib/indicator';
import type { BoardSession } from '../lib/session';

/**
 * Whether the board is online, syncing or offline, with the number of changes waiting to go out,
 * and a warning when changes cannot be kept on this device.
 */
export function SyncIndicator({ session }: { session: BoardSession }) {
  const indicator = describeSync(useSyncState(session.connection));
  const saveError = useSaveError(session.persistence);
  const unsaved = !session.persistence.durable || saveError !== null;
  return (
    <>
      <span className="sync" data-state={indicator.kind} role="status">
        {indicator.label}
        {indicator.detail !== null && <span className="sync-detail"> · {indicator.detail}</span>}
      </span>
      {unsaved && (
        <span
          className="save-warning"
          role="alert"
          title={saveError?.message ?? 'This browser does not allow the board to be stored.'}
        >
          Not saved on this device
        </span>
      )}
    </>
  );
}
