import type { SyncState } from './sync-connection';

export type IndicatorKind = 'online' | 'syncing' | 'offline';

export interface Indicator {
  readonly kind: IndicatorKind;
  /** The text to show. */
  readonly label: string;
  /** Changes made here that the server is not known to have yet. */
  readonly pending: number;
  /** "3 pending changes", or `null` when there are none. */
  readonly detail: string | null;
}

const changes = (count: number) => `${count} pending change${count === 1 ? '' : 's'}`;

/**
 * What to tell the user about the connection:
 *
 * - *online*: connected and the server has everything;
 * - *syncing*: connected and changes are still going out, or the first connection is being made;
 * - *offline*: not connected (including while retrying), with the number of changes waiting.
 *
 * A first attempt that is still in flight counts as syncing so that opening a board does not flash
 * "offline"; once an attempt has failed, trying again still counts as offline.
 */
export function describeSync({ status, pending, failures }: SyncState): Indicator {
  const detail = pending > 0 ? changes(pending) : null;
  if (status === 'online') {
    return pending === 0
      ? { kind: 'online', label: 'Online', pending, detail }
      : { kind: 'syncing', label: 'Syncing…', pending, detail };
  }
  if (status === 'connecting' && failures === 0) {
    return { kind: 'syncing', label: 'Syncing…', pending, detail };
  }
  return { kind: 'offline', label: 'Offline', pending, detail };
}
