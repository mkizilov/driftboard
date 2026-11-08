import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Board } from './board';
import { boardOpToJson, deserializeBoardOps } from './board-json';
import {
  NOTE_COLORS,
  UnknownNoteError,
  type BoardChange,
  type BoardOp,
  type NoteColor,
} from './board-ops';
import { createManualClock, type ManualClock } from './clock';
import { checkConvergence, type CheckableSpec } from './convergence';
import { replicaId } from './replica-id';
import { must } from './test-support';

function newBoard(name: string, startMs = 1000): { board: Board; clock: ManualClock } {
  const clock = createManualClock(startMs);
  return { board: new Board({ replicaId: replicaId(name), clock }), clock };
}

const boardOf = (name: string, startMs?: number): Board => newBoard(name, startMs).board;

function pair(): [Board, Board] {
  return [boardOf('a'), boardOf('b')];
}

/** The whole state of a board as a string: equal strings mean converged replicas. */
const state = (board: Board): string => JSON.stringify(board.snapshot());

function expectConverged(first: Board, ...others: Board[]): void {
  for (const other of others) expect(state(other)).toBe(state(first));
}

const logJson = (ops: readonly BoardOp[]) => ops.map(boardOpToJson);

// ---- Random histories --------------------------------------------------------------------------

type Intent =
  | { kind: 'create'; x: number; y: number; color: NoteColor; text: string }
  | { kind: 'move'; pick: number; x: number; y: number }
  | { kind: 'color'; pick: number; color: NoteColor }
  | { kind: 'front'; pick: number }
  | { kind: 'edit'; pick: number; at: number; deleteCount: number; text: string }
  | { kind: 'delete'; pick: number };

const coordinate = fc.integer({ min: -50, max: 50 });
const colorArb = fc.constantFrom(...NOTE_COLORS);
const textArb = fc
  .array(fc.constantFrom('a', 'b', 'c', '😀', 'é'), { maxLength: 4 })
  .map((chars) => chars.join(''));

const intentArb: fc.Arbitrary<Intent> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('create' as const),
      x: coordinate,
      y: coordinate,
      color: colorArb,
      text: textArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('move' as const),
      pick: fc.nat(),
      x: coordinate,
      y: coordinate,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('color' as const), pick: fc.nat(), color: colorArb }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('front' as const), pick: fc.nat() }) },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('edit' as const),
      pick: fc.nat(),
      at: fc.nat(),
      deleteCount: fc.integer({ min: 0, max: 3 }),
      text: textArb,
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('delete' as const), pick: fc.nat() }) },
);

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`Postcondition failed: ${what}`);
}

/**
 * Performs `intent` on the board (on a note picked from the notes it currently shows), checks the
 * local result is exactly what was asked for, and returns the operations.
 */
function applyIntent(board: Board, intent: Intent): BoardOp[] {
  if (intent.kind === 'create') {
    const others = board.notes();
    const { id, ops } = board.createNote({
      x: intent.x,
      y: intent.y,
      color: intent.color,
      text: intent.text,
    });
    const note = must(board.getNote(id));
    check(
      note.x === intent.x &&
        note.y === intent.y &&
        note.color === intent.color &&
        note.text === intent.text &&
        others.every((other) => other.z < note.z),
      'create',
    );
    return ops;
  }

  const target = board.notes()[intent.pick % board.size];
  if (target === undefined) return [];
  const { id } = target;
  switch (intent.kind) {
    case 'move': {
      const ops = board.moveNote(id, intent.x, intent.y);
      const note = must(board.getNote(id));
      check(note.x === intent.x && note.y === intent.y, 'move');
      return ops;
    }
    case 'color': {
      const ops = board.setColor(id, intent.color);
      check(must(board.getNote(id)).color === intent.color, 'color');
      return ops;
    }
    case 'front': {
      const ops = board.bringToFront(id);
      const note = must(board.getNote(id));
      check(board.notes().every((other) => other.id === id || other.z < note.z), 'front');
      return ops;
    }
    case 'edit': {
      const chars = [...target.text];
      const index = intent.at % (chars.length + 1);
      const count = Math.min(intent.deleteCount, chars.length - index);
      const ops = board.editText(id, index, count, intent.text);
      const expected = [...chars.slice(0, index), ...intent.text, ...chars.slice(index + count)];
      check(must(board.getNote(id)).text === expected.join(''), 'edit');
      return ops;
    }
    case 'delete': {
      const ops = board.deleteNote(id);
      check(board.getNote(id) === undefined, 'delete');
      return ops;
    }
  }
}

