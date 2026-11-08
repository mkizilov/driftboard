import {
  Board,
  BoardFormatError,
  createManualClock,
  replicaId,
  type BoardOp,
  type ReplicaId,
} from '@driftboard/crdt';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BinaryFormatError, decodeOps, encodeOps, isBinaryBatch } from './binary';
import { canonicalizeOp, stampOps, type StampedOp } from './ops';
import { must } from './test-support';

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const WORDS = ['alpha', 'beta ', 'gamma', ' delta', 'é', '😀', 'x', 'kiwi mango'];
const COLORS = ['yellow', 'pink', 'green', 'blue', 'purple', 'orange'] as const;

/**
 * Three people editing one board at the same instant, now and then catching up with each other's
 * operations: notes made, typed into, erased from, moved, recoloured, raised and deleted, with
 * whole and fractional coordinates. Returns what each authored, as the stream of its origin.
 */
function conversation(seed: number, steps: number): StampedOp[] {
  const random = lcg(seed);
  const clock = createManualClock(1_700_000_000_000);
  const people = ['a', 'b', 'c'].map((name) => ({
    origin: replicaId(name),
    board: new Board({ replicaId: replicaId(name), clock }),
    authored: [] as BoardOp[],
    seen: new Map<ReplicaId, number>(),
  }));
  const pick = <T>(items: readonly T[]): T => must(items[Math.floor(random() * items.length)]);
  for (let step = 0; step < steps; step += 1) {
    if (random() < 0.6) clock.advance(Math.floor(random() * 4000));
    const person = pick(people);
    const notes = person.board.notes();
    const roll = random();
    let ops: BoardOp[] = [];
    if (roll < 0.12 || notes.length === 0) {
      const coordinate = () =>
        random() < 0.5 ? Math.floor(random() * 3000) - 1000 : random() * 3000 - 1000;
      ops = person.board.createNote({ x: coordinate(), y: coordinate(), color: pick(COLORS) }).ops;
    } else if (roll < 0.62) {
      const note = pick(notes);
      const length = Array.from(note.text).length;
      if (random() < 0.7 || length === 0) {
        ops = person.board.editText(note.id, Math.floor(random() * (length + 1)), 0, pick(WORDS));
      } else {
        const count = Math.min(length, 1 + Math.floor(random() * 4));
        const at = Math.floor(random() * (length - count + 1));
        ops = person.board.editText(note.id, at, count, random() < 0.3 ? 'z' : '');
      }
    } else if (roll < 0.7) {
      ops = person.board.moveNote(pick(notes).id, Math.floor(random() * 2000), random() * 2000);
    } else if (roll < 0.76) {
      ops = person.board.setColor(pick(notes).id, pick(COLORS));
    } else if (roll < 0.81) {
      ops = person.board.bringToFront(pick(notes).id);
    } else if (roll < 0.84 && notes.length > 1) {
      ops = person.board.deleteNote(pick(notes).id);
    } else {
      // Catch up with someone: their operations that this person has not applied yet.
      const other = pick(people);
      if (other !== person) {
        const from = person.seen.get(other.origin) ?? 0;
        person.board.applyRemote(other.authored.slice(from));
        person.seen.set(other.origin, other.authored.length);
      }
    }
    person.authored.push(...ops);
  }
  return people.flatMap((person) => stampOps(person.origin, 1, person.authored));
}

const text = (ops: readonly StampedOp[]) => JSON.stringify(ops);
const ascii = (value: string): Uint8Array => Uint8Array.from(value, (c) => c.charCodeAt(0));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const withBody = (op: object): StampedOp[] => [
  { origin: replicaId('a'), seq: 1, op: op as StampedOp['op'] },
];

