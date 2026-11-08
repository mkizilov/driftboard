import {
  Board,
  NOTE_COLORS,
  VersionVector,
  createManualClock,
  replicaId,
  type BoardOp,
  type NoteColor,
  type ReplicaId,
} from '@driftboard/crdt';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeMessage, parseMessage, type Message } from './messages';
import { toBoardOps } from './ops';
import {
  createRoom,
  roomConnect,
  roomDisconnect,
  roomReceive,
  type Room,
  type RoomStep,
} from './room';
import { emptyStore, storeMissing, storeVector, type OpStore } from './store';
import { authorOps, flush, isSynced, openInitiator, receive, type Session } from './sync';
import { must } from './test-support';

/**
 * A simulated network of three clients and one server. Messages travel as JSON text through the
 * real encoder and parser. Each connection has one ordered queue per direction. The simulation can
 * drop a connection (losing what is in flight), let the server notice later, reconnect, and
 * duplicate a message that is in flight. While it runs it checks that
 *  - on one connection no operation is ever sent twice,
 *  - no original (not network-duplicated) message ever carries an operation its receiver holds,
 *  - nobody ever sends an error, or receives a message that fails to parse.
 */

const BOARD = 'board-1';
const serverId = replicaId('server');

type Edit =
  | { kind: 'create'; x: number; y: number; text: string }
  | { kind: 'move'; pick: number; x: number; y: number }
  | { kind: 'color'; pick: number; color: NoteColor }
  | { kind: 'text'; pick: number; at: number; deleteCount: number; text: string }
  | { kind: 'delete'; pick: number };

function perform(board: Board, edit: Edit): BoardOp[] {
  if (edit.kind === 'create') {
    return board.createNote({ x: edit.x, y: edit.y, text: edit.text }).ops;
  }
  const notes = board.notes();
  const note = notes[edit.pick % notes.length];
  if (note === undefined) return [];
  switch (edit.kind) {
    case 'move':
      return board.moveNote(note.id, edit.x, edit.y);
    case 'color':
      return board.setColor(note.id, edit.color);
    case 'text': {
      const chars = [...note.text];
      const index = edit.at % (chars.length + 1);
      const count = Math.min(edit.deleteCount, chars.length - index);
      return board.editText(note.id, index, count, edit.text);
    }
    case 'delete':
      return board.deleteNote(note.id);
  }
}

interface Packet {
  readonly text: string;
  /** Made by the network duplicating a message, not by a sender. */
  readonly copy: boolean;
}

interface Link {
  readonly id: number;
  readonly client: number;
  alive: boolean;
  /** The server has been told the connection ended. */
  reaped: boolean;
  up: Packet[];
  down: Packet[];
}

interface SimClient {
  readonly id: ReplicaId;
  readonly board: Board;
  store: OpStore;
  session: Session | null;
  link: Link | null;
  presenceSeen: number;
}

interface Stats {
  /** Operations put on the wire by either side, counting each occurrence. */
  opsSent: number;
  /** Operations sent again on a connection they were already sent on. */
  repeatedOnLink: number;
  /** Operations in an original message that the receiver already held. */
  redundantDeliveries: number;
  errorsSent: number;
  parseFailures: number;
  dropped: number;
  duplicatesDelivered: number;
  delivered: number;
}

const holds = (store: OpStore, op: { origin: ReplicaId; seq: number }) =>
  storeVector(store).get(op.origin) >= op.seq;

class Network {
  room: Room = createRoom({ serverId, boardId: BOARD });
  readonly clients: SimClient[];
  readonly links = new Map<number, Link>();
  readonly stats: Stats = {
    opsSent: 0,
    repeatedOnLink: 0,
    redundantDeliveries: 0,
    errorsSent: 0,
    parseFailures: 0,
    dropped: 0,
    duplicatesDelivered: 0,
    delivered: 0,
  };
  readonly #sentOnLink = new Map<string, Set<string>>();
  #nextLink = 1;

