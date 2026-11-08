import { isReplicaId } from '@driftboard/crdt';
import { describe, expect, it } from 'vitest';
import { createBoardSession, type BoardSession, type SessionOptions } from './session';
import { FakeNetwork, FakeTimers } from './test-network';

function bytes(seed: number): (length: number) => Uint8Array {
  return (length) => Uint8Array.from({ length }, (_, index) => (seed * 53 + index * 7) % 256);
}

function open(
  net: FakeNetwork,
  timers: FakeTimers,
  seed: number,
  extra: Partial<SessionOptions> = {},
) {
  return createBoardSession({
    boardId: net.boardId,
    url: 'ws://test.invalid/ws',
    randomBytes: bytes(seed),
    createSocket: net.createSocket,
    timers,
    random: () => 0,
    retry: { initialMs: 100, maxMs: 1000 },
    ...extra,
  });
}

function connect(net: FakeNetwork, session: BoardSession) {
  session.start();
  const socket = net.sockets.at(-1);
  if (socket === undefined) throw new Error('the session did not connect');
  net.open(socket);
  return socket;
}

describe('createBoardSession', () => {
  it('names the board and gives the page its own valid replica id', () => {
    const net = new FakeNetwork();
    const timers = new FakeTimers();
    const a = open(net, timers, 1);
    const sameBytes = open(net, timers, 1);
    const other = open(net, timers, 2);
    expect(a.boardId).toBe(net.boardId);
    expect(isReplicaId(a.replicaId)).toBe(true);
    expect(sameBytes.replicaId).toBe(a.replicaId);
    expect(other.replicaId).not.toBe(a.replicaId);
  });

  it('does not connect before it is started', () => {
    const net = new FakeNetwork();
    open(net, new FakeTimers(), 1);
    expect(net.sockets).toHaveLength(0);
  });

  it('joins the store to the connection, so edits reach other sessions', () => {
    const net = new FakeNetwork();
    const timers = new FakeTimers();
    const a = open(net, timers, 1);
    const b = open(net, timers, 2);
    connect(net, a);
    connect(net, b);
    expect(a.connection.getStatus()).toBe('online');

    const id = a.store.createNote(5, 6);
    if (id === undefined) throw new Error('the note was not created');
    a.store.editText(id, { start: 0, deleteCount: 0, insert: 'hello' });
    expect(b.store.getNote(id)).toMatchObject({ x: 5, y: 6, text: 'hello' });

    b.store.moveNote(id, 1, 2);
    expect(a.store.getNote(id)).toMatchObject({ x: 1, y: 2, text: 'hello' });
  });

  it('writes with the physical clock it was given', () => {
    const net = new FakeNetwork();
    let reads = 0;
    const session = open(net, new FakeTimers(), 1, {
      now: () => {
        reads += 1;
        return 5_000;
      },
    });
    session.store.createNote(0, 0);
    expect(reads).toBeGreaterThan(0);
  });

  it('retries the way it was told to', () => {
    const net = new FakeNetwork();
    const timers = new FakeTimers();
    const session = open(net, timers, 1);
    session.start();
    net.sockets.at(-1)?.drop();
    expect(timers.delays).toEqual([50]);
  });

  it('closes the connection when disposed', () => {
    const net = new FakeNetwork();
    const timers = new FakeTimers();
    const session = open(net, timers, 1);
    const socket = connect(net, session);
    session.dispose();
    expect(socket.closed).toBe(true);
    expect(session.connection.getStatus()).toBe('offline');
  });
});
