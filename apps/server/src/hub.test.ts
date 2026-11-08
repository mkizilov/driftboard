import { Board, createManualClock, replicaId, type ReplicaId } from '@driftboard/crdt';
import {
  PROTOCOL_VERSION,
  authorOps,
  emptyStore,
  encodeMessage,
  flush,
  openInitiator,
  parseMessage,
  receive,
  storeSize,
  storeVector,
  type Message,
  type OpStore,
  type Session,
  type StampedOp,
} from '@driftboard/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase } from './db';
import { CLOSE, SyncHub, type HubConnection, type HubOptions, type HubSocket } from './hub';
import { BoardStorage } from './storage';
import { must, sleep, stamped } from './test-support';

const a = replicaId('a');
const b = replicaId('b');
const c = replicaId('c');
const BOARD = 'board-aaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'board-bbbbbbbbbbbbbbbbbbbbbb';

let db: Database.Database;
let storage: BoardStorage;
let errors: { error: unknown; context: string }[];

beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  storage = new BoardStorage(db);
  errors = [];
});

afterEach(() => {
  db.close();
});

function newHub(options: Partial<HubOptions> = {}): SyncHub {
  return new SyncHub({
    storage,
    helloTimeoutMs: 0,
    onError: (error, context) => errors.push({ error, context }),
    ...options,
  });
}

class FakeSocket implements HubSocket {
  readonly sent: Message[] = [];
  closed: { code: number; reason: string } | null = null;
  /** Called with each message as it is sent, to look at the world at that moment. */
  onSend: ((message: Message) => void) | undefined;

  send(text: string): void {
    const parsed = parseMessage(text);
    if (!parsed.ok) throw new Error(`the hub sent an invalid message: ${parsed.error}`);
    this.onSend?.(parsed.message);
    this.sent.push(parsed.message);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  types(): string[] {
    return this.sent.map((message) => message.type);
  }

  lastError(): Message | undefined {
    return [...this.sent].reverse().find((message) => message.type === 'error');
  }
}

/** A client of the hub that speaks the real sync protocol over a fake socket. */
class Peer {
  readonly socket = new FakeSocket();
  readonly conn: HubConnection;
  readonly board: Board;
  readonly id: ReplicaId;
  readonly boardId: string;
  store: OpStore;
  session: Session | null = null;
  readonly applied: StampedOp[] = [];
  readonly presence: Message[] = [];
  #cursor = 0;
  #notes = 0;

  constructor(hub: SyncHub, id: ReplicaId, boardId: string, store: OpStore = emptyStore) {
    this.id = id;
    this.boardId = boardId;
    this.conn = hub.accept(this.socket);
    this.store = store;
    this.board = new Board({ replicaId: id, clock: createManualClock(1000) });
  }

  say(message: Message): void {
    this.conn.receive(encodeMessage(message), false);
  }

  hello(): void {
    const open = openInitiator({ self: this.id, boardId: this.boardId }, this.store);
    this.session = open.session;
    for (const message of open.send) this.say(message);
  }

