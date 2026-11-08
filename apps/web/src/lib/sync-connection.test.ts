import { parseMessage } from '@driftboard/protocol';
import { describe, expect, it } from 'vitest';
import { BoardStore } from './board-store';
import { SyncConnection, type ConnectionStatus } from './sync-connection';
import { FakeNetwork, FakeTimers, serverError, type FakeSocket } from './test-network';
import { replica } from './test-support';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

function setup(random: () => number = () => 0) {
  const net = new FakeNetwork();
  const timers = new FakeTimers();
  const client = (seed: number) => {
    const board = replica(seed);
    const connection = new SyncConnection({
      boardId: net.boardId,
      replicaId: board.replicaId,
      url: 'ws://test.invalid/ws',
      board,
      createSocket: net.createSocket,
      timers,
      random,
      retry: { initialMs: 100, maxMs: 1000 },
    });
    const store = new BoardStore(board, (ops) => {
      connection.submit(ops);
    });
    return { board, connection, store };
  };
  /** The socket most recently made. */
  const latest = (): FakeSocket => must(net.sockets.at(-1));
  /** Starts the client and completes the connection. Returns its socket. */
  const online = (c: ReturnType<typeof client>): FakeSocket => {
    c.connection.start();
    const socket = latest();
    net.open(socket);
    expect(c.connection.getStatus()).toBe('online');
    return socket;
  };
  return { net, timers, client, latest, online };
}

/** `origin:seq` of every operation in the `ops` messages among `frames`. */
function opKeys(frames: readonly string[]): string[] {
  const keys: string[] = [];
  for (const frame of frames) {
    const parsed = parseMessage(frame);
    if (parsed.ok && parsed.message.type === 'ops') {
      for (const op of parsed.message.ops) keys.push(`${op.origin}:${op.seq}`);
    }
  }
  return keys;
}

const hasNoDuplicates = (keys: readonly string[]) => new Set(keys).size === keys.length;

describe('SyncConnection: connecting', () => {
  it('stays offline until it is started, then connects and goes online', () => {
    const { net, client, latest } = setup();
    const a = client(1);
    expect(a.connection.getStatus()).toBe('offline');
    expect(net.sockets).toHaveLength(0);

    a.connection.start();
    expect(a.connection.getStatus()).toBe('connecting');
    expect(latest().url).toBe('ws://test.invalid/ws');

    net.open(latest());
    expect(a.connection.getStatus()).toBe('online');
  });

  it('opens with a hello naming the replica, the board and what it holds', () => {
    const { net, client, latest } = setup();
    const a = client(1);
    a.connection.start();
    net.open(latest());
    const hello = parseMessage(must(latest().sent[0]));
    expect(hello.ok ? hello.message : undefined).toMatchObject({
      type: 'hello',
      replicaId: a.board.replicaId,
      boardId: net.boardId,
      versionVector: [],
    });
  });

  it('is not online, and sends nothing, until the server has answered the hello', () => {
    const { net, client, latest } = setup();
    const a = client(1);
    const b = client(2);
    a.connection.start();
    net.hold();
    net.open(latest());
    expect(a.connection.getStatus()).toBe('connecting');

    const id = must(a.store.createNote(1, 1));
    expect(opKeys(latest().sent)).toEqual([]);

    net.release();
    expect(a.connection.getStatus()).toBe('online');
    b.connection.start();
    net.open(latest());
    expect(b.board.getNote(id)).toMatchObject({ x: 1, y: 1 });
  });

  it('makes one connection however often it is started', () => {
    const { net, client } = setup();
    const a = client(1);
    a.connection.start();
    a.connection.start();
    expect(net.sockets).toHaveLength(1);
  });

  it('reports each change of status once', () => {
    const { net, client, latest } = setup();
    const a = client(1);
    const seen: ConnectionStatus[] = [];
    const stop = a.connection.subscribe(() => {
      seen.push(a.connection.getStatus());
    });
    a.connection.start();
    net.open(latest());
    latest().drop();
    expect(seen).toEqual(['connecting', 'online', 'offline']);
    stop();
    a.connection.start();
    expect(seen).toHaveLength(3);
  });

  it('does not report a status it already has', () => {
    const { client } = setup();
    const a = client(1);
    let calls = 0;
    a.connection.subscribe(() => {
      calls += 1;
    });
    a.connection.dispose();
    a.connection.dispose();
    expect(calls).toBe(0);
  });
});