interface Step {
  replica: number;
  intent: Intent;
  /** Replica to bring up to date with everything created so far after this step, or -1. */
  syncTo: number;
}

const stepArb: fc.Arbitrary<Step> = fc.record({
  replica: fc.integer({ min: 0, max: 2 }),
  intent: intentArb,
  syncTo: fc.integer({ min: -1, max: 2 }),
});

/** Runs the steps on three boards and returns every operation in creation order. */
function simulate(steps: readonly Step[]): BoardOp[] {
  const boards = [0, 1, 2].map((i) => boardOf(`r${i}`));
  const log: BoardOp[] = [];
  for (const step of steps) {
    log.push(...applyIntent(must(boards[step.replica]), step.intent));
    if (step.syncTo >= 0) must(boards[step.syncTo]).applyRemote(log);
  }
  return log;
}

describe('Board: creating and reading notes', () => {
  it('starts empty', () => {
    const board = boardOf('a');
    expect(board.size).toBe(0);
    expect(board.notes()).toEqual([]);
    expect(board.getNote('1@a')).toBeUndefined();
    expect(board.log).toEqual([]);
  });

  it('creates a note with defaults and returns its id and one operation', () => {
    const board = boardOf('a');
    const { id, ops } = board.createNote();
    expect(id).toBe('1@a');
    expect(board.getNote(id)).toEqual({ id, x: 0, y: 0, color: 'yellow', z: 1, text: '' });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'notes', op: { type: 'put', key: id } });
  });

  it('creates a note with position, colour and text, and puts new notes on top', () => {
    const board = boardOf('a');
    const first = board.createNote({ x: 10, y: -5, color: 'pink', text: 'héllo 😀' });
    const second = board.createNote({ x: 1, y: 2 });
    expect(first.ops.map((op) => op.type)).toEqual(['notes', ...Array<string>(7).fill('text')]);
    expect(board.getNote(first.id)).toEqual({
      id: first.id,
      x: 10,
      y: -5,
      color: 'pink',
      z: 1,
      text: 'héllo 😀',
    });
    expect(second.id).toBe('2@a');
    expect(must(board.getNote(second.id)).z).toBe(2);
    expect(board.notes().map((n) => n.id)).toEqual([first.id, second.id]);
  });

  it('orders notes by z, then by id', () => {
    const [a, b] = pair();
    const fromA = a.createNote();
    const fromB = b.createNote();
    a.applyRemote(fromB.ops);
    b.applyRemote(fromA.ops);
    // Both were created on an empty board, so both have z = 1; the id breaks the tie.
    expect(a.notes().map((n) => n.id)).toEqual(['1@a', '1@b']);
    expect(b.notes().map((n) => n.id)).toEqual(['1@a', '1@b']);
  });

  it('rejects invalid initial values', () => {
    const board = boardOf('a');
    expect(() => board.createNote({ x: Number.NaN })).toThrow(RangeError);
    expect(() => board.createNote({ y: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => board.createNote({ color: 'red' as NoteColor })).toThrow(RangeError);
    expect(board.size).toBe(0);
    expect(board.log).toEqual([]);
  });
});

