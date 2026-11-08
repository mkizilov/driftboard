import { VersionVector, type Board, type BoardOp, type ReplicaId } from '@driftboard/crdt';
import {
  authorOps,
  emptyStore,
  encodeFrame,
  flush,
  openInitiator,
  parseFrame,
  readBoardOps,
  receive,
  type Frame,
  type OpStore,
  type Presence,
  type PresenceState,
  type Session,
  type StampedOp,
} from '@driftboard/protocol';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

/** What the UI needs to know about the connection. A new object whenever any of it changes. */
export interface SyncState {
  readonly status: ConnectionStatus;
  /** Operations the server is not known to hold. */
  readonly pending: number;
  /** Connection attempts that failed since the last working one. */
  readonly failures: number;
}

/** How many operations of `store` the vector `held` does not cover. */
export function countPending(store: OpStore, held: VersionVector): number {
  let pending = 0;
  for (const [origin, log] of store.logs) pending += Math.max(0, log.length - held.get(origin));
  return pending;
}

/** What the connection needs from a WebSocket, so that tests can stand in for it. */
export interface SocketLike {
  /** A string goes out as a text frame, bytes as a binary frame. */
  send(frame: Frame): void;
  close(): void;
}

export interface SocketHandlers {
  open(): void;
  /** A message arrived: a string (text frame) or an `ArrayBuffer` (binary frame). */
  message(data: unknown): void;
  /** The connection ended or could not be made. Always follows a failure. */
  close(): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketLike;

/** The browser's WebSocket. */
export const browserSocket: SocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  // Binary frames (operations) are handed over as ArrayBuffers rather than Blobs.
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    handlers.open();
  });
  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    handlers.message(event.data);
  });
  socket.addEventListener('close', () => {
    handlers.close();
  });
  // A failed connection is always followed by a 'close' event, which does the work.
  socket.addEventListener('error', () => undefined);
  return {
    send: (frame) => {
      socket.send(frame);
    },
    close: () => {
      socket.close();
    },
  };
};

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const browserTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface SyncConnectionOptions {
  readonly boardId: string;
  readonly replicaId: ReplicaId;
  /**
   * A secret for this replica, sent with every `hello`: the server lets a connection replace
   * this replica's earlier one only if it knows it, so that others cannot push this replica off
   * the board by saying its id. Made when the replica is, so it lasts as long as the replica.
   */
  readonly secret?: string;
  readonly url: string;
  /** Receives the operations that arrive from the server. */
  readonly board: Board;
  readonly createSocket?: SocketFactory;
  readonly timers?: Timers;
  /** A number in [0, 1) for retry jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** First retry delay and its cap, in ms; each retry doubles the delay. */
  readonly retry?: { readonly initialMs: number; readonly maxMs: number };
  /**
   * What this device already holds, read from storage before connecting: the operations, and what
   * the server was last known to hold of them. Without it the connection starts empty.
   */
  readonly initial?: { readonly store: OpStore; readonly held: VersionVector };
  /** Called with operations that just entered the store, authored here or received. */
  readonly onStored?: (ops: readonly StampedOp[]) => void;
  /** Called when what the server is known to hold has changed. */
  readonly onHeld?: (held: VersionVector) => void;
  /** Called with presence that the server relays: who is here and what they are doing. */
  readonly onPresence?: (presence: Presence) => void;
}

/**
 * Keeps one board in sync with the server over a WebSocket. It owns the replica's stamped
 * operations and runs the pure sync logic of `@driftboard/protocol`: on every (re)connection it
 * opens with its version vector and the server answers with exactly what it lacks; local operations
 * are sent once connected, and anything made while offline goes out on the next connection.
 *
 * It reconnects forever with exponential backoff and jitter. `getState` is for the UI: `status` is
 * `connecting` (trying), `online` (hello exchanged) or `offline` (waiting to retry), and `pending`
 * counts the operations the server is not known to hold. The connection does not store anything
 * itself: it starts from `initial` and reports what enters the store through `onStored` and what
 * the server holds through `onHeld`, so the caller can keep them across page loads.
 */
