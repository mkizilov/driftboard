import { replicaId, type ReplicaId } from '@driftboard/crdt';
import {
  MAX_FRAME_BYTES,
  createRoom,
  encodeFrame,
  encodeMessage,
  errorMessage,
  parseFrame,
  roomConnect,
  roomDisconnect,
  roomReceive,
  type ErrorCode,
  type Frame,
  type Message,
  type Room,
  type RoomStep,
} from '@driftboard/protocol';
import { isValidBoardId } from './board-id';
import { DEFAULT_RATE_LIMITS, bucketFor, type RateLimits, type TokenBucket } from './rate-limit';
import type { BoardStorage } from './storage';

/** WebSocket close codes the hub uses. */
export const CLOSE = {
  goingAway: 1001,
  unsupportedData: 1003,
  policyViolation: 1008,
  tooBig: 1009,
  internalError: 1011,
  /** The same replica connected again, so this older connection is dropped. */
  replaced: 4001,
} as const;

/** What the hub needs from a connection; the WebSocket server adapts `ws` to this. */
export interface HubSocket {
  /** A string goes out as a text frame, bytes as a binary frame. */
  send(frame: Frame): void;
  close(code: number, reason: string): void;
}

/** What the transport tells the hub about one connection. */
export interface HubConnection {
  /** A frame arrived: the text of a text frame, or the bytes of a binary frame. */
  receive(data: string | Uint8Array, isBinary: boolean): void;
  /** The connection ended (or the hub already closed it); safe to call more than once. */
  closed(): void;
  /** Whether a valid `hello` has been accepted. */
  readonly greeted: boolean;
}

export interface HubOptions {
  readonly storage: BoardStorage;
  readonly serverId?: ReplicaId;
  /** Largest message accepted, in bytes. Defaults to the protocol's frame limit (1 MiB). */
  readonly maxMessageBytes?: number;
  /** Fold a board's tail into its snapshot once the tail has this many operations; 0 disables. */
  readonly compactAfterOps?: number;
  /** Close a connection that has not sent a valid `hello` within this time; 0 disables. */
  readonly helloTimeoutMs?: number;
  /** Receives errors the hub survives (storage failures); defaults to `console.error`. */
  readonly onError?: (error: unknown, context: string) => void;
  /** What one connection may send; a connection that sends more is closed. */
  readonly rateLimits?: RateLimits;
  /** The clock for the rate limits, in ms. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Most characters one note's text may hold. Defaults to the protocol's limit. */
  readonly maxNoteNodes?: number;
}

interface Conn {
  readonly id: string;
  readonly socket: HubSocket;
  live: LiveRoom | null;
  done: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Pays for each message / each operation the connection sends; `undefined` if unlimited. */
  readonly messages: TokenBucket | undefined;
  readonly ops: TokenBucket | undefined;
}

/** A board that has connections: its sync room, kept in memory while anyone is connected. */
interface LiveRoom {
  readonly boardId: string;
  room: Room;
  readonly conns: Map<string, Conn>;
  /** Operations in the tail table (not yet in the snapshot). */
  tail: number;
  /**
   * Compact when the tail reaches this. After a failed attempt it moves up, so that the attempt is
   * not repeated on every message.
   */
  compactAt: number;
}

/**
 * Every board has one room, created when its first client says hello and dropped when its last
 * client leaves. The hub is the glue between transport, protocol and storage and does no I/O of its
 * own: it receives frames, runs the pure sync logic of `@driftboard/protocol`, writes new
 * operations to storage *before* anything is sent about them, and sends the resulting messages.
 *
 * Every frame is checked before it reaches the sync logic: within the size limit, and either JSON
 * text valid against the zod schemas or a binary batch of operations (see `binary.ts` in
 * `@driftboard/protocol`). A connection that sends anything else, or something out of turn, or
 * more than its rate limits allow, gets one `error` message and is closed. Nothing a connection
 * sends can throw out of `receive`: an error the hub does not expect closes that connection only.
 */
