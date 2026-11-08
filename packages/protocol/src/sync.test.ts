import { Board, createManualClock, replicaId, type ReplicaId } from '@driftboard/crdt';
import { describe, expect, it } from 'vitest';
import { MAX_OPS_PER_MESSAGE, PROTOCOL_VERSION } from './constants';
import type { Hello, Message, Ops } from './messages';
import type { StampedOp } from './ops';
import { emptyStore, storeSize, storeVector, type OpStore } from './store';
import {
  authorOps,
  farewell,
  flush,
  isSynced,
  openInitiator,
  openResponder,
  receive,
  vectorToWire,
  type Session,
  type SessionStep,
} from './sync';
import { boardOps, must, presenceState, stamped, storeOf } from './test-support';

const a = replicaId('a');
const b = replicaId('b');
const c = replicaId('c');
const serverId = replicaId('server');
const BOARD = 'board-1';

const vectorOf = (store: OpStore) => vectorToWire(storeVector(store));
const label = (op: { origin: ReplicaId; seq: number }) => `${op.origin}${op.seq}`;
const types = (send: readonly Message[]) => send.map((message) => message.type);

/** The ops messages in `send`, flattened to origin+seq labels such as "a3". */
const sentOps = (send: readonly Message[]): string[] =>
  send.flatMap((message) => (message.type === 'ops' ? message.ops.map(label) : []));

function hello(replica: ReplicaId, store: OpStore, overrides: Partial<Hello> = {}): Hello {
  return {
    type: 'hello',
    version: PROTOCOL_VERSION,
    replicaId: replica,
    boardId: BOARD,
    versionVector: vectorOf(store),
    ...overrides,
  };
}

function newBoard(origin: ReplicaId): Board {
  return new Board({ replicaId: origin, clock: createManualClock(1000) });
}

/** One side of a connection: its session and store, and every operation that was new to it. */
interface Endpoint {
  session: Session;
  store: OpStore;
  applied: StampedOp[];
}

interface Pair {
  client: Endpoint;
  server: Endpoint;
  /** Everything each side sent, in order. */
  fromClient: Message[];
  fromServer: Message[];
}

/** A client (replica `c`) and a server, connected, with the hello exchange not yet delivered. */
function connect(clientStore: OpStore, serverStore: OpStore): Pair & { toServer: Message[] } {
  const open = openInitiator({ self: c, boardId: BOARD }, clientStore);
  return {
    client: { session: open.session, store: clientStore, applied: [] },
    server: {
      session: openResponder({ self: serverId, boardId: BOARD }),
      store: serverStore,
      applied: [],
    },
    fromClient: [...open.send],
    fromServer: [],
    toServer: [...open.send],
  };
}

/** Delivers messages in order, alternating between the sides, until nothing is left in flight. */
function pump(pair: Pair, toServer: Message[], toClient: Message[] = []): void {
  const step = (endpoint: Endpoint, message: Message, outbox: Message[], trace: Message[]) => {
    const result = receive(endpoint.session, endpoint.store, message);
    endpoint.session = result.session;
    endpoint.store = result.store;
    endpoint.applied.push(...result.applied);
    outbox.push(...result.send);
    trace.push(...result.send);
  };
  while (toServer.length > 0 || toClient.length > 0) {
    const forServer = toServer.shift();
    if (forServer !== undefined) step(pair.server, forServer, toClient, pair.fromServer);
    const forClient = toClient.shift();
    if (forClient !== undefined) step(pair.client, forClient, toServer, pair.fromClient);
  }
}

function synced(clientStore: OpStore, serverStore: OpStore): Pair {
  const pair = connect(clientStore, serverStore);
  pump(pair, pair.toServer);
  return pair;
}