describe('Board: changing notes', () => {
  it('moves a note', () => {
    const board = boardOf('a');
    const { id } = board.createNote();
    const ops = board.moveNote(id, 40, -2.5);
    expect(ops).toHaveLength(1);
    expect(board.getNote(id)).toMatchObject({ x: 40, y: -2.5 });
  });

  it('recolours a note and brings it to the front', () => {
    const board = boardOf('a');
    const first = board.createNote();
    const second = board.createNote();
    board.setColor(first.id, 'green');
    expect(must(board.getNote(first.id)).color).toBe('green');
    board.bringToFront(first.id);
    expect(must(board.getNote(first.id)).z).toBe(3);
    expect(board.notes().map((n) => n.id)).toEqual([second.id, first.id]);
  });

  it('edits text like splice: delete some characters, insert others', () => {
    const board = boardOf('a');
    const { id } = board.createNote({ text: 'hello' });
    const text = () => must(board.getNote(id)).text;
    board.editText(id, 1, 3, 'ipp');
    expect(text()).toBe('hippo');
    board.editText(id, 5, 0, '!');
    expect(text()).toBe('hippo!');
    board.editText(id, 0, 2, '');
    expect(text()).toBe('ppo!');
    board.editText(id, 1, 1, '😀😀');
    expect(text()).toBe('p😀😀o!');
    board.editText(id, 1, 2, '');
    expect(text()).toBe('po!');
  });

  it('returns text operations followed by a write that re-asserts the note', () => {
    const board = boardOf('a');
    const { id } = board.createNote({ text: 'ab' });
    const ops = board.editText(id, 0, 1, 'xy');
    expect(ops.map((op) => op.op.type)).toEqual([
      'delete',
      'insert',
      'insert',
      'put',
    ]);
    expect(must(ops[3])).toMatchObject({ type: 'notes' });
    expect(board.editText(id, 1, 0, '')).toEqual([]);
  });

  it('deletes a note', () => {
    const board = boardOf('a');
    const keep = board.createNote();
    const { id } = board.createNote();
    const ops = board.deleteNote(id);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'notes', op: { type: 'remove', key: id } });
    expect(board.getNote(id)).toBeUndefined();
    expect(board.notes().map((n) => n.id)).toEqual([keep.id]);
  });

  it('refuses to change a note that does not exist, and leaves the board alone', () => {
    const board = boardOf('a');
    const { id } = board.createNote({ text: 'x' });
    board.deleteNote(id);
    const logged = board.log.length;
    for (const change of [
      () => board.moveNote(id, 1, 1),
      () => board.setColor(id, 'blue'),
      () => board.bringToFront(id),
      () => board.editText(id, 0, 0, 'y'),
      () => board.deleteNote(id),
      () => board.moveNote('nope', 1, 1),
    ]) {
      expect(change).toThrow(UnknownNoteError);
    }
    expect(board.log).toHaveLength(logged);
  });

  it('validates arguments before changing anything', () => {
    const board = boardOf('a');
    const { id } = board.createNote({ text: 'abc' });
    const before = state(board);
    expect(() => board.moveNote(id, Number.NaN, 0)).toThrow(RangeError);
    expect(() => board.setColor(id, 'red' as NoteColor)).toThrow(RangeError);
    expect(() => board.editText(id, 1, 5, 'x')).toThrow(RangeError);
    expect(() => board.editText(id, 4, 0, 'x')).toThrow(RangeError);
    expect(() => board.editText(id, -1, 0, 'x')).toThrow(RangeError);
    expect(() => board.editText(id, 0, -1, 'x')).toThrow(RangeError);
    expect(state(board)).toBe(before);
  });
});

