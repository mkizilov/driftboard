import {
  Board,
  MAX_NOTE_NODES,
  VersionVector,
  createManualClock,
  replicaId,
  type BoardOp,
  type JsonObject,
  type ReplicaId,
} from '@driftboard/crdt';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeFrame, encodeMessage, parseFrame, type Frame, type Message } from './messages';
import { canonicalizeOp, readBoardOps, type StampedOp } from './ops';
import { createRoom, roomConnect, roomDisconnect, roomReceive, type Room } from './room';
import { emptyStore, storeAdd, storeMissing, storeVector, type OpStore } from './store';
import { authorOps, flush, openInitiator, receive, type Session } from './sync';

/**
 * Fuzzing a room: two honest clients and one hostile one that sends raw garbage, mutated copies of
 * real frames, and real operations spoiled in every way there is a name for. Whatever it does, the
 * room must not throw, the honest clients must stay connected and agree with each other, and what
 * the room ends up holding must obey the rules.
 */

const BOARD = 'board-fuzz-aaaaaaaaaaaaaaaa';
const serverId = replicaId('server');

// ---- What the clients do ------------------------------------------------------------------------

type Edit =
  | { kind: 'create'; text: string }
  | { kind: 'type'; pick: number; at: number; text: string }
  | { kind: 'erase'; pick: number; at: number; count: number }
  | { kind: 'move'; pick: number; x: number; y: number }
  | { kind: 'delete'; pick: number };

const textArb = fc
  .array(fc.constantFrom('a', 'b', 'é', '😀'), { maxLength: 4 })
  .map((chars) => chars.join(''));

const editArb: fc.Arbitrary<Edit> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('create' as const), text: textArb }) },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('type' as const),
      pick: fc.nat(),
      at: fc.nat(),
      text: textArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('erase' as const),
      pick: fc.nat(),
      at: fc.nat(),
      count: fc.integer({ min: 0, max: 3 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('move' as const),
      pick: fc.nat(),
      x: fc.integer({ min: -50, max: 50 }),
      y: fc.integer({ min: -50, max: 50 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), pick: fc.nat() }) },
);

/** The ways a hostile client spoils the operations it sends. */
type TamperKind =
  | 'none'
  | 'origin'
  | 'seq'
  | 'counter'
  | 'replica'
  | 'parent'
  | 'target'
  | 'note'
  | 'value'
  | 'side'
  | 'refs'
  | 'replay'
  | 'huge';

interface TamperPlan {
  readonly kind: TamperKind;
  readonly index: number;
  readonly amount: number;
  readonly pick: number;
}

const tamperArb: fc.Arbitrary<TamperPlan> = fc.record({
  kind: fc.constantFrom<TamperKind>(
    'none',
    'none',
    'origin',
    'seq',
    'counter',
    'replica',
    'parent',
    'target',
    'note',
    'value',
    'side',
    'refs',
    'replay',
    'huge',
  ),
  index: fc.nat(),
  amount: fc.integer({ min: -3, max: 5 }),
  pick: fc.nat(),
});

interface ByteEdit {
  readonly how: 'flip' | 'truncate' | 'repeat' | 'insert';
  readonly at: number;
  readonly value: number;
}

const byteEditArb: fc.Arbitrary<ByteEdit> = fc.record({
  how: fc.constantFrom('flip', 'truncate', 'repeat', 'insert'),
  at: fc.nat(),
  value: fc.integer({ min: 0, max: 255 }),
});

type Raw =
  | { raw: 'text'; text: string }
  | { raw: 'json'; value: unknown }
  | { raw: 'bytes'; bytes: Uint8Array }
  | { raw: 'mutate'; pick: number; edits: ByteEdit[] }
  | { raw: 'hello'; replica: string; version: number; board: string }
  | { raw: 'presence'; replica: string; editing: string | null };

type Action =
  | { who: 'honest'; client: number; edit: Edit }
  | { who: 'hostile'; edit: Edit; tamper: TamperPlan }
  /** `fresh`: on a connection that has not said hello. */
  | ({ who: 'hostile'; fresh: boolean } & Raw);

