import { describe, expect, it } from 'vitest';
import { AwMap } from './aw-map';
import { Board } from './board';
import { type BoardOp, type NoteColor, type NoteFields } from './board-ops';
import { createManualClock } from './clock';
import { MAX_LOGICAL, hlcTimestamp } from './hlc';
import { LwwRegister } from './lww-register';
import { opId, type OpId } from './op-id';
import { replicaId, type ReplicaId } from './replica-id';
import { TextSequence, type TextInsertOp } from './text-sequence';

/**
 * Cases found by reviewing `packages/crdt` as a sceptic would, each tried rather than argued.
 * `CRDT-REVIEW.md` explains them. The first group were bugs and are fixed; the second are ways in
 * which replicas can still disagree, kept as tests so that they stay true to what the code does,
 * and so that anyone who closes one is told to update the review.
 */

const a = replicaId('a');
const h = replicaId('hostile');
const c = replicaId('c');

const boardAt = (
  name: ReplicaId,
  now: number,
  options: { maxNoteNodes?: number; maxPendingOps?: number } = {},
) => new Board({ replicaId: name, clock: createManualClock(now), ...options });
const state = (board: Board) => JSON.stringify(board.snapshot());
const textOf = (board: Board, noteId: string) =>
  board
    .textNodes(noteId)
    .filter((n) => !n.deleted)
    .map((n) => n.value)
    .join('');

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/** A write by `by` of a note, stamped at the given hybrid time, replacing the dots in `replaces`. */
function stamped(
  noteId: string,
  by: ReplicaId,
  dot: number,
  replaces: OpId[],
  at: { wallMs: number; logical: number },
  color: NoteColor = 'pink',
  x = 1,
): BoardOp {
  const set = <T>(value: T) =>
    LwwRegister.empty<T>().apply({
      type: 'set',
      value,
      timestamp: hlcTimestamp(at.wallMs, at.logical, by),
    });
  const value: NoteFields = { x: set(x), y: set(1), z: set(1), color: set(color) };
  return {
    type: 'notes',
    op: { type: 'put', key: noteId, dot: opId(dot, by), supersedes: replaces, value },
  };
}

describe('fixed: a clock that cannot take a timestamp', () => {
  it('does not leave writes waiting for one that was applied, on the replicas whose clock is behind', () => {
    // alice makes a note. A hostile replica writes it with the largest logical counter there is,
    // at a wall time later than some replicas' clocks and earlier than others'. carol, whose clock
    // is ahead, sees that write and replaces it with a write of her own.
    const alice = boardAt(a, 1000);
    const { id, ops } = alice.createNote();
    const poison = stamped(id, h, 1, [opId(1, a)], { wallMs: 2000, logical: MAX_LOGICAL });
    const carol = boardAt(c, 5000);
    carol.applyRemote(ops);
    carol.applyUntrusted([poison]);
    const reply = carol.setColor(id, 'blue');

    // Two replicas hear it in the same order: the reply first (it has to wait), then the write it
    // replaces. Only their clocks differ.
    const slow = boardAt(replicaId('slow'), 1000);
    const fast = boardAt(replicaId('fast'), 9000);
    for (const replica of [slow, fast]) {
      replica.applyRemote(ops);
      replica.applyUntrusted(reply);
      replica.applyUntrusted([poison]);
    }
    expect(fast.pendingCount).toBe(0);
    expect(slow.pendingCount).toBe(0);
    expect(state(slow)).toBe(state(fast));
    expect(slow.getNote(id)?.color).toBe('blue');
    // The write was applied, so it is not reported as set aside.
    expect(slow.quarantinedCount).toBe(0);
  });

  it('does not make the strict applyRemote throw for a write it has applied', () => {
    const alice = boardAt(a, 1000);
    const { id, ops } = alice.createNote();
    const poison = stamped(id, h, 1, [opId(1, a)], { wallMs: 2000, logical: MAX_LOGICAL });
    const slow = boardAt(replicaId('slow'), 1000);
    slow.applyRemote(ops);
    expect(() => slow.applyRemote([poison])).not.toThrow();
    expect(slow.getNote(id)?.color).toBe('pink');
  });
});

describe('fixed: zero with a sign', () => {
  it('is the same zero on the replica that wrote it and on the ones that hear of it', () => {
    const writer = boardAt(a, 1000);
    const { id, ops } = writer.createNote({ x: -0, y: -0 });
    const moved = writer.moveNote(id, -0, 5);
    const reader = boardAt(c, 1000);
    reader.applyRemote([...ops, ...moved]);
    const [mine, theirs] = [must(writer.getNote(id)), must(reader.getNote(id))];
    expect(Object.is(mine.x, theirs.x)).toBe(true);
    expect(Object.is(mine.y, theirs.y)).toBe(true);
    expect(Object.is(mine.x, 0)).toBe(true);
  });
});

