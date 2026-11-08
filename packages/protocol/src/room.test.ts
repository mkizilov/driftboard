import { Board, createManualClock, replicaId, type ReplicaId } from '@driftboard/crdt';
import { describe, expect, it } from 'vitest';
import type { Message } from './messages';
import type { StampedOp } from './ops';
import {
  createRoom,
  roomConnect,
  roomDisconnect,
  roomReceive,
  type Outgoing,
  type Room,
  type RoomStep,
} from './room';
import { emptyStore, storeVector, type OpStore } from './store';
import { authorOps, flush, openInitiator, receive, vectorToWire, type Session } from './sync';
import { presenceState, stamped, storeOf } from './test-support';

const BOARD = 'board-1';
const serverId = replicaId('server');
const a = replicaId('a');
const b = replicaId('b');
const c = replicaId('c');
const d = replicaId('d');

const label = (op: { origin: ReplicaId; seq: number }) => `${op.origin}${op.seq}`;

interface Client {
  readonly id: ReplicaId;
  readonly conn: string;
  session: Session;
  store: OpStore;
  applied: StampedOp[];
  presence: Message[];
  errors: Message[];
}

/** A room and some clients wired together by hand, with a record of every operation sent. */
class Rig {
  room: Room = createRoom({ serverId, boardId: BOARD });
  readonly clients = new Map<string, Client>();
  /** Labels of the operations sent to each connection (`to:<conn>`) and to the server (`from:<conn>`). */
  readonly sent = new Map<string, string[]>();
  readonly persisted: StampedOp[] = [];
  /** Types of the messages sent to each connection, in order. */
  readonly types = new Map<string, string[]>();
  closed: string[] = [];
  #toServer: { conn: string; message: Message }[] = [];
  #toClients: Outgoing[] = [];
  #serial = 0;

  connect(id: ReplicaId, store: OpStore = emptyStore): Client {
    this.#serial += 1;
    const conn = `${id}#${this.#serial}`;
    const open = openInitiator({ self: id, boardId: BOARD }, store);
    const client: Client = {
      id,
      conn,
      session: open.session,
      store,
      applied: [],
      presence: [],
      errors: [],
    };
    this.clients.set(conn, client);
    this.room = roomConnect(this.room, conn);
    for (const message of open.send) this.#sendToServer(client, message);
    return client;
  }

  disconnect(client: Client): void {
    this.clients.delete(client.conn);
    this.#toServer = this.#toServer.filter((m) => m.conn !== client.conn);
    this.#toClients = this.#toClients.filter((m) => m.conn !== client.conn);
    this.#handle(roomDisconnect(this.room, client.conn));
  }

  /** The client creates `count` notes and sends the operations if it is connected. */
  author(client: Client, count = 1): void {
    const board = new Board({ replicaId: client.id, clock: createManualClock(1000) });
    for (let index = 0; index < count; index += 1) {
      const authored = authorOps(client.store, client.id, board.createNote({ x: index }).ops);
      client.store = authored.store;
    }
    if (this.clients.has(client.conn)) this.#flush(client);
  }

  send(client: Client, message: Message): void {
    this.#sendToServer(client, message);
  }

  /** Delivers everything in flight, in order, until nothing is left. */
  run(): void {
    while (this.#toServer.length > 0 || this.#toClients.length > 0) {
      const inbound = this.#toServer.shift();
      if (inbound !== undefined) {
        this.#handle(roomReceive(this.room, inbound.conn, inbound.message));
      }
      const outbound = this.#toClients.shift();
      if (outbound !== undefined) this.#deliver(outbound);
    }
  }

  opsSentTo(client: Client): string[] {
    return this.sent.get(`to:${client.conn}`) ?? [];
  }

  opsSentBy(client: Client): string[] {
    return this.sent.get(`from:${client.conn}`) ?? [];
  }

  #record(key: string, message: Message): void {
    if (message.type !== 'ops') return;
    this.sent.set(key, [...(this.sent.get(key) ?? []), ...message.ops.map(label)]);
  }

  #sendToServer(client: Client, message: Message): void {
    this.#record(`from:${client.conn}`, message);
    this.#toServer.push({ conn: client.conn, message });
  }

  #flush(client: Client): void {
    const flushed = flush(client.session, client.store);
    client.session = flushed.session;
    for (const message of flushed.send) this.#sendToServer(client, message);
  }

  #handle(step: RoomStep): void {
    this.room = step.room;
    this.persisted.push(...step.applied);
    this.closed.push(...step.close);
    for (const outgoing of step.send) {
      this.#record(`to:${outgoing.conn}`, outgoing.message);
      this.types.set(outgoing.conn, [
        ...(this.types.get(outgoing.conn) ?? []),
        outgoing.message.type,
      ]);
      this.#toClients.push(outgoing);
    }
  }

  #deliver(outgoing: Outgoing): void {
    const client = this.clients.get(outgoing.conn);
    if (client === undefined) return;
    const step = receive(client.session, client.store, outgoing.message);
    client.session = step.session;
    client.store = step.store;
    client.applied.push(...step.applied);
    if (step.presence !== null) client.presence.push(step.presence);
    if (outgoing.message.type === 'error') client.errors.push(outgoing.message);
    for (const message of step.send) this.#sendToServer(client, message);
  }
}

