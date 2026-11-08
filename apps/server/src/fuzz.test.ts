import {
  Board,
  createManualClock,
  replicaId,
  type BoardOp,
  type JsonObject,
  type ReplicaId,
} from '@driftboard/crdt';
import {
  authorOps,
  canonicalizeOp,
  emptyStore,
  encodeFrame,
  encodeMessage,
  flush,
  isSynced,
  openInitiator,
  parseFrame,
  readBoardOps,
  receive,
  stampOps,
  storeMissing,
  storeVector,
  type Frame,
  type OpStore,
  type Session,
  type StampedOp,
} from '@driftboard/protocol';
import { VersionVector } from '@driftboard/crdt';
import type Database from 'better-sqlite3';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { generateBoardId } from './board-id';
import { IN_MEMORY, openDatabase } from './db';
import { startSyncServer, type SyncServer } from './server';
import { must, sleep, until } from './test-support';

/**
 * Fuzzing the running server over real WebSockets: honest clients edit one board while hostile
 * connections send random bytes and text, mutated copies of real frames, operations spoiled in
 * several ways, frames that are too big and floods. The server must stay up and report no
 * unexpected error, the honest clients must stay connected and agree, and a client that joins
 * afterwards must get the same board.
 */

// Loopback ports 22140-22149 are reserved for this file (server.test.ts has 22110-22139).
const PORT = 22140;
const URL = `ws://127.0.0.1:${PORT}/ws`;
/** Small enough that a flood in a test trips them, large enough for the honest clients. */
const RATE_LIMITS = {
  messages: { burst: 300, perSecond: 200 },
  ops: { burst: 5000, perSecond: 2000 },
};

let db: Database.Database;
let server: SyncServer;
const unexpected: unknown[] = [];

beforeAll(async () => {
  db = openDatabase(IN_MEMORY);
  server = await startSyncServer({
    host: '127.0.0.1',
    port: PORT,
    db,
    helloTimeoutMs: 0,
    compactAfterOps: 50,
    compactIntervalMs: 0,
    rateLimits: RATE_LIMITS,
    onError: (error, context) => unexpected.push({ error, context }),
  });
});

afterAll(async () => {
  await server.close();
  db.close();
});

// ---- Clients ------------------------------------------------------------------------------------

type Edit =
  | { kind: 'create'; text: string }
  | { kind: 'type'; pick: number; at: number; text: string }
  | { kind: 'erase'; pick: number; at: number; count: number }
  | { kind: 'move'; pick: number; x: number };

class Honest {
  readonly id: ReplicaId;
  readonly board: Board;
  store: OpStore = emptyStore;
  session: Session | null = null;
  socket: WebSocket | null = null;
  closeCode: number | null = null;
  #notes = 0;

  constructor(
    name: string,
    readonly boardId: string,
    /** Every frame this client sends, for the hostile ones to spoil. */
    readonly seen: Frame[],
  ) {
    this.id = replicaId(name);
    this.board = new Board({ replicaId: this.id, clock: createManualClock(1000) });
  }

  async connect(): Promise<void> {
    const socket = new WebSocket(URL);
    this.socket = socket;
    socket.on('message', (data, isBinary) => {
      const bytes = data as Buffer;
      this.#hear(isBinary ? new Uint8Array(bytes) : bytes.toString('utf8'));
    });
    socket.on('close', (code) => {
      this.closeCode = code;
    });
    socket.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    const open = openInitiator(
      { self: this.id, boardId: this.boardId, token: `secret-${this.id}` },
      this.store,
    );
    this.session = open.session;
    // A hello carries the client's secret, which nobody else sees: the hostile ones are not given it.
    for (const message of open.send) this.socket?.send(encodeFrame(message));
  }

