import type { Board, BoardOp, ReplicaId } from '@driftboard/crdt';
import {
  authorOps,
  emptyStore,
  encodeMessage,
  flush,
  openInitiator,
  parseMessage,
  receive,
  toBoardOps,
  type OpStore,
  type Session,
} from '@driftboard/protocol';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

/** What the connection needs from a WebSocket, so that tests can stand in for it. */
export interface SocketLike {
  send(text: string): void;
  close(): void;
}

export interface SocketHandlers {
  open(): void;
  /** A message arrived; anything but text is a protocol violation. */
  message(data: unknown): void;
  /** The connection ended or could not be made. Always follows a failure. */
  close(): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketLike;

/** The browser's WebSocket. */
export const browserSocket: SocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
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
    send: (text) => {
      socket.send(text);
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

const browserTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface SyncConnectionOptions {
  readonly boardId: string;
  readonly replicaId: ReplicaId;
  readonly url: string;
  /** Receives the operations that arrive from the server. */
  readonly board: Board;
  readonly createSocket?: SocketFactory;
  readonly timers?: Timers;
  /** A number in [0, 1) for retry jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** First retry delay and its cap, in ms; each retry doubles the delay. */
  readonly retry?: { readonly initialMs: number; readonly maxMs: number };
}

/**
 * Keeps one board in sync with the server over a WebSocket. It owns the replica's stamped
 * operations and runs the pure sync logic of `@driftboard/protocol`: on every (re)connection it
 * opens with its version vector and the server answers with exactly what it lacks; local operations
 * are sent once connected, and anything made while offline goes out on the next connection.
 *
 * It reconnects forever with exponential backoff and jitter. `status` is for the UI:
 * `connecting` (trying), `online` (hello exchanged), `offline` (waiting to retry). Nothing here is
 * kept across page loads yet; operations made offline are lost if the page is closed.
 */
export class SyncConnection {
  readonly #options: SyncConnectionOptions;
  readonly #createSocket: SocketFactory;
  readonly #timers: Timers;
  readonly #random: () => number;
  readonly #listeners = new Set<() => void>();
  #store: OpStore = emptyStore;
  #session: Session | null = null;
  #socket: SocketLike | null = null;
  /** Identifies the current socket, so events from an old one are ignored. */
  #token: object | null = null;
  #retryTimer: unknown = undefined;
  #attempt = 0;
  #disposed = false;
  #status: ConnectionStatus = 'offline';
  #lastError: string | null = null;

  constructor(options: SyncConnectionOptions) {
    this.#options = options;
    this.#createSocket = options.createSocket ?? browserSocket;
    this.#timers = options.timers ?? browserTimers;
    this.#random = options.random ?? Math.random;
  }

  readonly getStatus = (): ConnectionStatus => this.#status;

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

  /** Starts connecting. */
  start(): void {
    if (!this.#disposed && this.#socket === null && this.#retryTimer === undefined) {
      this.#connect();
    }
  }

  /** Records operations made on this replica and sends them if connected. */
  submit(ops: BoardOp[]): void {
    this.#store = authorOps(this.#store, this.#options.replicaId, ops).store;
    this.#flush();
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

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    for (const listener of [...this.#listeners]) listener();
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
    const open = openInitiator(
      { self: this.#options.replicaId, boardId: this.#options.boardId },
      this.#store,
    );
    this.#session = open.session;
    for (const message of open.send) this.#send(encodeMessage(message));
  }

  #onMessage(data: unknown): void {
    if (this.#session === null) return;
    if (typeof data !== 'string') {
      this.#fail('the server sent a message that is not text');
      return;
    }
    const parsed = parseMessage(data);
    if (!parsed.ok) {
      this.#fail(`the server sent an invalid message: ${parsed.error}`);
      return;
    }
    const step = receive(this.#session, this.#store, parsed.message);
    this.#session = step.session;
    this.#store = step.store;
    if (step.applied.length > 0) {
      try {
        this.#options.board.applyRemote(toBoardOps(step.applied));
      } catch (error) {
        this.#fail(error instanceof Error ? error.message : 'could not apply operations');
        return;
      }
    }
    for (const message of step.send) this.#send(encodeMessage(message));
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
      this.#setStatus('online');
    }
  }

  #onClose(): void {
    this.#socket = null;
    this.#token = null;
    this.#session = null;
    this.#setStatus('offline');
    if (this.#disposed) return;
    const { initialMs, maxMs } = this.#options.retry ?? { initialMs: 500, maxMs: 15_000 };
    const delay = Math.min(maxMs, initialMs * 2 ** this.#attempt) * (0.5 + this.#random() / 2);
    this.#attempt += 1;
    this.#retryTimer = this.#timers.setTimeout(() => {
      if (!this.#disposed) this.#connect();
    }, delay);
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
    for (const message of flushed.send) this.#send(encodeMessage(message));
  }

  #send(text: string): void {
    this.#socket?.send(text);
  }
}
