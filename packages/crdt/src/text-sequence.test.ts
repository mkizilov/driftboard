import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkConvergence, type CheckableSpec } from './convergence';
import { opId, opIdKey } from './op-id';
import { replicaId } from './replica-id';
import { must } from './test-support';
import { TextSequence, type TextInsertOp, type TextOp } from './text-sequence';

const a = replicaId('a');
const b = replicaId('b');

const seq = (name: string): TextSequence => new TextSequence(replicaId(name));

/** Applies `ops` (in order) to every target. */
function deliver(ops: readonly TextOp[], ...targets: TextSequence[]): void {
  for (const target of targets) for (const op of ops) target.apply(op);
}

/** Creates replicas that all start with the same `base` text, typed by the first one. */
function replicasWith(names: readonly string[], base: string): TextSequence[] {
  const replicas = names.map(seq);
  const [first, ...others] = replicas;
  if (first === undefined) throw new Error('need at least one replica');
  deliver(first.insert(0, base), ...others);
  return replicas;
}

function pairWith(base: string): [TextSequence, TextSequence] {
  const [x, y] = replicasWith(['a', 'b'], base);
  return [must(x), must(y)];
}

function trioWith(base: string): [TextSequence, TextSequence, TextSequence] {
  const [x, y, z] = replicasWith(['a', 'b', 'c'], base);
  return [must(x), must(y), must(z)];
}

/** Sends each batch of operations to every replica except the one that created it. */
function exchange(
  replicas: readonly TextSequence[],
  batches: readonly (readonly TextOp[])[],
): void {
  replicas.forEach((replica, i) => {
    batches.forEach((batch, j) => {
      if (i !== j) deliver(batch, replica);
    });
  });
}

type Direction = 'forward' | 'backward';

/** Types `word` at `index` one character at a time, left to right or right to left. */
function typeWord(
  target: TextSequence,
  index: number,
  word: string,
  direction: Direction,
): TextInsertOp[] {
  const chars = [...word];
  return direction === 'forward'
    ? chars.flatMap((char, i) => target.insert(index + i, char))
    : chars.reverse().flatMap((char) => target.insert(index, char));
}

