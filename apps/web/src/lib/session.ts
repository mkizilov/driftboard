import {
  Board,
  BoardHistory,
  VersionVector,
  generateReplicaId,
  type ReplicaId,
} from '@driftboard/crdt';
import { storeMissing, toBoardOps } from '@driftboard/protocol';
import { BoardStore } from './board-store';
import { IdentityStore } from './identity';
import { Persistence, restoreStore } from './persistence';
import { createPresence, type LivePresence } from './presence';
import { PresenceStore } from './presence-store';
import type { BoardStorage } from './storage';
import {
  SyncConnection,
  browserTimers,
  type SocketFactory,
  type SyncConnectionOptions,
  type Timers,
} from './sync-connection';

/**
 * A board open in this browser tab: its document, the store React reads, the connection, what is
 * kept on this device and who else is here.
 */
export interface BoardSession {
  readonly boardId: string;
  readonly replicaId: ReplicaId;
  readonly store: BoardStore;
  readonly connection: SyncConnection;
  readonly persistence: Persistence;
  /** Who else is here, and what this person shows them. Never stored. */
  readonly presence: LivePresence;
  /** Stored operations that could not be used because an earlier one of their origin is missing. */
  readonly droppedOps: number;
  start(): void;
  /** Stops the connection, writes what is queued and releases the storage. */
  dispose(): Promise<void>;
}

export interface SessionOptions {
  readonly boardId: string;
  readonly url: string;
  /** Where the board is kept on this device. */
  readonly storage: BoardStorage;
  /** Random bytes for the replica id (`crypto.getRandomValues` in the browser). */
  readonly randomBytes: (length: number) => Uint8Array;
  /** Whole milliseconds since the epoch. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Milliseconds from any start that never goes backwards, for timing presence. Defaults to
   * `performance.now`; the wall clock is no good because it can be set back.
   */
  readonly elapsed?: () => number;
  /** Who this person is on every board. Defaults to a new one that lasts as long as the page. */
  readonly identity?: IdentityStore;
  readonly createSocket?: SocketFactory;
  readonly timers?: Timers;
  readonly random?: () => number;
  readonly retry?: SyncConnectionOptions['retry'];
}

/**
 * Opens a board local-first: whatever the device holds is read from storage and put into the
 * document before anything connects, so the board is there even with no network. Every operation
 * that later enters the store is written back; nothing waits for the network or for the disk.
 * Nothing from earlier page loads can be undone: undo is for what this page did.
 *
 * Every page load is a new replica with a new id, because two tabs sharing one replica id would
 * write conflicting operation streams. Operations that earlier page loads made and the server does
 * not hold yet are not lost by that: they are in the stored log and are sent like any other
 * operation the server lacks.
 */
export async function openBoardSession(options: SessionOptions): Promise<BoardSession> {
  const stored = await options.storage.load();
  const { store: restored, dropped } = restoreStore(stored.ops);

  const replicaId = generateReplicaId(options.randomBytes);
  const now = options.now ?? (() => Date.now());
  const board = new Board({ replicaId, clock: { now } });
  board.applyRemote(toBoardOps(storeMissing(restored, VersionVector.empty)));

  const persistence = new Persistence(options.storage);
  const timers = options.timers ?? browserTimers;
  const elapsed = options.elapsed ?? (() => performance.now());
  const presenceStore = new PresenceStore({ self: replicaId, now: elapsed, timers });
  const connection = new SyncConnection({
    boardId: options.boardId,
    replicaId,
    url: options.url,
    board,
    initial: { store: restored, held: VersionVector.from(stored.held) },
    onStored: (ops) => {
      persistence.add(ops);
    },
    onHeld: (held) => {
      persistence.setHeld(held);
    },
    onPresence: presenceStore.receive,
    timers,
    ...(options.createSocket === undefined ? {} : { createSocket: options.createSocket }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });
  // Undo history lives as long as the page: it names characters this replica typed, and a reload
  // is a new replica.
  const history = new BoardHistory(board, { now: elapsed });
  const store = new BoardStore(
    board,
    (ops) => {
      connection.submit(ops);
    },
    history,
  );
  const presence = createPresence({
    store: presenceStore,
    identity: options.identity ?? new IdentityStore(null, options.randomBytes),
    connection,
    now: elapsed,
    timers,
  });
  let closing: Promise<void> | null = null;
  return {
    boardId: options.boardId,
    replicaId,
    store,
    connection,
    persistence,
    presence,
    droppedOps: dropped,
    start: () => {
      connection.start();
    },
    dispose: () => {
      presence.dispose();
      connection.dispose();
      closing ??= persistence.close();
      return closing;
    },
  };
}