describe('SyncConnection: syncing', () => {
  it('gets local edits to the other clients, each operation crossing each link once', () => {
    const { client, online } = setup();
    const a = client(1);
    const b = client(2);
    const socketA = online(a);
    const socketB = online(b);

    const id = must(a.store.createNote(1, 2));
    a.store.editText(id, { start: 0, deleteCount: 0, insert: 'hi' });
    b.store.moveNote(id, 7, 8);

    expect(b.board.getNote(id)).toMatchObject({ text: 'hi' });
    expect(a.board.getNote(id)).toEqual(b.board.getNote(id));
    expect(a.board.getNote(id)).toMatchObject({ x: 7, y: 8, text: 'hi' });

    const fromA = opKeys(socketA.sent);
    expect(fromA.length).toBeGreaterThan(0);
    expect(hasNoDuplicates(fromA)).toBe(true);
    expect(hasNoDuplicates(opKeys(socketB.received))).toBe(true);
    expect(hasNoDuplicates(opKeys(socketA.received))).toBe(true);
    // Each client got the other's operations and sent none of the ones it was given.
    expect(opKeys(socketB.received).filter((key) => fromA.includes(key))).toHaveLength(
      fromA.length,
    );
    expect(opKeys(socketA.sent).some((key) => opKeys(socketA.received).includes(key))).toBe(false);
  });

  it('brings a client that connects later up to date', () => {
    const { client, online } = setup();
    const a = client(1);
    online(a);
    const id = must(a.store.createNote(1, 2));
    a.store.editText(id, { start: 0, deleteCount: 0, insert: 'hi' });

    const b = client(2);
    online(b);
    expect(b.board.getNote(id)).toMatchObject({ x: 1, y: 2, text: 'hi' });
  });

  it('keeps what was made before connecting and sends it once connected', () => {
    const { net, client, online } = setup();
    const a = client(1);
    const id = must(a.store.createNote(3, 4));
    expect(net.sockets).toHaveLength(0);

    const b = client(2);
    online(b);
    expect(b.board.getNote(id)).toBeUndefined();
    online(a);
    expect(b.board.getNote(id)).toMatchObject({ x: 3, y: 4 });
  });

  it('sends what was made offline after reconnecting, and nothing twice', () => {
    const { net, timers, client, latest, online } = setup();
    const a = client(1);
    const b = client(2);
    const firstA = online(a);
    online(b);
    const id = must(a.store.createNote(0, 0));

    firstA.drop();
    expect(a.connection.getStatus()).toBe('offline');
    a.store.editText(id, { start: 0, deleteCount: 0, insert: 'offline' });
    b.store.moveNote(id, 9, 9);
    expect(a.board.getNote(id)).not.toEqual(b.board.getNote(id));

    timers.fire();
    expect(a.connection.getStatus()).toBe('connecting');
    const secondA = latest();
    net.open(secondA);
    expect(a.connection.getStatus()).toBe('online');

    expect(a.board.getNote(id)).toEqual(b.board.getNote(id));
    expect(a.board.getNote(id)).toMatchObject({ x: 9, y: 9, text: 'offline' });
    const sentByA = opKeys([...firstA.sent, ...secondA.sent]);
    expect(sentByA.length).toBeGreaterThan(0);
    expect(hasNoDuplicates(sentByA)).toBe(true);
    // The new hello says what A holds, so the server does not send A its own operations back.
    expect(opKeys(secondA.received).some((key) => sentByA.includes(key))).toBe(false);
    const hello = parseMessage(must(secondA.sent[0]));
    const vector = hello.ok && hello.message.type === 'hello' ? hello.message.versionVector : [];
    expect(vector.length).toBeGreaterThan(0);
  });
});