  #send(frame: Frame): void {
    if (this.seen.length < 40) this.seen.push(frame);
    this.socket?.send(frame);
  }

  edit(edit: Edit): void {
    const notes = this.board.notes();
    const note = notes[(edit.kind === 'create' ? 0 : edit.pick) % Math.max(1, notes.length)];
    let ops: BoardOp[];
    switch (edit.kind) {
      case 'create':
        this.#notes += 1;
        ops = this.board.createNote({ x: this.#notes, text: edit.text }).ops;
        break;
      case 'type':
        if (note === undefined) return;
        ops = this.board.editText(note.id, edit.at % ([...note.text].length + 1), 0, edit.text);
        break;
      case 'erase': {
        if (note === undefined) return;
        const length = [...note.text].length;
        const at = edit.at % (length + 1);
        ops = this.board.editText(note.id, at, Math.min(edit.count, length - at), '');
        break;
      }
      case 'move':
        if (note === undefined) return;
        ops = this.board.moveNote(note.id, edit.x, 0);
        break;
    }
    if (ops.length === 0) return;
    this.store = authorOps(this.store, this.id, ops).store;
    if (this.session === null) return;
    const flushed = flush(this.session, this.store);
    this.session = flushed.session;
    for (const message of flushed.send) this.#send(encodeFrame(message));
  }

  #hear(frame: string | Uint8Array): void {
    const parsed = parseFrame(frame);
    if (!parsed.ok) throw new Error(`the server sent an invalid message: ${parsed.error}`);
    if (this.session === null) return;
    const step = receive(this.session, this.store, parsed.message);
    this.session = step.session;
    this.store = step.store;
    if (step.applied.length > 0) this.board.applyUntrusted(readBoardOps(step.applied).ops);
    for (const reply of step.send) this.#send(encodeFrame(reply));
  }

  close(): void {
    this.socket?.close();
  }
}

const vector = (client: Honest) => JSON.stringify(storeVector(client.store).entries());
const snapshot = (client: Honest) => JSON.stringify(client.board.snapshot());

function converged(clients: readonly Honest[]): boolean {
  const first = clients[0];
  return (
    first !== undefined &&
    clients.every(
      (client) =>
        client.closeCode === null &&
        client.session?.phase === 'ready' &&
        isSynced(client.session, client.store) &&
        vector(client) === vector(first),
    )
  );
}

/** A connection that sends what it is told to, and records how the server answered. */
class Hostile {
  closeCode: number | null = null;
  readonly errors: string[] = [];
  #socket: WebSocket;
  #opened: Promise<void>;
  #seq = 1;
  #board: Board;
  readonly id: ReplicaId;

  constructor(name: string) {
    this.id = replicaId(name);
    this.#board = new Board({ replicaId: this.id, clock: createManualClock(1000) });
    this.#socket = new WebSocket(URL, { maxPayload: 8 * 1024 * 1024 });
    this.#socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const parsed = parseFrame((data as Buffer).toString('utf8'));
      if (parsed.ok && parsed.message.type === 'error') this.errors.push(parsed.message.code);
    });
    this.#socket.on('close', (code) => {
      this.closeCode = code;
    });
    this.#socket.on('error', () => undefined);
    this.#opened = new Promise<void>((resolve) => {
      this.#socket.once('open', () => {
        resolve();
      });
      this.#socket.once('error', () => {
        resolve();
      });
    });
  }

  async send(data: string | Uint8Array): Promise<void> {
    await this.#opened;
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.send(data);
  }

  async hello(boardId: string): Promise<void> {
    await this.send(
      encodeMessage({
        type: 'hello',
        version: 3,
        replicaId: this.id,
        boardId,
        versionVector: [],
      }),
    );
  }

  /** Operations this connection's replica really makes, stamped as its next ones. */
  next(text: string): StampedOp[] {
    const ops = this.#board.createNote({ text }).ops;
    const stamped = stampOps(this.id, this.#seq, ops);
    this.#seq += ops.length;
    return stamped;
  }

  close(): void {
    this.#socket.terminate();
  }
}

// ---- What the hostile connections do ------------------------------------------------------------

type Spoil = 'none' | 'origin' | 'seq' | 'replica' | 'counter' | 'huge' | 'replay';

type Attack =
  | { kind: 'garbage'; text: string }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'mutate'; pick: number; at: number; value: number; cut: boolean }
  | { kind: 'ops'; text: string; spoil: Spoil; amount: number }
  | { kind: 'flood'; count: number; hello: boolean }
  | { kind: 'huge' }
  | { kind: 'hang' };

const editArb: fc.Arbitrary<Edit> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('create' as const),
      text: fc.constantFrom('', 'a', 'hello', '😀'),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('type' as const),
      pick: fc.nat(),
      at: fc.nat(),
      text: fc.constantFrom('x', 'yz', '😀'),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('erase' as const),
      pick: fc.nat(),
      at: fc.nat(),
      count: fc.integer({ min: 0, max: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('move' as const),
      pick: fc.nat(),
      x: fc.integer({ min: -9, max: 9 }),
    }),
  },
);