describe('encodeOps and decodeOps', () => {
  it('give back exactly the operations that went in: same values and same key order', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const ops = conversation(seed, 150);
      const back = decodeOps(encodeOps(ops));
      expect(back).toEqual(ops);
      expect(text(back)).toBe(text(ops));
    }
  });

  it('do so for any stretch of the stream, and for a batch with gaps and several origins mixed', () => {
    const ops = conversation(7, 300);
    expect(ops.length).toBeGreaterThan(300);
    const random = lcg(11);
    for (let round = 0; round < 40; round += 1) {
      const from = Math.floor(random() * ops.length);
      const slice = ops.slice(from, from + 1 + Math.floor(random() * 80));
      expect(decodeOps(encodeOps(slice))).toEqual(slice);
      const sparse = ops.filter(() => random() < 0.5);
      expect(decodeOps(encodeOps(sparse))).toEqual(sparse);
    }
  });

  it('do so for anything that the editing script makes, found by property', () => {
    fc.assert(
      fc.property(fc.nat(), fc.integer({ min: 1, max: 80 }), (seed, steps) => {
        const ops = conversation(seed, steps);
        expect(text(decodeOps(encodeOps(ops)))).toBe(text(ops));
      }),
      { numRuns: 60 },
    );
  });

  it('write an empty batch as a header and nothing else', () => {
    const bytes = encodeOps([]);
    expect(Array.from(bytes)).toEqual([0xdb, 1, 0]);
    expect(decodeOps(bytes)).toEqual([]);
    expect(isBinaryBatch(bytes)).toBe(true);
    expect(isBinaryBatch(ascii('{"v":1}'))).toBe(false);
    expect(isBinaryBatch(new Uint8Array())).toBe(false);
  });

  it('carry a coordinate that is not a number as far as the checks for incoming operations, which refuse it', () => {
    const put = must(conversation(3, 40).find((s) => s.op['type'] === 'note-put'));
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const body = clone(put.op) as unknown as { fields: { x: { value: number } } };
      body.fields.x.value = bad;
      const decoded = must(decodeOps(encodeOps(withBody(body)))[0]);
      const shown = (decoded.op['fields'] as unknown as { x: { value: number } }).x.value;
      expect(Object.is(shown, bad)).toBe(true);
      expect(() => canonicalizeOp(decoded.op)).toThrow(BoardFormatError);
    }
  });

  it('hand back operations that the checks for incoming operations accept unchanged', () => {
    for (const { op } of decodeOps(encodeOps(conversation(5, 200)))) {
      expect(JSON.stringify(canonicalizeOp(op))).toBe(JSON.stringify(op));
    }
  });
});