  /** Creates notes and sends the operations. */
  author(count = 1): void {
    for (let index = 0; index < count; index += 1) {
      this.#notes += 1;
      const ops = this.board.createNote({ x: this.#notes }).ops;
      this.store = authorOps(this.store, this.id, ops).store;
    }
    if (this.session === null) return;
    const flushed = flush(this.session, this.store);
    this.session = flushed.session;
    for (const message of flushed.send) this.say(message);
  }

  /** Handles what the hub has sent since the last call; true if there was anything. */
  pump(): boolean {
    let any = false;
    while (this.#cursor < this.socket.sent.length) {
      const message = must(this.socket.sent[this.#cursor]);
      this.#cursor += 1;
      any = true;
      if (this.session === null) continue;
      const step = receive(this.session, this.store, message);
      this.session = step.session;
      this.store = step.store;
      this.applied.push(...step.applied);
      if (step.presence !== null) this.presence.push(step.presence);
      for (const reply of step.send) this.say(reply);
    }
    return any;
  }
}

/** Lets the peers and the hub answer each other until nothing more is sent. */
function settle(...peers: Peer[]): void {
  while (peers.map((peer) => peer.pump()).some(Boolean)) {
    // keep going
  }
}

function connected(hub: SyncHub, id: ReplicaId, boardId = BOARD, store?: OpStore): Peer {
  const peer = new Peer(hub, id, boardId, store);
  peer.hello();
  return peer;
}

const labels = (ops: readonly StampedOp[]) => ops.map((op) => `${op.origin}${op.seq}`);
const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('syncing through the hub', () => {
  it('answers a hello with its own hello and the operations stored for the board', () => {
    storage.append(BOARD, stamped(a, 1, 3));
    const hub = newHub();
    const peer = connected(hub, b);
    settle(peer);
    expect(peer.socket.types()[0]).toBe('hello');
    expect(labels(peer.applied)).toEqual(['a1', 'a2', 'a3']);
    expect(peer.conn.greeted).toBe(true);
  });

  it('stores new operations before it acknowledges them', () => {
    const hub = newHub();
    const peer = connected(hub, a);
    settle(peer);
    const stored: number[] = [];
    peer.socket.onSend = (message) => {
      if (message.type === 'ack') stored.push(storage.tailSize(BOARD));
    };
    peer.author(3);
    settle(peer);
    expect(stored).toEqual([3]);
    expect(storage.tailSize(BOARD)).toBe(3);
  });

  it('relays operations to the other clients, once, and never back to the author', () => {
    const hub = newHub();
    const [pa, pb, pc] = [connected(hub, a), connected(hub, b), connected(hub, c)];
    settle(pa, pb, pc);
    pa.author(2);
    pb.author(1);
    settle(pa, pb, pc);

    for (const peer of [pa, pb, pc]) {
      expect(storeVector(peer.store).entries()).toEqual([
        ['a', 2],
        ['b', 1],
      ]);
    }
    expect(labels(pa.applied)).toEqual(['b1']);
    expect(labels(pb.applied)).toEqual(['a1', 'a2']);
    expect(labels(pc.applied).sort()).toEqual(['a1', 'a2', 'b1']);
    expect(storage.tailSize(BOARD)).toBe(3);
  });

  it('keeps boards apart', () => {
    const hub = newHub();
    const onBoard = connected(hub, a, BOARD);
    const onOther = connected(hub, b, OTHER);
    settle(onBoard, onOther);
    onBoard.author(2);
    onOther.author(1);
    settle(onBoard, onOther);
    expect(onBoard.applied).toEqual([]);
    expect(onOther.applied).toEqual([]);
    expect(storage.tailSize(BOARD)).toBe(2);
    expect(storage.tailSize(OTHER)).toBe(1);
    expect(hub.roomCount).toBe(2);
  });

  it('drops a room when its last client leaves, and loads it again from storage', () => {
    const hub = newHub();
    const first = connected(hub, a);
    settle(first);
    first.author(4);
    settle(first);
    expect(hub.roomCount).toBe(1);
    first.conn.closed();
    expect(hub.roomCount).toBe(0);
    expect(hub.connectionCount).toBe(0);

    const later = connected(hub, b);
    settle(later);
    expect(labels(later.applied)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(hub.roomCount).toBe(1);
  });

  it('tells the others when a client leaves', () => {
    const hub = newHub();
    const [pa, pb] = [connected(hub, a), connected(hub, b)];
    settle(pa, pb);
    pa.conn.closed();
    settle(pb);
    expect(pb.presence).toEqual([{ type: 'presence', replicaId: a, state: null }]);
  });

  it('relays presence without storing it', () => {
    const hub = newHub();
    const [pa, pb] = [connected(hub, a), connected(hub, b)];
    settle(pa, pb);
    const state = { cursor: { x: 1, y: 2 }, selection: ['n'] };
    pa.say({ type: 'presence', replicaId: a, state });
    settle(pa, pb);
    expect(pb.presence).toEqual([{ type: 'presence', replicaId: a, state }]);
    expect(count('ops')).toBe(0);
  });

  it('closes the older connection when a replica connects again', () => {
    const hub = newHub();
    const old = connected(hub, a);
    settle(old);
    const fresh = connected(hub, a);
    settle(old, fresh);
    expect(old.socket.closed?.code).toBe(CLOSE.replaced);
    expect(fresh.socket.closed).toBeNull();
    expect(hub.connectionCount).toBe(1);
  });

  it('ignores a second hello on the same connection', () => {
    storage.append(BOARD, stamped(a, 1, 2));
    const hub = newHub();
    const peer = connected(hub, b);
    settle(peer);
    const before = peer.socket.sent.length;
    peer.hello();
    settle(peer);
    expect(peer.socket.sent.length).toBe(before);
  });

  it('closes every connection when it shuts down', () => {
    const hub = newHub();
    const peers = [connected(hub, a), connected(hub, b, OTHER)];
    hub.close();
    for (const peer of peers) expect(peer.socket.closed?.code).toBe(CLOSE.goingAway);
    expect(hub.connectionCount).toBe(0);
    expect(hub.roomCount).toBe(0);
  });
});

describe('compaction', () => {
  it('folds the tail into the snapshot once it is long enough', () => {
    const hub = newHub({ compactAfterOps: 5 });
    const peer = connected(hub, a);
    settle(peer);
    peer.author(4);
    expect(count('snapshots')).toBe(0);
    expect(storage.tailSize(BOARD)).toBe(4);
    peer.author(2);
    settle(peer);
    expect(count('snapshots')).toBe(1);
    expect(storage.tailSize(BOARD)).toBe(0);

    peer.author(1);
    expect(storage.tailSize(BOARD)).toBe(1);
    expect(storeSize(storage.load(BOARD).store)).toBe(7);
  });

  it('is skipped when switched off, and done on request for boards with a tail', () => {
    const hub = newHub({ compactAfterOps: 0 });
    const peer = connected(hub, a);
    settle(peer);
    peer.author(20);
    settle(peer);
    expect(count('snapshots')).toBe(0);
    storage.append(OTHER, stamped(b, 1, 3));

    expect(hub.compactAll()).toBe(2);
    expect(count('snapshots')).toBe(2);
    expect(storage.tailSize(BOARD)).toBe(0);
    expect(hub.compactAll()).toBe(0);

    peer.author(1); // an open room starts a new tail
    expect(storage.tailSize(BOARD)).toBe(1);
    expect(storeSize(storage.load(BOARD).store)).toBe(21);
  });

  it('does not take connections down when it fails', () => {
    const hub = newHub({ compactAfterOps: 3 });
    const peer = connected(hub, a);
    const other = connected(hub, b);
    settle(peer, other);
    // Operations that do not continue anyone's log make the tail impossible to fold in.
    db.prepare('INSERT INTO ops (board_id, origin, seq, payload) VALUES (?, ?, ?, ?)').run(BOARD, 'zz', 9, '{}');
    peer.author(3);
    settle(peer, other);
    expect(errors.map((e) => e.context)).toEqual([`compacting board ${BOARD}`]);
    expect(peer.socket.closed).toBeNull();
    expect(labels(other.applied)).toEqual(['a1', 'a2', 'a3']);
    expect(count('snapshots')).toBe(0);

    // It is not retried on every message, only after the tail has grown by another threshold.
    peer.author(2);
    settle(peer, other);
    expect(errors).toHaveLength(1);
    peer.author(1);
    settle(peer, other);
    expect(errors).toHaveLength(2);
    expect(peer.socket.closed).toBeNull();
  });
});

describe('invalid data closes the connection', () => {
  function expectRejected(peer: Peer, code: string, closeCode: number): void {
    expect(peer.socket.lastError()).toMatchObject({ type: 'error', code });
    expect(peer.socket.closed?.code).toBe(closeCode);
  }

  const raw = (hub: SyncHub, text: string, isBinary = false): Peer => {
    const peer = new Peer(hub, a, BOARD);
    peer.conn.receive(text, isBinary);
    return peer;
  };

  it('text that is not JSON, and JSON that is not a message', () => {
    const hub = newHub();
    for (const text of ['not json', '[]', '{}', '{"type":"hello"}', '{"type":"ops","ops":[]}', 'null']) {
      const peer = raw(hub, text);
      expectRejected(peer, 'invalid_message', CLOSE.policyViolation);
    }
    expect(hub.connectionCount).toBe(0);
    expect(hub.roomCount).toBe(0);
  });

  it('binary frames', () => {
    const peer = raw(newHub(), '', true);
    expectRejected(peer, 'invalid_message', CLOSE.unsupportedData);
  });

  it('messages over the size limit, even valid ones', () => {
    const hub = newHub({ maxMessageBytes: 2000 });
    const message = encodeMessage({ type: 'ops', ops: stamped(a, 1, 40) });
    expect(Buffer.byteLength(message)).toBeGreaterThan(2000);
    expectRejected(raw(hub, message), 'invalid_message', CLOSE.tooBig);
    const within = encodeMessage({ type: 'ack', versionVector: [] });
    expect(Buffer.byteLength(within)).toBeLessThan(2000);
  });

  it('a first message that is not hello', () => {
    const hub = newHub();
    const peer = new Peer(hub, a, BOARD);
    peer.say({ type: 'ops', ops: stamped(a, 1, 1) });
    expectRejected(peer, 'unexpected_message', CLOSE.policyViolation);
    expect(count('ops')).toBe(0);
  });

  it('a board id that is too short to be secret', () => {
    const hub = newHub();
    for (const boardId of ['x', 'home', 'a'.repeat(21), 'a'.repeat(129), `${'a'.repeat(21)}!`]) {
      const peer = new Peer(hub, a, boardId);
      peer.hello();
      expectRejected(peer, 'invalid_message', CLOSE.policyViolation);
    }
    expect(hub.roomCount).toBe(0);
  });

  it('a protocol version the server does not speak', () => {
    const hub = newHub();
    const peer = new Peer(hub, a, BOARD);
    peer.say({
      type: 'hello',
      version: PROTOCOL_VERSION + 1,
      replicaId: a,
      boardId: BOARD,
      versionVector: [],
    });
    expectRejected(peer, 'unsupported_version', CLOSE.policyViolation);
    expect(hub.roomCount).toBe(0);
  });

  it('operations that are not valid board operations, and none of their batch is stored', () => {
    const hub = newHub();
    const peer = connected(hub, a);
    settle(peer);
    const good = must(stamped(a, 1, 1)[0]);
    peer.say({ type: 'ops', ops: [good, { origin: a, seq: 2, op: { type: 'note-put' } }] });
    expectRejected(peer, 'invalid_message', CLOSE.policyViolation);
    expect(count('ops')).toBe(0);
  });

  it('operations that skip ahead or contradict what is stored', () => {
    storage.append(BOARD, stamped(a, 1, 2));
    const hub = newHub();
    const skipping = connected(hub, b);
    settle(skipping);
    skipping.say({ type: 'ops', ops: stamped(b, 2, 1) });
    expectRejected(skipping, 'out_of_order', CLOSE.policyViolation);

    const contradicting = connected(hub, c);
    settle(contradicting);
    const other = must(stamped(a, 1, 2)[1]);
    contradicting.say({
      type: 'ops',
      ops: [{ ...other, seq: 1 }],
    });
    expectRejected(contradicting, 'conflicting_op', CLOSE.policyViolation);
    expect(storage.tailSize(BOARD)).toBe(2);
  });

  it('presence that speaks for another replica', () => {
    const hub = newHub();
    const peer = connected(hub, a);
    settle(peer);
    peer.say({ type: 'presence', replicaId: b, state: null });
    expectRejected(peer, 'invalid_message', CLOSE.policyViolation);
  });

  it('and leaves the other connections of the board working', () => {
    const hub = newHub();
    const good = connected(hub, a);
    const bad = connected(hub, b);
    settle(good, bad);
    bad.conn.receive('garbage', false);
    expect(bad.socket.closed?.code).toBe(CLOSE.policyViolation);
    good.author(2);
    settle(good);
    expect(good.socket.closed).toBeNull();
    expect(storage.tailSize(BOARD)).toBe(2);
    expect(hub.connectionCount).toBe(1);
  });

  it('ignores anything that arrives after the connection was closed', () => {
    const hub = newHub();
    const peer = connected(hub, a);
    settle(peer);
    peer.conn.receive('garbage', false);
    const sent = peer.socket.sent.length;
    peer.say({ type: 'ops', ops: stamped(a, 1, 1) });
    expect(peer.socket.sent.length).toBe(sent);
    expect(count('ops')).toBe(0);
  });

  it('a connection that never says hello', async () => {
    const hub = newHub({ helloTimeoutMs: 20 });
    const silent = new Peer(hub, a, BOARD);
    const polite = new Peer(hub, b, BOARD);
    polite.hello();
    await sleep(80);
    expectRejected(silent, 'unexpected_message', CLOSE.policyViolation);
    expect(polite.socket.closed).toBeNull();
    expect(hub.connectionCount).toBe(1);
  });
});

describe('when storage fails', () => {
  it('closes the connection, reports the error, and does not tell anyone about the operations', () => {
    const hub = newHub();
    const writer = connected(hub, a);
    const reader = connected(hub, b);
    settle(writer, reader);
    db.exec('DROP TABLE ops');
    writer.author(2);
    settle(writer, reader);
    expect(writer.socket.closed?.code).toBe(CLOSE.internalError);
    expect(writer.socket.lastError()).toMatchObject({ code: 'internal_error' });
    expect(errors.map((e) => e.context)).toEqual(['handling a message']);
    expect(reader.applied).toEqual([]);
    expect(reader.socket.closed).toBeNull();

    // The room did not keep the operations that could not be stored.
    const late = connected(hub, c);
    settle(late);
    expect(late.applied).toEqual([]);
  });

  it('closes a connection whose board cannot be loaded', () => {
    storage.append(BOARD, stamped(a, 1, 2));
    db.prepare('UPDATE ops SET origin = ? WHERE seq = 1').run('bad id');
    const hub = newHub();
    const peer = connected(hub, b);
    expect(peer.socket.closed?.code).toBe(CLOSE.internalError);
    expect(hub.roomCount).toBe(0);
    expect(hub.connectionCount).toBe(0);
  });
});