export class SyncConnection {
  readonly #options: SyncConnectionOptions;
  readonly #createSocket: SocketFactory;
  readonly #timers: Timers;
  readonly #random: () => number;
  readonly #listeners = new Set<() => void>();
  #store: OpStore;
  /** What the server is known to hold, as of the last time it told us. */
  #held: VersionVector;
  #session: Session | null = null;
  #socket: SocketLike | null = null;
  /** Identifies the current socket, so events from an old one are ignored. */
  #token: object | null = null;
  #retryTimer: unknown = undefined;
  #attempt = 0;
  #disposed = false;
  #state: SyncState;
  #lastError: string | null = null;
  #quarantined = 0;

  constructor(options: SyncConnectionOptions) {
    this.#options = options;
    this.#createSocket = options.createSocket ?? browserSocket;
    this.#timers = options.timers ?? browserTimers;
    this.#random = options.random ?? Math.random;
    this.#store = options.initial?.store ?? emptyStore;
    this.#held = options.initial?.held ?? VersionVector.empty;
    this.#state = {
      status: 'offline',
      pending: countPending(this.#store, this.#held),
      failures: 0,
    };
  }

  readonly getState = (): SyncState => this.#state;

  readonly getStatus = (): ConnectionStatus => this.#state.status;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Why the last connection ended, if the server or the data were at fault. */
  get lastError(): string | null {
    return this.#lastError;
  }

  /**
   * How many operations from the server were set aside instead of applied since this started,
   * because they were not valid or could not be applied. A server that checks what it relays
   * never causes this; it is a sign of a damaged disk or of a server that is not to be trusted.
   */
  get quarantinedCount(): number {
    return this.#quarantined;
  }

  /** Starts connecting. */
  start(): void {
    if (!this.#disposed && this.#socket === null && this.#retryTimer === undefined) {
      this.#connect();
    }
  }