describe('Board: replication', () => {
  it('replicates a note and its edits', () => {
    const [a, b] = pair();
    const { id, ops } = a.createNote({ x: 3, y: 4, color: 'blue', text: 'hello' });
    b.applyRemote(ops);
    expect(b.getNote(id)).toEqual(a.getNote(id));
    b.applyRemote(a.editText(id, 5, 0, ' world'));
    a.applyRemote(b.moveNote(id, 9, 9));
    a.applyRemote(b.setColor(id, 'pink'));
    expect(a.getNote(id)).toEqual({ id, x: 9, y: 9, color: 'pink', z: 1, text: 'hello world' });
    expectConverged(a, b);
  });

  it('lets the later of two concurrent writes win for every field, whichever replica made it', () => {
    for (const laterIsA of [true, false]) {
      const { board: a, clock: clockA } = newBoard('a');
      const { board: b, clock: clockB } = newBoard('b');
      const { id, ops } = a.createNote();
      b.applyRemote(ops);
      (laterIsA ? clockA : clockB).advance(10_000);
      const fromA = [...a.moveNote(id, 1, 2), ...a.setColor(id, 'pink')];
      const fromB = [...b.moveNote(id, 3, 4), ...b.setColor(id, 'blue')];
      a.applyRemote(fromB);
      b.applyRemote(fromA);
      const winner = laterIsA ? { x: 1, y: 2, color: 'pink' } : { x: 3, y: 4, color: 'blue' };
      expect(a.getNote(id)).toMatchObject(winner);
      expect(b.getNote(id)).toMatchObject(winner);
      expectConverged(a, b);
    }
  });

  it('writes x and y of one move with the same timestamp, so concurrent moves cannot tear', () => {
    const board = boardOf('a');
    const { id } = board.createNote();
    const op = must(board.moveNote(id, 1, 2)[0]);
    if (op.type !== 'notes' || op.op.type !== 'put') throw new Error('expected a note write');
    const { x, y, z, color } = op.op.value;
    expect(x.timestamp).toEqual(y.timestamp);
    expect(x.timestamp).not.toEqual(z.timestamp); // z and colour keep their older timestamp
    expect(color.timestamp).toEqual(z.timestamp);
  });

  it('lets a move made after seeing another win even if its clock is behind', () => {
    const { board: a } = newBoard('a', 5000);
    const { board: b } = newBoard('b', 1000);
    const { id, ops } = a.createNote();
    b.applyRemote(ops);
    a.applyRemote(b.moveNote(id, 1, 1));
    const fromA = a.moveNote(id, 2, 2);
    b.applyRemote(fromA);
    const fromB = b.moveNote(id, 3, 3); // b has seen a's move, so this must win
    a.applyRemote(fromB);
    expect(a.getNote(id)).toMatchObject({ x: 3, y: 3 });
    expectConverged(a, b);
  });

  it('keeps concurrent changes to different fields of one note', () => {
    const [a, b] = pair();
    const { id, ops } = a.createNote();
    b.applyRemote(ops);
    const move = a.moveNote(id, 7, 8);
    const colour = b.setColor(id, 'purple');
    const front = b.bringToFront(id);
    a.applyRemote([...colour, ...front]);
    b.applyRemote(move);
    expect(a.getNote(id)).toMatchObject({ x: 7, y: 8, color: 'purple', z: 2 });
    expectConverged(a, b);
  });

  it('does not interleave words typed into the same note at the same position', () => {
    const [a, b] = pair();
    const { id, ops } = a.createNote({ text: '[]' });
    b.applyRemote(ops);
    const fromA = a.editText(id, 1, 0, 'alpha');
    const fromB = b.editText(id, 1, 0, 'OMEGA');
    a.applyRemote(fromB);
    b.applyRemote(fromA);
    expect(['[alphaOMEGA]', '[OMEGAalpha]']).toContain(must(a.getNote(id)).text);
    expectConverged(a, b);
  });

  describe('editing a note while another replica concurrently deletes it', () => {
    function setup() {
      const [a, b] = pair();
      const { id, ops } = a.createNote({ x: 5, y: 6, color: 'green', text: 'hello' });
      b.applyRemote(ops);
      return { a, b, id };
    }

    it('keeps the note, with the edit (add wins), whichever arrives first', () => {
      for (const deleteFirst of [true, false]) {
        const { a, b, id } = setup();
        const deletion = a.deleteNote(id);
        const edit = b.editText(id, 5, 0, ' world');
        if (deleteFirst) {
          b.applyRemote(deletion);
          a.applyRemote(edit);
        } else {
          a.applyRemote(edit);
          b.applyRemote(deletion);
        }
        for (const board of [a, b]) {
          expect(board.getNote(id)).toEqual({
            id,
            x: 5,
            y: 6,
            color: 'green',
            z: 1,
            text: 'hello world',
          });
        }
        expectConverged(a, b);
      }
    });

    it('keeps the note when the edit deletes characters', () => {
      const { a, b, id } = setup();
      const deletion = a.deleteNote(id);
      const edit = b.editText(id, 0, 5, 'bye');
      a.applyRemote(edit);
      b.applyRemote(deletion);
      expect(must(a.getNote(id)).text).toBe('bye');
      expectConverged(a, b);
    });

    it('keeps the note after a concurrent move or recolour too', () => {
      const { a, b, id } = setup();
      const deletion = a.deleteNote(id);
      const move = b.moveNote(id, 50, 60);
      a.applyRemote(move);
      b.applyRemote(deletion);
      expect(a.getNote(id)).toMatchObject({ x: 50, y: 60, text: 'hello' });
      expectConverged(a, b);
    });

    it('lets two concurrent deletes delete the note', () => {
      const { a, b, id } = setup();
      const fromA = a.deleteNote(id);
      const fromB = b.deleteNote(id);
      a.applyRemote(fromB);
      b.applyRemote(fromA);
      expect(a.size).toBe(0);
      expectConverged(a, b);
    });

    it('keeps the note deleted when the delete came after the edit', () => {
      const { a, b, id } = setup();
      const edit = b.editText(id, 5, 0, '!');
      a.applyRemote(edit);
      const deletion = a.deleteNote(id);
      b.applyRemote(deletion);
      expect(a.size).toBe(0);
      expect(b.size).toBe(0);
      expectConverged(a, b);
    });

    it('rejects an edit made after the delete was seen', () => {
      const { a, b, id } = setup();
      b.applyRemote(a.deleteNote(id));
      expect(() => b.editText(id, 0, 0, 'x')).toThrow(UnknownNoteError);
    });

    it('keeps text typed by a third replica, which sees the delete and the edit in any order', () => {
      const { a, b, id } = setup();
      const c = boardOf('c');
      c.applyRemote(a.log);
      const deletion = a.deleteNote(id);
      const edit = b.editText(id, 5, 0, '!');
      const other = c.editText(id, 0, 0, '>');
      for (const board of [a, b, c]) board.applyRemote([...deletion, ...edit, ...other]);
      expect(must(a.getNote(id)).text).toBe('>hello!');
      expectConverged(a, b, c);
    });
  });
});