export class SyncHub {
  readonly #storage: BoardStorage;
  readonly #serverId: ReplicaId;
  readonly #maxMessageBytes: number;
  readonly #compactAfterOps: number;
  readonly #helloTimeoutMs: number;
  readonly #onError: (error: unknown, context: string) => void;
  readonly #rateLimits: RateLimits;
  readonly #now: () => number;
  readonly #maxNoteNodes: number | undefined;
  readonly #rooms = new Map<string, LiveRoom>();
  readonly #conns = new Set<Conn>();
  #serial = 0;

  constructor(options: HubOptions) {
    this.#storage = options.storage;
    this.#serverId = options.serverId ?? replicaId('server');
    this.#maxMessageBytes = options.maxMessageBytes ?? MAX_FRAME_BYTES;
    this.#compactAfterOps = options.compactAfterOps ?? 1000;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
    this.#rateLimits = options.rateLimits ?? DEFAULT_RATE_LIMITS;
    this.#now = options.now ?? Date.now;
    this.#maxNoteNodes = options.maxNoteNodes;
    this.#onError =
      options.onError ??
      ((error, context) => {
        console.error(`driftboard: ${context}`, error);
      });
  }

  /** Boards that currently have at least one connection. */
  get roomCount(): number {
    return this.#rooms.size;
  }

  get connectionCount(): number {
    return this.#conns.size;
  }

