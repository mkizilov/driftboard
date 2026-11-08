import { generateReplicaId } from '@driftboard/crdt';
import {
  ERROR_CODES,
  createRoom,
  encodeMessage,
  generateBoardId,
  parseMessage,
  roomConnect,
  roomDisconnect,
  roomReceive,
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
  /** Text frames the client sent. */
  readonly sent: string[] = [];
  /** Text frames the server delivered. */
  readonly received: string[] = [];
  closed = false;
  readonly #network: FakeNetwork;

  constructor(network: FakeNetwork, conn: string, url: string, handlers: SocketHandlers) {
    this.#network = network;
    this.conn = conn;
    this.url = url;
    this.handlers = handlers;
  }

  send(text: string): void {
    if (this.closed) return;
    this.sent.push(text);
    this.#network.fromClient(this, text);
  }

  /** The client closes the connection. */
  close(): void {
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
 * Frames travel as the text the real encoder and parser produce. Nothing is asynchronous: a frame
 * is handled before `send` returns, so tests stay deterministic.
 */
export class FakeNetwork {
  room: Room;
  readonly sockets: FakeSocket[] = [];
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

  /** Give this to a `SyncConnection` or a session. The connection opens when the test says so. */
  readonly createSocket: SocketFactory = (url, handlers) => {
    const socket = new FakeSocket(this, `connection-${this.sockets.length}`, url, handlers);
    this.sockets.push(socket);
    this.#bySocketId.set(socket.conn, socket);
    return socket;
  };

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
    const text = encodeMessage(message);
    socket.received.push(text);
    socket.handlers.message(text);
  }

  fromClient(socket: FakeSocket, text: string): void {
    const parsed = parseMessage(text);
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

/** Timers that only run when the test says so. */
export class FakeTimers implements Timers {
  readonly #waiting = new Map<number, { callback: () => void; ms: number }>();
  #next = 1;

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next;
    this.#next += 1;
    this.#waiting.set(id, { callback, ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#waiting.delete(handle as number);
  }

  /** The delays of the timers that are waiting, oldest first. */
  get delays(): number[] {
    return [...this.#waiting.values()].map((timer) => timer.ms);
  }

  /** Runs the oldest waiting timer. */
  fire(): void {
    const first = this.#waiting.entries().next();
    if (first.done === true) throw new Error('no timer is waiting');
    const [id, timer] = first.value;
    this.#waiting.delete(id);
    timer.callback();
  }
}

/** An error message the server could send. */
export function serverError(message: string): Message {
  const code = ERROR_CODES[0];
  if (code === undefined) throw new Error('the protocol has no error codes');
  return { type: 'error', code, message };
}
