import {
  Board,
  createManualClock,
  replicaId,
  type BoardOp,
  type JsonObject,
  type ReplicaId,
} from '@driftboard/crdt';
import { describe, expect, it } from 'vitest';
import { MAX_VECTOR_ENTRIES, PROTOCOL_VERSION } from './constants';
import { ledgerAdd, ledgerOf } from './ledger';
import type { Hello, Message } from './messages';
import { stampOps, type StampedOp } from './ops';
import { createRoom, roomConnect, roomReceive, type Room } from './room';
import { emptyStore, storeAdd, storeVector, type OpStore } from './store';
import { openInitiator, openResponder, receive } from './sync';
import { stamped, storeOf } from './test-support';

const alice = replicaId('alice');
const mallory = replicaId('mallory');
const serverId = replicaId('server');
const BOARD = 'board-1';

/** A replica's board with the stream of operations it has made, as a real client keeps them. */
class Writer {
  readonly id: ReplicaId;
  readonly board: Board;
  #seq = 1;

  constructor(name: string) {
    this.id = replicaId(name);
    this.board = new Board({ replicaId: this.id, clock: createManualClock(1000) });
  }

  stamp(ops: BoardOp[]): StampedOp[] {
    const out = stampOps(this.id, this.#seq, ops);
    this.#seq += ops.length;
    return out;
  }

  note(text = ''): { id: string; ops: StampedOp[]; raw: BoardOp[] } {
    const { id, ops: raw } = this.board.createNote({ text });
    return { id, ops: this.stamp(raw), raw };
  }

  type(noteId: string, index: number, text: string): StampedOp[] {
    return this.stamp(this.board.editText(noteId, index, 0, text));
  }

  erase(noteId: string, index: number, count: number): StampedOp[] {
    return this.stamp(this.board.editText(noteId, index, count, ''));
  }

  move(noteId: string): StampedOp[] {
    return this.stamp(this.board.moveNote(noteId, 5, 5));
  }
}

/** A copy of `op` after `change` has altered its payload. */
function altered(op: StampedOp, change: (payload: Record<string, unknown>) => void): StampedOp {
  const payload = JSON.parse(JSON.stringify(op.op)) as Record<string, unknown>;
  change(payload);
  return { ...op, op: payload as JsonObject };
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

function refused(result: ReturnType<typeof storeAdd>, detail?: RegExp): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe('invalid');
  if (detail !== undefined) expect(result.detail).toMatch(detail);
}

function accepted(result: ReturnType<typeof storeAdd>): OpStore {
  if (!result.ok) throw new Error(result.detail);
  return result.store;
}

/** A writer with one note of one character, and the store that holds exactly those operations. */
function started() {
  const w = new Writer('mallory');
  const { id, ops } = w.note('a');
  return { w, id, base: accepted(storeAdd(emptyStore, ops)) };
}

describe('the ids of an origin in the store', () => {
  it('accepts an honest stream, in one batch or in several, and carries the counters on', () => {
    const w = new Writer('alice');
    const { id, ops } = w.note('ab');
    const typed = w.type(id, 1, 'cd');
    const erased = w.erase(id, 0, 2);
    const whole = accepted(storeAdd(emptyStore, [...ops, ...typed, ...erased]));
    let split = emptyStore;
    for (const batch of [ops, typed, erased]) split = accepted(storeAdd(split, batch));
    expect(storeVector(split).entries()).toEqual(storeVector(whole).entries());
    expect(split.logs.get(w.id)?.counters).toEqual(whole.logs.get(w.id)?.counters);
    expect(whole.logs.get(w.id)?.counters.puts).toBe(3);
    expect(whole.logs.get(w.id)?.counters.inserts.get(id)).toBe(4);
  });

  it('refuses an id that belongs to another replica', () => {
    const w = new Writer('mallory');
    const { ops } = w.note('a');
    const [put, insert] = [must(ops[0]), must(ops[1])];
    refused(
      storeAdd(emptyStore, [altered(put, (p) => (p['dot'] = '1@alice'))]),
      /dot belongs to alice/,
    );
    refused(
      storeAdd(emptyStore, [put, altered(insert, (p) => (p['id'] = '1@alice'))]),
      /id belongs to alice/,
    );
  });

  it('refuses a counter that skips, repeats or goes back', () => {
    const w = new Writer('mallory');
    const { ops } = w.note('ab');
    const [put, one, two] = [must(ops[0]), must(ops[1]), must(ops[2])];
    refused(storeAdd(emptyStore, [altered(put, (p) => (p['dot'] = '2@mallory'))]));
    refused(storeAdd(emptyStore, [altered(put, (p) => (p['dot'] = '0@mallory'))]));
    const base = accepted(storeAdd(emptyStore, [put, one]));
    refused(storeAdd(base, [altered(two, (p) => (p['id'] = '3@mallory'))]), /next one is 2/);
    refused(storeAdd(base, [altered(two, (p) => (p['id'] = '1@mallory'))]), /next one is 2/);
    // The same counter in another note is another character.
    const other = w.note('z');
    expect(storeAdd(base, [two, ...other.ops]).ok).toBe(true);
  });

  it('refuses a reference to an id of its own that it has not made yet', () => {
    const typing = started();
    const typed = must(typing.w.type(typing.id, 1, 'b')[0]);
    refused(
      storeAdd(typing.base, [altered(typed, (p) => (p['parent'] = '2@mallory'))]),
      /too early/,
    );
    refused(
      storeAdd(typing.base, [altered(typed, (p) => (p['parent'] = '9@mallory'))]),
      /too early/,
    );

    const erasing = started();
    const erase = must(erasing.w.erase(erasing.id, 0, 1)[0]);
    refused(
      storeAdd(erasing.base, [altered(erase, (p) => (p['target'] = '5@mallory'))]),
      /too early/,
    );

    const moving = started();
    const move = must(moving.w.move(moving.id)[0]);
    refused(
      storeAdd(moving.base, [altered(move, (p) => (p['supersedes'] = ['4@mallory']))]),
      /too early/,
    );
    expect(storeAdd(moving.base, [move]).ok).toBe(true);
  });

  it('refuses a character that is the parent of one in another note', () => {
    const w = new Writer('mallory');
    const first = w.note('abc');
    const second = w.note('x');
    const base = accepted(storeAdd(emptyStore, [...first.ops, ...second.ops]));
    // 3@mallory is a character of the first note; the second has only 1@mallory.
    const typed = must(w.type(second.id, 1, 'y')[0]);
    refused(storeAdd(base, [altered(typed, (p) => (p['parent'] = '3@mallory'))]), /too early/);
    expect(storeAdd(base, [typed]).ok).toBe(true);
  });

  it('turns down the whole batch and leaves the store as it was', () => {
    const w = new Writer('mallory');
    const { ops } = w.note('ab');
    const bad = altered(must(ops[2]), (p) => (p['id'] = '7@mallory'));
    const base = storeOf(stamped(alice, 1, 1));
    refused(storeAdd(base, [must(ops[0]), must(ops[1]), bad]));
    expect(base.logs.has(mallory)).toBe(false);
  });

  it('leaves operations of a kind it does not know to the caller', () => {
    const odd: StampedOp = { origin: mallory, seq: 1, op: { n: 1 } };
    expect(storeAdd(emptyStore, [odd]).ok).toBe(true);
  });

  it('keeps an older version of a store usable when a newer one has been made', () => {
    const { w, id, base } = started();
    const next = w.type(id, 1, 'b');
    const newer = accepted(storeAdd(base, next));
    expect(base.logs.get(mallory)?.counters.inserts.get(id)).toBe(1);
    expect(newer.logs.get(mallory)?.counters.inserts.get(id)).toBe(2);
    expect(storeAdd(base, next).ok).toBe(true);
  });
});

describe('ids that belong to other origins', () => {
  it('are not judged by the store: their operations may just not have arrived yet', () => {
    const a = new Writer('alice');
    const noteA = a.note('x');
    const m = new Writer('mallory');
    m.board.applyRemote(noteA.raw);
    const noteM = m.note('');
    const child = m.stamp(m.board.insertTextAfter(noteA.id, { counter: 1, replicaId: alice }, 'y'));
    // Mallory builds on alice's character and her write, with none of alice's operations here yet.
    const withoutAlice = accepted(storeAdd(emptyStore, noteM.ops));
    const result = storeAdd(withoutAlice, child, { maxOrigins: MAX_VECTOR_ENTRIES });
    expect(result.ok).toBe(true);
    const { w, id, base } = started();
    const move = must(w.move(id)[0]);
    const writesOver = altered(move, (p) => (p['supersedes'] = ['1@mallory', '4@alice']));
    expect(storeAdd(base, [writesOver]).ok).toBe(true);
    const removal: StampedOp = {
      origin: mallory,
      seq: 3,
      op: { type: 'note-remove', noteId: id, dots: ['9@alice'] },
    };
    expect(storeAdd(base, [removal]).ok).toBe(true);
  });

  it('can be sent in any order across origins, with the same result', () => {
    const a = new Writer('alice');
    const noteA = a.note('xy');
    const m = new Writer('mallory');
    m.board.applyRemote(noteA.raw);
    const edit = m.type(noteA.id, 1, 'z');
    const forwards = accepted(storeAdd(accepted(storeAdd(emptyStore, noteA.ops)), edit));
    const backwards = accepted(storeAdd(accepted(storeAdd(emptyStore, edit)), noteA.ops));
    expect(storeVector(forwards).entries()).toEqual(storeVector(backwards).entries());
    for (const origin of [alice, mallory]) {
      expect(forwards.logs.get(origin)?.counters).toEqual(backwards.logs.get(origin)?.counters);
    }
  });

  it(`are not taken from more than ${MAX_VECTOR_ENTRIES} origins, which is all a hello holds`, () => {
    const options = { maxOrigins: MAX_VECTOR_ENTRIES };
    let store = emptyStore;
    for (let index = 0; index < MAX_VECTOR_ENTRIES; index += 1) {
      store = accepted(storeAdd(store, stamped(replicaId(`r${index}`), 1, 1), options));
    }
    const one = stamped(replicaId('one-more'), 1, 1);
    refused(storeAdd(store, one, options), /1000 replicas/);
    expect(storeAdd(store, one).ok).toBe(true);
    const known = stamped(replicaId('r7'), 2, 1);
    expect(storeAdd(store, known, options).ok).toBe(true);
  });
});

describe('what a connection may send', () => {
  const hello = (replica: ReplicaId): Hello => ({
    type: 'hello',
    version: PROTOCOL_VERSION,
    replicaId: replica,
    boardId: BOARD,
    versionVector: [],
  });
  const ready = (replica: ReplicaId, store: OpStore = emptyStore) =>
    receive(openResponder({ self: serverId, boardId: BOARD }), store, hello(replica)).session;

  it('has the server take operations of an earlier replica of the same device', () => {
    // Every page load is a new replica, and the next one sends what the last could not.
    const { ops } = new Writer('alice').note('a');
    const own: Message = { type: 'ops', ops };
    expect(receive(ready(alice), emptyStore, own).applied).toHaveLength(2);
    expect(receive(ready(mallory), emptyStore, own).applied).toHaveLength(2);
  });

  it('has the server close a connection whose operations break the rules, and store none', () => {
    const { ops } = new Writer('mallory').note('a');
    const forged = [must(ops[0]), altered(must(ops[1]), (p) => (p['id'] = '1@alice'))];
    const step = receive(ready(mallory), emptyStore, { type: 'ops', ops: forged });
    expect(step.session.phase).toBe('closed');
    expect(step.send[0]).toMatchObject({ type: 'error', code: 'invalid_message' });
    expect(step.store).toBe(emptyStore);
    expect(step.applied).toEqual([]);
  });

  it('has the server refuse the operations of a 1001st replica, and a client take them', () => {
    let full = emptyStore;
    for (let index = 0; index < MAX_VECTOR_ENTRIES; index += 1) {
      full = accepted(storeAdd(full, stamped(replicaId(`r${index}`), 1, 1)));
    }
    const ops: Message = { type: 'ops', ops: stamped(mallory, 1, 1) };
    const atServer = receive(ready(mallory, full), full, ops);
    expect(atServer.session.phase).toBe('closed');
    expect(atServer.send[0]).toMatchObject({ type: 'error', code: 'invalid_message' });
    expect(atServer.store).toBe(full);

    const open = openInitiator({ self: alice, boardId: BOARD }, full);
    const client = receive(open.session, full, hello(serverId)).session;
    expect(receive(client, full, ops).applied).toHaveLength(1);
  });

  it('has a client take relayed operations of any origin, in any order', () => {
    const open = openInitiator({ self: alice, boardId: BOARD }, emptyStore);
    const initiator = receive(open.session, emptyStore, hello(serverId)).session;
    expect(initiator.phase).toBe('ready');
    const m = new Writer('mallory');
    const note = m.note('');
    const child = m.stamp(m.board.insertTextAfter(note.id, null, 'y'));
    // The server's order is not the order of writing, and that is not the client's concern.
    const step = receive(initiator, emptyStore, { type: 'ops', ops: [...note.ops, ...child] });
    expect(step.applied).toHaveLength(3);
  });
});

describe('the board-wide limits of a room', () => {
  const join = (room: Room, replica: ReplicaId, conn: string): Room => {
    const hello: Message = {
      type: 'hello',
      version: PROTOCOL_VERSION,
      replicaId: replica,
      boardId: BOARD,
      versionVector: [],
    };
    return roomReceive(roomConnect(room, conn), conn, hello).room;
  };

  describe('a hello for a replica id that another connection holds', () => {
    const hello = (replica: ReplicaId, token?: string): Message => ({
      type: 'hello',
      version: PROTOCOL_VERSION,
      replicaId: replica,
      boardId: BOARD,
      versionVector: [],
      ...(token === undefined ? {} : { token }),
    });
    const connect = (room: Room, conn: string, replica: ReplicaId, token?: string) =>
      roomReceive(roomConnect(room, conn), conn, hello(replica, token));

    it('does not push it off without its secret, and keeps it where it is', () => {
      const first = connect(createRoom({ serverId, boardId: BOARD }), 'c1', alice, 'secret-alice');
      for (const token of [undefined, 'another-secret']) {
        const step = connect(first.room, 'c2', alice, token);
        expect(step.close).toEqual(['c2']);
        expect(step.send[0]?.message).toMatchObject({ type: 'error', code: 'invalid_message' });
        expect(step.room.sessions.get('c1')?.phase).toBe('ready');
        expect(step.room.sessions.has('c2')).toBe(false);
      }
    });

    it('is let in with the secret, and takes the old connection’s place', () => {
      const first = connect(createRoom({ serverId, boardId: BOARD }), 'c1', alice, 'secret-alice');
      const step = connect(first.room, 'c2', alice, 'secret-alice');
      expect(step.close).toEqual(['c1']);
      expect(step.room.sessions.get('c2')?.phase).toBe('ready');
      expect(step.room.sessions.has('c1')).toBe(false);
    });

    it('may take the place of a replica that came without a secret, as before', () => {
      const first = connect(createRoom({ serverId, boardId: BOARD }), 'c1', alice);
      const step = connect(first.room, 'c2', alice, 'whatever-it-is');
      expect(step.close).toEqual(['c1']);
    });
  });

  it('refuses operations in the name of a replica that is connected, and only those', () => {
    const { ops } = new Writer('alice').note('a');
    let room = join(createRoom({ serverId, boardId: BOARD }), mallory, 'c-mallory');
    // Nobody is connected as alice: whatever device made these, they are taken.
    const taken = roomReceive(room, 'c-mallory', { type: 'ops', ops });
    expect(taken.close).toEqual([]);
    expect(taken.applied).toHaveLength(2);

    // Alice connects, and from then on speaks for herself.
    room = join(createRoom({ serverId, boardId: BOARD }), mallory, 'c-mallory');
    room = join(room, alice, 'c-alice');
    const step = roomReceive(room, 'c-mallory', { type: 'ops', ops });
    expect(step.close).toEqual(['c-mallory']);
    expect(step.applied).toEqual([]);
    expect(step.room.store).toBe(room.store);
    const refusal = step.send[0]?.message;
    expect(refusal).toMatchObject({ type: 'error', code: 'invalid_message' });
    expect(refusal?.type === 'error' ? refusal.message : '').toContain('alice');
  });

  it('takes text for a note whose write has not arrived, as a device sends in the order of replica ids', () => {
    const { ops } = new Writer('mallory').note('a');
    const room = join(createRoom({ serverId, boardId: BOARD }), mallory, 'c1');
    // The character, numbered as the first operation of its stream: the note's write comes later.
    const early = { ...must(ops[1]), seq: 1 };
    const step = roomReceive(room, 'c1', { type: 'ops', ops: [early] });
    expect(step.close).toEqual([]);
    expect(step.applied).toHaveLength(1);
    expect(step.room.notes.get('1@mallory')).toBe(1);
  });

  it('holds the text of a note to maxNoteNodes characters, deleted ones included', () => {
    const w = new Writer('mallory');
    const { id, ops } = w.note('abc');
    let room = join(createRoom({ serverId, boardId: BOARD, maxNoteNodes: 4 }), mallory, 'c1');
    room = roomReceive(room, 'c1', { type: 'ops', ops }).room;
    room = roomReceive(room, 'c1', { type: 'ops', ops: w.erase(id, 0, 3) }).room;
    expect(room.notes.get(id)).toBe(3);
    room = roomReceive(room, 'c1', { type: 'ops', ops: w.type(id, 0, 'd') }).room;
    expect(room.notes.get(id)).toBe(4);
    const step = roomReceive(room, 'c1', { type: 'ops', ops: w.type(id, 1, 'e') });
    expect(step.close).toEqual(['c1']);
    expect(step.room.notes.get(id)).toBe(4);
    expect(step.send[0]?.message).toMatchObject({ code: 'invalid_message' });
  });

  it('counts what the store it was made from already holds', () => {
    const w = new Writer('mallory');
    const { id, ops } = w.note('abc');
    const room = createRoom({ serverId, boardId: BOARD, store: storeOf(ops), maxNoteNodes: 3 });
    expect(room.notes.get(id)).toBe(3);
    const step = roomReceive(join(room, mallory, 'c1'), 'c1', {
      type: 'ops',
      ops: w.type(id, 0, 'd'),
    });
    expect(step.close).toEqual(['c1']);
  });

  it('adds up what several replicas write into one note', () => {
    const a = new Writer('alice');
    const noteA = a.note('ab');
    const m = new Writer('mallory');
    m.board.applyRemote(noteA.raw);
    const ledger = ledgerOf(storeOf(noteA.ops));
    expect(ledger.get(noteA.id)).toBe(2);
    const more = m.stamp(m.board.editText(noteA.id, 2, 0, 'cd'));
    expect(ledgerAdd(ledger, more, 5).ok).toBe(true);
    expect(ledgerAdd(ledger, more, 3)).toMatchObject({ ok: false });
    expect(ledger.get(noteA.id)).toBe(2);
  });
});