describe('TextSequence basics', () => {
  it('starts empty', () => {
    const s = seq('a');
    expect(s.toString()).toBe('');
    expect(s.length).toBe(0);
    expect(s.nodes()).toEqual([]);
    expect(s.pendingCount).toBe(0);
  });

  it('returns one insert operation per code point with consecutive counters', () => {
    const s = seq('a');
    const ops = s.insert(0, 'abc');
    expect(ops.map((o) => [o.id.counter, o.id.replicaId, o.value])).toEqual([
      [1, 'a', 'a'],
      [2, 'a', 'b'],
      [3, 'a', 'c'],
    ]);
    expect(s.toString()).toBe('abc');
    expect(must(s.insert(3, 'd')[0]).id.counter).toBe(4);
  });

  it('inserts at the start, in the middle and at the end', () => {
    const s = seq('a');
    s.insert(0, 'abc');
    s.insert(0, 'X');
    expect(s.toString()).toBe('Xabc');
    s.insert(2, 'Y');
    expect(s.toString()).toBe('XaYbc');
    s.insert(5, 'Z');
    expect(s.toString()).toBe('XaYbcZ');
    expect(s.length).toBe(6);
  });

  it('hangs each character on the tree as the Fugue rules say', () => {
    const s = seq('a');
    const [first, second] = s.insert(0, 'ab');
    expect(first).toEqual({
      type: 'insert',
      id: opId(1, a),
      parent: null,
      side: 'right',
      value: 'a',
    });
    expect(second).toEqual({
      type: 'insert',
      id: opId(2, a),
      parent: opId(1, a),
      side: 'right',
      value: 'b',
    });
    // Before 'a': 'a' is the first right child of the start, so the new node is a left child of it.
    expect(s.insert(0, 'X')[0]).toMatchObject({ parent: opId(1, a), side: 'left' });
    // Between 'a' and 'b': 'a' already has a right child, so the new node is a left child of 'b'.
    expect(s.insert(2, 'Y')[0]).toMatchObject({ parent: opId(2, a), side: 'left' });
    // After 'b': 'b' has no right child yet.
    expect(s.insert(4, 'Z')[0]).toMatchObject({ parent: opId(2, a), side: 'right' });
    expect(s.toString()).toBe('XaYbZ');
  });

  it('deletes ranges and keeps tombstones', () => {
    const s = seq('a');
    s.insert(0, 'hello');
    const ops = s.delete(1, 3);
    expect(ops.map((o) => o.target.counter)).toEqual([2, 3, 4]);
    expect(s.toString()).toBe('ho');
    expect(s.length).toBe(2);
    const nodes = s.nodes();
    expect(nodes.map((n) => n.value).join('')).toBe('hello');
    expect(
      nodes
        .filter((n) => n.deleted)
        .map((n) => n.value)
        .join(''),
    ).toBe('ell');
  });

  it('can insert next to and between tombstones', () => {
    const s = seq('a');
    s.insert(0, 'abc');
    s.delete(1, 1);
    s.insert(1, 'X');
    expect(s.toString()).toBe('aXc');
    s.delete(0, 3);
    s.insert(0, 'new');
    expect(s.toString()).toBe('new');
  });

  it('returns no operations for empty inserts and zero-length deletes', () => {
    const s = seq('a');
    s.insert(0, 'ab');
    expect(s.insert(1, '')).toEqual([]);
    expect(s.delete(1, 0)).toEqual([]);
    expect(s.toString()).toBe('ab');
  });

  it('counts code points, not UTF-16 units', () => {
    const s = seq('a');
    s.insert(0, 'a😀b');
    expect(s.length).toBe(3);
    s.insert(2, '!');
    expect(s.toString()).toBe('a😀!b');
    s.delete(1, 1);
    expect(s.toString()).toBe('a!b');
  });

  it('rejects out-of-range indices', () => {
    const s = seq('a');
    s.insert(0, 'ab');
    expect(() => s.insert(3, 'x')).toThrow(RangeError);
    expect(() => s.insert(-1, 'x')).toThrow(RangeError);
    expect(() => s.insert(0.5, 'x')).toThrow(RangeError);
    expect(() => s.delete(1, 2)).toThrow(RangeError);
    expect(() => s.delete(-1, 1)).toThrow(RangeError);
    expect(() => s.delete(0, -1)).toThrow(RangeError);
    expect(s.toString()).toBe('ab');
  });

  it('handles very long runs without recursing', () => {
    const s = seq('a');
    s.insert(0, 'x'.repeat(20_000));
    expect(s.length).toBe(20_000);
    s.insert(0, 'y');
    expect(s.length).toBe(20_001);
  });
});