  constructor(count: number) {
    this.clients = Array.from({ length: count }, (_, i) => {
      const id = replicaId(`c${i + 1}`);
      const board = new Board({ replicaId: id, clock: createManualClock(1000) });
      return { id, board, store: emptyStore, session: null, link: null, presenceSeen: 0 };
    });
    for (const client of this.clients) this.connect(client);
  }

  client(index: number): SimClient {
    return must(this.clients[index % this.clients.length]);
  }

  connect(client: SimClient): void {
    if (client.link !== null) return;
    const link: Link = {
      id: this.#nextLink,
      client: this.clients.indexOf(client),
      alive: true,
      reaped: false,
      up: [],
      down: [],
    };
    this.#nextLink += 1;
    this.links.set(link.id, link);
    client.link = link;
    this.room = roomConnect(this.room, String(link.id));
    const open = openInitiator({ self: client.id, boardId: BOARD }, client.store);
    client.session = open.session;
    for (const message of open.send) this.#sendUp(link, message);
  }

  /** The connection breaks: what is in flight is lost. The server does not know yet. */
  disconnect(client: SimClient): void {
    const link = client.link;
    if (link === null) return;
    link.alive = false;
    this.stats.dropped += link.up.length + link.down.length;
    link.up = [];
    link.down = [];
    client.link = null;
    client.session = null;
  }

  /** The server notices a dead connection. */
  reap(link: Link): void {
    if (link.alive || link.reaped) return;
    link.reaped = true;
    this.#applyRoom(roomDisconnect(this.room, String(link.id)));
  }

  reapAll(): void {
    for (const link of this.links.values()) this.reap(link);
  }

  edit(client: SimClient, edit: Edit): void {
    const ops = perform(client.board, edit);
    if (ops.length === 0) return;
    client.store = authorOps(client.store, client.id, ops).store;
    this.#flushClient(client);
  }