const attackArb: fc.Arbitrary<Attack> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('garbage' as const),
      text: fc.oneof(fc.string({ maxLength: 80 }), fc.fullUnicodeString({ maxLength: 30 })),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('bytes' as const),
      bytes: fc.uint8Array({ maxLength: 200 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('mutate' as const),
      pick: fc.nat(),
      at: fc.nat(),
      value: fc.integer({ min: 0, max: 255 }),
      cut: fc.boolean(),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('ops' as const),
      text: fc.constantFrom('', 'a', 'abc'),
      spoil: fc.constantFrom<Spoil>(
        'none',
        'origin',
        'seq',
        'replica',
        'counter',
        'huge',
        'replay',
      ),
      amount: fc.integer({ min: 1, max: 4 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('flood' as const),
      // More than the burst of the test's rate limits, so one that said hello is always cut off.
      count: fc.integer({ min: 600, max: 1500 }),
      hello: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.constant<Attack>({ kind: 'huge' }) },
  { weight: 1, arbitrary: fc.constant<Attack>({ kind: 'hang' }) },
);

type Action = { who: 'honest'; client: number; edit: Edit } | { who: 'hostile'; attack: Attack };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      who: fc.constant('honest' as const),
      client: fc.integer({ min: 0, max: 1 }),
      edit: editArb,
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({ who: fc.constant('hostile' as const), attack: attackArb }),
  },
);

function spoiled(ops: StampedOp[], spoil: Spoil, amount: number): StampedOp[] {
  const first = ops[0];
  if (first === undefined) return ops;
  const edit = (change: (payload: Record<string, unknown>) => void): StampedOp[] =>
    ops.map((op, index) => {
      if (index !== ops.length - 1) return op;
      const payload = JSON.parse(JSON.stringify(op.op)) as Record<string, unknown>;
      change(payload);
      return { ...op, op: payload as JsonObject };
    });
  const move = (value: unknown, to: (counter: number, replica: string) => string): unknown => {
    if (typeof value !== 'string') return value;
    const at = value.indexOf('@');
    return to(Number(value.slice(0, at)), value.slice(at + 1));
  };
  switch (spoil) {
    case 'origin':
      return ops.map((op) => ({ ...op, origin: replicaId('alice') }));
    case 'seq':
      return ops.map((op) => ({ ...op, seq: op.seq + amount }));
    case 'replica':
      return edit((p) => {
        for (const key of ['id', 'dot']) if (key in p) p[key] = move(p[key], (c) => `${c}@alice`);
      });
    case 'counter':
      return edit((p) => {
        for (const key of ['id', 'dot']) {
          if (key in p) p[key] = move(p[key], (c, r) => `${c + amount}@${r}`);
        }
      });
    case 'huge':
      return edit((p) => {
        for (const key of ['id', 'dot']) {
          if (key in p) p[key] = move(p[key], (_, r) => `${Number.MAX_SAFE_INTEGER}@${r}`);
        }
      });
    case 'replay':
      return [...ops, ...ops];
    default:
      return ops;
  }
}

function mutated(frame: Frame, at: number, value: number, cut: boolean): Frame {
  if (typeof frame === 'string') {
    const where = at % Math.max(1, frame.length);
    return cut
      ? frame.slice(0, where)
      : frame.slice(0, where) + String.fromCharCode(value) + frame.slice(where + 1);
  }
  const where = at % Math.max(1, frame.length);
  if (cut) return frame.slice(0, where);
  const copy = Uint8Array.from(frame);
  copy[where] = value;
  return copy;
}

async function attack(
  action: Attack,
  boardId: string,
  seen: readonly Frame[],
  index: number,
): Promise<Hostile> {
  const hostile = new Hostile(`evil${index}`);
  switch (action.kind) {
    case 'garbage':
      await hostile.send(action.text);
      break;
    case 'bytes':
      await hostile.send(action.bytes);
      break;
    case 'mutate': {
      const frame = seen[action.pick % Math.max(1, seen.length)];
      if (frame !== undefined)
        await hostile.send(mutated(frame, action.at, action.value, action.cut));
      break;
    }
    case 'ops': {
      await hostile.hello(boardId);
      const ops = spoiled(hostile.next(action.text), action.spoil, action.amount);
      let frame: Frame;
      try {
        frame = encodeFrame({ type: 'ops', ops });
      } catch {
        frame = encodeMessage({ type: 'ops', ops });
      }
      await hostile.send(frame);
      break;
    }
    case 'flood': {
      if (action.hello) await hostile.hello(boardId);
      const ack = encodeMessage({ type: 'ack', versionVector: [] });
      for (let sent = 0; sent < action.count; sent += 1) await hostile.send(ack);
      break;
    }
    case 'huge':
      await hostile.send(new Uint8Array(2 * 1024 * 1024));
      break;
    case 'hang':
      await hostile.hello(boardId);
      break;
  }
  return hostile;
}