describe('Board: out-of-order and repeated delivery', () => {
  it('holds operations until the ones they depend on arrive', () => {
    const [a, b] = pair();
    const { id, ops } = a.createNote({ text: 'ab' });
    const moves = a.moveNote(id, 1, 1);
    const edits = a.editText(id, 2, 0, 'c');
    const all = [...ops, ...moves, ...edits];
    for (const op of [...all].reverse()) b.applyRemote([op]);
    expect(b.pendingCount).toBe(0);
    expect(b.getNote(id)).toEqual(a.getNote(id));
    expectConverged(a, b);
  });

  it('holds a write until the earlier writes of its replica have arrived', () => {
    const [a, b] = pair();
    const { id, ops } = a.createNote();
    const first = a.moveNote(id, 1, 1);
    const second = a.moveNote(id, 2, 2);
    b.applyRemote(second);
    expect(b.pendingCount).toBe(1);
    expect(b.size).toBe(0);
    b.applyRemote(first);
    expect(b.pendingCount).toBe(2);
    b.applyRemote(ops);
    expect(b.pendingCount).toBe(0);
    expect(b.getNote(id)).toMatchObject({ x: 2, y: 2 });
  });

  it('ignores operations it has already applied, its own included', () => {
    const [a, b] = pair();
    const { id, ops } = a.createNote({ text: 'x' });
    const edit = a.editText(id, 1, 0, 'y');
    b.applyRemote(ops);
    b.applyRemote([...ops, ...edit]);
    b.applyRemote(edit);
    a.applyRemote([...ops, ...edit]);
    expect(b.log).toHaveLength(a.log.length);
    expect(a.log).toHaveLength(ops.length + edit.length);
    expectConverged(a, b);
  });

  it('rejects malformed operations without applying any in the batch', () => {
    const [a, b] = pair();
    const { id, ops } = a.createNote({ text: 'x' });
    const bad: BoardOp = {
      type: 'text',
      noteId: id,
      op: {
        type: 'insert',
        id: { counter: 9, replicaId: replicaId('a') },
        parent: null,
        side: 'right',
        value: 'too long',
      },
    };
    expect(() => b.applyRemote([...ops, bad])).toThrow(RangeError);
    expect(b.size).toBe(0);
    expect(b.log).toEqual([]);
  });

  it('converges for any arrival order of a random history', () => {
    const steps = fc.array(stepArb, { maxLength: 30 });
    fc.assert(
      fc.property(
        steps.chain((script) => {
          const log = simulate(script);
          return fc.tuple(
            fc.constant(log),
            fc.shuffledSubarray(log, { minLength: log.length, maxLength: log.length }),
          );
        }),
        ([log, arrival]) => {
          const inOrder = boardOf('x');
          inOrder.applyRemote(log);
          const shuffled = boardOf('y');
          for (const op of arrival) shuffled.applyRemote([op]);
          expect(shuffled.pendingCount).toBe(0);
          expect(state(shuffled)).toBe(state(inOrder));

          // The op log of the shuffled replica is itself a valid order to replay.
          const replay = boardOf('z');
          for (const op of shuffled.log) {
            replay.applyRemote([op]);
            expect(replay.pendingCount).toBe(0);
          }
          expect(state(replay)).toBe(state(inOrder));
        },
      ),
    );
  });
});