describe('the handshake', () => {
  const clientStore = storeOf(stamped(a, 1, 2), stamped(c, 1, 1));
  const serverStore = storeOf(stamped(a, 1, 3), stamped(b, 1, 1));

  it('opens with the version vector and nothing else', () => {
    const open = openInitiator({ self: c, boardId: BOARD }, clientStore);
    expect(open.send).toEqual([hello(c, clientStore)]);
    expect(open.send[0]).toMatchObject({
      versionVector: [
        [a, 2],
        [c, 1],
      ],
    });
    expect(open.session.phase).toBe('awaiting-hello');
  });

  it('answers with its own vector and exactly the operations the other side lacks', () => {
    const pair = connect(clientStore, serverStore);
    const atServer = receive(pair.server.session, serverStore, hello(c, clientStore));
    expect(types(atServer.send)).toEqual(['hello', 'ops']);
    expect(atServer.send[0]).toEqual(hello(serverId, serverStore));
    expect(sentOps(atServer.send)).toEqual(['a3', 'b1']); // the client holds a1, a2, c1
    expect(atServer.session).toMatchObject({ phase: 'ready', peer: c });
    expect(atServer.applied).toEqual([]);

    const atClient = receive(pair.client.session, clientStore, must(atServer.send[0]));
    expect(types(atClient.send)).toEqual(['ops']);
    expect(sentOps(atClient.send)).toEqual(['c1']); // the server holds a1..a3, b1
    expect(atClient.session).toMatchObject({ phase: 'ready', peer: serverId });
  });

  it('sends nothing but the two hellos when both sides hold the same', () => {
    const pair = synced(serverStore, serverStore);
    expect(types(pair.fromServer)).toEqual(['hello']);
    expect(types(pair.fromClient)).toEqual(['hello']);
  });

  it('ends with equal stores, every missing operation sent exactly once, and both sides synced', () => {
    const pair = synced(clientStore, serverStore);
    expect(sentOps(pair.fromServer)).toEqual(['a3', 'b1']);
    expect(sentOps(pair.fromClient)).toEqual(['c1']);
    expect(vectorOf(pair.client.store)).toEqual(vectorOf(pair.server.store));
    expect(vectorOf(pair.client.store)).toEqual([
      [a, 3],
      [b, 1],
      [c, 1],
    ]);
    expect(isSynced(pair.client.session, pair.client.store)).toBe(true);
    expect(isSynced(pair.server.session, pair.server.store)).toBe(true);
  });

  it('reports the operations that were new, so the application can apply them', () => {
    const pair = synced(clientStore, serverStore);
    expect(pair.client.applied.map(label)).toEqual(['a3', 'b1']);
    expect(pair.server.applied.map(label)).toEqual(['c1']);
    expect(storeSize(pair.client.store)).toBe(5);
  });

  it('ignores a repeated hello instead of answering it again', () => {
    const message = hello(c, emptyStore);
    const first = receive(openResponder({ self: serverId, boardId: BOARD }), serverStore, message);
    expect(sentOps(first.send)).toEqual(['a1', 'a2', 'a3', 'b1']);
    const second = receive(first.session, serverStore, message);
    expect(second.send).toEqual([]);
    expect(second.session).toBe(first.session);
  });

  it('splits a large catch-up into messages of at most MAX_OPS_PER_MESSAGE', () => {
    const total = MAX_OPS_PER_MESSAGE * 2 + 200;
    const big = storeOf(stamped(a, 1, total));
    const responder = openResponder({ self: serverId, boardId: BOARD });
    const first = receive(responder, big, hello(c, emptyStore));
    const sizes = first.send.filter((m): m is Ops => m.type === 'ops').map((m) => m.ops.length);
    expect(sizes).toEqual([MAX_OPS_PER_MESSAGE, MAX_OPS_PER_MESSAGE, 200]);
  });

  it("brings back a replica's own operations after it lost its data, and numbers on from them", () => {
    const pair = synced(emptyStore, storeOf(stamped(c, 1, 3)));
    expect(pair.client.applied.map(label)).toEqual(['c1', 'c2', 'c3']);
    // The fourth operation of replica c, from the board that made the first three.
    const next = authorOps(pair.client.store, c, boardOps(c, 4).slice(3));
    expect(next.ops.map((op) => op.seq)).toEqual([4]);
  });
});

describe('after the handshake', () => {
  it('sends a new operation once, and nothing when flushed again', () => {
    const pair = synced(emptyStore, emptyStore);
    const authored = authorOps(pair.client.store, c, newBoard(c).createNote().ops);
    expect(authored.ops.map((op) => op.seq)).toEqual([1]);

    const first = flush(pair.client.session, authored.store);
    expect(sentOps(first.send)).toEqual(['c1']);
    expect(flush(first.session, authored.store).send).toEqual([]);

    const more = authorOps(authored.store, c, boardOps(c, 2).slice(1));
    expect(more.ops.map((op) => op.seq)).toEqual([2]);
    expect(sentOps(flush(first.session, more.store).send)).toEqual(['c2']);
  });

  it('applies received operations, acks them, and never sends them back', () => {
    const pair = synced(emptyStore, emptyStore);
    const authored = authorOps(pair.client.store, c, newBoard(c).createNote().ops);
    const sent = flush(pair.client.session, authored.store);

    const atServer = receive(pair.server.session, emptyStore, must(sent.send[0]));
    expect(atServer.applied.map(label)).toEqual(['c1']);
    expect(atServer.send).toEqual([{ type: 'ack', versionVector: [[c, 1]] }]);
    expect(flush(atServer.session, atServer.store).send).toEqual([]);

    const atClient = receive(sent.session, authored.store, must(atServer.send[0]));
    expect(atClient.session.acked.get(c)).toBe(1);
    expect(isSynced(atClient.session, authored.store)).toBe(true);
  });

  it('ignores a duplicated ops message: nothing applied, no ack, nothing to send', () => {
    const pair = synced(emptyStore, emptyStore);
    const authored = authorOps(pair.client.store, c, newBoard(c).createNote().ops);
    const message = must(flush(pair.client.session, authored.store).send[0]);
    const first = receive(pair.server.session, emptyStore, message);
    const second = receive(first.session, first.store, message);
    expect(second.applied).toEqual([]);
    expect(second.send).toEqual([]);
    expect(second.store).toBe(first.store);
  });

  it('is not synced until the peer has acknowledged what was sent', () => {
    const pair = synced(emptyStore, emptyStore);
    const authored = authorOps(pair.client.store, c, newBoard(c).createNote().ops);
    const flushed = flush(pair.client.session, authored.store);
    expect(isSynced(flushed.session, authored.store)).toBe(false);
    const ack: Message = { type: 'ack', versionVector: [[c, 1]] };
    const acked = receive(flushed.session, authored.store, ack);
    expect(isSynced(acked.session, authored.store)).toBe(true);
  });
});

