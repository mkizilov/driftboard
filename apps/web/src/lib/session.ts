import { Board, generateReplicaId, type ReplicaId } from '@driftboard/crdt';
import { BoardStore } from './board-store';
import {
  SyncConnection,
  type SocketFactory,
  type SyncConnectionOptions,
  type Timers,
} from './sync-connection';

/** A board open in this browser tab: its document, the store React reads, and the connection. */
export interface BoardSession {
  readonly boardId: string;
  readonly replicaId: ReplicaId;
  readonly store: BoardStore;
  readonly connection: SyncConnection;
  start(): void;
  dispose(): void;
}

export interface SessionOptions {
  readonly boardId: string;
  readonly url: string;
  /** Random bytes for the replica id (`crypto.getRandomValues` in the browser). */
  readonly randomBytes: (length: number) => Uint8Array;
  /** Whole milliseconds since the epoch. Defaults to `Date.now`. */
  readonly now?: () => number;
  readonly createSocket?: SocketFactory;
  readonly timers?: Timers;
  readonly random?: () => number;
  readonly retry?: SyncConnectionOptions['retry'];
}

/**
 * Opens a board. Every page load is a new replica with a new id, because two tabs sharing one
 * replica id would write conflicting operation streams.
 */
export function createBoardSession(options: SessionOptions): BoardSession {
  const replicaId = generateReplicaId(options.randomBytes);
  const now = options.now ?? (() => Date.now());
  const board = new Board({ replicaId, clock: { now } });
  const connection = new SyncConnection({
    boardId: options.boardId,
    replicaId,
    url: options.url,
    board,
    ...(options.createSocket === undefined ? {} : { createSocket: options.createSocket }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });
  const store = new BoardStore(board, (ops) => {
    connection.submit(ops);
  });
  return {
    boardId: options.boardId,
    replicaId,
    store,
    connection,
    start: () => {
      connection.start();
    },
    dispose: () => {
      connection.dispose();
    },
  };
}