describe('TextSequence.insertAfter', () => {
  const idOf = (s: TextSequence, index: number) => must(s.nodes()[index]).id;

  it('inserts at the start for null, before text that is already there', () => {
    const s = seq('a');
    s.insert(0, 'bc');
    s.insertAfter(null, 'xy');
    expect(s.toString()).toBe('xybc');
  });

  it('inserts directly after a visible character, in the middle and at the end', () => {
    const s = seq('a');
    s.insert(0, 'abc');
    s.insertAfter(idOf(s, 0), 'X');
    expect(s.toString()).toBe('aXbc');
    s.insertAfter(idOf(s, 3), 'Y');
    expect(s.toString()).toBe('aXbcY');
  });

  it('inserts directly after a deleted character, where its tombstone stands', () => {
    const s = seq('a');
    s.insert(0, 'abcd');
    const b = idOf(s, 1);
    s.delete(1, 2);
    expect(s.toString()).toBe('ad');
    s.insertAfter(b, 'X');
    expect(s.toString()).toBe('aXd');
    // After the tombstone of c instead: still between a and d, but behind the earlier text.
    s.insertAfter(idOf(s, 3), 'Y');
    expect(s.toString()).toBe('aXYd');
  });

  it('goes by the tombstone, which is not where text typed again in its place stands', () => {
    const s = seq('a');
    s.insert(0, 'abc');
    const a1 = idOf(s, 0);
    s.delete(0, 3);
    s.insert(0, 'abc');
    s.insertAfter(a1, 'X');
    // The new abc was typed in front of the old tombstones, so a1 is behind it.
    expect(s.toString()).toBe('abcX');
  });

  it('inserts several characters in order, as one run', () => {
    const s = seq('a');
    s.insert(0, 'ad');
    const ops = s.insertAfter(idOf(s, 0), 'bc');
    expect(s.toString()).toBe('abcd');
    expect(ops.map((op) => op.value)).toEqual(['b', 'c']);
  });

  it('inserts nothing for empty text', () => {
    const s = seq('a');
    s.insert(0, 'ab');
    expect(s.insertAfter(null, '')).toEqual([]);
    expect(s.toString()).toBe('ab');
  });

  it('rejects a character it does not know', () => {
    const s = seq('a');
    s.insert(0, 'ab');
    expect(() => s.insertAfter(opId(99, a), 'x')).toThrow(RangeError);
    expect(s.toString()).toBe('ab');
  });

  it('gives operations that other replicas apply to the same result, even in another order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', 'c', '😀'), { minLength: 1, maxLength: 8 }),
        fc.array(fc.integer({ min: 0, max: 7 }), { maxLength: 6 }),
        fc.nat(),
        (chars, deletions, pick) => {
          const [x, y] = pairWith(chars.join(''));
          for (const at of deletions) {
            if (x.length > 0) deliver(x.delete(at % x.length, 1), y);
          }
          const nodes = x.nodes();
          const chosen = nodes[pick % Math.max(1, nodes.length)];
          const origin = pick % (nodes.length + 1) === 0 || chosen === undefined ? null : chosen.id;
          const ops = x.insertAfter(origin, 'XY');
          deliver([...ops].reverse(), y);
          return x.toString() === y.toString() && x.toString().includes('XY');
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('TextSequence replication', () => {
  it('propagates inserts and deletes', () => {
    const x = seq('a');
    const y = seq('b');
    deliver(x.insert(0, 'hello'), y);
    expect(y.toString()).toBe('hello');
    deliver(y.insert(5, ' world'), x);
    expect(x.toString()).toBe('hello world');
    deliver(x.delete(0, 6), y);
    expect(y.toString()).toBe('world');
    expect(x.nodes()).toEqual(y.nodes());
  });

  it('merges concurrent edits made on different replicas', () => {
    const [x, y] = pairWith('abc');
    const fromX = x.insert(1, 'X');
    const fromY = y.delete(1, 1);
    deliver(fromX, y);
    deliver(fromY, x);
    expect(x.toString()).toBe('aXc');
    expect(y.nodes()).toEqual(x.nodes());
  });

  it('keeps a character typed next to a character that another replica deleted', () => {
    const [x, y] = pairWith('ab');
    const fromX = x.delete(0, 1);
    const fromY = y.insert(1, 'X');
    deliver(fromX, y);
    deliver(fromY, x);
    expect(x.toString()).toBe('Xb');
    expect(y.toString()).toBe('Xb');
  });

  it('ignores operations it has already applied, including its own', () => {
    const s = seq('a');
    const ops = s.insert(0, 'ab');
    const del = s.delete(0, 1);
    deliver([...ops, ...del], s);
    deliver([...ops, ...del], s);
    expect(s.toString()).toBe('b');
    expect(s.pendingCount).toBe(0);
    expect(s.nodes()).toHaveLength(2);
  });

  it('continues numbering after replaying its own earlier operations', () => {
    const ops = seq('a').insert(0, 'abc');
    const restarted = seq('a');
    deliver(ops, restarted);
    expect(must(restarted.insert(3, 'd')[0]).id).toEqual(opId(4, a));
  });

  it('rejects an id reused for a different character', () => {
    const s = seq('a');
    const [op] = s.insert(0, 'x');
    expect(() => s.apply({ ...must(op), value: 'y' })).toThrow(RangeError);
    expect(s.toString()).toBe('x');
  });

  it('rejects malformed operations', () => {
    const s = seq('a');
    const base: TextInsertOp = {
      type: 'insert',
      id: opId(1, b),
      parent: null,
      side: 'right',
      value: 'x',
    };
    const bad: TextOp[] = [
      { ...base, value: '' },
      { ...base, value: 'xy' },
      { ...base, parent: null, side: 'left' },
      { ...base, side: 'up' as unknown as 'left' },
      { ...base, id: { counter: 0, replicaId: b } },
      { ...base, id: { counter: 1, replicaId: 'not valid' as unknown as typeof b } },
      { type: 'delete', target: { counter: 1.5, replicaId: b } },
      { type: 'unknown' } as unknown as TextOp,
    ];
    for (const op of bad) expect(() => s.apply(op)).toThrow(RangeError);
    expect(s.nodes()).toEqual([]);
    expect(s.pendingCount).toBe(0);
  });
});

describe('TextSequence causal delivery', () => {
  it('holds an insert until the character it hangs off arrives', () => {
    const [first, second, third] = seq('a').insert(0, 'abc');
    const s = seq('b');
    s.apply(must(third));
    expect([s.pendingCount, s.toString()]).toEqual([1, '']);
    s.apply(must(second));
    expect([s.pendingCount, s.toString()]).toEqual([2, '']);
    s.apply(must(first));
    expect([s.pendingCount, s.toString()]).toEqual([0, 'abc']);
  });

  it('holds a delete until the character it targets arrives', () => {
    const origin = seq('a');
    const insert = origin.insert(0, 'x');
    const remove = origin.delete(0, 1);
    const s = seq('b');
    deliver(remove, s);
    expect(s.pendingCount).toBe(1);
    deliver(insert, s);
    expect(s.pendingCount).toBe(0);
    expect(s.toString()).toBe('');
    expect(s.nodes().map((n) => n.deleted)).toEqual([true]);
  });

  it('reports each operation that changed the sequence, including held ones it releases', () => {
    const origin = seq('a');
    const [first, second] = origin.insert(0, 'ab');
    const [remove] = origin.delete(0, 1);
    const s = seq('b');
    const applied: TextOp[] = [];
    const record = (op: TextOp): void => {
      applied.push(op);
    };
    s.apply(must(second), record);
    expect(applied).toEqual([]);
    s.apply(must(first), record);
    expect(applied).toEqual([first, second]);
    s.apply(must(first), record); // duplicate insert
    s.apply(must(remove), record);
    s.apply(must(remove), record); // already deleted
    expect(applied).toEqual([first, second, remove]);
  });

  it('holds duplicates of a waiting operation without applying them twice', () => {
    const ops = seq('a').insert(0, 'abc');
    const s = seq('b');
    s.apply(must(ops[2]));
    s.apply(must(ops[2]));
    expect(s.pendingCount).toBe(2);
    deliver([must(ops[1]), must(ops[0])], s);
    expect(s.pendingCount).toBe(0);
    expect(s.toString()).toBe('abc');
    expect(s.nodes()).toHaveLength(3);
  });

  interface Edit {
    replica: number;
    insert: boolean;
    at: number;
    text: string;
    length: number;
    /** Replica to bring up to date with everything created so far after this edit, or -1. */
    syncTo: number;
  }

  const editArb: fc.Arbitrary<Edit> = fc.record({
    replica: fc.integer({ min: 0, max: 2 }),
    insert: fc.boolean(),
    at: fc.nat(),
    text: fc
      .array(fc.constantFrom('a', 'b', 'c', 'd', '😀', 'é'), { minLength: 1, maxLength: 3 })
      .map((chars) => chars.join('')),
    length: fc.integer({ min: 1, max: 3 }),
    syncTo: fc.integer({ min: -1, max: 2 }),
  });

  /** Runs the edits on three replicas and returns every operation in creation order. */
  function simulate(edits: readonly Edit[]): TextOp[] {
    const replicas = [0, 1, 2].map((i) => seq(`r${i}`));
    const log: TextOp[] = [];
    for (const edit of edits) {
      const origin = must(replicas[edit.replica]);
      if (edit.insert) {
        log.push(...origin.insert(edit.at % (origin.length + 1), edit.text));
      } else if (origin.length > 0) {
        const index = edit.at % origin.length;
        log.push(...origin.delete(index, Math.min(edit.length, origin.length - index)));
      }
      if (edit.syncTo >= 0) deliver(log, must(replicas[edit.syncTo]));
    }
    return log;
  }

  it('converges when every operation arrives in an arbitrary order', () => {
    fc.assert(
      fc.property(
        fc.array(editArb, { maxLength: 30 }).chain((edits) => {
          const log = simulate(edits);
          return fc.tuple(
            fc.constant(log),
            fc.shuffledSubarray(log, { minLength: log.length, maxLength: log.length }),
          );
        }),
        ([log, arrival]) => {
          const inOrder = seq('x');
          deliver(log, inOrder);
          const shuffled = seq('y');
          deliver(arrival, shuffled);
          expect(shuffled.pendingCount).toBe(0);
          expect(shuffled.toString()).toBe(inOrder.toString());
          expect(shuffled.nodes()).toEqual(inOrder.nodes());
        },
      ),
    );
  });
});

describe('concurrent typing at the same position', () => {
  const directions: [Direction, Direction][] = [
    ['forward', 'forward'],
    ['backward', 'backward'],
    ['forward', 'backward'],
    ['backward', 'forward'],
  ];
  const places = [
    ['at the start', '[]', 0],
    ['in the middle', '[]', 1],
    ['at the end', '[]', 2],
    ['into empty text', '', 0],
  ] as const;

  for (const [first, second] of directions) {
    for (const [label, base, position] of places) {
      it(`does not interleave two words typed ${first}/${second} ${label}`, () => {
        const [x, y] = pairWith(base);
        const fromX = typeWord(x, position, 'alpha', first);
        const fromY = typeWord(y, position, 'OMEGA', second);
        const head = base.slice(0, position);
        const tail = base.slice(position);
        expect(x.toString()).toBe(`${head}alpha${tail}`);
        exchange([x, y], [fromX, fromY]);

        expect(x.toString()).toBe(y.toString());
        expect([`${head}alphaOMEGA${tail}`, `${head}OMEGAalpha${tail}`]).toContain(x.toString());
        expect(x.nodes()).toEqual(y.nodes());
      });
    }
  }

  it('does not interleave words inserted with a single insert call', () => {
    const [x, y] = pairWith('[]');
    exchange([x, y], [x.insert(1, 'alpha'), y.insert(1, 'OMEGA')]);
    expect(['[alphaOMEGA]', '[OMEGAalpha]']).toContain(x.toString());
    expect(y.toString()).toBe(x.toString());
  });

  it('puts the run whose first character has the smaller id first', () => {
    // 'a' typed the base, so its words start at counter 3; 'b' starts at counter 1.
    const [x, y] = pairWith('[]');
    exchange([x, y], [typeWord(x, 1, 'alpha', 'forward'), typeWord(y, 1, 'OMEGA', 'forward')]);
    expect(x.toString()).toBe('[OMEGAalpha]');
    expect(y.toString()).toBe('[OMEGAalpha]');
  });

  it('keeps three simultaneous words apart, whichever way each was typed', () => {
    const replicas = trioWith('()');
    const [x, y, z] = replicas;
    exchange(replicas, [
      typeWord(x, 1, 'one', 'forward'),
      typeWord(y, 1, 'TWO', 'backward'),
      typeWord(z, 1, '333', 'forward'),
    ]);
    const allowed = [
      '(oneTWO333)',
      '(one333TWO)',
      '(TWOone333)',
      '(TWO333one)',
      '(333oneTWO)',
      '(333TWOone)',
    ];
    expect(allowed).toContain(x.toString());
    expect(y.toString()).toBe(x.toString());
    expect(z.toString()).toBe(x.toString());
  });

  it('keeps words apart when the text next to them has tombstones', () => {
    const [x, y] = pairWith('xyz');
    deliver(x.delete(1, 1), y);
    exchange([x, y], [typeWord(x, 1, 'alpha', 'backward'), typeWord(y, 1, 'OMEGA', 'backward')]);
    expect(['xalphaOMEGAz', 'xOMEGAalphaz']).toContain(x.toString());
    expect(y.toString()).toBe(x.toString());
  });

  it('never interleaves words of distinct letters, for any position and typing direction', () => {
    const wordArb = (alphabet: string) =>
      fc.shuffledSubarray([...alphabet], { minLength: 1 }).map((chars) => chars.join(''));
    const permutations = (words: readonly string[]): string[] =>
      words.length <= 1
        ? [words.join('')]
        : words.flatMap((word, i) =>
            permutations([...words.slice(0, i), ...words.slice(i + 1)]).map((rest) => word + rest),
          );

    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 3 }),
        fc.array(fc.constantFrom('x', 'y', 'z'), { maxLength: 5 }).map((chars) => chars.join('')),
        fc.nat(),
        fc.tuple(wordArb('ABCDE'), wordArb('abcde'), wordArb('12345')),
        fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()),
        (count, base, positionPick, allWords, backward) => {
          const replicas = replicasWith(['a', 'b', 'c'].slice(0, count), base);
          const words = allWords.slice(0, count);
          const position = positionPick % (base.length + 1);
          const batches = replicas.map((replica, i) =>
            typeWord(replica, position, must(words[i]), must(backward[i]) ? 'backward' : 'forward'),
          );
          exchange(replicas, batches);

          const head = base.slice(0, position);
          const tail = base.slice(position);
          const allowed = permutations(words).map((middle) => head + middle + tail);
          for (const replica of replicas) expect(allowed).toContain(replica.toString());
        },
      ),
    );
  });
});

