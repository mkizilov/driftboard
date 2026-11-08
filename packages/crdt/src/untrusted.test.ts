import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Board } from './board';
import { boardOpFromJson } from './board-json';
import { assertValidBoardOp, type BoardOp } from './board-ops';
import { CausalBuffer, PendingBudget, PendingLimitError } from './causal-buffer';
import { createManualClock } from './clock';
import { MAX_OP_REFS } from './limits';
import { opId, opIdKey, type OpId } from './op-id';
import { replicaId } from './replica-id';
import { TextSequence, TextTooLongError, type TextInsertOp } from './text-sequence';

const a = replicaId('a');
const m = replicaId('mallory');

const boardOf = (name: string, options: { maxPendingOps?: number; maxNoteNodes?: number } = {}) =>
  new Board({ replicaId: replicaId(name), clock: createManualClock(1000), ...options });

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/** A text insert as a hostile peer would write it by hand. */
const insert = (
  noteId: string,
  counter: number,
  parent: OpId | null,
  value: string,
  by = m,
): BoardOp => ({
  type: 'text',
  noteId,
  op: { type: 'insert', id: opId(counter, by), parent, side: 'right', value },
});

/** The visible text of a note's sequence, whether or not the note itself exists. */
const textOf = (board: Board, noteId: string): string =>
  board
    .textNodes(noteId)
    .filter((node) => !node.deleted)
    .map((node) => node.value)
    .join('');

interface TestOp {
  readonly id: OpId;
  readonly needs: readonly OpId[];
}
const top = (n: number, ...needs: number[]): TestOp => ({
  id: opId(n, a),
  needs: needs.map((need) => opId(need, a)),
});

function buffers(limit: number, count = 1) {
  const budget = new PendingBudget(limit);
  const applied = new Set<string>();
  const made = Array.from({ length: count }, () => {
    const buffer = new CausalBuffer<TestOp>({
      budget,
      provides: (o) => o.id,
      requires: (o) => o.needs,
      isApplied: (dep) => applied.has(opIdKey(dep)),
    });
    const receive = (o: TestOp, reject?: (o: TestOp, error: unknown) => void) =>
      buffer.receive(
        o,
        (ready) => {
          applied.add(opIdKey(ready.id));
        },
        reject,
      );
    return { buffer, receive };
  });
  return { budget, made };
}