describe('protocol violations close the session with an error', () => {
  const responder = () => openResponder({ self: serverId, boardId: BOARD });
  const readyServer = () => synced(emptyStore, emptyStore).server.session;

  function expectClosed(step: SessionStep, code: string) {
    expect(step.session.phase).toBe('closed');
    expect(step.send).toHaveLength(1);
    expect(step.send[0]).toMatchObject({ type: 'error', code });
  }

  it('ops, ack or presence before hello', () => {
    const ops: Message = { type: 'ops', ops: stamped(a, 1, 1) };
    const ack: Message = { type: 'ack', versionVector: [] };
    const presence: Message = { type: 'presence', replicaId: a, state: null };
    for (const message of [ops, ack, presence]) {
      expectClosed(receive(responder(), emptyStore, message), 'unexpected_message');
    }
  });

  it('a hello for another board or protocol version, or with our own replica id', () => {
    const other = hello(a, emptyStore, { boardId: 'other' });
    expectClosed(receive(responder(), emptyStore, other), 'wrong_board');
    const future = hello(a, emptyStore, { version: PROTOCOL_VERSION + 1 });
    expectClosed(receive(responder(), emptyStore, future), 'unsupported_version');
    // Version 1 clients sent a different presence state (a list of selected notes).
    const old = hello(a, emptyStore, { version: 1 });
    expectClosed(receive(responder(), emptyStore, old), 'unsupported_version');
    expectClosed(receive(responder(), emptyStore, hello(serverId, emptyStore)), 'invalid_message');
  });

  it('an operation that skips ahead in its origin stream', () => {
    const skipped: Message = { type: 'ops', ops: stamped(c, 2, 1) };
    const step = receive(readyServer(), emptyStore, skipped);
    expectClosed(step, 'out_of_order');
    expect(step.store).toBe(emptyStore);
  });

  it('an operation that differs from the stored one with the same number', () => {
    const store = storeOf(stamped(c, 1, 1));
    const different = authorOps(emptyStore, c, newBoard(c).createNote({ x: 9 }).ops);
    const step = receive(readyServer(), store, { type: 'ops', ops: different.ops });
    expectClosed(step, 'conflicting_op');
    expect(step.store).toBe(store);
  });

  it('a payload that is not a valid board operation, without storing any of the batch', () => {
    const good = must(stamped(c, 1, 1)[0]);
    const bad = { origin: c, seq: 2, op: { type: 'note-put', noteId: 'n' } };
    const step = receive(readyServer(), emptyStore, { type: 'ops', ops: [good, bad] });
    expectClosed(step, 'invalid_message');
    expect(step.store).toBe(emptyStore);
    expect(step.applied).toEqual([]);
  });

  it('presence from a client about another replica', () => {
    const spoof: Message = { type: 'presence', replicaId: a, state: null };
    expectClosed(receive(readyServer(), emptyStore, spoof), 'invalid_message');
  });

  it('nothing is processed after the session closed', () => {
    const closed = receive(responder(), emptyStore, { type: 'ack', versionVector: [] }).session;
    const full = storeOf(stamped(a, 1, 2));
    const step = receive(closed, full, hello(a, emptyStore));
    expect(step.send).toEqual([]);
    expect(step.session.phase).toBe('closed');
    expect(flush(closed, full).send).toEqual([]);
  });

  it('an error from the peer closes the session and is reported', () => {
    const error: Message = { type: 'error', code: 'wrong_board', message: 'no' };
    const step = receive(readyServer(), emptyStore, error);
    expect(step.session.phase).toBe('closed');
    expect(step.peerError).toEqual(error);
    expect(step.send).toEqual([]);
  });
});

describe('presence', () => {
  it("passes a client's presence up, and a relayed one down to a client", () => {
    const pair = synced(emptyStore, emptyStore);
    const mine: Message = {
      type: 'presence',
      replicaId: c,
      state: presenceState({ cursor: { x: 1, y: 2 } }),
    };
    expect(receive(pair.server.session, emptyStore, mine).presence).toEqual(mine);

    const theirs: Message = { type: 'presence', replicaId: a, state: null };
    expect(receive(pair.client.session, emptyStore, theirs).presence).toEqual(theirs);
    // A client ignores presence that claims to be about itself.
    expect(receive(pair.client.session, emptyStore, mine).presence).toBeNull();
  });

  it('tells the others when a ready client leaves, but not for other sessions', () => {
    const pair = synced(emptyStore, emptyStore);
    expect(farewell(pair.server.session)).toEqual({ type: 'presence', replicaId: c, state: null });
    expect(farewell(pair.client.session)).toBeNull();
    expect(farewell(openResponder({ self: serverId, boardId: BOARD }))).toBeNull();
  });
});