describe('why the sequence is not plain RGA', () => {
  // Plain RGA: a character is inserted *after* one other character (or the start) and siblings
  // are ordered by descending id (Lamport counter, then replica). This model is only used here.
  interface RgaChar {
    readonly counter: number;
    readonly replica: string;
    readonly after: RgaChar | null;
    readonly value: string;
  }

  function rgaText(chars: readonly RgaChar[]): string {
    const children = (parent: RgaChar | null) =>
      chars
        .filter((c) => c.after === parent)
        .sort((p, q) => q.counter - p.counter || (p.replica < q.replica ? 1 : -1));
    const walk = (parent: RgaChar | null): string =>
      children(parent)
        .map((c) => c.value + walk(c))
        .join('');
    return walk(null);
  }

  /** The characters one replica creates when typing `word` at the start of the document. */
  function rgaTyped(replica: string, word: string, direction: Direction): RgaChar[] {
    const chars: RgaChar[] = [];
    let previous: RgaChar | null = null;
    for (const value of direction === 'forward' ? [...word] : [...word].reverse()) {
      // Forward typing continues after the previous character; backward typing always inserts
      // directly after the start, because the cursor stays where it was.
      const char: RgaChar = {
        counter: chars.length + 1,
        replica,
        after: direction === 'forward' ? previous : null,
        value,
      };
      chars.push(char);
      previous = char;
    }
    return chars;
  }

  it('plain RGA keeps forward-typed words together but interleaves backward-typed ones', () => {
    const forward = [...rgaTyped('a', 'abc', 'forward'), ...rgaTyped('b', 'xyz', 'forward')];
    expect(rgaText(forward)).toBe('xyzabc');
    const backward = [...rgaTyped('a', 'abc', 'backward'), ...rgaTyped('b', 'xyz', 'backward')];
    expect(rgaText(backward)).toBe('xaybzc');
  });

  it('this sequence keeps both together', () => {
    for (const direction of ['forward', 'backward'] as const) {
      const [x, y] = pairWith('');
      exchange([x, y], [typeWord(x, 0, 'abc', direction), typeWord(y, 0, 'xyz', direction)]);
      expect(['abcxyz', 'xyzabc']).toContain(x.toString());
      expect(y.toString()).toBe(x.toString());
    }
  });
});