describe('runs', () => {
  const note = () => {
    const board = new Board({ replicaId: replicaId('a'), clock: createManualClock(1000) });
    const { id, ops } = board.createNote();
    return { board, id, created: ops };
  };
  const stream = (ops: BoardOp[]) => stampOps(replicaId('a'), 1, ops);
  const inserts = (ops: readonly StampedOp[]) => ops.filter((s) => s.op['type'] === 'text-insert');

  it('write the characters of a typed word as one insert, a byte or two each', () => {
    const { board, id, created } = note();
    const typed = board.editText(id, 0, 0, 'hello world, this is typed in one go');
    const all = stream([...created, ...typed]);
    const onlyText = inserts(all);
    expect(onlyText).toHaveLength(36);
    const bytes = encodeOps(onlyText);
    // A header, one run header of about ten bytes, and a byte per character.
    expect(bytes.length).toBeLessThan(60);
    expect(bytes.length).toBeLessThan(JSON.stringify(onlyText).length / 40);
    expect(decodeOps(bytes)).toEqual(onlyText);
  });

  it('start a new run where the typing stops being one after another', () => {
    const { board, id, created } = note();
    const ops = [
      ...created,
      ...board.editText(id, 0, 0, 'abc'),
      ...board.editText(id, 1, 0, 'XY'), // in the middle: a left child of 'b'
      ...board.editText(id, 5, 0, 'def'), // at the end
      ...board.editText(id, 0, 0, '1'), // at the start
    ];
    const all = stream(ops);
    const bytes = encodeOps(all);
    expect(decodeOps(bytes)).toEqual(all);
    // Four runs of inserts: 3 + 2 + 3 + 1 characters, however many puts are mixed in.
    const runs = Array.from(bytes).filter((byte) => byte === 1).length;
    expect(runs).toBeGreaterThanOrEqual(4);
  });

  it('keep a run going across code points beyond the basic plane and other scripts', () => {
    const { board, id, created } = note();
    const all = stream([...created, ...board.editText(id, 0, 0, 'a😀é日本語😀z')]);
    expect(decodeOps(encodeOps(all))).toEqual(all);
  });

  it('write deleting a selection as one run', () => {
    const { board, id, created } = note();
    const typed = board.editText(id, 0, 0, 'abcdefghijklmnopqrstuvwxyz');
    const selection = board.editText(id, 2, 10, '');
    const all = stream([...created, ...typed, ...selection]);
    expect(all.filter((s) => s.op['type'] === 'text-delete')).toHaveLength(10);
    const bytes = encodeOps(all);
    expect(decodeOps(bytes)).toEqual(all);
    // Ten deletes in the room of a header and four bytes, whatever their ids look like in JSON.
    const without = encodeOps(stream([...created, ...typed]));
    expect(bytes.length - without.length).toBeLessThan(12);
  });

  it('write a key at a time as one run of pairs: a character and the note written again', () => {
    const { board, id, created } = note();
    const sentence = 'the quick brown fox jumps over the lazy dog';
    const keys = Array.from(sentence).flatMap((char, index) => board.editText(id, index, 0, char));
    const all = stream([...created, ...keys]);
    expect(all).toHaveLength(1 + 2 * sentence.length);
    const bytes = encodeOps(all);
    expect(decodeOps(bytes)).toEqual(all);
    // The note is put in full once (the created one), then 43 characters for a byte each, and a
    // dozen bytes of header for the whole run.
    const first = encodeOps(all.slice(0, 1));
    expect(bytes.length - first.length).toBeLessThan(sentence.length + 14);
    expect(bytes.length).toBeLessThan(JSON.stringify(all).length / 50);
  });

  it('write backspacing a key at a time as one run of pairs, and a paste as a run and a re-assertion', () => {
    const { board, id, created } = note();
    const typed = board.editText(id, 0, 0, 'forty characters of text to backspace over');
    const length = 'forty characters of text to backspace over'.length;
    const backspaces = Array.from({ length: 30 }, (_, n) => length - 1 - n).flatMap((index) =>
      board.editText(id, index, 1, ''),
    );
    const pasted = board.editText(id, 0, 0, 'pasted words');
    const all = stream([...created, ...typed, ...backspaces, ...pasted]);
    const bytes = encodeOps(all);
    expect(decodeOps(bytes)).toEqual(all);
    const rest = encodeOps(stream([...created, ...typed]));
    // 30 deletes and their puts: one run header; 12 characters pasted: one run and one reassert.
    expect(bytes.length - rest.length).toBeLessThan(10 + 12 + 14);
  });

  it('fall back to whole puts when a note is changed between keys, and still round-trip', () => {
    const { board, id, created } = note();
    const ops: BoardOp[] = [...created];
    for (const [index, char] of Array.from('moving while typing').entries()) {
      ops.push(...board.editText(id, index, 0, char));
      if (index % 4 === 3) ops.push(...board.moveNote(id, index * 10, index));
    }
    const all = stream(ops);
    expect(decodeOps(encodeOps(all))).toEqual(all);
  });

  it('pair up typing in two notes by turns, because each re-assertion repeats its own note', () => {
    const board = new Board({ replicaId: replicaId('a'), clock: createManualClock(1000) });
    const one = board.createNote();
    const two = board.createNote();
    const ops: BoardOp[] = [...one.ops, ...two.ops];
    for (const [index, char] of Array.from('abcdefgh').entries()) {
      ops.push(
        ...board.editText(one.id, index, 0, char),
        ...board.editText(two.id, index, 0, char),
      );
    }
    const all = stream(ops);
    const bytes = encodeOps(all);
    expect(decodeOps(bytes)).toEqual(all);
    expect(bytes.length).toBeLessThan(JSON.stringify(all).length / 25);
  });

  it('split a run at the point a character is typed somewhere else, and keep going after', () => {
    const { board, id, created } = note();
    const ops: BoardOp[] = [...created];
    for (let index = 0; index < 6; index += 1) ops.push(...board.editText(id, index, 0, 'k'));
    ops.push(...board.editText(id, 2, 0, 'M'));
    for (let index = 7; index < 12; index += 1) ops.push(...board.editText(id, index, 0, 'j'));
    const all = stream(ops);
    expect(decodeOps(encodeOps(all))).toEqual(all);
  });

  it('do not join deletes of other notes, other replicas or counters that skip', () => {
    const board = new Board({ replicaId: replicaId('a'), clock: createManualClock(1000) });
    const one = board.createNote();
    const two = board.createNote();
    const ops = [
      ...one.ops,
      ...two.ops,
      ...board.editText(one.id, 0, 0, 'abcdef'),
      ...board.editText(two.id, 0, 0, 'uvwxyz'),
      ...board.editText(one.id, 0, 1, ''),
      ...board.editText(two.id, 0, 1, ''),
      ...board.editText(one.id, 1, 1, ''), // 'c', skipping 'b'
      ...board.editText(one.id, 0, 1, ''),
    ];
    const all = stream(ops);
    expect(decodeOps(encodeOps(all))).toEqual(all);
  });
});