const vector = (store: OpStore) => vectorToWire(storeVector(store));

describe('a room with several clients', () => {
  function threeConnected() {
    const rig = new Rig();
    const [ca, cb, cc] = [rig.connect(a), rig.connect(b), rig.connect(c)];
    rig.run();
    return { rig, ca, cb, cc };
  }

  it('relays an operation to the other clients exactly once, and never back to its author', () => {
    const { rig, ca, cb, cc } = threeConnected();
    rig.author(ca, 2);
    rig.run();

    expect(rig.opsSentBy(ca)).toEqual(['a1', 'a2']);
    expect(rig.opsSentTo(cb)).toEqual(['a1', 'a2']);
    expect(rig.opsSentTo(cc)).toEqual(['a1', 'a2']);
    expect(rig.opsSentTo(ca)).toEqual([]);
    expect(rig.persisted.map(label)).toEqual(['a1', 'a2']);
    for (const client of [ca, cb, cc]) expect(vector(client.store)).toEqual([[a, 2]]);
  });

  it('relays concurrent operations from several clients without repeating any', () => {
    const { rig, ca, cb, cc } = threeConnected();
    rig.author(ca);
    rig.author(cb, 2);
    rig.author(cc);
    rig.run();

    for (const client of [ca, cb, cc]) {
      expect(vector(client.store)).toEqual([
        [a, 1],
        [b, 2],
        [c, 1],
      ]);
      const received = rig.opsSentTo(client);
      expect(new Set(received).size).toBe(received.length);
      expect(received.length).toBe(4 - rig.opsSentBy(client).length);
    }
    expect(rig.persisted).toHaveLength(4);
  });

  it('gives a client that joins late everything in the reply to its hello', () => {
    const { rig, ca } = threeConnected();
    rig.author(ca, 3);
    rig.run();
    const late = rig.connect(d);
    rig.run();
    expect(rig.opsSentTo(late)).toEqual(['a1', 'a2', 'a3']);
    expect(vector(late.store)).toEqual([[a, 3]]);
  });

  it('sends a returning client only what it missed, and relays what it wrote offline', () => {
    const { rig, ca, cb, cc } = threeConnected();
    rig.author(ca, 2);
    rig.run();

    rig.disconnect(cb);
    rig.author(ca); // a3 happens while b is away
    rig.author(cb); // b1 is written offline
    rig.run();
    expect(rig.opsSentTo(cb)).toEqual(['a1', 'a2']); // nothing new reached b

    const back = rig.connect(b, cb.store);
    rig.run();
    expect(rig.opsSentTo(back)).toEqual(['a3']);
    expect(rig.opsSentBy(back)).toEqual(['b1']);
    expect(rig.opsSentTo(ca)).toEqual(['b1']);
    expect(rig.opsSentTo(cc)).toEqual(['a1', 'a2', 'a3', 'b1']);
    for (const client of [ca, back, cc]) {
      expect(vector(client.store)).toEqual([
        [a, 3],
        [b, 1],
      ]);
    }
  });

  it('replaces a replica\'s old session when it reconnects before the old one was noticed', () => {
    const { rig, cb } = threeConnected();
    const again = rig.connect(b, cb.store);
    rig.run();
    expect(rig.closed).toEqual([cb.conn]);
    expect([...rig.room.sessions.keys()].sort()).toEqual(
      [...[...rig.clients.keys()].filter((conn) => conn !== cb.conn)].sort(),
    );
    expect(rig.room.sessions.get(again.conn)?.peer).toBe(b);
  });

  it('closes a connection that breaks the protocol and leaves the others alone', () => {
    const { rig, ca, cb, cc } = threeConnected();
    rig.send(cc, { type: 'ops', ops: stamped(c, 2, 1) }); // skips c1
    rig.run();
    expect(rig.closed).toEqual([cc.conn]);
    expect(cc.errors).toHaveLength(1);
    expect(rig.room.sessions.has(cc.conn)).toBe(false);
    expect(rig.room.sessions.has(ca.conn) && rig.room.sessions.has(cb.conn)).toBe(true);
    rig.author(ca);
    rig.run();
    expect(vector(cb.store)).toEqual([[a, 1]]);
  });

  it('ignores messages from connections it does not know', () => {
    const rig = new Rig();
    const step = roomReceive(rig.room, 'ghost', { type: 'ack', versionVector: [] });
    expect(step).toEqual({ room: rig.room, send: [], applied: [], close: [] });
    expect(roomDisconnect(rig.room, 'ghost')).toEqual(step);
  });

  it('starts from stored operations', () => {
    const store = storeOf(stamped(a, 1, 3));
    const room = createRoom({ serverId, boardId: BOARD, store });
    expect(vector(room.store)).toEqual([[a, 3]]);
  });
});

