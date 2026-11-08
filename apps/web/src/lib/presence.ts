import type { PresenceState } from '@driftboard/protocol';
import type { IdentityStore } from './identity';
import { PresenceSender } from './presence-sender';
import type { PresenceStore } from './presence-store';
import type { ConnectionStatus, Timers } from './sync-connection';
import type { Point } from './viewport';

/** The part of a `SyncConnection` that presence needs. */
export interface PresenceConnection {
  getStatus(): ConnectionStatus;
  subscribe(listener: () => void): () => void;
  /** Sends this replica's presence; returns false when there is no connection to send it on. */
  sendPresence(state: PresenceState | null): boolean;
}

export interface PresenceOptions {
  readonly store: PresenceStore;
  readonly identity: IdentityStore;
  readonly connection: PresenceConnection;
  /** Milliseconds from any start that never goes backwards (`performance.now`). */
  readonly now: () => number;
  readonly timers: Timers;
}

/** What the board page tells the others, and what it hears from them. */
export interface LivePresence {
  readonly store: PresenceStore;
  readonly identity: IdentityStore;
  /** What this person is showing the others right now. */
  getState(): PresenceState;
  /** The pointer, in board coordinates; `null` when it is not over the board. */
  moveCursor(point: Point | null): void;
  startEditing(noteId: string): void;
  /** Only stops if the person is still editing that note, so a quick change of note stands. */
  stopEditing(noteId: string): void;
  dispose(): void;
}

/**
 * Joins this person's presence to a connection. It is sent through a `PresenceSender`, which
 * throttles it and repeats it, only while the connection is online, and what comes in goes to the
 * `PresenceStore` (the connection's `onPresence` feeds it). Presence is not kept anywhere: when the
 * connection is lost everyone else is forgotten, because nothing can be known about them any more,
 * and when it returns the server tells who is here.
 */
export function createPresence(options: PresenceOptions): LivePresence {
  const { store, identity, connection } = options;
  const sender = new PresenceSender({
    send: (state) => connection.sendPresence(state),
    now: options.now,
    timers: options.timers,
    identity: identity.getIdentity(),
  });

  let online = false;
  const follow = () => {
    const nowOnline = connection.getStatus() === 'online';
    if (nowOnline === online) return;
    online = nowOnline;
    sender.setConnected(nowOnline);
    if (!nowOnline) store.clear();
  };
  const stopFollowing = connection.subscribe(follow);
  const stopIdentity = identity.subscribe(() => {
    sender.setIdentity(identity.getIdentity());
  });
  follow();

  return {
    store,
    identity,
    getState: () => sender.getState(),
    moveCursor: (point) => {
      sender.moveCursor(point);
    },
    startEditing: (noteId) => {
      sender.setEditing(noteId);
    },
    stopEditing: (noteId) => {
      if (sender.getState().editing === noteId) sender.setEditing(null);
    },
    dispose: () => {
      stopFollowing();
      stopIdentity();
      sender.dispose();
      store.dispose();
    },
  };
}