  /** Registers a new connection. */
  accept(socket: HubSocket): HubConnection {
    this.#serial += 1;
    const conn: Conn = {
      id: String(this.#serial),
      socket,
      live: null,
      done: false,
      timer: undefined,
      messages: bucketFor(this.#rateLimits.messages, this.#now),
      ops: bucketFor(this.#rateLimits.ops, this.#now),
    };
    this.#conns.add(conn);
    if (this.#helloTimeoutMs > 0) {
      conn.timer = setTimeout(() => {
        if (conn.live !== null) return;
        this.#fail(conn, 'unexpected_message', CLOSE.policyViolation, 'no hello in time');
      }, this.#helloTimeoutMs);
      conn.timer.unref();
    }
    return {
      receive: (data, isBinary) => {
        this.#receive(conn, data, isBinary);
      },
      closed: () => {
        this.#drop(conn);
      },
      get greeted() {
        return conn.live !== null;
      },
    };
  }

  /**
   * Folds the tail of every board that has at least `minTail` operations into its snapshot. Returns
   * the number of boards compacted. Run it periodically so that boards nobody is editing do not
   * keep a long tail.
   */
  compactAll(minTail = 1): number {
    let compacted = 0;
    for (const boardId of this.#storage.boardsWithTail(minTail)) {
      if (this.#compact(boardId)) compacted += 1;
    }
    return compacted;
  }

  /** Closes every connection. */
  close(): void {
    for (const conn of [...this.#conns]) {
      this.#terminate(conn, CLOSE.goingAway, 'server shutting down');
    }
  }

  // ---- Frames ---------------------------------------------------------------------------------

  #receive(conn: Conn, data: string | Uint8Array, isBinary: boolean): void {
    if (conn.done) return;
    try {
      this.#check(conn, data, isBinary);
    } catch (error) {
      this.#onError(error, 'handling a message');
      this.#fail(conn, 'internal_error', CLOSE.internalError, 'internal error');
    }
  }

  #check(conn: Conn, data: string | Uint8Array, isBinary: boolean): void {
    if (conn.messages?.take() === false) {
      this.#fail(conn, 'rate_limited', CLOSE.policyViolation, 'too many messages');
      return;
    }
    if (isBinary !== (typeof data !== 'string')) {
      this.#fail(conn, 'invalid_message', CLOSE.unsupportedData, 'frame type and data disagree');
      return;
    }
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    if (size > this.#maxMessageBytes) {
      this.#fail(conn, 'invalid_message', CLOSE.tooBig, 'message too large');
      return;
    }
    const parsed = parseFrame(data);
    if (!parsed.ok) {
      // Binary data that is not a batch of operations is data the server cannot take at all.
      const closeCode = isBinary ? CLOSE.unsupportedData : CLOSE.policyViolation;
      this.#fail(conn, 'invalid_message', closeCode, parsed.error);
      return;
    }
    if (parsed.message.type === 'ops' && conn.ops?.take(parsed.message.ops.length) === false) {
      this.#fail(conn, 'rate_limited', CLOSE.policyViolation, 'too many operations');
      return;
    }
    this.#handle(conn, parsed.message);
  }

  #handle(conn: Conn, message: Message): void {
    let live = conn.live;
    if (live === null) {
      if (message.type !== 'hello') {
        const text = 'the first message must be hello';
        this.#fail(conn, 'unexpected_message', CLOSE.policyViolation, text);
        return;
      }
      if (!isValidBoardId(message.boardId)) {
        const text = 'board id must be 22 to 128 URL-safe characters';
        this.#fail(conn, 'invalid_message', CLOSE.policyViolation, text);
        return;
      }
      live = this.#join(conn, message.boardId);
    }
    const step = roomReceive(live.room, conn.id, message);
    // Store before telling anyone: an ack must mean the operations are durable. If storing fails
    // the step is dropped, so the room still matches what is on disk.
    this.#storage.append(live.boardId, step.applied);
    live.room = step.room;
    live.tail += step.applied.length;
    this.#dispatch(live, step, conn);
    if (this.#compactAfterOps > 0 && live.tail >= live.compactAt) {
      if (!this.#compact(live.boardId)) live.compactAt = live.tail + this.#compactAfterOps;
    }
  }

  /** Puts the connection in its board's room, loading the board from storage if it is not open. */
  #join(conn: Conn, boardId: string): LiveRoom {
    let live = this.#rooms.get(boardId);
    if (live === undefined) {
      const loaded = this.#storage.load(boardId);
      live = {
        boardId,
        room: createRoom({
          serverId: this.#serverId,
          boardId,
          store: loaded.store,
          ...(this.#maxNoteNodes === undefined ? {} : { maxNoteNodes: this.#maxNoteNodes }),
        }),
        conns: new Map(),
        tail: loaded.tail,
        compactAt: this.#compactAfterOps,
      };
      this.#rooms.set(boardId, live);
    }
    live.room = roomConnect(live.room, conn.id);
    live.conns.set(conn.id, conn);
    conn.live = live;
    if (conn.timer !== undefined) clearTimeout(conn.timer);
    return live;
  }

  /** Sends a room step's messages and closes the connections it asks to close. */
  #dispatch(live: LiveRoom, step: RoomStep, origin: Conn): void {
    for (const { conn: id, message } of step.send) {
      const target = live.conns.get(id);
      if (target !== undefined && !target.done) target.socket.send(encodeFrame(message));
    }
    for (const id of step.close) {
      const target = live.conns.get(id);
      if (target === undefined) continue;
      if (target === origin) this.#terminate(target, CLOSE.policyViolation, 'protocol violation');
      else this.#terminate(target, CLOSE.replaced, 'replaced by a newer connection');
    }
  }

  // ---- Closing --------------------------------------------------------------------------------

  /** Answers a bad connection with one error message and closes it. */
  #fail(conn: Conn, code: ErrorCode, closeCode: number, text: string): void {
    if (conn.done) return;
    conn.socket.send(encodeMessage(errorMessage(code, text)));
    this.#terminate(conn, closeCode, text);
  }

  #terminate(conn: Conn, closeCode: number, reason: string): void {
    if (conn.done) return;
    this.#drop(conn);
    conn.socket.close(closeCode, reason.slice(0, 100));
  }

  /** The connection is over: leave its room, tell the others, and drop the room if now empty. */
  #drop(conn: Conn): void {
    if (conn.done) return;
    conn.done = true;
    if (conn.timer !== undefined) clearTimeout(conn.timer);
    this.#conns.delete(conn);
    const live = conn.live;
    if (live === null) return;
    const step = roomDisconnect(live.room, conn.id);
    live.room = step.room;
    live.conns.delete(conn.id);
    this.#dispatch(live, step, conn);
    if (live.conns.size === 0) this.#rooms.delete(live.boardId);
  }

  /** Compaction must never take a connection down; a failure is reported and retried later. */
  #compact(boardId: string): boolean {
    try {
      this.#storage.compact(boardId);
    } catch (error) {
      this.#onError(error, `compacting board ${boardId}`);
      return false;
    }
    const live = this.#rooms.get(boardId);
    if (live !== undefined) {
      live.tail = 0;
      live.compactAt = this.#compactAfterOps;
    }
    return true;
  }
}