describe('TextSequence convergence harness', () => {
  type Intent =
    | { kind: 'insert'; at: number; text: string }
    | { kind: 'delete'; at: number; length: number };

  // Few distinct characters, including one outside the BMP, so that edits collide often.
  const charArb = fc.constantFrom('a', 'b', 'c', 'd', '😀', 'é');
  const insertIntent = fc.record({
    kind: fc.constant('insert' as const),
    at: fc.nat(),
    text: fc.array(charArb, { minLength: 1, maxLength: 4 }).map((chars) => chars.join('')),
  });
  const deleteIntent = fc.record({
    kind: fc.constant('delete' as const),
    at: fc.nat(),
    length: fc.integer({ min: 1, max: 3 }),
  });

  /** True if `after` is `before`, or `before` with exactly one character added or removed. */
  function changedByAtMostOneCharacter(
    before: readonly string[],
    after: readonly string[],
  ): boolean {
    if (before.length === after.length) return before.every((char, i) => char === after[i]);
    const [longer, shorter] = before.length > after.length ? [before, after] : [after, before];
    if (longer.length !== shorter.length + 1) return false;
    const target = shorter.join('');
    return longer.some(
      (_, k) => [...longer.slice(0, k), ...longer.slice(k + 1)].join('') === target,
    );
  }

  function expectText(state: TextSequence, expected: readonly string[], what: string): void {
    const actual = state.toString();
    if (actual !== expected.join('')) {
      throw new Error(
        `${what} gave ${JSON.stringify(actual)}, expected ${JSON.stringify(expected.join(''))}`,
      );
    }
  }

  const spec: CheckableSpec<TextSequence, TextOp, Intent> = {
    name: 'TextSequence',
    intentArb: fc.oneof(
      { weight: 3, arbitrary: insertIntent },
      { weight: 2, arbitrary: deleteIntent },
    ),
    idempotentApply: true,
    create: (replica) => new TextSequence(replica),
    // `insert` and `delete` apply locally and return the operations to send; the harness applies
    // them once more, which is a no-op. Besides convergence, every local edit must have exactly the
    // intended effect on the text (checked against plain array operations).
    prepare: (state, intent) => {
      const before = [...state.toString()];
      if (intent.kind === 'insert') {
        const index = intent.at % (before.length + 1);
        const ops = state.insert(index, intent.text);
        const expected = [...before.slice(0, index), ...intent.text, ...before.slice(index)];
        expectText(state, expected, `insert(${index}, ${JSON.stringify(intent.text)})`);
        return ops;
      }
      if (before.length === 0) return [];
      const index = intent.at % before.length;
      const count = Math.min(intent.length, before.length - index);
      const ops = state.delete(index, count);
      const expected = [...before.slice(0, index), ...before.slice(index + count)];
      expectText(state, expected, `delete(${index}, ${count})`);
      return ops;
    },
    // A remote operation may add or remove one character but never moves existing ones.
    apply: (state, op) => {
      const before = [...state.toString()];
      state.apply(op);
      if (!changedByAtMostOneCharacter(before, [...state.toString()])) {
        throw new Error(`applying ${JSON.stringify(op)} reordered the text`);
      }
      return state;
    },
    snapshot: (state) => ({
      text: state.toString(),
      pending: state.pendingCount,
      nodes: state
        .nodes()
        .map((n) => [
          opIdKey(n.id),
          n.parent === null ? null : opIdKey(n.parent),
          n.side,
          n.value,
          n.deleted,
        ]),
    }),
  };

  it('converges over 1000 random scenarios on 3 to 5 replicas', { timeout: 300_000 }, () => {
    const summary = checkConvergence(spec, { numRuns: 1000, replicas: { min: 3, max: 5 } });
    expect(summary.runs).toBe(1000);
    expect(summary.maxReplicas).toBe(5);
    expect(summary.ops).toBeGreaterThan(0);
    expect(summary.concurrentPairs).toBeGreaterThan(0);
    expect(summary.redeliveries).toBeGreaterThan(0);
  });
});