describe('Board: op log and JSON', () => {
  it('logs every applied operation once, in the order it took effect', () => {
    const [a, b] = pair();
    const { id, ops } = a.createNote({ text: 'hi' });
    expect(a.log).toEqual(ops);
    const edit = a.editText(id, 2, 0, '!');
    const moved = a.moveNote(id, 1, 1);
    expect(a.log).toEqual([...ops, ...edit, ...moved]);

    // Delivered newest first, b still logs each operation once, in an order that replays cleanly.
    b.applyRemote([...moved, ...edit, ...ops]);
    expect(b.log).toHaveLength(a.log.length);
    const replay = boardOf('c');
    for (const op of b.log) {
      replay.applyRemote([op]);
      expect(replay.pendingCount).toBe(0);
    }
    expectConverged(a, b, replay);
  });

  it('does not log operations that change nothing', () => {
    const [a, b] = pair();
    const { id, ops } = a.createNote({ text: 'hi' });
    b.applyRemote(ops);
    const remove = a.deleteNote(id);
    b.applyRemote(remove);
    const logged = b.log.length;
    b.applyRemote(remove);
    b.applyRemote(ops);
    expect(b.log).toHaveLength(logged);
  });

  it('serialises to JSON and back without losing anything', () => {
    const [a, b] = pair();
    const { id, ops } = a.createNote({ x: 3, y: 4, color: 'orange', text: 'héllo 😀' });
    b.applyRemote(ops);
    b.applyRemote(a.editText(id, 1, 2, 'EY'));
    a.applyRemote(b.moveNote(id, -1.5, 99));
    a.applyRemote(b.setColor(id, 'blue'));
    const other = b.createNote({ text: 'second' });
    a.applyRemote(other.ops);
    a.deleteNote(other.id);

    const json = a.serializeLog();
    const restored = deserializeBoardOps(json);
    expect(logJson(restored)).toEqual(logJson(a.log));

    const copy = boardOf('c');
    copy.applyRemote(restored);
    expect(state(copy)).toBe(state(a));
    expect(copy.serializeLog()).toBe(json);
    expect(copy.getNote(id)).toEqual(a.getNote(id));
    expect(copy.getNote(other.id)).toBeUndefined();
  });

  it('restores a replica from its own log and keeps its numbering and clock ahead', () => {
    const { board: a } = newBoard('a', 5000);
    const { id } = a.createNote({ text: 'hi' });
    a.moveNote(id, 7, 8);
    a.editText(id, 2, 0, '!');

    // Same replica id, but this device's clock is far behind the log.
    const restored = boardOf('a', 0);
    restored.applyRemote(deserializeBoardOps(a.serializeLog()));
    expect(state(restored)).toBe(state(a));

    restored.moveNote(id, 1, 1);
    expect(restored.getNote(id)).toMatchObject({ x: 1, y: 1 });
    expect(restored.createNote().id).toBe('5@a');
    restored.editText(id, 3, 0, '?');
    expect(must(restored.getNote(id)).text).toBe('hi!?');
  });

  it('replays a log into a board that already has some of it', () => {
    const [a, b] = pair();
    const { ops } = a.createNote({ text: 'x' });
    b.applyRemote(ops);
    a.moveNote(must(a.notes()[0]).id, 5, 5);
    b.applyRemote(deserializeBoardOps(a.serializeLog()));
    expectConverged(a, b);
  });
});