describe('CausalBuffer with a budget', () => {
  it('refuses to hold more operations than the budget allows, and keeps counting right', () => {
    const { budget, made } = buffers(2);
    const { buffer, receive } = must(made[0]);
    receive(top(10, 1));
    receive(top(11, 2));
    expect(budget.used).toBe(2);
    expect(() => receive(top(12, 3))).toThrow(PendingLimitError);
    expect(buffer.size).toBe(2);
    expect(budget.used).toBe(2);
    receive(top(1));
    expect(buffer.size).toBe(1);
    expect(budget.used).toBe(1);
    receive(top(2));
    expect(buffer.size).toBe(0);
    expect(budget.used).toBe(0);
  });

  it('shares one budget between buffers', () => {
    const { budget, made } = buffers(3, 2);
    const [first, second] = [must(made[0]), must(made[1])];
    first.receive(top(10, 1));
    first.receive(top(11, 1));
    second.receive(top(12, 2));
    expect(budget.used).toBe(3);
    expect(() => second.receive(top(13, 2))).toThrow(PendingLimitError);
    expect(() => first.receive(top(14, 3))).toThrow(PendingLimitError);
  });

  it('hands a refused operation to reject and carries on with the others', () => {
    const { budget, made } = buffers(1);
    const { receive } = must(made[0]);
    const rejected: number[] = [];
    const reject = (o: TestOp) => rejected.push(o.id.counter);
    receive(top(10, 1), reject);
    receive(top(11, 1), reject);
    receive(top(12, 1), reject);
    expect(rejected).toEqual([11, 12]);
    expect(budget.used).toBe(1);
    expect(receive(top(1), reject)).toBe(2);
    expect(budget.used).toBe(0);
  });

  it('with reject, refuses what waits for a refused operation, and frees its places', () => {
    const budget = new PendingBudget(10);
    const known = new Set<string>();
    const buffer = new CausalBuffer<TestOp>({
      budget,
      provides: (o) => o.id,
      requires: (o) => o.needs,
      isApplied: (dep) => known.has(opIdKey(dep)),
    });
    const rejected: number[] = [];
    const apply = (ready: TestOp) => {
      if (ready.id.counter === 1) throw new Error('cannot apply 1');
      known.add(opIdKey(ready.id));
    };
    const reject = (o: TestOp) => rejected.push(o.id.counter);
    // 3 waits for 2, 2 and 4 wait for 1, 5 waits for something else.
    for (const o of [top(3, 2), top(2, 1), top(4, 1), top(5, 9)]) buffer.receive(o, apply, reject);
    expect(budget.used).toBe(4);
    buffer.receive(top(1), apply, reject);
    expect(rejected.sort()).toEqual([1, 2, 3, 4]);
    expect(buffer.size).toBe(1);
    expect(budget.used).toBe(1);
    // What arrives later and needs a refused operation is refused at once, not held.
    buffer.receive(top(6, 4), apply, reject);
    expect(rejected).toContain(6);
    expect(buffer.size).toBe(1);
    expect(budget.used).toBe(1);
  });

  it('with reject, a failing apply does not hold up the operations released with it', () => {
    const applied: number[] = [];
    const rejected: number[] = [];
    const known = new Set<string>();
    const buffer = new CausalBuffer<TestOp>({
      provides: (o) => o.id,
      requires: (o) => o.needs,
      isApplied: (dep) => known.has(opIdKey(dep)),
    });
    const apply = (ready: TestOp) => {
      if (ready.id.counter === 2) throw new Error('cannot apply 2');
      known.add(opIdKey(ready.id));
      applied.push(ready.id.counter);
    };
    const reject = (o: TestOp) => rejected.push(o.id.counter);
    buffer.receive(top(2, 1), apply, reject);
    buffer.receive(top(3, 1), apply, reject);
    expect(buffer.receive(top(1), apply, reject)).toBe(2);
    expect(applied).toEqual([1, 3]);
    expect(rejected).toEqual([2]);
    expect(buffer.size).toBe(0);
  });
});

describe('TextSequence with a limit on its size', () => {
  it('refuses a local insert that does not fit, and changes nothing', () => {
    const s = new TextSequence(a, { maxNodes: 5 });
    s.insert(0, 'abc');
    expect(() => s.insert(3, 'def')).toThrow(TextTooLongError);
    expect(s.toString()).toBe('abc');
    expect(s.size).toBe(3);
    s.insert(3, 'de');
    expect(s.size).toBe(5);
    expect(() => s.insert(0, 'x')).toThrow(RangeError);
  });

  it('counts code points, and deleted characters too', () => {
    const s = new TextSequence(a, { maxNodes: 4 });
    s.insert(0, '😀😀');
    s.delete(0, 2);
    expect(s.length).toBe(0);
    expect(s.size).toBe(2);
    expect(() => s.insert(0, '123')).toThrow(TextTooLongError);
    expect(s.insert(0, '12')).toHaveLength(2);
  });

  it('refuses a remote insert beyond the limit and hands it to onReject', () => {
    const source = new TextSequence(a);
    const ops = source.insert(0, 'abcdef');
    const target = new TextSequence(replicaId('b'), { maxNodes: 4 });
    const rejected: unknown[] = [];
    for (const op of ops) target.apply(op, undefined, (failed) => rejected.push(failed));
    expect(target.toString()).toBe('abcd');
    expect(rejected).toHaveLength(2);
    expect(() => target.apply(must(ops[4]))).toThrow(TextTooLongError);
  });

  it('does not count an insert it already has', () => {
    const source = new TextSequence(a);
    const ops = source.insert(0, 'abc');
    const target = new TextSequence(replicaId('b'), { maxNodes: 3 });
    for (const op of ops) target.apply(op);
    for (const op of ops) target.apply(op);
    expect(target.toString()).toBe('abc');
  });

  it('still tells a repeated insert from a different one under the same id', () => {
    const op: TextInsertOp = {
      type: 'insert',
      id: opId(1, m),
      parent: null,
      side: 'right',
      value: 'x',
    };
    const s = new TextSequence(a);
    s.apply(op);
    expect(() => s.apply({ ...op })).not.toThrow();
    expect(() => s.apply({ ...op, value: 'y' })).toThrow(RangeError);
  });
});