  present(client: SimClient, x: number, y: number): void {
    const link = client.link;
    if (link === null || client.session?.phase !== 'ready') return;
    this.#sendUp(link, {
      type: 'presence',
      replicaId: client.id,
      state: { cursor: { x, y }, selection: [] },
    });
  }

  /** Links and directions that have a message in flight. */
  queues(): { link: Link; direction: 'up' | 'down' }[] {
    const queues: { link: Link; direction: 'up' | 'down' }[] = [];
    for (const link of this.links.values()) {
      if (link.up.length > 0) queues.push({ link, direction: 'up' });
      if (link.down.length > 0) queues.push({ link, direction: 'down' });
    }
    return queues;
  }

  deliver(pick: number): void {
    const queues = this.queues();
    if (queues.length === 0) return;
    const { link, direction } = must(queues[pick % queues.length]);
    const packet = must(direction === 'up' ? link.up.shift() : link.down.shift());
    this.stats.delivered += 1;
    if (packet.copy) this.stats.duplicatesDelivered += 1;
    if (direction === 'up') this.#atServer(link, packet);
    else this.#atClient(link, packet);
  }

  /** The network delivers a message in flight a second time, later in the same queue. */
  duplicate(pick: number, later: number): void {
    const queues = this.queues();
    if (queues.length === 0) return;
    const { link, direction } = must(queues[pick % queues.length]);
    const queue = direction === 'up' ? link.up : link.down;
    const index = pick % queue.length;
    const original = must(queue[index]);
    const position = index + 1 + (later % (queue.length - index));
    queue.splice(position, 0, { text: original.text, copy: true });
  }

  /** Ends all faults: the server notices dead connections, everyone reconnects, all is delivered. */
  drain(picks: readonly number[]): void {
    this.reapAll();
    for (const client of this.clients) this.connect(client);
    for (let round = 0; ; round += 1) {
      if (this.queues().length === 0) break;
      if (round > 100_000) throw new Error('the network never went quiet');
      this.deliver(picks.length === 0 ? 0 : must(picks[round % picks.length]));
    }
  }

  #key(link: Link, direction: 'up' | 'down'): string {
    return `${link.id}:${direction}`;
  }

  #emit(link: Link, direction: 'up' | 'down', message: Message): Packet {
    if (message.type === 'error') this.stats.errorsSent += 1;
    if (message.type === 'ops') {
      const sent = this.#sentOnLink.get(this.#key(link, direction)) ?? new Set<string>();
      this.#sentOnLink.set(this.#key(link, direction), sent);
      for (const op of message.ops) {
        const label = `${op.origin}#${op.seq}`;
        if (sent.has(label)) this.stats.repeatedOnLink += 1;
        sent.add(label);
        this.stats.opsSent += 1;
      }
    }
    return { text: encodeMessage(message), copy: false };
  }

  #sendUp(link: Link, message: Message): void {
    const packet = this.#emit(link, 'up', message);
    if (link.alive) link.up.push(packet);
    else this.stats.dropped += 1;
  }

  #sendDown(link: Link, message: Message): void {
    const packet = this.#emit(link, 'down', message);
    if (link.alive) link.down.push(packet);
    else this.stats.dropped += 1;
  }

  #flushClient(client: SimClient): void {
    const link = client.link;
    if (link === null || client.session === null) return;
    const flushed = flush(client.session, client.store);
    client.session = flushed.session;
    for (const message of flushed.send) this.#sendUp(link, message);
  }

  #applyRoom(step: RoomStep): void {
    this.room = step.room;
    for (const outgoing of step.send) {
      this.#sendDown(must(this.links.get(Number(outgoing.conn))), outgoing.message);
    }
    for (const conn of step.close) {
      const link = must(this.links.get(Number(conn)));
      // Only connections the client already dropped may be closed (a replaced session).
      if (link.alive) this.stats.errorsSent += 1;
    }
  }

  #parse(packet: Packet): Message | null {
    const parsed = parseMessage(packet.text);
    if (parsed.ok) return parsed.message;
    this.stats.parseFailures += 1;
    return null;
  }

  #checkFresh(message: Message, packet: Packet, receiverStore: OpStore): void {
    if (message.type !== 'ops' || packet.copy) return;
    for (const op of message.ops) if (holds(receiverStore, op)) this.stats.redundantDeliveries += 1;
  }

  #atServer(link: Link, packet: Packet): void {
    const message = this.#parse(packet);
    if (message === null) return;
    this.#checkFresh(message, packet, this.room.store);
    this.#applyRoom(roomReceive(this.room, String(link.id), message));
  }

  #atClient(link: Link, packet: Packet): void {
    const client = this.client(link.client);
    const message = this.#parse(packet);
    if (message === null || client.session === null || client.link !== link) return;
    this.#checkFresh(message, packet, client.store);
    const step = receive(client.session, client.store, message);
    client.session = step.session;
    client.store = step.store;
    if (step.applied.length > 0) client.board.applyRemote(toBoardOps(step.applied));
    if (step.presence !== null) client.presenceSeen += 1;
    if (step.peerError !== null) this.stats.errorsSent += 1;
    for (const reply of step.send) this.#sendUp(link, reply);
  }
}

const vector = (store: OpStore) => storeVector(store).entries();
const total = (store: OpStore) => vector(store).reduce((sum, [, count]) => sum + count, 0);
const snapshot = (board: Board) => JSON.stringify(board.snapshot());