const rawArb: fc.Arbitrary<Raw> = fc.oneof(
  {
    weight: 1,
    arbitrary: fc.record({
      raw: fc.constant('text' as const),
      text: fc.oneof(fc.string({ maxLength: 60 }), fc.fullUnicodeString({ maxLength: 30 })),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      raw: fc.constant('json' as const),
      value: fc.jsonValue({ maxDepth: 4 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      raw: fc.constant('bytes' as const),
      bytes: fc.uint8Array({ maxLength: 80 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      raw: fc.constant('mutate' as const),
      pick: fc.nat(),
      edits: fc.array(byteEditArb, { minLength: 1, maxLength: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      raw: fc.constant('hello' as const),
      replica: fc.oneof(fc.constantFrom('x', 'server', 'ghost'), fc.string({ maxLength: 8 })),
      version: fc.integer({ min: 0, max: 5 }),
      board: fc.constantFrom(BOARD, 'other-board', ''),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      raw: fc.constant('presence' as const),
      replica: fc.constantFrom('alice', 'bob', 'ghost', 'evil1'),
      editing: fc.oneof(fc.constant(null), fc.string({ maxLength: 10 })),
    }),
  },
);

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      who: fc.constant('honest' as const),
      client: fc.integer({ min: 0, max: 1 }),
      edit: editArb,
    }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      who: fc.constant('hostile' as const),
      edit: editArb,
      tamper: tamperArb,
    }),
  },
  {
    weight: 4,
    arbitrary: fc
      .tuple(fc.boolean(), rawArb)
      .map(([fresh, raw]): Action => ({ who: 'hostile', fresh, ...raw })),
  },
);

// ---- Spoiling operations ------------------------------------------------------------------------

function altered(op: StampedOp, change: (payload: Record<string, unknown>) => void): StampedOp {
  const payload = JSON.parse(JSON.stringify(op.op)) as Record<string, unknown>;
  change(payload);
  return { ...op, op: payload as JsonObject };
}

/** `counter@replica` rewritten, if `value` is an id. */
function reid(value: unknown, change: (counter: number, replica: string) => string): unknown {
  if (typeof value !== 'string') return value;
  const at = value.indexOf('@');
  if (at < 1) return value;
  return change(Number(value.slice(0, at)), value.slice(at + 1));
}

function tampered(ops: StampedOp[], plan: TamperPlan, others: readonly string[]): StampedOp[] {
  if (ops.length === 0 || plan.kind === 'none') return ops;
  const index = plan.index % ops.length;
  const other = others[plan.pick % others.length] ?? 'ghost';
  const only = (change: (p: Record<string, unknown>) => void): StampedOp[] =>
    ops.map((op, i) => (i === index ? altered(op, change) : op));
  const ids = (change: (value: unknown) => unknown) => (p: Record<string, unknown>) => {
    for (const key of ['id', 'dot']) if (key in p) p[key] = change(p[key]);
  };
  switch (plan.kind) {
    case 'origin':
      return ops.map((op) => ({ ...op, origin: other as ReplicaId }));
    case 'seq':
      return ops.map((op, i) =>
        i === index ? { ...op, seq: Math.max(1, op.seq + plan.amount) } : op,
      );
    case 'counter':
      return only(ids((v) => reid(v, (c, r) => `${Math.max(1, c + plan.amount)}@${r}`)));
    case 'replica':
      return only(ids((v) => reid(v, (c) => `${c}@${other}`)));
    case 'parent':
      return only((p) => {
        p['parent'] = `${Math.max(1, plan.amount + 3)}@${other}`;
      });
    case 'target':
      return only((p) => {
        p['target'] = `${Math.max(1, plan.amount + 3)}@${other}`;
      });
    case 'note':
      return only((p) => {
        p['noteId'] = ['', 'x'.repeat(201), 'ghost', '1@ghost'][plan.pick % 4];
      });
    case 'value':
      return only((p) => {
        p['value'] = ['', 'ab', '\ud800', '😀', 'x'.repeat(10)][plan.pick % 5];
      });
    case 'side':
      return only((p) => {
        p['side'] = ['up', 'left', 'right', 7][plan.pick % 4];
      });
    case 'refs':
      return only((p) => {
        const length = (plan.pick % 3) * 600 + plan.amount + 3;
        const refs = Array.from({ length }, (_, n) => `${n + 1}@${other}`);
        if ('supersedes' in p) p['supersedes'] = refs;
        else if ('dots' in p) p['dots'] = refs;
        else p['parent'] = refs[0] ?? null;
      });
    case 'replay':
      return [...ops, ...ops];
    case 'huge':
      return only(ids((v) => reid(v, (_, r) => `${Number.MAX_SAFE_INTEGER}@${r}`)));
    default:
      return ops;
  }
}

function mutated(frame: Frame, edits: readonly ByteEdit[]): Frame {
  if (typeof frame === 'string') {
    let text = frame;
    for (const { how, at, value } of edits) {
      const where = text.length === 0 ? 0 : at % text.length;
      const char = String.fromCharCode(value);
      if (how === 'flip') text = text.slice(0, where) + char + text.slice(where + 1);
      else if (how === 'truncate') text = text.slice(0, where);
      else if (how === 'repeat')
        text = text.slice(0, where) + text.slice(where, where + 8).repeat(3);
      else text = text.slice(0, where) + char + text.slice(where);
    }
    return text;
  }
  let bytes = Array.from(frame);
  for (const { how, at, value } of edits) {
    const where = bytes.length === 0 ? 0 : at % bytes.length;
    if (how === 'flip') bytes[where] = (bytes[where] ?? 0) ^ (value || 1);
    else if (how === 'truncate') bytes = bytes.slice(0, where);
    else if (how === 'repeat') bytes.splice(where, 0, ...bytes.slice(where, where + 8));
    else bytes.splice(where, 0, value);
  }
  return Uint8Array.from(bytes);
}

// ---- The world: a room, honest clients and a hostile one -----------------------------------------

class Client {
  readonly board: Board;
  readonly id: ReplicaId;
  readonly conn: string;
  session: Session | null = null;
  store: OpStore = emptyStore;
  closed = false;
  #notes = 0;

  constructor(
    readonly rig: Rig,
    id: string,
    /** Set for the hostile client: how the operations it sends are spoiled. */
    public plan: TamperPlan | undefined = undefined,
  ) {
    this.id = replicaId(id);
    this.conn = `${id}#${rig.serial()}`;
    this.board = new Board({ replicaId: this.id, clock: createManualClock(1000) });
  }

  hello(): void {
    const open = openInitiator(
      { self: this.id, boardId: BOARD, token: `secret-${this.id}` },
      this.store,
    );
    this.session = open.session;
    for (const message of open.send) this.rig.toServer(this, message);
  }

  edit(edit: Edit): void {
    if (this.closed) return;
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
        ops = this.board.moveNote(note.id, edit.x, edit.y);
        break;
      case 'delete':
        if (note === undefined) return;
        ops = this.board.deleteNote(note.id);
        break;
    }
    if (ops.length === 0) return;
    this.store = authorOps(this.store, this.id, ops).store;
    if (this.session === null || this.session.phase !== 'ready') return;
    const flushed = flush(this.session, this.store);
    this.session = flushed.session;
    for (const message of flushed.send) this.rig.toServer(this, message);
  }

  /** What the server sent. */
  hear(message: Message): void {
    if (this.closed || this.session === null) return;
    const step = receive(this.session, this.store, message);
    this.session = step.session;
    this.store = step.store;
    if (step.applied.length > 0) this.board.applyUntrusted(readBoardOps(step.applied).ops);
    for (const reply of step.send) this.rig.toServer(this, reply);
    if (step.session.phase === 'closed' || step.peerError !== null) this.closed = true;
  }
}