describe('the ids an operation refers to', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}@a`);
  const field = (value: unknown) => ({ value, at: '000000000001-0000-a' });
  const put = (supersedes: string[]) => ({
    type: 'note-put',
    noteId: '1@a',
    dot: '1@a',
    supersedes,
    fields: { x: field(1), y: field(1), z: field(1), color: field('yellow') },
  });

  it('may not be more than MAX_OP_REFS, which is checked before they are read', () => {
    expect(() => boardOpFromJson(put(ids(MAX_OP_REFS + 1)))).toThrow(/more than/);
    expect(() =>
      boardOpFromJson({ type: 'note-remove', noteId: '1@a', dots: ids(MAX_OP_REFS + 1) }),
    ).toThrow(/more than/);
    expect(boardOpFromJson(put(ids(MAX_OP_REFS)))).toMatchObject({ type: 'notes' });
  });

  it('are checked by assertValidBoardOp too', () => {
    const op = boardOpFromJson(put(ids(3)));
    const inner = op.type === 'notes' ? op.op : undefined;
    if (inner?.type !== 'put') throw new Error('expected a put');
    const refs = Array.from({ length: MAX_OP_REFS + 1 }, (_, i) => opId(i + 1, a));
    expect(() => assertValidBoardOp({ type: 'notes', op: { ...inner, supersedes: refs } })).toThrow(
      RangeError,
    );
  });
});

describe('Board.applyUntrusted', () => {
  const junk: unknown[] = [
    null,
    undefined,
    42,
    'text',
    [],
    {},
    { type: 'text' },
    { type: 'text', noteId: '', op: { type: 'delete', target: opId(1, m) } },
    { type: 'text', noteId: 'n', op: null },
    { type: 'text', noteId: 'n', op: { type: 'insert' } },
    { type: 'text', noteId: 'n', op: { type: 'delete', target: { counter: -1, replicaId: m } } },
    { type: 'notes', op: null },
    { type: 'notes', op: { type: 'put', key: 'n' } },
    { type: 'notes', op: { type: 'remove', key: 'n', dots: 'x' } },
    insert('n', 1, null, 'too long'),
    {
      type: 'text',
      noteId: 'n',
      op: {
        type: 'insert',
        id: { counter: 0, replicaId: m },
        parent: null,
        side: 'right',
        value: 'x',
      },
    },
    insert('n', 1, opId(1, m), ''),
  ];

  it('never throws for junk, sets it aside, and goes on with the valid operations', () => {
    const author = boardOf('a');
    const { id, ops } = author.createNote({ text: 'hi' });
    const target = boardOf('b');
    const rejected = target.applyUntrusted([...junk, ...ops, ...junk]);
    expect(rejected).toHaveLength(junk.length * 2);
    expect(target.quarantinedCount).toBe(junk.length * 2);
    expect(target.getNote(id)).toEqual(author.getNote(id));
    expect(rejected.every((entry) => entry.reason.length > 0 && entry.reason.length <= 200)).toBe(
      true,
    );
  });

  it('keeps the first of two different characters under one id and sets the second aside', () => {
    const board = boardOf('b');
    const { id, ops } = boardOf('a').createNote({ text: 'x' });
    board.applyUntrusted(ops);
    const first = must(ops.find((op) => op.type === 'text'));
    if (first.type !== 'text' || first.op.type !== 'insert') throw new Error('expected an insert');
    const forged: BoardOp = { ...first, op: { ...first.op, value: 'y' } };
    const rejected = board.applyUntrusted([forged]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatch(/Conflicting inserts/);
    expect(textOf(board, id)).toBe('x');
    // The strict entry point still throws, as it always did.
    expect(() => board.applyRemote([forged])).toThrow(RangeError);
  });

  it('refuses a text that grows past the limit, and applies what fits', () => {
    const { id, ops } = boardOf('a').createNote({ text: 'abcdefgh' });
    const board = boardOf('b', { maxNoteNodes: 5 });
    const rejected = board.applyUntrusted(ops);
    expect(rejected).toHaveLength(3);
    expect(rejected[0]?.reason).toMatch(/at most 5 characters/);
    expect(textOf(board, id)).toBe('abcde');
  });

  it('holds back operations that wait for others, up to the limit, then sets the rest aside', () => {
    const board = boardOf('b', { maxPendingOps: 3 });
    const missing = opId(99, m);
    const children = [1, 2, 3, 4, 5].map((n) => insert('n', n, missing, 'c'));
    const rejected = board.applyUntrusted(children);
    expect(board.pendingCount).toBe(3);
    expect(rejected).toHaveLength(2);
    expect(rejected[0]?.reason).toMatch(/waiting for others/);

    // The missing parent arrives: the three that were held are applied, and the count goes down.
    expect(board.applyUntrusted([insert('n', 99, null, 'p')])).toEqual([]);
    expect(board.pendingCount).toBe(0);
    expect(textOf(board, 'n')).toBe('pccc');
  });

  it('counts the operations waiting in every note against one limit', () => {
    const board = boardOf('b', { maxPendingOps: 4 });
    const missing = opId(99, m);
    const rejected = board.applyUntrusted(
      ['n1', 'n2', 'n3'].flatMap((note) => [
        insert(note, 1, missing, 'a'),
        insert(note, 2, missing, 'b'),
      ]),
    );
    expect(board.pendingCount).toBe(4);
    expect(rejected).toHaveLength(2);
  });

  it('remembers only the last hundred set-aside operations but counts them all', () => {
    const board = boardOf('b');
    board.applyUntrusted(Array.from({ length: 250 }, () => null));
    expect(board.quarantine).toHaveLength(100);
    expect(board.quarantinedCount).toBe(250);
  });

  it('still reports an error thrown by a subscriber, after applying the change', () => {
    const board = boardOf('b');
    board.subscribe(() => {
      throw new Error('boom');
    });
    const { id, ops } = boardOf('a').createNote({ text: 'x' });
    expect(() => board.applyUntrusted(ops)).toThrow('boom');
    expect(textOf(board, id)).toBe('x');
  });

  it('refuses an edit that does not fit before it changes anything', () => {
    const board = boardOf('a', { maxNoteNodes: 4 });
    const { id } = board.createNote({ text: 'abc' });
    const before = board.log.length;
    expect(() => board.editText(id, 0, 2, 'xyz')).toThrow(TextTooLongError);
    expect(board.log).toHaveLength(before);
    expect(textOf(board, id)).toBe('abc');
    expect(() => board.createNote({ text: 'abcde' })).toThrow(TextTooLongError);
    expect(board.size).toBe(1);
    expect(board.log).toHaveLength(before);
  });

  describe('an operation that refers to an id its replica has not made yet', () => {
    const alice = replicaId('alice');

    it('is applied on every replica once the id exists, the replica itself included', () => {
      const owner = boardOf('alice');
      const { id, ops } = owner.createNote();
      const other = boardOf('bob');
      other.applyRemote(ops);
      // A character that hangs off alice's first character, before alice has typed anything.
      const early = insert(id, 1, opId(1, alice), 'x', m);

      owner.applyUntrusted([early]);
      expect(owner.pendingCount).toBe(1);
      const heard: string[] = [];
      owner.subscribe((change) => heard.push(change.source));
      const mine = owner.editText(id, 0, 0, 'a');

      expect(owner.pendingCount).toBe(0);
      expect(textOf(owner, id)).toBe('ax');
      // What the call returns is the owner's own, to be sent on; the other character is not.
      for (const op of mine) {
        const own =
          op.type === 'text' ? op.op.type === 'insert' && op.op.id.replicaId === alice : true;
        expect(own).toBe(true);
      }
      expect(heard).toEqual(['local', 'remote']);
      expect(owner.log).toContainEqual(early);

      // Another replica that hears of the two in the other order ends up with the same board.
      other.applyUntrusted([early]);
      other.applyUntrusted(mine);
      expect(JSON.stringify(other.snapshot())).toBe(JSON.stringify(owner.snapshot()));
    });

    it('is applied once a write that replaces a dot not yet made is made, on every replica', () => {
      const owner = boardOf('alice');
      const { id, ops } = owner.createNote();
      const fields = must(owner.getFields(id));
      // A write by mallory that replaces alice's second write, which does not exist yet.
      const early: BoardOp = {
        type: 'notes',
        op: { type: 'put', key: id, dot: opId(1, m), supersedes: [opId(2, alice)], value: fields },
      };
      const other = boardOf('bob');
      other.applyRemote(ops);

      owner.applyUntrusted([early]);
      expect(owner.pendingCount).toBe(1);
      const mine = owner.moveNote(id, 5, 5);
      expect(owner.pendingCount).toBe(0);
      expect(mine).toHaveLength(1);

      other.applyUntrusted([early]);
      other.applyUntrusted(mine);
      expect(other.pendingCount).toBe(0);
      expect(JSON.stringify(other.snapshot())).toBe(JSON.stringify(owner.snapshot()));
    });
  });

  it('does not let later hostile operations change what honest ones already built', () => {
    const honest = boardOf('h');
    const { id, ops } = honest.createNote({ text: 'honest' });
    const viewer = boardOf('v');
    viewer.applyUntrusted(ops);
    const hostile: BoardOp[] = [
      // An id that is taken, a parent that never comes, a delete of something that never was.
      insert(id, 1, null, 'z', replicaId('h')),
      insert(id, 7, opId(1000, m), 'q'),
      { type: 'text', noteId: id, op: { type: 'delete', target: opId(5000, m) } },
    ];
    const rejected = viewer.applyUntrusted(hostile);
    expect(rejected).toHaveLength(1);
    expect(viewer.pendingCount).toBe(2);
    expect(viewer.getNote(id)).toEqual(honest.getNote(id));
  });

  it('gives the same result as applyRemote for honest operations in any order, with noise between', () => {
    const edit = fc.record({
      at: fc.nat(),
      remove: fc.integer({ min: 0, max: 2 }),
      text: fc.constantFrom('', 'a', 'bc', '😀'),
    });
    fc.assert(
      fc.property(
        fc.array(edit, { maxLength: 15 }).chain((edits) => {
          const author = boardOf('a');
          const { id, ops } = author.createNote({ text: 'seed' });
          const log: BoardOp[] = [...ops];
          for (const { at, remove, text } of edits) {
            const length = [...textOf(author, id)].length;
            const start = at % (length + 1);
            log.push(...author.editText(id, start, Math.min(remove, length - start), text));
          }
          return fc.tuple(
            fc.constant(id),
            fc.constant(log),
            fc.shuffledSubarray(log, { minLength: log.length, maxLength: log.length }),
          );
        }),
        ([id, log, arrival]) => {
          const trusted = boardOf('t');
          trusted.applyRemote(log);
          const untrusted = boardOf('u');
          for (const op of arrival) untrusted.applyUntrusted([null, op, { type: 'x' }]);
          expect(untrusted.pendingCount).toBe(0);
          expect(JSON.stringify(untrusted.getNote(id))).toBe(JSON.stringify(trusted.getNote(id)));
          expect(JSON.stringify(untrusted.snapshot())).toBe(JSON.stringify(trusted.snapshot()));
        },
      ),
      { numRuns: 100 },
    );
  });
});