describe('what must not be joined into a run', () => {
  const a = replicaId('a');
  const insert = (
    note: string,
    counter: number,
    parent: string | null,
    value = 'x',
    side = 'right',
  ) => ({
    type: 'text-insert',
    noteId: note,
    id: `${counter}@a`,
    parent,
    side,
    value,
  });
  const erase = (note: string, counter: number) => ({
    type: 'text-delete',
    noteId: note,
    target: `${counter}@a`,
  });
  const batch = (...bodies: object[]): StampedOp[] =>
    bodies.map((op, index) => ({ origin: a, seq: index + 1, op: op as StampedOp['op'] }));

  it('inserts into different notes, even when the counters and parents would fit', () => {
    const ops = batch(insert('n1', 1, null), insert('n2', 2, '1@a'), insert('n1', 3, '2@a'));
    expect(decodeOps(encodeOps(ops))).toEqual(ops);
  });

  it('inserts whose counters skip, or whose parent is not the one before, or that hang on the left', () => {
    const skipping = batch(insert('n', 1, null), insert('n', 3, '1@a'));
    expect(decodeOps(encodeOps(skipping))).toEqual(skipping);
    const elsewhere = batch(insert('n', 1, null), insert('n', 2, null));
    expect(decodeOps(encodeOps(elsewhere))).toEqual(elsewhere);
    const leftwards = batch(insert('n', 1, null), insert('n', 2, '1@a', 'y', 'left'));
    expect(decodeOps(encodeOps(leftwards))).toEqual(leftwards);
    const another = batch(insert('n', 1, null), { ...insert('n', 2, '1@a'), id: '2@b' });
    expect(decodeOps(encodeOps(another))).toEqual(another);
  });

  it('joins inserts that follow one another, and only those', () => {
    const joined = batch(insert('n', 1, null), insert('n', 2, '1@a'), insert('n', 3, '2@a'));
    const apart = batch(insert('n', 1, null), insert('n', 2, '1@a'), insert('n', 4, '2@a'));
    expect(encodeOps(joined).length).toBeLessThan(encodeOps(apart).length);
    expect(decodeOps(encodeOps(joined))).toEqual(joined);
    expect(decodeOps(encodeOps(apart))).toEqual(apart);
  });

  it('deletes that turn back, jump, or belong to another note or replica', () => {
    for (const targets of [
      [3, 4, 3],
      [3, 4, 5, 4],
      [5, 4, 5],
      [5, 4, 3, 4],
      [3, 5, 6],
      [3, 3],
    ]) {
      const ops = batch(...targets.map((target) => erase('n', target)));
      expect(decodeOps(encodeOps(ops))).toEqual(ops);
    }
    const notes = batch(erase('n', 3), erase('m', 4), erase('n', 5));
    expect(decodeOps(encodeOps(notes))).toEqual(notes);
    const replicas = batch(erase('n', 3), { ...erase('n', 4), target: '4@b' });
    expect(decodeOps(encodeOps(replicas))).toEqual(replicas);
  });

  it('joins deletes that go one way, up or down', () => {
    const up = batch(erase('n', 3), erase('n', 4), erase('n', 5), erase('n', 6));
    const down = batch(erase('n', 6), erase('n', 5), erase('n', 4), erase('n', 3));
    const scattered = batch(erase('n', 6), erase('n', 4), erase('n', 9), erase('n', 3));
    expect(encodeOps(up).length).toBeLessThan(encodeOps(scattered).length);
    expect(encodeOps(down).length).toBeLessThan(encodeOps(scattered).length);
    expect(decodeOps(encodeOps(up))).toEqual(up);
    expect(decodeOps(encodeOps(down))).toEqual(down);
  });
});

