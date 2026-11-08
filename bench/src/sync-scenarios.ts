import {
  Board,
  NOTE_COLORS,
  createManualClock,
  replicaId,
  type BoardOp,
  type ReplicaId,
} from '@driftboard/crdt';
import {
  authorOps,
  createRoom,
  decodeOps,
  emptyStore,
  encodeOps,
  flush,
  openInitiator,
  receive,
  roomConnect,
  roomDisconnect,
  roomReceive,
  storeVector,
  toBoardOps,
  type Message,
  type OpStore,
  type Room,
  type Session,
} from '@driftboard/protocol';
import { sentence } from './board-scenarios';
import { createRng, type Rng } from './rng';

/** How messages travel between the client and the server. */
export interface Wire {
  readonly name: string;
  /** Turns a message into the frame that would be sent, and says how many bytes that is. */
  encode(message: Message): { readonly frame: unknown; readonly bytes: number };
  decode(frame: unknown): Message;
}

/** The text frames of today: `JSON.stringify` and `JSON.parse`, without the schema check. */
export const jsonWire: Wire = {
  name: 'JSON text',
  encode: (message) => {
    const frame = JSON.stringify(message);
    return { frame, bytes: Buffer.byteLength(frame) };
  },
  decode: (frame) => JSON.parse(frame as string) as Message,
};

/**
 * The frames of protocol version 3: operations as a binary batch (`encodeOps`), every other
 * message as JSON text. Decoding checks the structure of the bytes, as the real parser does, but
 * not the schema of the control messages, like `jsonWire`.
 */
export const binaryWire: Wire = {
  name: 'binary operations',
  encode: (message) => {
    if (message.type !== 'ops') return jsonWire.encode(message);
    const frame = encodeOps(message.ops);
    return { frame, bytes: frame.length };
  },
  decode: (frame) =>
    typeof frame === 'string'
      ? jsonWire.decode(frame)
      : { type: 'ops', ops: decodeOps(frame as Uint8Array) },
};

/** Messages that are handed over as they are: nothing is encoded, so nothing is counted. */
export const directWire: Wire = {
  name: 'direct',
  encode: (message) => ({ frame: message, bytes: 0 }),
  decode: (frame) => frame as Message,
};

interface Client {
  readonly name: string;
  readonly replica: ReplicaId;
  readonly board: Board;
  store: OpStore;
  session: Session | null;
  /** The id of the connection the server knows this client by. */
  conn: string;
}

export interface WorldSize {
  /** Notes made by the first author before anyone goes offline. */
  readonly notes: number;
  readonly charsPerNote: number;
  /** Operations the client that goes offline makes while it is away. */
  readonly offlineOps: number;
  /** Operations the other client makes in the meantime. */
  readonly onlineOps: number;
}

export interface World {
  readonly boardId: string;
  room: Room;
  readonly offline: Client;
  readonly online: Client;
  readonly noteIds: readonly string[];
}

/** What a reconnect cost. */
export interface ReconnectResult {
  readonly messages: number;
  readonly bytes: number;
  /** Operations that crossed the wire in either direction. */
  readonly operations: number;
}

class Network {
  readonly #world: World;
  readonly #wire: Wire;
  readonly #clients = new Map<string, Client>();
  readonly #queue: { to: 'server' | Client; conn: string; frame: unknown }[] = [];
  #next = 0;
  messages = 0;
  bytes = 0;
  operations = 0;

  constructor(world: World, wire: Wire) {
    this.#world = world;
    this.#wire = wire;
    for (const client of [world.offline, world.online]) this.#clients.set(client.conn, client);
  }

  /** A client that connects (or reconnects) under a new connection id. */
  connect(client: Client, conn: string): void {
    this.#clients.delete(client.conn);
    client.conn = conn;
    this.#clients.set(conn, client);
    this.#world.room = roomConnect(this.#world.room, conn);
    const open = openInitiator({ self: client.replica, boardId: this.#world.boardId }, client.store);
    client.session = open.session;
    for (const message of open.send) this.#toServer(client, message);
  }

  /** Sends whatever a client holds that its server session does not know about. */
  push(client: Client): void {
    if (client.session === null) return;
    const flushed = flush(client.session, client.store);
    client.session = flushed.session;
    for (const message of flushed.send) this.#toServer(client, message);
  }

  /** Delivers everything that is in flight, and what that causes, until all is quiet. */
  run(): void {
    for (let delivery = this.#queue[this.#next]; delivery !== undefined; ) {
      this.#next += 1;
      if (delivery.to === 'server') this.#serverReceives(delivery.conn, delivery.frame);
      else this.#clientReceives(delivery.to, delivery.frame);
      delivery = this.#queue[this.#next];
    }
    this.#queue.length = 0;
    this.#next = 0;
  }

  #count(message: Message): void {
    if (message.type === 'ops') this.operations += message.ops.length;
  }

  #toServer(client: Client, message: Message): void {
    this.#count(message);
    const { frame, bytes } = this.#wire.encode(message);
    this.messages += 1;
    this.bytes += bytes;
    this.#queue.push({ to: 'server', conn: client.conn, frame });
  }

