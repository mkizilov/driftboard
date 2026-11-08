import { generateReplicaId } from '@driftboard/crdt';
import {
  ERROR_CODES,
  createRoom,
  encodeFrame,
  generateBoardId,
  parseFrame,
  roomConnect,
  roomDisconnect,
  roomReceive,
  type Frame,
  type Message,
  type Outgoing,
  type Room,
} from '@driftboard/protocol';
import type { SocketFactory, SocketHandlers, SocketLike, Timers } from './sync-connection';

/** One client connection as the client and the test see it. */
export class FakeSocket implements SocketLike {
  readonly url: string;
  readonly conn: string;
  readonly handlers: SocketHandlers;
  /** Frames the client sent: text, or bytes for operations. */
  readonly sent: Frame[] = [];
  /** Frames the server delivered, in the same two kinds. */
  readonly received: Frame[] = [];
  closed = false;
  /** Set when `close` was asked for but, as on a dead connection, has not happened yet. */
  closing = false;
  /** Makes `close` wait until `finishClosing`, as a real socket does when the network is gone. */
  lingers = false;
  readonly #network: FakeNetwork;

  constructor(network: FakeNetwork, conn: string, url: string, handlers: SocketHandlers) {
    this.#network = network;
    this.conn = conn;
    this.url = url;
    this.handlers = handlers;
  }

  send(frame: Frame): void {
    if (this.closed) return;
    this.sent.push(frame);
    this.#network.fromClient(this, frame);
  }

  /** The client closes the connection. */
  close(): void {
    if (this.lingers) this.closing = true;
    else this.drop();
  }

  /** The close that was asked for finally happens. */
  finishClosing(): void {
    this.drop();
  }

  /** The connection ends, whoever the cause: the client, the server or the network. */
  drop(): void {
    if (this.closed) return;
    this.closed = true;
    this.#network.ended(this);
    this.handlers.close();
  }
}

/**
 * A sync server for one board, made of the protocol's real `Room`, and the connections to it.
 * Frames travel as the text or bytes the real encoder and parser produce (the server's bytes reach
 * the client as an `ArrayBuffer`, as a browser's WebSocket delivers them). Nothing is
 * asynchronous: a frame is handled before `send` returns, so tests stay deterministic.
 */
export class FakeNetwork {
  room: Room;
  /** A clock for everything on this network, for tests where devices must share time. */
  readonly timers = new FakeTimers();
  readonly sockets: FakeSocket[] = [];
  /** Whether sockets made from now on linger when closed; see `FakeSocket.lingers`. */
  lingerOnClose = false;
  readonly #bySocketId = new Map<string, FakeSocket>();
  #held: (() => void)[] | null = null;

  constructor(
    boardId = generateBoardId((length) => Uint8Array.from({ length }, (_, index) => index + 1)),
  ) {
    this.room = createRoom({
      serverId: generateReplicaId((length) => Uint8Array.from({ length }, (_, i) => 250 - i)),
      boardId,
    });
  }

  get boardId(): string {
    return this.room.boardId;
  }

  /** Makes a connection. It opens when the test says so, with `open`. */
  connect(url: string, handlers: SocketHandlers): FakeSocket {
    const socket = new FakeSocket(this, `connection-${this.sockets.length}`, url, handlers);
    socket.lingers = this.lingerOnClose;
    this.sockets.push(socket);
    this.#bySocketId.set(socket.conn, socket);
    return socket;
  }

  /** Give this to a `SyncConnection` or a session. */
  readonly createSocket: SocketFactory = (url, handlers) => this.connect(url, handlers);

  /** The connection is made: the server accepts it and the client is told it is open. */
  open(socket: FakeSocket): void {
    if (socket.closed) throw new Error('the socket is already closed');
    this.room = roomConnect(this.room, socket.conn);
    socket.handlers.open();
  }

  /** Keeps what the server sends back until `release`, as a slow network would. */
  hold(): void {
    this.#held ??= [];
  }

  release(): void {
    const held = this.#held ?? [];
    this.#held = null;
    for (const deliver of held) deliver();
  }

  /** Delivers something the server could not have sent, such as garbage or binary data. */
  inject(socket: FakeSocket, data: unknown): void {
    socket.handlers.message(data);
  }

  /** Delivers a well-formed message from the server. */
  injectMessage(socket: FakeSocket, message: Message): void {
    const frame = encodeFrame(message);
    socket.received.push(frame);
    socket.handlers.message(typeof frame === 'string' ? frame : new Uint8Array(frame).buffer);
  }

  fromClient(socket: FakeSocket, frame: Frame): void {
    const parsed = parseFrame(frame);
    if (!parsed.ok) throw new Error(`the client sent an invalid message: ${parsed.error}`);
    const step = roomReceive(this.room, socket.conn, parsed.message);
    this.room = step.room;
    this.#deliver(step.send);
    for (const conn of step.close) this.#bySocketId.get(conn)?.drop();
  }

  ended(socket: FakeSocket): void {
    if (!this.room.sessions.has(socket.conn)) return;
    const step = roomDisconnect(this.room, socket.conn);
    this.room = step.room;
    this.#deliver(step.send);
  }

  #deliver(outgoing: readonly Outgoing[]): void {
    for (const { conn, message } of outgoing) {
      const target = this.#bySocketId.get(conn);
      if (target === undefined || target.closed) continue;
      if (this.#held === null) {
        this.injectMessage(target, message);
      } else {
        this.#held.push(() => {
          if (!target.closed) this.injectMessage(target, message);
        });
      }
    }
  }
}

/**
 * Timers on a clock that only moves when the test says so: `advance` runs everything that falls
 * due, in order, and `fire` jumps to the next timer and runs it. `now` is the clock, in ms from 0.
 */
export class FakeTimers implements Timers {
  readonly #waiting = new Map<number, { callback: () => void; ms: number; due: number }>();
  #next = 1;
  #now = 0;

  get now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next;
    this.#next += 1;
    this.#waiting.set(id, { callback, ms, due: this.#now + ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#waiting.delete(handle as number);
  }

  /** The delays the waiting timers were set with, in the order they were set. */
  get delays(): number[] {
    return [...this.#waiting.values()].map((timer) => timer.ms);
  }

  /** Runs the timer that is due first, moving the clock to its time if that is still ahead. */
  fire(): void {
    const next = this.#nextDue();
    if (next === undefined) throw new Error('no timer is waiting');
    this.#run(next[0], next[1]);
  }

  /** Moves the clock forward by `ms`, running each timer that falls due on the way, in order. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const next = this.#nextDue();
      if (next === undefined || next[1].due > target) break;
      this.#run(next[0], next[1]);
    }
    this.#now = target;
  }

  #nextDue(): [number, { callback: () => void; due: number }] | undefined {
    let best: [number, { callback: () => void; due: number }] | undefined;
    for (const entry of this.#waiting) {
      if (best === undefined || entry[1].due < best[1].due) best = entry;
    }
    return best;
  }

  #run(id: number, timer: { callback: () => void; due: number }): void {
    this.#waiting.delete(id);
    this.#now = Math.max(this.#now, timer.due);
    timer.callback();
  }
}

/** An error message the server could send. */
export function serverError(message: string): Message {
  const code = ERROR_CODES[0];
  if (code === undefined) throw new Error('the protocol has no error codes');
  return { type: 'error', code, message };
}