  /** Records operations made on this replica and sends them if connected. */
  submit(ops: BoardOp[]): void {
    const authored = authorOps(this.#store, this.#options.replicaId, ops);
    this.#store = authored.store;
    this.#options.onStored?.(authored.ops);
    this.#flush();
    this.#update({});
  }

  /**
   * Sends this replica's presence (`null` says it has left). Presence is ephemeral: it is sent now
   * or not at all. Returns whether there was a connection to send it on.
   */
  sendPresence(state: PresenceState | null): boolean {
    if (this.#session === null || this.#session.phase !== 'ready') return false;
    const replicaId = this.#options.replicaId;
    this.#send(encodeFrame({ type: 'presence', replicaId, state }));
    return true;
  }

  /** The network is back (or the user asks): connect now instead of waiting out the retry delay. */
  retryNow(): void {
    if (this.#retryTimer === undefined) return;
    this.#timers.clearTimeout(this.#retryTimer);
    this.#connect();
  }

  /**
   * The browser says the network is gone. A connection can look open for minutes after that, so
   * give it up now and wait for the retry.
   */
  networkLost(): void {
    const socket = this.#socket;
    if (socket === null || this.#disposed) return;
    this.#onClose();
    socket.close();
  }

  /** Closes the connection and stops retrying. */
  dispose(): void {
    this.#disposed = true;
    if (this.#retryTimer !== undefined) this.#timers.clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    const socket = this.#socket;
    this.#token = null;
    this.#socket = null;
    this.#session = null;
    socket?.close();
    this.#setStatus('offline');
  }

  /** Replaces the state if anything in it changed, and tells the listeners. */
  #update(change: Partial<Pick<SyncState, 'status'>>): void {
    const next: SyncState = {
      status: change.status ?? this.#state.status,
      pending: countPending(this.#store, this.#held),
      failures: this.#attempt,
    };
    const { status, pending, failures } = this.#state;
    if (next.status === status && next.pending === pending && next.failures === failures) return;
    this.#state = next;
    for (const listener of [...this.#listeners]) listener();
  }

  #setStatus(status: ConnectionStatus): void {
    this.#update({ status });
  }

  #connect(): void {
    this.#retryTimer = undefined;
    this.#setStatus('connecting');
    const token = {};
    this.#token = token;
    const socket = this.#createSocket(this.#options.url, {
      open: () => {
        if (this.#token === token) this.#onOpen();
      },
      message: (data) => {
        if (this.#token === token) this.#onMessage(data);
      },
      close: () => {
        if (this.#token === token) this.#onClose();
      },
    });
    if (this.#token === token) this.#socket = socket;
    else socket.close();
  }

  #onOpen(): void {
    const { replicaId, boardId, secret } = this.#options;
    const open = openInitiator(
      { self: replicaId, boardId, ...(secret === undefined ? {} : { token: secret }) },
      this.#store,
    );
    this.#session = open.session;
    for (const message of open.send) this.#send(encodeFrame(message));
  }

  #onMessage(data: unknown): void {
    if (this.#session === null) return;
    if (
      typeof data !== 'string' &&
      !(data instanceof ArrayBuffer) &&
      !(data instanceof Uint8Array)
    ) {
      this.#fail('the server sent a message that is neither text nor bytes');
      return;
    }
    // Whatever a server sends, it must not throw out of the socket's event handler.
    try {
      this.#handle(data);
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : 'could not handle a message');
    }
  }

  #handle(data: string | ArrayBuffer | Uint8Array): void {
    if (this.#session === null) return;
    const parsed = parseFrame(data);
    if (!parsed.ok) {
      this.#fail(`the server sent an invalid message: ${parsed.error}`);
      return;
    }
    const step = receive(this.#session, this.#store, parsed.message);
    this.#session = step.session;
    this.#store = step.store;
    if (step.applied.length > 0) this.#options.onStored?.(step.applied);
    this.#trackHeld(step.session);
    if (step.presence !== null) this.#options.onPresence?.(step.presence);
    if (step.applied.length > 0) {
      const { ops, invalid } = readBoardOps(step.applied);
      const rejected = this.#options.board.applyUntrusted(ops);
      this.#quarantined += invalid + rejected.length;
    }
    for (const message of step.send) this.#send(encodeFrame(message));
    if (step.peerError !== null) {
      this.#fail(`the server rejected the connection: ${step.peerError.message}`);
      return;
    }
    if (step.session.phase === 'closed') {
      this.#fail('the connection was closed after a protocol error');
      return;
    }
    if (step.session.phase === 'ready') {
      this.#attempt = 0;
      this.#lastError = null;
      this.#update({ status: 'online' });
    }
  }

  /**
   * The server's `hello` tells what it really holds, and its acks only add to that, so a ready
   * session's `acked` is always the truth, even when it is less than what was stored.
   */
  #trackHeld(session: Session): void {
    if (session.phase !== 'ready' || session.acked.equals(this.#held)) return;
    this.#held = session.acked;
    this.#options.onHeld?.(session.acked);
  }

  #onClose(): void {
    this.#socket = null;
    this.#token = null;
    this.#session = null;
    if (this.#disposed) {
      this.#setStatus('offline');
      return;
    }
    const { initialMs, maxMs } = this.#options.retry ?? { initialMs: 500, maxMs: 15_000 };
    const delay = Math.min(maxMs, initialMs * 2 ** this.#attempt) * (0.5 + this.#random() / 2);
    this.#attempt += 1;
    this.#retryTimer = this.#timers.setTimeout(() => {
      if (!this.#disposed) this.#connect();
    }, delay);
    this.#setStatus('offline');
  }

  #fail(reason: string): void {
    this.#lastError = reason;
    // Closing makes the socket report 'close', which schedules the retry.
    this.#socket?.close();
  }

  #flush(): void {
    if (this.#session === null || this.#session.phase !== 'ready') return;
    const flushed = flush(this.#session, this.#store);
    this.#session = flushed.session;
    for (const message of flushed.send) this.#send(encodeFrame(message));
  }

  #send(frame: Frame): void {
    this.#socket?.send(frame);
  }
}
