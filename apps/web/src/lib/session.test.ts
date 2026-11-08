import { isReplicaId } from '@driftboard/crdt';
import { describe, expect, it } from 'vitest';
import { openBoardSession, type BoardSession, type SessionOptions } from './session';
import { MemoryDisk, type BoardStorage, type StoredBoard, type WriteBatch } from './storage';
import { FakeNetwork, FakeTimers } from './test-network';
import { operations } from './test-support';

function bytes(seed: number): (length: number) => Uint8Array {
  return (length) => Uint8Array.from({ length }, (_, index) => (seed * 53 + index * 7) % 256);
}

function open(
  net: FakeNetwork,
  timers: FakeTimers,
  seed: number,
  extra: Partial<SessionOptions> = {},
): Promise<BoardSession> {
  return openBoardSession({
    boardId: net.boardId,
    url: 'ws://test.invalid/ws',
    storage: new MemoryDisk().open(net.boardId),
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

describe('openBoardSession', () => {
  it('names the board and gives the page its own valid replica id', async () => {
    const net = new FakeNetwork();
    const timers = new FakeTimers();
    const a = await open(net, timers, 1);
    const sameBytes = await open(net, timers, 1);
    const other = await open(net, timers, 2);
    expect(a.boardId).toBe(net.boardId);
    expect(isReplicaId(a.replicaId)).toBe(true);
    expect(sameBytes.replicaId).toBe(a.replicaId);
    expect(other.replicaId).not.toBe(a.replicaId);
  });

  it('does not connect before it is started', async () => {
    const net = new FakeNetwork();
    await open(net, new FakeTimers(), 1);
    expect(net.sockets).toHaveLength(0);
  });

  it('joins the store to the connection, so edits reach other sessions', async () => {
    const net = new FakeNetwork();
    const timers = new FakeTimers();
    const a = await open(net, timers, 1);
    const b = await open(net, timers, 2);
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

  it('writes with the physical clock it was given', async () => {
    const net = new FakeNetwork();
    let reads = 0;
    const session = await open(net, new FakeTimers(), 1, {
      now: () => {
        reads += 1;
        return 5_000;
      },
    });
    session.store.createNote(0, 0);
    expect(reads).toBeGreaterThan(0);
  });

  it('retries the way it was told to', async () => {
    const net = new FakeNetwork();
    const timers = new FakeTimers();
    const session = await open(net, timers, 1);
    session.start();
    net.sockets.at(-1)?.drop();
    expect(timers.delays).toEqual([50]);
  });

  it('closes the connection when disposed', async () => {
    const net = new FakeNetwork();
    const session = await open(net, new FakeTimers(), 1);
    const socket = connect(net, session);
    await session.dispose();
    expect(socket.closed).toBe(true);
    expect(session.connection.getStatus()).toBe('offline');
  });
});

describe('openBoardSession and the device', () => {
  it('puts what the device holds into the board before anything connects', async () => {
    const net = new FakeNetwork();
    const disk = new MemoryDisk();
    const earlier = await open(net, new FakeTimers(), 1, { storage: disk.open(net.boardId) });
    const id = earlier.store.createNote(5, 6);
    if (id === undefined) throw new Error('the note was not created');
    earlier.store.editText(id, { start: 0, deleteCount: 0, insert: 'kept' });
    await earlier.dispose();

    const sockets = net.sockets.length;
    const later = await open(net, new FakeTimers(), 2, { storage: disk.open(net.boardId) });
    expect(later.store.getNote(id)).toMatchObject({ x: 5, y: 6, text: 'kept' });
    expect(later.connection.getState().pending).toBeGreaterThan(0);
    expect(net.sockets).toHaveLength(sockets);
    expect(later.replicaId).not.toBe(earlier.replicaId);
  });

  it('keeps what it authors and what it receives', async () => {
    const net = new FakeNetwork();
    const timers = new FakeTimers();
    const disk = new MemoryDisk();
    const a = await open(net, timers, 1, { storage: disk.open(net.boardId) });
    const b = await open(net, timers, 2);
    connect(net, a);
    connect(net, b);
    const mine = a.store.createNote(1, 1);
    const theirs = b.store.createNote(2, 2);
    if (mine === undefined || theirs === undefined) throw new Error('no notes');
    await a.persistence.flush();
    const stored = await disk.open(net.boardId).load();
    const origins = new Set(stored.ops.map((op) => op.origin));
    expect(origins).toEqual(new Set([a.replicaId, b.replicaId]));
    expect(stored.held.length).toBeGreaterThan(0);
  });

  it('writes what is queued before dispose finishes', async () => {
    const net = new FakeNetwork();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const written: WriteBatch[] = [];
    let closed = false;
    const slow: BoardStorage = {
      durable: true,
      load: () => Promise.resolve<StoredBoard>({ ops: [], held: [] }),
      write: async (batch) => {
        await gate;
        written.push(batch);
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
    const session = await open(net, new FakeTimers(), 1, { storage: slow });
    session.store.createNote(1, 1);
    const disposing = session.dispose();
    expect(closed).toBe(false);
    release();
    await disposing;
    expect(written.flatMap((batch) => batch.ops).length).toBeGreaterThan(0);
    expect(closed).toBe(true);
  });

  it('can be disposed more than once', async () => {
    const net = new FakeNetwork();
    const session = await open(net, new FakeTimers(), 1);
    await Promise.all([session.dispose(), session.dispose()]);
    await session.dispose();
  });

  it('opens with what it can use when the stored operations have a gap, and says how many it left out', async () => {
    const net = new FakeNetwork();
    const disk = new MemoryDisk();
    const ops = operations(1, ['abcd']);
    await disk.open(net.boardId).write({ ops: ops.filter((op) => op.seq !== 3), held: [] });
    const session = await open(net, new FakeTimers(), 2, { storage: disk.open(net.boardId) });
    expect(session.droppedOps).toBe(ops.length - 3);
    expect(session.store.getIds()).toHaveLength(1);
    expect(session.connection.getState().pending).toBe(2);
  });

  it('reports nothing dropped for an intact log', async () => {
    const net = new FakeNetwork();
    const disk = new MemoryDisk();
    await disk.open(net.boardId).write({ ops: operations(1), held: [] });
    const session = await open(net, new FakeTimers(), 2, { storage: disk.open(net.boardId) });
    expect(session.droppedOps).toBe(0);
  });

  it('passes on whether the storage is durable', async () => {
    const net = new FakeNetwork();
    const session = await open(net, new FakeTimers(), 1, {
      storage: new MemoryDisk({ durable: false }).open(net.boardId),
    });
    expect(session.persistence.durable).toBe(false);
  });

  it('fails to open when the device cannot be read', async () => {
    const net = new FakeNetwork();
    const storage = new MemoryDisk().open(net.boardId);
    await storage.close();
    await expect(open(net, new FakeTimers(), 1, { storage })).rejects.toThrow('closed');
  });

  it('rebuilds the same board from the log whatever order it was stored in', async () => {
    const net = new FakeNetwork();
    const mine = operations(1, ['ab']);
    const theirs = operations(2, ['xy']);
    const [first, second] = [new MemoryDisk(), new MemoryDisk()];
    await first.open(net.boardId).write({ ops: [...mine, ...theirs], held: [] });
    await second.open(net.boardId).write({ ops: [...theirs, ...mine].reverse(), held: [] });
    const a = await open(net, new FakeTimers(), 3, { storage: first.open(net.boardId) });
    const b = await open(net, new FakeTimers(), 4, { storage: second.open(net.boardId) });
    const notes = (session: BoardSession) =>
      session.store.getIds().flatMap((id) => session.store.getNote(id) ?? []);
    expect(notes(a)).toEqual(notes(b));
    expect(notes(a)).toHaveLength(2);
  });
});