describe('still open: replicas can disagree when the same id is used twice', () => {
  it('for a register, if two different values carry one timestamp, the first to arrive stays', () => {
    const t = hlcTimestamp(10, 0, a);
    const first = LwwRegister.empty<string>().apply({ type: 'set', value: 'one', timestamp: t });
    const second = LwwRegister.empty<string>().apply({ type: 'set', value: 'two', timestamp: t });
    const left = first.apply({ type: 'set', value: 'two', timestamp: t });
    const right = second.apply({ type: 'set', value: 'one', timestamp: t });
    expect(left.value).toBe('one');
    expect(right.value).toBe('two');
  });

  it('for the add-wins map, two different writes under one dot: the first to arrive stays', () => {
    const join = (x: string, y: string) => (x < y ? y : x);
    const put = (value: string) => ({
      type: 'put' as const,
      key: 'k',
      dot: opId(1, a),
      supersedes: [],
      value,
    });
    const left = AwMap.empty<string>(join).apply(put('one')).apply(put('two'));
    const right = AwMap.empty<string>(join).apply(put('two')).apply(put('one'));
    expect(left.get('k')).toBe('one');
    expect(right.get('k')).toBe('two');
  });

  it('for a text, two different characters under one id: the first to arrive stays', () => {
    const insert = (value: string): TextInsertOp => ({
      type: 'insert',
      id: opId(1, a),
      parent: null,
      side: 'right',
      value,
    });
    const left = new TextSequence(c);
    const right = new TextSequence(c);
    left.apply(insert('x'));
    right.apply(insert('y'));
    expect(() => left.apply(insert('y'))).toThrow(RangeError);
    expect(() => right.apply(insert('x'))).toThrow(RangeError);
    expect(left.toString()).toBe('x');
    expect(right.toString()).toBe('y');
  });

  it('for a board, a replica that lost its history and was used again writes a second note 1@r', () => {
    const before = boardAt(a, 1000);
    const first = before.createNote({ x: 1 });
    // The same replica id, started over: the same note id and the same dot for another note.
    const after = boardAt(a, 2000);
    const second = after.createNote({ x: 2 });
    expect(second.id).toBe(first.id);

    const early = boardAt(c, 1000);
    const late = boardAt(replicaId('late'), 1000);
    early.applyRemote(first.ops);
    early.applyRemote(second.ops);
    late.applyRemote(second.ops);
    late.applyRemote(first.ops);
    expect(early.getNote(first.id)?.x).toBe(1);
    expect(late.getNote(first.id)?.x).toBe(2);
  });
});

describe('still open: replicas can disagree when a limit refuses something', () => {
  it('a limit on the characters of a text keeps whichever arrived first', () => {
    const left = boardAt(a, 1000);
    const { id, ops } = left.createNote();
    const typing = (name: ReplicaId, text: string) => {
      const writer = boardAt(name, 1000);
      writer.applyRemote(ops);
      return writer.editText(id, 0, 0, text);
    };
    const fromB = typing(replicaId('b'), 'bb');
    const fromC = typing(c, 'cc');
    const roomForThree = { maxNoteNodes: 3 };
    const one = boardAt(replicaId('one'), 1000, roomForThree);
    const two = boardAt(replicaId('two'), 1000, roomForThree);
    for (const board of [one, two]) board.applyRemote(ops);
    one.applyUntrusted(fromB);
    one.applyUntrusted(fromC);
    two.applyUntrusted(fromC);
    two.applyUntrusted(fromB);
    expect(textOf(one, id).length).toBe(3);
    expect(textOf(two, id).length).toBe(3);
    expect(textOf(one, id)).not.toBe(textOf(two, id));
  });

  it('the limit on writes waiting for others refuses whichever arrived last', () => {
    const missing = opId(9, h);
    const waiting = (counter: number, value: string): BoardOp => ({
      type: 'text',
      noteId: 'n',
      op: { type: 'insert', id: opId(counter, c), parent: missing, side: 'right', value },
    });
    const root: BoardOp = {
      type: 'text',
      noteId: 'n',
      op: { type: 'insert', id: missing, parent: null, side: 'right', value: 'r' },
    };
    const x = waiting(1, 'x');
    const y = waiting(2, 'y');
    const one = boardAt(replicaId('one'), 1000, { maxPendingOps: 1 });
    const two = boardAt(replicaId('two'), 1000, { maxPendingOps: 1 });
    one.applyUntrusted([x, y, root]);
    two.applyUntrusted([y, x, root]);
    expect(textOf(one, 'n')).toBe('rx');
    expect(textOf(two, 'n')).toBe('ry');
  });

  it('the strict applyRemote stops at the first operation it cannot apply and drops the rest', () => {
    const insert = (counter: number, value: string): BoardOp => ({
      type: 'text',
      noteId: 'n',
      op: { type: 'insert', id: opId(counter, a), parent: null, side: 'right', value },
    });
    const stopped = boardAt(c, 1000);
    const piecemeal = boardAt(replicaId('piece'), 1000);
    stopped.applyRemote([insert(1, 'x')]);
    piecemeal.applyRemote([insert(1, 'x')]);
    const batch = [insert(1, 'y'), insert(2, 'z')];
    expect(() => stopped.applyRemote(batch)).toThrow(RangeError);
    expect(() => piecemeal.applyRemote([must(batch[0])])).toThrow(RangeError);
    piecemeal.applyRemote([must(batch[1])]);
    expect(textOf(stopped, 'n')).toBe('x');
    expect(textOf(piecemeal, 'n')).toBe('xz');
  });
});