describe('puts', () => {
  const lone = () => new Board({ replicaId: replicaId('a'), clock: createManualClock(5_000) });
  const stream = (ops: BoardOp[]) => stampOps(replicaId('a'), 1, ops);

  it('write the re-assertion that every text edit makes in a few bytes', () => {
    const board = lone();
    const { id, ops: created } = board.createNote({ x: 120, y: 340, color: 'green' });
    const typing = Array.from('keystrokes').flatMap((char, index) =>
      board.editText(id, index, 0, char),
    );
    const all = stream([...created, ...typing]);
    const puts = all.filter((s) => s.op['type'] === 'note-put');
    expect(puts).toHaveLength(11);
    const bytes = encodeOps(all);
    expect(decodeOps(bytes)).toEqual(all);
    // The whole batch is ten edits of a char and a put each; JSON needs hundreds of bytes per put.
    expect(bytes.length).toBeLessThan(JSON.stringify(all).length / 20);
  });

  it('keep whole numbers, negative ones, fractions and very large and very small ones exact', () => {
    const board = lone();
    const values = [
      0,
      -1,
      1,
      63,
      -64,
      64,
      2 ** 31,
      -(2 ** 31),
      2 ** 50,
      -(2 ** 50),
      2 ** 50 + 2,
      Number.MAX_SAFE_INTEGER,
      0.1,
      -123.456,
      1e300,
      -1e-300,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
    ];
    const ops: BoardOp[] = [];
    for (const value of values) {
      const { id, ops: made } = board.createNote({ x: value, y: -value });
      ops.push(...made, ...board.moveNote(id, -value, value));
    }
    const all = stream(ops);
    expect(text(decodeOps(encodeOps(all)))).toBe(text(all));
  });

  it('keep every colour, and the raising and recolouring of notes', () => {
    const board = lone();
    const { id, ops: created } = board.createNote();
    const ops = [
      ...created,
      ...COLORS.flatMap((color) => board.setColor(id, color)),
      ...board.bringToFront(id),
      ...board.moveNote(id, 7, 8),
    ];
    const all = stream(ops);
    expect(decodeOps(encodeOps(all))).toEqual(all);
  });

  it('leave out the fields of a put that have not changed since the last put of the note', () => {
    const board = lone();
    const { id, ops: created } = board.createNote({ x: 120, y: 340, color: 'green' });
    const moved = board.moveNote(id, 130, 340);
    const recoloured = board.setColor(id, 'blue');
    const first = stream(created);
    const withMove = stampOps(replicaId('a'), 1, [...created, ...moved]);
    const withColor = stampOps(replicaId('a'), 1, [...created, ...recoloured]);
    const everything = stampOps(replicaId('a'), 1, [...created, ...moved, ...recoloured]);
    for (const ops of [withMove, withColor, everything]) {
      expect(decodeOps(encodeOps(ops))).toEqual(ops);
    }
    const whole = encodeOps(first).length;
    // What a put costs when all four fields have to be written, as for a note new to the batch.
    const another = board.createNote({ x: 5, y: 6, color: 'pink' });
    const full = encodeOps(stream([...created, ...another.ops])).length - whole;
    // The move rewrites x and y with a new timestamp; z and the colour are "as before" and cost a
    // bit of the mask. The recolour rewrites only the colour. Either is less than a whole put.
    expect(encodeOps(withMove).length - whole).toBeLessThan(full);
    expect(encodeOps(withColor).length - whole).toBeLessThan(full);
  });

  it('keep what several people wrote to one note, and the removal of all of it', () => {
    const clock = createManualClock(9_000);
    const a = new Board({ replicaId: replicaId('a'), clock });
    const b = new Board({ replicaId: replicaId('b'), clock });
    const { id, ops: created } = a.createNote({ x: 1, y: 2 });
    b.applyRemote(created);
    const fromA = a.moveNote(id, 10, 20);
    const fromB = b.setColor(id, 'purple');
    a.applyRemote(fromB);
    b.applyRemote(fromA);
    const removal = a.deleteNote(id);
    const streamA = stampOps(replicaId('a'), 1, [...created, ...fromA, ...removal]);
    const streamB = stampOps(replicaId('b'), 1, fromB);
    const all = [...streamA, ...streamB];
    expect(removal[0]).toMatchObject({ type: 'notes', op: { type: 'remove' } });
    expect(decodeOps(encodeOps(all))).toEqual(all);
  });
});