describe('SyncConnection: retrying', () => {
  it('waits twice as long after each failure, up to a cap, with jitter at its lowest', () => {
    const { timers, client, latest } = setup(() => 0);
    const a = client(1);
    a.connection.start();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      latest().drop();
      delays.push(...timers.delays);
      timers.fire();
    }
    expect(delays).toEqual([50, 100, 200, 400, 500, 500]);
  });

  it('spreads the delay with jitter', () => {
    const { timers, client, latest } = setup(() => 0.5);
    const a = client(1);
    a.connection.start();
    latest().drop();
    expect(timers.delays).toEqual([75]);
  });

  it('starts again from the shortest delay once a connection worked', () => {
    const { net, timers, client, latest } = setup(() => 0);
    const a = client(1);
    a.connection.start();
    latest().drop();
    timers.fire();
    latest().drop();
    expect(timers.delays).toEqual([100]);
    timers.fire();
    net.open(latest());
    expect(a.connection.getStatus()).toBe('online');
    latest().drop();
    expect(timers.delays).toEqual([50]);
  });

  it('does not connect again while a retry is waiting', () => {
    const { net, timers, client, latest } = setup();
    const a = client(1);
    a.connection.start();
    latest().drop();
    a.connection.start();
    expect(net.sockets).toHaveLength(1);
    timers.fire();
    expect(net.sockets).toHaveLength(2);
  });
});

describe('SyncConnection: dispose', () => {
  it('closes the connection and goes offline', () => {
    const { client, online } = setup();
    const a = client(1);
    const socket = online(a);
    a.connection.dispose();
    expect(socket.closed).toBe(true);
    expect(a.connection.getStatus()).toBe('offline');
  });

  it('closes a connection that is still being made', () => {
    const { client, latest } = setup();
    const a = client(1);
    a.connection.start();
    a.connection.dispose();
    expect(latest().closed).toBe(true);
    expect(a.connection.getStatus()).toBe('offline');
  });

  it('cancels a waiting retry and never connects again', () => {
    const { net, timers, client, latest } = setup();
    const a = client(1);
    a.connection.start();
    latest().drop();
    expect(timers.delays).toHaveLength(1);
    a.connection.dispose();
    expect(timers.delays).toHaveLength(0);
    a.connection.start();
    expect(net.sockets).toHaveLength(1);
  });

  it('ignores whatever the closed connection still delivers', () => {
    const { net, client, online } = setup();
    const a = client(1);
    const socket = online(a);
    a.connection.dispose();
    net.inject(socket, 'this arrives too late to matter');
    expect(a.connection.lastError).toBeNull();
    expect(a.connection.getStatus()).toBe('offline');
  });
});

describe('SyncConnection: a server that misbehaves', () => {
  it('drops a connection that sends something that is not a message, then retries', () => {
    const { net, timers, client, online } = setup();
    const a = client(1);
    const socket = online(a);
    net.inject(socket, 'this is not json');
    expect(socket.closed).toBe(true);
    expect(a.connection.getStatus()).toBe('offline');
    expect(a.connection.lastError).toContain('invalid message');
    expect(timers.delays).toHaveLength(1);
  });

  it('drops a connection that sends something that is not text', () => {
    const { net, client, online } = setup();
    const a = client(1);
    const socket = online(a);
    net.inject(socket, new ArrayBuffer(4));
    expect(socket.closed).toBe(true);
    expect(a.connection.lastError).toContain('not text');
  });

  it('reports the reason when the server turns the client away', () => {
    const { net, client, online } = setup();
    const a = client(1);
    const socket = online(a);
    net.injectMessage(socket, serverError('go away'));
    expect(socket.closed).toBe(true);
    expect(a.connection.getStatus()).toBe('offline');
    expect(a.connection.lastError).toContain('go away');
  });

  it('forgets the error once a connection works again', () => {
    const { net, timers, client, latest, online } = setup();
    const a = client(1);
    const socket = online(a);
    net.inject(socket, 'garbage');
    expect(a.connection.lastError).not.toBeNull();
    timers.fire();
    net.open(latest());
    expect(a.connection.getStatus()).toBe('online');
    expect(a.connection.lastError).toBeNull();
  });

  it('ignores events from a connection it has already replaced', () => {
    const { net, timers, client, latest } = setup();
    const a = client(1);
    a.connection.start();
    const old = latest();
    net.open(old);
    old.drop();
    timers.fire();
    const current = latest();
    net.open(current);
    expect(a.connection.getStatus()).toBe('online');
    const sentBefore = current.sent.length;

    // The old socket wakes up late.
    old.handlers.open();
    old.handlers.message('late');
    old.handlers.close();

    expect(current.sent).toHaveLength(sentBefore);
    expect(current.closed).toBe(false);
    expect(a.connection.getStatus()).toBe('online');
    expect(a.connection.lastError).toBeNull();
    expect(timers.delays).toHaveLength(0);
  });
});