/** Rejects with `what()` if `work` has not finished after `ms`. */
function deadline<T>(work: Promise<T>, ms: number, what: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(what()));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

describe('hostile connections to a running server', () => {
  it('stays up and silent about errors, keeps honest clients connected and agreeing', async () => {
    let runs = 0;
    let floods = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { maxLength: 25, size: 'max' }), async (actions) => {
        // A run that never ends would hide the actions that caused it: fail it with them instead.
        const progress = { step: 'start' };
        await deadline(
          (async () => {
            const boardId = generateBoardId();
            const seen: Frame[] = [];
            const honest = [new Honest('alice', boardId, seen), new Honest('bob', boardId, seen)];
            progress.step = 'connecting the honest clients';
            for (const client of honest) await client.connect();
            await until(() => converged(honest), 5000);

            const hostiles: Hostile[] = [];
            for (const [index, action] of actions.entries()) {
              progress.step = `action ${index}: ${JSON.stringify(action).slice(0, 120)}`;
              if (action.who === 'honest') must(honest[action.client]).edit(action.edit);
              else hostiles.push(await attack(action.attack, boardId, seen, index + 1));
              if (index % 4 === 3) await sleep(1);
            }

            // Honest clients end up connected, with everything, and agreeing.
            progress.step = 'waiting for the honest clients to agree';
            await until(() => converged(honest), 10_000);
            const [first, second] = [must(honest[0]), must(honest[1])];
            expect(first.closeCode).toBeNull();
            expect(second.closeCode).toBeNull();
            expect(snapshot(first)).toBe(snapshot(second));
            expect(first.board.quarantinedCount).toBe(0);

            // A client that joins now gets the same board.
            progress.step = 'a late client';
            const late = new Honest('carol', boardId, []);
            await late.connect();
            await until(() => converged([first, second, late]), 10_000);
            expect(snapshot(late)).toBe(snapshot(first));

            // The server is alive, says so, and did not hit anything it did not expect.
            progress.step = 'asking /healthz';
            const health = await fetch(`http://127.0.0.1:${PORT}/healthz`);
            expect(health.status).toBe(200);
            expect(unexpected).toEqual([]);

            // What it stored is what the rules allow.
            const stored = db
              .prepare('SELECT payload FROM ops WHERE board_id = ?')
              .all(boardId) as { payload: string }[];
            for (const { payload } of stored) {
              const op = JSON.parse(payload) as JsonObject;
              expect(canonicalizeOp(op)).toEqual(op);
            }

            floods += hostiles.filter((h) => h.errors.includes('rate_limited')).length;
            for (const hostile of hostiles) hostile.close();
            for (const client of [...honest, late]) client.close();
            runs += 1;
          })(),
          30_000,
          () => `stuck at: ${progress.step}`,
        );
      }),
      { numRuns: 40 },
    );
    expect(runs).toBe(40);
    // Floods that said hello are cut off by the rate limit; the ones that did not, at once.
    expect(floods).toBeGreaterThan(0);
  }, 300_000);

  it('cuts off a flood and a frame that is too big, and serves the next client as usual', async () => {
    const boardId = generateBoardId();
    const flooder = await attack({ kind: 'flood', count: 2000, hello: true }, boardId, [], 90);
    const giant = await attack({ kind: 'huge' }, boardId, [], 91);
    await until(() => flooder.closeCode !== null && giant.closeCode !== null, 10_000);
    expect(flooder.closeCode).toBe(1008);
    expect(flooder.errors).toContain('rate_limited');
    expect(giant.closeCode).toBe(1009);

    const client = new Honest('dave', boardId, []);
    await client.connect();
    client.edit({ kind: 'create', text: 'still here' });
    await until(() => converged([client]), 5000);
    expect(unexpected).toEqual([]);
    client.close();
  });

  it('keeps what honest clients stored when the hostile ones are the only ones left', async () => {
    const boardId = generateBoardId();
    const writer = new Honest('erin', boardId, []);
    await writer.connect();
    writer.edit({ kind: 'create', text: 'kept' });
    await until(() => converged([writer]), 5000);
    writer.close();
    const hostile = await attack(
      { kind: 'ops', text: 'x', spoil: 'origin', amount: 1 },
      boardId,
      [],
      95,
    );
    await until(() => hostile.closeCode !== null, 5000);
    const reader = new Honest('frank', boardId, []);
    await reader.connect();
    await until(() => converged([reader]), 5000);
    expect(reader.board.notes().map((note) => note.text)).toEqual(['kept']);
    const stored = storeMissing(reader.store, VersionVector.empty);
    expect(stored.length).toBeGreaterThan(0);
    reader.close();
  });
});