describe('encodeOps', () => {
  const valid = (): StampedOp[] => conversation(3, 40);
  const withOp = (op: Record<string, unknown>): StampedOp[] => [
    { origin: replicaId('a'), seq: 1, op: op as StampedOp['op'] },
  ];

  it('refuses what is not a canonical operation', () => {
    expect(() => encodeOps(withOp({ type: 'something-else' }))).toThrow(BinaryFormatError);
    expect(() => encodeOps(withOp({ type: 'text-delete', noteId: 'n', target: '01@a' }))).toThrow(
      BinaryFormatError,
    );
    expect(() => encodeOps(withOp({ type: 'text-delete', noteId: 'n', target: 'x' }))).toThrow(
      BinaryFormatError,
    );
    expect(() => encodeOps(withOp({ type: 'text-delete', noteId: 5, target: '1@a' }))).toThrow(
      BinaryFormatError,
    );
    const insert = { type: 'text-insert', noteId: 'n', id: '1@a', parent: null, side: 'right' };
    expect(() => encodeOps(withOp({ ...insert, value: 'ab' }))).toThrow('one code point');
    expect(() => encodeOps(withOp({ ...insert, value: '' }))).toThrow(BinaryFormatError);
    expect(() => encodeOps(withOp({ ...insert, value: 'a', side: 'up' }))).toThrow(
      BinaryFormatError,
    );
    expect(() => encodeOps(withOp({ ...insert, value: 'a', side: 'left' }))).toThrow(
      BinaryFormatError,
    );
    expect(() => encodeOps(withOp({ ...insert, value: 'a', parent: 7 }))).toThrow(
      BinaryFormatError,
    );
    expect(() => encodeOps(withOp({ type: 'note-remove', noteId: 'n', dots: [3] }))).toThrow(
      BinaryFormatError,
    );
  });

  it('refuses a put with a colour or timestamp that is not canonical', () => {
    const put = valid().find((s) => s.op['type'] === 'note-put');
    const original = clone(must(put).op) as unknown as {
      fields: { color: { value: string; at: string } };
    };
    const badColor = clone(original);
    badColor.fields.color.value = 'mauve';
    expect(() => encodeOps(withOp(badColor))).toThrow('color');
    const badTime = clone(original);
    badTime.fields.color.at = badTime.fields.color.at.toUpperCase();
    expect(() => encodeOps(withOp(badTime))).toThrow(BinaryFormatError);
    badTime.fields.color.at = 'yesterday';
    expect(() => encodeOps(withOp(badTime))).toThrow(BinaryFormatError);
  });

  it('refuses a sequence number below 1', () => {
    expect(() => encodeOps([{ origin: replicaId('a'), seq: 0, op: { type: 'x' } }])).toThrow(
      BinaryFormatError,
    );
  });
});