class Rig {
  room: Room = createRoom({ serverId, boardId: BOARD });
  readonly clients = new Map<string, Client>();
  /** Valid frames that went by, for the hostile client to spoil. */
  readonly seen: Frame[] = [];
  /** Batches of operations from the hostile client that the room took, and that it refused. */
  accepted = 0;
  refused = 0;
  #queue: (() => void)[] = [];
  #serial = 0;
  #lives = 0;

  serial(): number {
    this.#serial += 1;
    return this.#serial;
  }

  join(client: Client): void {
    this.clients.set(client.conn, client);
    this.room = roomConnect(this.room, client.conn);
    client.hello();
    this.run();
  }

  /** A new replica for the hostile client, as after it was thrown out. */
  hostileLife(): Client {
    this.#lives += 1;
    const client = new Client(this, `evil${this.#lives}`, {
      kind: 'none',
      index: 0,
      amount: 0,
      pick: 0,
    });
    this.join(client);
    return client;
  }

  /** A connection that has not said hello. */
  fresh(): string {
    const conn = `raw#${this.serial()}`;
    this.room = roomConnect(this.room, conn);
    return conn;
  }

  toServer(from: Client, message: Message): void {
    let frame: Frame;
    if (from.plan !== undefined && message.type === 'ops') {
      const others = ['alice', 'bob', 'ghost', 'evil1', from.id];
      const ops = tampered(message.ops as StampedOp[], from.plan, others);
      try {
        frame = encodeFrame({ type: 'ops', ops });
      } catch {
        frame = encodeMessage({ type: 'ops', ops });
      }
    } else {
      frame = encodeFrame(message);
      // A hello carries the client's secret, which nobody else sees: the hostile one is not given it.
      if (message.type !== 'hello' && this.seen.length < 40) this.seen.push(frame);
    }
    this.raw(from.conn, frame);
  }