  #serverReceives(conn: string, frame: unknown): void {
    const step = roomReceive(this.#world.room, conn, this.#wire.decode(frame));
    this.#world.room = step.room;
    for (const { conn: target, message } of step.send) {
      const client = this.#clients.get(target);
      if (client === undefined) continue;
      this.#count(message);
      const { frame: out, bytes } = this.#wire.encode(message);
      this.messages += 1;
      this.bytes += bytes;
      this.#queue.push({ to: client, conn: target, frame: out });
    }
  }

  #clientReceives(client: Client, frame: unknown): void {
    if (client.session === null) return;
    const step = receive(client.session, client.store, this.#wire.decode(frame));
    client.session = step.session;
    client.store = step.store;
    if (step.applied.length > 0) client.board.applyRemote(toBoardOps(step.applied));
    for (const message of step.send) this.#toServer(client, message);
  }
}

function newClient(name: string): Client {
  const replica = replicaId(name);
  return {
    name,
    replica,
    board: new Board({ replicaId: replica, clock: createManualClock(1_700_000_000_000) }),
    store: emptyStore,
    session: null,
    conn: `${name}-1`,
  };
}

/** Numbers operations a client just made, and keeps them in its store for the next connection. */
function author(client: Client, ops: BoardOp[]): void {
  client.store = authorOps(client.store, client.replica, ops).store;
}

/** One burst of editing by a person: typing, erasing, moving or recolouring one note. */
function editOnce(client: Client, rng: Rng, noteIds: readonly string[]): number {
  const id = rng.pick(noteIds);
  const note = client.board.getNote(id);
  if (note === undefined) return 0;
  const length = Array.from(note.text).length;
  const roll = rng.next();
  let ops: BoardOp[];
  if (roll < 0.7 || length < 8) {
    ops = client.board.editText(id, rng.int(length + 1), 0, sentence(rng, 5 + rng.int(35)));
  } else if (roll < 0.85) {
    const count = 1 + rng.int(6);
    ops = client.board.editText(id, rng.int(length - count + 1), count, '');
  } else if (roll < 0.93) {
    ops = client.board.moveNote(id, rng.int(5000), rng.int(5000));
  } else if (roll < 0.97) {
    ops = client.board.setColor(id, rng.pick(NOTE_COLORS));
  } else {
    ops = client.board.bringToFront(id);
  }
  author(client, ops);
  return ops.length;
}

function editUntil(client: Client, rng: Rng, noteIds: readonly string[], operations: number): void {
  let made = 0;
  while (made < operations) made += editOnce(client, rng, noteIds);
}

/**
 * Two clients and a server that all hold the same board; then one client goes offline and makes
 * `offlineOps` operations while the other makes `onlineOps` and sends them to the server. Nothing
 * here is timed: it is the state a reconnect starts from.
 */
export function prepareWorld(seed: number, size: WorldSize): World {
  const rng = createRng(seed);
  const world: World = {
    boardId: 'bench-board-0000000000000',
    room: createRoom({ serverId: replicaId('server'), boardId: 'bench-board-0000000000000' }),
    offline: newClient('away'),
    online: newClient('home'),
    noteIds: [],
  };
  const network = new Network(world, directWire);
  network.connect(world.offline, 'away-1');
  network.connect(world.online, 'home-1');
  network.run();

  // The first author's notes, typed while both are connected.
  const noteIds: string[] = [];
  for (let n = 0; n < size.notes; n += 1) {
    const { id, ops } = world.offline.board.createNote({
      x: rng.int(5000),
      y: rng.int(5000),
      color: rng.pick(NOTE_COLORS),
    });
    author(world.offline, ops);
    noteIds.push(id);
    let typed = 0;
    while (typed < size.charsPerNote) {
      const run = Math.min(size.charsPerNote - typed, 10 + rng.int(70));
      const length = typed;
      author(world.offline, world.offline.board.editText(id, rng.int(length + 1), 0, sentence(rng, run)));
      typed += run;
    }
  }
  network.push(world.offline);
  network.run();

  // The first client leaves; the second goes on working.
  world.room = roomDisconnect(world.room, world.offline.conn).room;
  world.offline.session = null;
  editUntil(world.offline, rng, noteIds, size.offlineOps);
  editUntil(world.online, rng, noteIds, size.onlineOps);
  network.push(world.online);
  network.run();
  return { ...world, noteIds };
}

/**
 * The client that was away comes back: it says what it holds, receives what it missed, sends what
 * it did, and the server passes that on. Returns when everything is quiet.
 */
export function reconnect(world: World, wire: Wire): ReconnectResult {
  const network = new Network(world, wire);
  network.connect(world.offline, 'away-2');
  network.run();
  return { messages: network.messages, bytes: network.bytes, operations: network.operations };
}

/** Whether both clients and the server hold the same operations and show the same board. */
export function converged(world: World): boolean {
  const vector = (store: OpStore): string => JSON.stringify(storeVector(store).entries());
  const shown = (client: Client): string => JSON.stringify(client.board.notes());
  return (
    vector(world.offline.store) === vector(world.room.store) &&
    vector(world.online.store) === vector(world.room.store) &&
    shown(world.offline) === shown(world.online)
  );
}

/** How many operations each side has authored, for the report. */
export function describeWorld(world: World): { offline: number; online: number; total: number } {
  const count = (client: Client): number => storeVector(client.store).get(client.replica);
  return {
    offline: count(world.offline),
    online: count(world.online),
    total: [...storeVector(world.room.store).entries()].reduce((sum, [, n]) => sum + n, 0),
  };
}