describe('decodeOps', () => {
  const batch = () => encodeOps(conversation(9, 60));

  it('refuses bytes that are not a batch, or are one of another version', () => {
    expect(() => decodeOps(new Uint8Array())).toThrow(BinaryFormatError);
    expect(() => decodeOps(ascii('{"v":1,"origins":[]}'))).toThrow('Not a binary');
    const wrong = batch();
    wrong[1] = 2;
    expect(() => decodeOps(wrong)).toThrow('version');
  });

  it('refuses a batch cut short anywhere, with the error for bad data and no other', () => {
    const bytes = batch();
    expect(bytes.length).toBeGreaterThan(300);
    for (let length = 0; length < bytes.length; length += 1) {
      expect(() => decodeOps(bytes.slice(0, length))).toThrow(BinaryFormatError);
    }
  });

  it('refuses bytes after the end of the last group', () => {
    const bytes = batch();
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    expect(() => decodeOps(longer)).toThrow('Extra bytes');
  });

  it('fails with the error for bad data, or succeeds, on any damaged batch', () => {
    const bytes = batch();
    const random = lcg(5);
    let refused = 0;
    for (let round = 0; round < 600; round += 1) {
      const damaged = bytes.slice();
      const changes = 1 + Math.floor(random() * 3);
      for (let n = 0; n < changes; n += 1) {
        damaged[Math.floor(random() * damaged.length)] = Math.floor(random() * 256);
      }
      try {
        decodeOps(damaged);
      } catch (error) {
        expect(error).toBeInstanceOf(BinaryFormatError);
        refused += 1;
      }
    }
    expect(refused).toBeGreaterThan(100);
  });

  it('fails with the error for bad data on random bytes behind a good header', () => {
    const random = lcg(6);
    for (let round = 0; round < 400; round += 1) {
      const junk = new Uint8Array(2 + Math.floor(random() * 60));
      junk[0] = 0xdb;
      junk[1] = 1;
      for (let i = 2; i < junk.length; i += 1) junk[i] = Math.floor(random() * 256);
      try {
        decodeOps(junk);
      } catch (error) {
        expect(error).toBeInstanceOf(BinaryFormatError);
      }
    }
  });

  it('stops at once on a header that promises more than the data holds', () => {
    // Two billion groups, and then nothing.
    expect(() => decodeOps(new Uint8Array([0xdb, 1, 0xff, 0xff, 0xff, 0xff, 0x07]))).toThrow(
      BinaryFormatError,
    );
    // One group of a billion operations, and then nothing.
    const lying = new Uint8Array([0xdb, 1, 1, 0, 1, 97, 1, 0x80, 0x94, 0xeb, 0xdc, 0x03]);
    expect(() => decodeOps(lying)).toThrow(BinaryFormatError);
    // A run of a million characters in a dozen bytes.
    const run = [0xdb, 1, 1, 0, 1, 97, 1, 1, 1, 0, 1, 110, 0, 1, 0, 0xc0, 0x84, 0x3d];
    expect(() => decodeOps(new Uint8Array(run))).toThrow('bad length');
    // A run of deletes, which carries no data per operation, as long as the group allows.
    const deletes = [0xdb, 1, 1, 0, 1, 97, 1, 1, 2, 0, 1, 110, 0, 1, 0xc0, 0x84, 0x3d];
    expect(() => decodeOps(new Uint8Array(deletes))).toThrow('bad length');
    // And one that the group has room for in its header but that is beyond any run.
    const endless = [
      0xdb, 1, 1, 0, 1, 97, 1, 0xff, 0xff, 0xff, 0x7f, 2, 0, 1, 110, 0, 1, 0xfe, 0xff, 0xff, 0x7f,
    ];
    expect(() => decodeOps(new Uint8Array(endless))).toThrow('bad length');
  });

  it('refuses more operations than it is allowed', () => {
    const bytes = batch();
    const total = decodeOps(bytes).length;
    expect(decodeOps(bytes, total)).toHaveLength(total);
    expect(() => decodeOps(bytes, total - 1)).toThrow('Too many operations');
    expect(() => decodeOps(bytes, 0)).toThrow('Too many operations');
  });

  it('refuses a replica id that is not one, a name out of range and a repeat of a put that is not there', () => {
    const header = [0xdb, 1, 1];
    // Origin "a b" (a space is not allowed in a replica id).
    expect(() =>
      decodeOps(new Uint8Array([...header, 0, 3, 97, 32, 98, 1, 1, 2, 0, 0, 0, 0])),
    ).toThrow('Invalid name');
    // Origin index 5 when none has been defined.
    expect(() => decodeOps(new Uint8Array([...header, 5, 1, 1, 0]))).toThrow('out of range');
    // A put whose fields all say "as before", with nothing before.
    const put = [...header, 0, 1, 97, 1, 1, 3, 0, 1, 110, 0, 2, 0, 15];
    expect(() => decodeOps(new Uint8Array(put))).toThrow('not there');
  });
});

describe('sizes', () => {
  it('are a small part of the JSON for typed text, and for a board in general', () => {
    const typing = conversation(21, 400);
    const json = JSON.stringify(typing).length;
    const binary = encodeOps(typing).length;
    expect(typing.length).toBeGreaterThan(1000);
    // Measured, not hoped for: about a twentieth. The bound leaves room for the script's mix.
    expect(binary).toBeLessThan(json / 8);
    expect(binary / typing.length).toBeLessThan(25);
  });
});
