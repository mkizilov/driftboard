import { mkdtempSync, rmSync } from 'node:fs';
import { connect as tcpConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Board,
  createManualClock,
  replicaId,
  type BoardOp,
  type ReplicaId,
} from '@driftboard/crdt';
import {
  PROTOCOL_VERSION,
  authorOps,
  emptyStore,
  encodeMessage,
  flush,
  isSynced,
  openInitiator,
  parseMessage,
  receive,
  storeSize,
  storeVector,
  toBoardOps,
  type Message,
  type OpStore,
  type Session,
} from '@driftboard/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { generateBoardId } from './board-id';
import { IN_MEMORY, openDatabase } from './db';
import { startSyncServer, type SyncServer, type SyncServerOptions } from './server';
import { must, sleep, stamped, until } from './test-support';

// Loopback ports 22110-22139 are reserved for these tests; servers are closed after each test.
let portCounter = 0;
const nextPort = () => 22110 + (portCounter++ % 30);

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Running {
  server: SyncServer;
  db: Database.Database;
  port: number;
  url: string;
  errors: unknown[];
}

async function startServer(
  db: Database.Database,
  options: Partial<SyncServerOptions> = {},
  port = nextPort(),
): Promise<Running> {
  const errors: unknown[] = [];
  const server = await startSyncServer({
    host: '127.0.0.1',
    port,
    db,
    helloTimeoutMs: 0,
    compactIntervalMs: 0,
    onError: (error) => errors.push(error),
    ...options,
  });
  const running = { server, db, port, url: `ws://127.0.0.1:${port}/ws`, errors };
  cleanups.push(() => server.close().catch(() => undefined));
  return running;
}

function track(db: Database.Database): Database.Database {
  cleanups.push(() => {
    if (db.open) db.close();
  });
  return db;
}

async function startInMemory(options: Partial<SyncServerOptions> = {}): Promise<Running> {
  return startServer(track(openDatabase(IN_MEMORY)), options);
}

const count = (db: Database.Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** A client as the web app will build it: a board, a store of stamped operations and a session. */
class TestClient {
  readonly id: ReplicaId;
  readonly board: Board;
  readonly boardId: string;
  readonly url: string;
  store: OpStore = emptyStore;
  session: Session | null = null;
  socket: WebSocket | null = null;
  closeCode: number | null = null;
  /** Operations that arrived in `ops` messages, new or not. */
  opsReceived = 0;
  readonly presence: Message[] = [];

  constructor(url: string, name: string, boardId: string) {
    this.url = url;
    this.id = replicaId(name);
    this.boardId = boardId;
    this.board = new Board({ replicaId: this.id, clock: createManualClock(1000) });
  }

  async connect(): Promise<void> {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    this.closeCode = null;
    socket.on('message', (data) => {
      this.#onMessage(socket, data.toString());
    });
    socket.on('close', (code) => {
      if (this.socket !== socket) return;
      this.closeCode = code;
      this.socket = null;
      this.session = null;
    });
    socket.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    const open = openInitiator({ self: this.id, boardId: this.boardId }, this.store);
    this.session = open.session;
    for (const message of open.send) socket.send(encodeMessage(message));
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (socket === null) return;
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.close();
    await closed;
  }

  /** Applies board operations that were just made locally and sends them. */
  author(ops: BoardOp[]): void {
    this.store = authorOps(this.store, this.id, ops).store;
    if (this.session === null || this.socket === null) return;
    const flushed = flush(this.session, this.store);
    this.session = flushed.session;
    for (const message of flushed.send) this.socket.send(encodeMessage(message));
  }

  #onMessage(socket: WebSocket, text: string): void {
    const parsed = parseMessage(text);
    if (!parsed.ok) throw new Error(`the server sent an invalid message: ${parsed.error}`);
    if (this.session === null || this.socket !== socket) return;
    if (parsed.message.type === 'ops') this.opsReceived += parsed.message.ops.length;
    const step = receive(this.session, this.store, parsed.message);
    this.session = step.session;
    this.store = step.store;
    if (step.applied.length > 0) this.board.applyRemote(toBoardOps(step.applied));
    if (step.presence !== null) this.presence.push(step.presence);
    for (const reply of step.send) socket.send(encodeMessage(reply));
  }
}

const snapshot = (board: Board) => JSON.stringify(board.snapshot());
const vectorOf = (client: TestClient) => JSON.stringify(storeVector(client.store).entries());

/** Every client is connected, has nothing left to send, and holds the same operations. */
function converged(clients: readonly TestClient[]): boolean {
  const first = clients[0];
  return (
    first !== undefined &&
    clients.every(
      (client) =>
        client.session?.phase === 'ready' &&
        isSynced(client.session, client.store) &&
        vectorOf(client) === vectorOf(first),
    )
  );
}