/** After a drain: everyone agrees, nothing is left to send, and the invariants held all along. */
function expectSettled(network: Network): void {
  const { stats, room } = network;
  expect(stats.errorsSent).toBe(0);
  expect(stats.parseFailures).toBe(0);
  expect(stats.repeatedOnLink).toBe(0);
  expect(stats.redundantDeliveries).toBe(0);

  const clock = createManualClock(1000);
  const reference = new Board({ replicaId: replicaId('reference'), clock });
  reference.applyRemote(toBoardOps(storeMissing(room.store, VersionVector.empty)));
  for (const client of network.clients) {
    expect(vector(client.store)).toEqual(vector(room.store));
    expect(client.board.pendingCount).toBe(0);
    expect(snapshot(client.board)).toBe(snapshot(reference));
  }

  // Once synced nothing more is sent: flushing any session yields no message.
  for (const session of room.sessions.values()) {
    expect(flush(session, room.store).send).toEqual([]);
    expect(isSynced(session, room.store)).toBe(true);
  }
  for (const client of network.clients) {
    const session = must(client.session);
    expect(flush(session, client.store).send).toEqual([]);
    expect(isSynced(session, client.store)).toBe(true);
  }
  expect(network.queues()).toEqual([]);
}

const coordinate = fc.integer({ min: -50, max: 50 });
const textArb = fc
  .array(fc.constantFrom('a', 'b', 'c', '😀'), { maxLength: 3 })
  .map((chars) => chars.join(''));
const clientArb = fc.integer({ min: 0, max: 2 });

const editArb: fc.Arbitrary<Edit> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('create' as const),
      x: coordinate,
      y: coordinate,
      text: textArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('move' as const),
      pick: fc.nat(),
      x: coordinate,
      y: coordinate,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('color' as const),
      pick: fc.nat(),
      color: fc.constantFrom(...NOTE_COLORS),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('text' as const),
      pick: fc.nat(),
      at: fc.nat(),
      deleteCount: fc.integer({ min: 0, max: 2 }),
      text: textArb,
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), pick: fc.nat() }) },
);

type Action =
  | { kind: 'edit'; client: number; edit: Edit }
  | { kind: 'deliver'; pick: number }
  | { kind: 'duplicate'; pick: number; later: number }
  | { kind: 'disconnect'; client: number }
  | { kind: 'reconnect'; client: number }
  | { kind: 'reap'; pick: number }
  | { kind: 'present'; client: number; x: number; y: number };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({ kind: fc.constant('edit' as const), client: clientArb, edit: editArb }),
  },
  { weight: 12, arbitrary: fc.record({ kind: fc.constant('deliver' as const), pick: fc.nat() }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('duplicate' as const),
      pick: fc.nat(),
      later: fc.nat(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('disconnect' as const), client: clientArb }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant('reconnect' as const), client: clientArb }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('reap' as const), pick: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('present' as const),
      client: clientArb,
      x: coordinate,
      y: coordinate,
    }),
  },
);

function runAction(network: Network, action: Action): void {
  switch (action.kind) {
    case 'edit':
      network.edit(network.client(action.client), action.edit);
      break;
    case 'deliver':
      network.deliver(action.pick);
      break;
    case 'duplicate':
      network.duplicate(action.pick, action.later);
      break;
    case 'disconnect':
      network.disconnect(network.client(action.client));
      break;
    case 'reconnect':
      network.connect(network.client(action.client));
      break;
    case 'reap': {
      const dead = [...network.links.values()].filter((link) => !link.alive && !link.reaped);
      const link = dead[action.pick % Math.max(dead.length, 1)];
      if (link !== undefined) network.reap(link);
      break;
    }
    case 'present':
      network.present(network.client(action.client), action.x, action.y);
      break;
  }
}