  /** Sends a frame to the room as the hub would: parse it first, and drop what does not parse. */
  raw(conn: string, frame: Frame): void {
    this.#queue.push(() => {
      const parsed = parseFrame(frame);
      if (!parsed.ok) {
        this.#drop(conn);
        return;
      }
      const step = roomReceive(this.room, conn, parsed.message);
      this.room = step.room;
      if (this.clients.get(conn)?.plan !== undefined && parsed.message.type === 'ops') {
        if (step.applied.length > 0) this.accepted += 1;
        else this.refused += 1;
      }
      for (const { conn: to, message } of step.send) {
        const target = this.clients.get(to);
        if (target !== undefined) this.#queue.push(() => target.hear(message));
      }
      for (const closed of step.close) {
        const client = this.clients.get(closed);
        if (client !== undefined) client.closed = true;
      }
    });
  }

  #drop(conn: string): void {
    const step = roomDisconnect(this.room, conn);
    this.room = step.room;
    const client = this.clients.get(conn);
    if (client !== undefined) client.closed = true;
    for (const { conn: to, message } of step.send) {
      const target = this.clients.get(to);
      if (target !== undefined) this.#queue.push(() => target.hear(message));
    }
  }

  run(): void {
    for (let guard = 0; this.#queue.length > 0; guard += 1) {
      if (guard > 200_000) throw new Error('the messages never stop');
      this.#queue.shift()?.();
    }
  }
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/** The frame a raw action sends. */
function frameOf(action: Raw, seen: readonly Frame[]): Frame | undefined {
  switch (action.raw) {
    case 'text':
      return action.text;
    case 'json':
      return JSON.stringify(action.value) ?? 'null';
    case 'bytes':
      return action.bytes;
    case 'mutate': {
      const frame = seen[action.pick % Math.max(1, seen.length)];
      return frame === undefined ? undefined : mutated(frame, action.edits);
    }
    case 'hello':
      return JSON.stringify({
        type: 'hello',
        version: action.version,
        replicaId: action.replica,
        boardId: action.board,
        versionVector: [],
      });
    case 'presence':
      return JSON.stringify({
        type: 'presence',
        replicaId: action.replica,
        state: { cursor: null, editing: action.editing, name: 'x', color: '#000000' },
      });
  }
}

const vector = (store: OpStore) => storeVector(store).entries();

describe('hostile input to a room', () => {
  it('never throws, never closes an honest client, and honest clients converge', () => {
    let runs = 0;
    let accepted = 0;
    let refused = 0;
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 60, size: 'max' }), (actions) => {
        const rig = new Rig();
        const honest = ['alice', 'bob'].map((name) => new Client(rig, name));
        for (const client of honest) rig.join(client);
        let hostile: Client | undefined;
        const attacker = (): Client => {
          if (hostile === undefined || hostile.closed) hostile = rig.hostileLife();
          return hostile;
        };

        for (const action of actions) {
          if (action.who === 'honest') {
            must(honest[action.client]).edit(action.edit);
          } else if ('edit' in action) {
            const client = attacker();
            client.plan = action.tamper;
            client.edit(action.edit);
          } else {
            const frame = frameOf(action, rig.seen);
            if (frame !== undefined) rig.raw(action.fresh ? rig.fresh() : attacker().conn, frame);
          }
          rig.run();
        }
        rig.run();

        // Nothing an honest client did, or was sent, closed it.
        for (const client of honest) {
          expect(client.closed).toBe(false);
          expect(client.session?.phase).toBe('ready');
        }
        // Everything the room holds reached every honest client...
        for (const client of honest) expect(vector(client.store)).toEqual(vector(rig.room.store));
        // ...and they agree on the board, with nothing set aside.
        const [first, second] = [must(honest[0]), must(honest[1])];
        expect(JSON.stringify(first.board.snapshot())).toBe(
          JSON.stringify(second.board.snapshot()),
        );
        expect(first.board.quarantinedCount).toBe(0);
        expect(second.board.quarantinedCount).toBe(0);

        // The room only holds what the rules allow.
        const all = storeMissing(rig.room.store, VersionVector.empty);
        expect(storeAdd(emptyStore, all).ok).toBe(true);
        for (const op of all) expect(canonicalizeOp(op.op)).toEqual(op.op);
        for (const count of rig.room.notes.values())
          expect(count).toBeLessThanOrEqual(MAX_NOTE_NODES);

        runs += 1;
        accepted += rig.accepted;
        refused += rig.refused;
      }),
      { numRuns: 500 },
    );
    expect(runs).toBe(500);
    // The hostile client got operations through and was refused: both paths were exercised.
    expect(accepted).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(50);
  });
});