describe('presence through the room', () => {
  it('relays a client\'s presence to the others, not to itself, and announces its departure', () => {
    const rig = new Rig();
    const [ca, cb, cc] = [rig.connect(a), rig.connect(b), rig.connect(c)];
    rig.run();

    const mine: Message = {
      type: 'presence',
      replicaId: a,
      state: presenceState({ cursor: { x: 3, y: 4 }, editing: '1@a' }),
    };
    rig.send(ca, mine);
    rig.run();
    expect(cb.presence).toEqual([mine]);
    expect(cc.presence).toEqual([mine]);
    expect(ca.presence).toEqual([]);

    rig.disconnect(ca);
    rig.run();
    const left: Message = { type: 'presence', replicaId: a, state: null };
    expect(cb.presence).toEqual([mine, left]);
    expect(cc.presence).toEqual([mine, left]);
  });

  it('does not let a client speak for another replica', () => {
    const rig = new Rig();
    const [ca, cb] = [rig.connect(a), rig.connect(b)];
    rig.run();
    rig.send(ca, { type: 'presence', replicaId: b, state: null });
    rig.run();
    expect(rig.closed).toEqual([ca.conn]);
    // Nothing was said about b; the others only hear that a is gone.
    expect(cb.presence).toEqual([{ type: 'presence', replicaId: a, state: null }]);
  });

  describe('telling people who is here', () => {
    const present = (replica: ReplicaId, change = {}): Message => ({
      type: 'presence',
      replicaId: replica,
      state: presenceState({ name: replica, ...change }),
    });
    const hello = (replica: ReplicaId): Message => {
      const [first] = openInitiator({ self: replica, boardId: BOARD }, emptyStore).send;
      if (first === undefined) throw new Error('no hello');
      return first;
    };

    it('tells a client that joins late who is on the board, after the replies to its hello', () => {
      const rig = new Rig();
      const [ca, cb] = [rig.connect(a), rig.connect(b)];
      rig.run();
      const mine = present(a, { cursor: { x: 1, y: 2 } });
      const theirs = present(b, { editing: '1@b' });
      rig.send(ca, mine);
      rig.send(cb, theirs);
      rig.run();

      const cc = rig.connect(c);
      rig.run();
      expect(cc.presence).toEqual([mine, theirs]);
      const types = rig.types.get(cc.conn) ?? [];
      expect(types[0]).toBe('hello');
      expect(types.slice(-2)).toEqual(['presence', 'presence']);
    });

    it('tells a late joiner only the latest state of each replica', () => {
      const rig = new Rig();
      const ca = rig.connect(a);
      rig.run();
      rig.send(ca, present(a, { cursor: { x: 1, y: 1 } }));
      rig.send(ca, present(a, { cursor: { x: 9, y: 9 } }));
      rig.run();
      const cb = rig.connect(b);
      rig.run();
      expect(cb.presence).toEqual([present(a, { cursor: { x: 9, y: 9 } })]);
    });

    it('does not tell a late joiner about someone who left', () => {
      const rig = new Rig();
      const ca = rig.connect(a);
      rig.run();
      rig.send(ca, present(a));
      rig.run();
      rig.disconnect(ca);
      rig.run();
      expect(rig.room.presence.size).toBe(0);
      const cb = rig.connect(b);
      rig.run();
      expect(cb.presence).toEqual([]);
    });

    it('does not tell a late joiner about someone who cleared their presence', () => {
      const rig = new Rig();
      const ca = rig.connect(a);
      rig.run();
      rig.send(ca, present(a));
      rig.send(ca, { type: 'presence', replicaId: a, state: null });
      rig.run();
      expect(rig.room.presence.size).toBe(0);
      const cb = rig.connect(b);
      rig.run();
      expect(cb.presence).toEqual([]);
    });

    it('does not tell a client about itself when it comes back', () => {
      const rig = new Rig();
      const [ca, cb] = [rig.connect(a), rig.connect(b)];
      rig.run();
      const mine = present(a, { cursor: { x: 5, y: 5 } });
      rig.send(ca, mine);
      rig.send(cb, present(b));
      rig.run();

      const back = rig.connect(a);
      rig.run();
      expect(back.presence).toEqual([present(b)]);
      // Nothing about itself is sent to it, not even to be ignored.
      const types = rig.types.get(back.conn) ?? [];
      expect(types.filter((type) => type === 'presence')).toHaveLength(1);
    });

    it('is a value: a step does not change the room it was given', () => {
      const rig = new Rig();
      const [ca] = [rig.connect(a), rig.connect(b)];
      rig.run();
      rig.send(ca, present(a));
      rig.run();
      const before = rig.room;
      const snapshot = [...before.presence.keys()];

      const gone = roomReceive(before, ca.conn, { type: 'presence', replicaId: a, state: null });
      expect([...gone.room.presence.keys()]).toEqual([]);
      const left = roomDisconnect(before, ca.conn);
      expect([...left.room.presence.keys()]).toEqual([]);
      const spoke = roomReceive(before, ca.conn, present(a, { cursor: { x: 1, y: 1 } }));
      expect(spoke.room.presence).not.toBe(before.presence);

      expect([...before.presence.keys()]).toEqual(snapshot);
      expect(before.presence.get(a)).toEqual(presenceState({ name: a }));
      expect(before.sessions.size).toBe(2);
    });

    it('keeps showing a replica that comes back on a new connection, without announcing a departure', () => {
      const rig = new Rig();
      const [ca, cb] = [rig.connect(a), rig.connect(b)];
      rig.run();
      const state = presenceState({ name: a });
      const mine: Message = { type: 'presence', replicaId: a, state };
      rig.send(ca, mine);
      rig.run();
      rig.connect(a);
      rig.run();
      expect(cb.presence).toEqual([mine]);
      expect(rig.room.presence.get(a)).toEqual(state);
      // The old connection ending later changes nothing either.
      rig.disconnect(ca);
      rig.run();
      expect(cb.presence).toEqual([mine]);
    });

    it('announces a client that is closed for breaking the protocol, and forgets it', () => {
      const rig = new Rig();
      const [ca, cb] = [rig.connect(a), rig.connect(b)];
      rig.run();
      const mine = present(a);
      rig.send(ca, mine);
      rig.run();
      rig.send(ca, present(b));
      rig.run();
      expect(rig.closed).toEqual([ca.conn]);
      expect(cb.presence).toEqual([mine, { type: 'presence', replicaId: a, state: null }]);
      expect(rig.room.presence.size).toBe(0);
    });

    it('says nothing to a client that has not said hello yet, and tells it when it does', () => {
      let room = createRoom({ serverId, boardId: BOARD });
      room = roomConnect(roomConnect(room, 'a'), 'd');
      room = roomReceive(room, 'a', hello(a)).room;
      const mine = present(a);
      const relayed = roomReceive(room, 'a', mine);
      expect(relayed.send).toEqual([]);
      const joined = roomReceive(relayed.room, 'd', hello(d));
      const toD = joined.send.filter((outgoing) => outgoing.message.type === 'presence');
      expect(toD).toEqual([{ conn: 'd', message: mine }]);
    });

    it('holds nothing once everyone has gone', () => {
      const rig = new Rig();
      const clients = [rig.connect(a), rig.connect(b), rig.connect(c)];
      rig.run();
      for (const client of clients) rig.send(client, present(client.id));
      rig.run();
      expect(rig.room.presence.size).toBe(3);
      for (const client of clients) rig.disconnect(client);
      rig.run();
      expect(rig.room.presence.size).toBe(0);
    });

    it('does not change the room when a client that is not there speaks', () => {
      const room = createRoom({ serverId, boardId: BOARD });
      expect(roomReceive(room, 'nobody', present(a)).room).toBe(room);
    });
  });

  it('keeps presence out of the operation store', () => {
    const rig = new Rig();
    const ca = rig.connect(a);
    rig.connect(b);
    rig.run();
    rig.send(ca, { type: 'presence', replicaId: a, state: null });
    rig.run();
    expect(rig.persisted).toEqual([]);
    expect(rig.room.store).toBe(emptyStore);
  });
});