describe('simulated network of 3 clients and a server', () => {
  it('converges in every run with random faults', { timeout: 300_000 }, () => {
    let runs = 0;
    let delivered = 0;
    let duplicates = 0;
    let dropped = 0;
    let operations = 0;
    fc.assert(
      fc.property(
        fc.array(actionArb, { maxLength: 80 }),
        fc.array(fc.nat(), { maxLength: 40 }),
        (actions, drainPicks) => {
          const network = new Network(3);
          for (const action of actions) runAction(network, action);
          network.drain(drainPicks);
          expectSettled(network);
          runs += 1;
          delivered += network.stats.delivered;
          duplicates += network.stats.duplicatesDelivered;
          dropped += network.stats.dropped;
          operations += total(network.room.store);
        },
      ),
      { numRuns: 500 },
    );
    expect(runs).toBe(500);
    // The runs must actually have exercised the faults.
    expect(operations).toBeGreaterThan(500);
    expect(delivered).toBeGreaterThan(0);
    expect(duplicates).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
  });

  it('sends every operation over every connection exactly once when nothing goes wrong', () => {
    const network = new Network(3);
    network.drain([]);
    const edits: Edit[] = [
      { kind: 'create', x: 1, y: 2, text: 'hi' },
      { kind: 'create', x: 3, y: 4, text: '' },
      { kind: 'text', pick: 0, at: 1, deleteCount: 0, text: 'abc' },
      { kind: 'move', pick: 1, x: 9, y: 9 },
      { kind: 'color', pick: 0, color: 'blue' },
      { kind: 'delete', pick: 1 },
    ];
    edits.forEach((edit, index) => {
      network.edit(network.client(index), edit);
      if (index % 2 === 1) network.drain([]);
    });
    network.drain([]);
    expectSettled(network);

    const authored = total(network.room.store);
    expect(authored).toBeGreaterThan(6);
    // One trip up to the server and one down to each of the two other clients.
    expect(network.stats.opsSent).toBe(authored * 3);
  });

  it('does not send an operation again when the network duplicates messages', () => {
    const network = new Network(3);
    network.drain([]);
    network.edit(network.client(0), { kind: 'create', x: 1, y: 1, text: 'one' });
    network.edit(network.client(1), { kind: 'create', x: 2, y: 2, text: 'two' });
    for (let round = 0; round < 6; round += 1) {
      for (let count = 0; count < 4; count += 1) network.duplicate(count, round);
      network.deliver(round);
    }
    network.drain([]);
    expectSettled(network);
    expect(network.stats.duplicatesDelivered).toBeGreaterThan(0);
    expect(network.stats.opsSent).toBe(total(network.room.store) * 3);
  });

  it('sends a reconnecting client only what it missed', () => {
    const network = new Network(3);
    const [a, b] = [network.client(0), network.client(1)];
    network.drain([]);
    for (let i = 0; i < 3; i += 1) network.edit(a, { kind: 'create', x: i, y: 0, text: '' });
    network.drain([]);
    const sentBefore = network.stats.opsSent;
    expect(sentBefore).toBe(3 * 3);

    // b drops and the server notices; a writes two more notes and b one, which cannot be sent.
    network.disconnect(b);
    network.reapAll();
    for (let i = 0; i < 2; i += 1) network.edit(a, { kind: 'create', x: 10 + i, y: 0, text: '' });
    network.edit(b, { kind: 'create', x: 99, y: 99, text: '' });
    network.drain([]); // reconnects b
    expectSettled(network);

    // a4 and a5 went to the server and to c while b was away: 4. After b came back: the server
    // sent b exactly a4, a5 (2) and b sent exactly b1 (1), which the server relayed to a and c (2).
    expect(network.stats.opsSent - sentBefore).toBe(4 + 2 + 1 + 2);
  });

  it('keeps the connections of a replica that reconnects before the server noticed apart', () => {
    const network = new Network(3);
    const b = network.client(1);
    network.drain([]);
    network.edit(network.client(0), { kind: 'create', x: 0, y: 0, text: 'x' });
    network.disconnect(b);
    network.connect(b); // a new connection while the server still holds the old session
    network.edit(network.client(0), { kind: 'move', pick: 0, x: 5, y: 5 });
    for (let step = 0; step < 50; step += 1) network.deliver(step); // before the server reaps
    network.drain([]);
    expectSettled(network);
    expect([...network.room.sessions.keys()]).toHaveLength(3);
  });
});