/** A bare WebSocket for sending things a well-behaved client never would. */
class RawSocket {
  readonly messages: Message[] = [];
  readonly socket: WebSocket;
  readonly closed: Promise<number>;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    socket.on('message', (data) => {
      const parsed = parseMessage(data.toString());
      if (parsed.ok) this.messages.push(parsed.message);
    });
    socket.on('error', () => undefined);
  }

  static async open(url: string): Promise<RawSocket> {
    const raw = new RawSocket(new WebSocket(url));
    await new Promise<void>((resolve, reject) => {
      raw.socket.once('open', () => {
        resolve();
      });
      raw.socket.once('error', reject);
    });
    return raw;
  }

  send(data: string | Buffer): void {
    this.socket.send(data);
  }
}

describe('/healthz', () => {
  it('answers 200 while the database works, and refuses other methods and paths', async () => {
    const { port } = await startInMemory();
    const base = `http://127.0.0.1:${port}`;
    const ok = await fetch(`${base}/healthz`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('application/json');
    expect(await ok.json()).toEqual({ status: 'ok' });
    expect((await fetch(`${base}/healthz`, { method: 'HEAD' })).status).toBe(200);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/boards`)).status).toBe(404);
  });

  it('answers 503 when the database cannot be reached', async () => {
    const { port, db, errors } = await startInMemory();
    db.close();
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unavailable' });
    expect(errors).toHaveLength(1);
  });

  it('does not upgrade connections on any other path', async () => {
    const { port } = await startInMemory();
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = tcpConnect(port, '127.0.0.1', () => {
        socket.write(
          'GET /elsewhere HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      socket.once('data', (data) => {
        socket.destroy();
        resolve(data.toString());
      });
      socket.once('error', reject);
    });
    expect(reply.startsWith('HTTP/1.1 404')).toBe(true);
  });
});

describe('several real WebSocket clients', () => {
  it('converge on the same board, including a client that edited offline', async () => {
    const { url, server } = await startInMemory();
    const boardId = generateBoardId();
    const [a, b, c] = ['a', 'b', 'c'].map((name) => new TestClient(url, name, boardId)) as [
      TestClient,
      TestClient,
      TestClient,
    ];
    await Promise.all([a.connect(), b.connect()]);

    const { id: first, ops } = a.board.createNote({ x: 10, y: 20, text: 'hello' });
    a.author(ops);
    await until(() => converged([a, b]));
    expect(must(b.board.getNote(first)).text).toBe('hello');

    // Concurrent edits from both connected clients, and a third that edits offline and joins late.
    a.author(a.board.moveNote(first, 50, 60));
    b.author(b.board.editText(first, 5, 0, ' world'));
    const second = b.board.createNote({ text: 'two' });
    b.author(second.ops);
    const offline = c.board.createNote({ x: 1, y: 1, text: 'offline' });
    c.author(offline.ops);
    await until(() => converged([a, b]));
    await c.connect();
    await until(() => converged([a, b, c]));
    a.author(a.board.editText(first, 0, 5, 'HELLO'));
    c.author(c.board.setColor(offline.id, 'pink'));
    await until(() => converged([a, b, c]));

    const clients = [a, b, c];
    for (const client of clients) {
      expect(snapshot(client.board)).toBe(snapshot(a.board));
      expect(client.board.pendingCount).toBe(0);
    }
    expect(a.board.getNote(first)).toMatchObject({ x: 50, y: 60, text: 'HELLO world' });
    expect(a.board.getNote(offline.id)).toMatchObject({ color: 'pink', text: 'offline' });
    expect(a.board.size).toBe(3);

    // Every operation reached every client exactly once: nothing repeated or echoed back.
    for (const client of clients) {
      expect(client.opsReceived).toBe(storeSize(client.store) - authored(client));
    }
    expect(server.hub.connectionCount).toBe(3);
  });

  it('keep boards with different ids apart', async () => {
    const { url } = await startInMemory();
    const one = new TestClient(url, 'a', generateBoardId());
    const two = new TestClient(url, 'b', generateBoardId());
    const alsoOne = new TestClient(url, 'c', one.boardId);
    await Promise.all([one.connect(), two.connect(), alsoOne.connect()]);
    one.author(one.board.createNote({ text: 'private' }).ops);
    two.author(two.board.createNote({ text: 'elsewhere' }).ops);
    await until(() => converged([one, alsoOne]) && converged([two]));
    await sleep(50);
    expect(alsoOne.board.notes().map((note) => note.text)).toEqual(['private']);
    expect(two.board.notes().map((note) => note.text)).toEqual(['elsewhere']);
    expect(two.opsReceived).toBe(0);
  });

  it('relay presence and tell the others when a client leaves', async () => {
    const { url } = await startInMemory();
    const boardId = generateBoardId();
    const [a, b] = [new TestClient(url, 'a', boardId), new TestClient(url, 'b', boardId)];
    await Promise.all([a.connect(), b.connect()]);
    await until(() => converged([a, b]));
    const state = { cursor: { x: 5, y: 6 }, selection: [] };
    must(a.socket).send(encodeMessage({ type: 'presence', replicaId: a.id, state }));
    await until(() => b.presence.length === 1);
    expect(b.presence[0]).toEqual({ type: 'presence', replicaId: a.id, state });
    await a.disconnect();
    await until(() => b.presence.length === 2);
    expect(b.presence[1]).toEqual({ type: 'presence', replicaId: a.id, state: null });
  });

  it('close the older connection when the same replica connects again', async () => {
    const { url } = await startInMemory();
    const boardId = generateBoardId();
    const old = new TestClient(url, 'a', boardId);
    await old.connect();
    await until(() => converged([old]));
    const fresh = new TestClient(url, 'a', boardId);
    await fresh.connect();
    await until(() => old.closeCode !== null);
    expect(old.closeCode).toBe(4001);
    await until(() => converged([fresh]));
  });
});

/** Operations a client authored itself: they never come back from the server. */
function authored(client: TestClient): number {
  return storeVector(client.store).get(client.id);
}

describe('persistence', () => {
  function tempDatabase(): string {
    const dir = mkdtempSync(join(tmpdir(), 'driftboard-server-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    return join(dir, 'boards.sqlite');
  }

  it('keeps every board across a server restart', async () => {
    const file = tempDatabase();
    const boardId = generateBoardId();
    const port = nextPort();

    let db = track(openDatabase(file));
    let running = await startServer(db, {}, port);
    const a = new TestClient(running.url, 'a', boardId);
    const b = new TestClient(running.url, 'b', boardId);
    await Promise.all([a.connect(), b.connect()]);
    const { id, ops } = a.board.createNote({ x: 3, y: 4, color: 'blue', text: 'saved' });
    a.author(ops);
    await until(() => converged([a, b]));
    b.author(b.board.editText(id, 5, 0, ' for later'));
    b.author(b.board.createNote({ text: 'second' }).ops);
    await until(() => converged([a, b]));
    const expected = snapshot(a.board);
    const expectedVector = vectorOf(a);
    const total = storeSize(a.store);
    const receivedBefore = a.opsReceived;

    await a.disconnect();
    await b.disconnect();
    await running.server.close();
    db.close();

    db = track(openDatabase(file));
    running = await startServer(db, {}, port);
    const reader = new TestClient(running.url, 'reader', boardId);
    await reader.connect();
    await until(() => converged([reader]) && storeSize(reader.store) === total);
    expect(vectorOf(reader)).toBe(expectedVector);
    expect(snapshot(reader.board)).toBe(expected);
    expect(must(reader.board.getNote(id)).text).toBe('saved for later');

    // A returning client that kept its own copy is sent nothing it already has.
    await a.connect();
    await until(() => converged([a, reader]));
    expect(a.opsReceived).toBe(receivedBefore);

    // And the restarted server keeps accepting and keeping new work.
    reader.author(reader.board.moveNote(id, 9, 9));
    await until(() => converged([a, reader]));
    expect(a.board.getNote(id)).toMatchObject({ x: 9, y: 9 });
    expect(count(db, 'ops') + count(db, 'snapshots')).toBeGreaterThan(0);
  });

  it('folds the log into a snapshot plus a tail, and loads it after a restart', async () => {
    const file = tempDatabase();
    const boardId = generateBoardId();
    const port = nextPort();

    let db = track(openDatabase(file));
    let running = await startServer(db, { compactAfterOps: 10 }, port);
    const a = new TestClient(running.url, 'a', boardId);
    await a.connect();
    await until(() => converged([a]));
    for (let index = 0; index < 8; index += 1) {
      a.author(a.board.createNote({ x: index, text: `note ${index}` }).ops);
    }
    await until(() => converged([a]));
    const total = storeSize(a.store);
    const expected = snapshot(a.board);
    expect(total).toBeGreaterThan(50);

    const tail = count(db, 'ops');
    expect(count(db, 'snapshots')).toBe(1);
    expect(tail).toBeLessThan(10);
    expect(running.server.storage.tailSize(boardId)).toBe(tail);
    await a.disconnect();
    await running.server.close();
    db.close();

    db = track(openDatabase(file));
    running = await startServer(db, {}, port);
    const reader = new TestClient(running.url, 'reader', boardId);
    await reader.connect();
    await until(() => converged([reader]) && storeSize(reader.store) === total);
    expect(snapshot(reader.board)).toBe(expected);
  });

  it('compacts boards with a tail on a timer', async () => {
    const { url, db } = await startInMemory({ compactAfterOps: 0, compactIntervalMs: 20 });
    const a = new TestClient(url, 'a', generateBoardId());
    await a.connect();
    a.author(a.board.createNote({ text: 'abc' }).ops);
    await until(() => converged([a]) && count(db, 'snapshots') === 1);
    expect(count(db, 'ops')).toBe(0);
  });
});

describe('malformed input', () => {
  const garbage: [string, string][] = [
    ['text that is not JSON', 'definitely not json'],
    ['JSON that is not a message', '{"hello":"world"}'],
    ['a message of unknown type', '{"type":"login","user":"x"}'],
    ['a message with extra fields', `{"type":"ack","versionVector":[],"extra":1}`],
    [
      'a hello with a bad replica id',
      '{"type":"hello","version":1,"replicaId":"a b","boardId":"x","versionVector":[]}',
    ],
  ];

  for (const [name, text] of garbage) {
    it(`rejects ${name} with an error and closes the connection`, async () => {
      const { url, db, server } = await startInMemory();
      const raw = await RawSocket.open(url);
      raw.send(text);
      expect(await raw.closed).toBe(1008);
      expect(raw.messages).toHaveLength(1);
      expect(raw.messages[0]).toMatchObject({ type: 'error', code: 'invalid_message' });
      expect(count(db, 'ops')).toBe(0);
      await until(() => server.hub.connectionCount === 0);
    });
  }

  it('rejects binary frames', async () => {
    const { url } = await startInMemory();
    const raw = await RawSocket.open(url);
    raw.send(Buffer.from([1, 2, 3]));
    expect(await raw.closed).toBe(1003);
  });

  it('caps the message size before the server reads the message', async () => {
    const { url, db } = await startInMemory({ maxMessageBytes: 2048 });
    const raw = await RawSocket.open(url);
    raw.send(encodeMessage({ type: 'ops', ops: stamped(replicaId('a'), 1, 20) }));
    expect(await raw.closed).toBe(1009);
    // The WebSocket layer refuses the frame, so the hub never saw it and sent no error message.
    expect(raw.messages).toEqual([]);
    expect(count(db, 'ops')).toBe(0);
  });

  it('requires hello first, with a board id that cannot be guessed', async () => {
    const { url } = await startInMemory();
    const early = await RawSocket.open(url);
    early.send(encodeMessage({ type: 'ack', versionVector: [] }));
    expect(await early.closed).toBe(1008);
    expect(early.messages[0]).toMatchObject({ type: 'error', code: 'unexpected_message' });

    const guessable = await RawSocket.open(url);
    guessable.send(
      encodeMessage({
        type: 'hello',
        version: PROTOCOL_VERSION,
        replicaId: replicaId('a'),
        boardId: 'my-board',
        versionVector: [],
      }),
    );
    expect(await guessable.closed).toBe(1008);
    expect(guessable.messages[0]).toMatchObject({ type: 'error', code: 'invalid_message' });
  });

  it('rejects invalid operations after a good hello, and stores nothing', async () => {
    const { url, db } = await startInMemory();
    const raw = await RawSocket.open(url);
    raw.send(
      encodeMessage({
        type: 'hello',
        version: PROTOCOL_VERSION,
        replicaId: replicaId('a'),
        boardId: generateBoardId(),
        versionVector: [],
      }),
    );
    await until(() => raw.messages.length > 0);
    expect(raw.messages[0]).toMatchObject({ type: 'hello' });
    const good = must(stamped(replicaId('a'), 1, 1)[0]);
    raw.send(
      JSON.stringify({
        type: 'ops',
        ops: [good, { origin: 'a', seq: 2, op: { type: 'note-put', noteId: 'n' } }],
      }),
    );
    expect(await raw.closed).toBe(1008);
    expect(raw.messages.at(-1)).toMatchObject({ type: 'error', code: 'invalid_message' });
    expect(count(db, 'ops')).toBe(0);
  });

  it('closes a connection that never says hello', async () => {
    const { url, server } = await startInMemory({ helloTimeoutMs: 40 });
    const raw = await RawSocket.open(url);
    expect(await raw.closed).toBe(1008);
    expect(raw.messages[0]).toMatchObject({ type: 'error', code: 'unexpected_message' });
    await until(() => server.hub.connectionCount === 0);
  });

  it('is not disturbed by a bad client: other clients keep syncing', async () => {
    const { url, port } = await startInMemory();
    const boardId = generateBoardId();
    const [a, b] = [new TestClient(url, 'a', boardId), new TestClient(url, 'b', boardId)];
    await Promise.all([a.connect(), b.connect()]);
    await until(() => converged([a, b]));

    const bad = await RawSocket.open(url);
    bad.send('}{');
    expect(await bad.closed).toBe(1008);

    a.author(a.board.createNote({ text: 'still works' }).ops);
    await until(() => converged([a, b]));
    expect(b.board.notes().map((note) => note.text)).toEqual(['still works']);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });
});