describe('Board: change subscription', () => {
  it('reports each local call once, with the operations it returned', () => {
    const board = boardOf('a');
    const events: BoardChange[] = [];
    board.subscribe((change) => events.push(change));

    const { id, ops } = board.createNote({ text: 'hi' });
    const edit = board.editText(id, 2, 0, '!');
    board.editText(id, 0, 0, '');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ source: 'local', noteIds: [id] });
    expect(events[0]?.ops).toEqual(ops);
    expect(events[1]?.ops).toEqual(edit);
  });

  it('reports a batch of remote operations once, listing every note it touched', () => {
    const [a, b] = pair();
    const events: BoardChange[] = [];
    b.subscribe((change) => events.push(change));

    const first = a.createNote({ text: 'one' });
    const second = a.createNote({ text: 'two' });
    const batch = [...second.ops, ...first.ops, ...a.moveNote(first.id, 1, 1)];
    b.applyRemote(batch);

    expect(events).toHaveLength(1);
    const event = must(events[0]);
    expect(event.source).toBe('remote');
    expect(event.noteIds).toEqual([first.id, second.id]);
    expect(event.ops).toHaveLength(batch.length);
  });

  it('stays quiet for duplicates and empty batches', () => {
    const [a, b] = pair();
    const { ops } = a.createNote();
    b.applyRemote(ops);
    let count = 0;
    b.subscribe(() => {
      count += 1;
    });
    b.applyRemote(ops);
    b.applyRemote([]);
    expect(count).toBe(0);
  });

  it('shows listeners the state after the change', () => {
    const board = boardOf('a');
    const seen: (string | undefined)[] = [];
    board.subscribe((change) => {
      for (const id of change.noteIds) seen.push(board.getNote(id)?.text);
    });
    const { id } = board.createNote({ text: 'hi' });
    board.editText(id, 2, 0, '!');
    board.deleteNote(id);
    expect(seen).toEqual(['hi', 'hi!', undefined]);
  });

  it('unsubscribes, including from inside a listener, and allows the same listener twice', () => {
    const board = boardOf('a');
    const calls: string[] = [];
    const stop = board.subscribe(() => calls.push('first'));
    const once = board.subscribe(() => {
      calls.push('once');
      once();
    });
    const listener = () => calls.push('twice');
    board.subscribe(listener);
    board.subscribe(listener);

    board.createNote();
    expect(calls).toEqual(['first', 'once', 'twice', 'twice']);
    stop();
    calls.length = 0;
    board.createNote();
    expect(calls).toEqual(['twice', 'twice']);
  });

  it('runs every listener even if one throws, then reports the error; the change stays applied', () => {
    const board = boardOf('a');
    const { id } = board.createNote();
    const seen: string[] = [];
    board.subscribe(() => {
      throw new Error('boom');
    });
    board.subscribe(() => seen.push('second'));

    expect(() => board.moveNote(id, 4, 4)).toThrow('boom');
    expect(seen).toEqual(['second']);
    expect(board.getNote(id)).toMatchObject({ x: 4, y: 4 });
    expect(board.log).toHaveLength(2);

    board.subscribe(() => {
      throw new Error('bang');
    });
    expect(() => board.moveNote(id, 5, 5)).toThrow(AggregateError);
  });

  it('applies remote operations fully even if a listener throws', () => {
    const [a, b] = pair();
    b.subscribe(() => {
      throw new Error('boom');
    });
    const { id, ops } = a.createNote({ text: 'x' });
    expect(() => b.applyRemote(ops)).toThrow('boom');
    expect(b.getNote(id)).toEqual(a.getNote(id));
    expect(b.log).toHaveLength(ops.length);
  });
});

describe('Board convergence harness', () => {
  const spec: CheckableSpec<Board, BoardOp, Intent> = {
    name: 'Board',
    intentArb,
    idempotentApply: true,
    create: (replica, ctx) => new Board({ replicaId: replica, clock: ctx.physicalClock }),
    // The board applies its own changes locally and returns the operations; the harness then
    // applies them once more, which is a no-op.
    prepare: (board, intent) => applyIntent(board, intent),
    apply: (board, op) => {
      board.applyRemote([op]);
      return board;
    },
    snapshot: (board) => board.snapshot(),
  };

  it('converges over 1000 random whole-board scenarios', { timeout: 300_000 }, () => {
    const summary = checkConvergence(spec, { numRuns: 1000, replicas: { min: 3, max: 5 } });
    expect(summary.runs).toBe(1000);
    expect(summary.maxReplicas).toBe(5);
    expect(summary.ops).toBeGreaterThan(0);
    expect(summary.concurrentPairs).toBeGreaterThan(0);
    expect(summary.redeliveries).toBeGreaterThan(0);
  });
});
