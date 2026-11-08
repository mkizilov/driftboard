import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareOpIds, opIdKey } from './op-id';
import { replicaId } from './replica-id';
import { must } from './test-support';
import { TextSequence, type TextInsertOp, type TextOp } from './text-sequence';

/**
 * The document order straight from the Fugue rules, the slow way: group the nodes by parent and
 * side, order siblings by id, and walk the tree (left children, the node, right children). It has
 * no index structure, so it is the reference for the order `TextSequence` keeps incrementally.
 */
function walkOrder(inserts: readonly TextInsertOp[]): string[] {
  const children = new Map<string, { left: TextInsertOp[]; right: TextInsertOp[] }>();
  const childrenOf = (key: string) => {
    let entry = children.get(key);
    if (entry === undefined) {
      entry = { left: [], right: [] };
      children.set(key, entry);
    }
    return entry;
  };
  for (const op of inserts) {
    childrenOf(op.parent === null ? '' : opIdKey(op.parent))[op.side].push(op);
  }
  for (const entry of children.values()) {
    entry.left.sort((x, y) => compareOpIds(x.id, y.id));
    entry.right.sort((x, y) => compareOpIds(x.id, y.id));
  }
  const order: string[] = [];
  type Frame = { readonly key: string; readonly self: boolean };
  const stack: Frame[] = [{ key: '', self: false }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    if (frame.self) {
      order.push(frame.key);
      continue;
    }
    const entry = childrenOf(frame.key);
    // Pushed in reverse, so that they come off the stack in document order.
    for (const op of [...entry.right].reverse()) stack.push({ key: opIdKey(op.id), self: false });
    if (frame.key !== '') stack.push({ key: frame.key, self: true });
    for (const op of [...entry.left].reverse()) stack.push({ key: opIdKey(op.id), self: false });
  }
  return order;
}

const orderOf = (s: TextSequence): string[] => s.nodes().map((node) => opIdKey(node.id));

const insertsOf = (ops: readonly TextOp[]): TextInsertOp[] =>
  ops.flatMap((op) => (op.type === 'insert' ? [op] : []));

/** A small seeded generator, so that these tests do not depend on fast-check for volume. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe('the document order a TextSequence keeps', () => {
  it('matches a walk of the tree after every kind of local edit, on a text of many thousand characters', () => {
    const random = lcg(1);
    const s = new TextSequence(replicaId('a'));
    const model: string[] = [];
    const inserts: TextInsertOp[] = [];
    for (let step = 0; step < 6000; step += 1) {
      const roll = random();
      if (roll < 0.7 || model.length === 0) {
        // Mostly typing at the caret, with jumps: runs, insertions inside runs, at the start.
        const at = random() < 0.5 ? model.length : Math.floor(random() * (model.length + 1));
        const text = random() < 0.2 ? 'xyz😀' : String.fromCharCode(97 + Math.floor(random() * 26));
        inserts.push(...s.insert(at, text));
        model.splice(at, 0, ...Array.from(text));
      } else {
        const at = Math.floor(random() * model.length);
        const count = Math.min(model.length - at, 1 + Math.floor(random() * 4));
        s.delete(at, count);
        model.splice(at, count);
      }
      if (step % 500 === 0) s.assertConsistent();
    }
    s.assertConsistent();
    expect(s.toString()).toBe(model.join(''));
    expect(s.length).toBe(model.length);
    expect(orderOf(s)).toEqual(walkOrder(inserts));
    expect(inserts.length).toBeGreaterThan(5000);
  });

  it('inserts and deletes at the right index at every size, including on either side of a split', () => {
    const s = new TextSequence(replicaId('a'));
    const model: string[] = [];
    for (let size = 0; size <= 300; size += 1) {
      // Insert in the middle, then check by reading the neighbours back through the text.
      const at = Math.floor(model.length / 2);
      s.insert(at, String.fromCharCode(65 + (size % 26)));
      model.splice(at, 0, String.fromCharCode(65 + (size % 26)));
      expect(s.toString()).toBe(model.join(''));
    }
    while (model.length > 0) {
      const at = model.length > 3 ? 1 : 0;
      s.delete(at, 1);
      model.splice(at, 1);
      expect(s.toString()).toBe(model.join(''));
    }
    s.assertConsistent();
    expect(s.length).toBe(0);
    expect(s.nodes()).toHaveLength(301);
    expect(s.nodes().every((node) => node.deleted)).toBe(true);
  });

  it('puts text at the right place after a long run of deletions in front of it', () => {
    const s = new TextSequence(replicaId('a'));
    s.insert(0, 'a'.repeat(500) + 'END');
    s.delete(0, 500);
    expect(s.length).toBe(3);
    s.insert(1, '-');
    expect(s.toString()).toBe('E-ND');
    s.insert(0, '>');
    s.insert(5, '<');
    expect(s.toString()).toBe('>E-ND<');
    expect(s.nodes()).toHaveLength(500 + 3 + 3);
    s.assertConsistent();
  });

  it('reports indexes out of range, also after deletions', () => {
    const s = new TextSequence(replicaId('a'));
    s.insert(0, 'abcdef');
    s.delete(1, 2);
    expect(() => s.insert(5, 'x')).toThrow(RangeError);
    expect(() => s.delete(3, 2)).toThrow(RangeError);
    expect(() => s.delete(-1, 1)).toThrow(RangeError);
    expect(s.toString()).toBe('adef');
    expect(() => s.insert(4, 'x')).not.toThrow();
    expect(s.toString()).toBe('adefx');
  });

  it('gives the same text for a text that is read between edits as for one that is read once', () => {
    const random = lcg(2);
    const reading = new TextSequence(replicaId('a'));
    const quiet = new TextSequence(replicaId('a'));
    let length = 0;
    for (let step = 0; step < 1500; step += 1) {
      const at = Math.floor(random() * (length + 1));
      if (random() < 0.8 || length === 0) {
        reading.insert(at, 'k');
        quiet.insert(at, 'k');
        length += 1;
      } else {
        const index = Math.min(at, length - 1);
        reading.delete(index, 1);
        quiet.delete(index, 1);
        length -= 1;
      }
      expect(reading.toString().length).toBe(length);
    }
    expect(reading.toString()).toBe(quiet.toString());
  });

  it('matches a walk of the tree on every replica when edits are made at once and delivered in any order', () => {
    const edit = fc.oneof(
      fc.record({
        kind: fc.constant('type' as const),
        replica: fc.integer({ min: 0, max: 2 }),
        at: fc.nat(),
        text: fc.constantFrom('a', 'bc', 'def', '😀', 'gh😀'),
      }),
      fc.record({
        kind: fc.constant('erase' as const),
        replica: fc.integer({ min: 0, max: 2 }),
        at: fc.nat(),
        count: fc.integer({ min: 1, max: 3 }),
      }),
      fc.record({
        kind: fc.constant('deliver' as const),
        replica: fc.integer({ min: 0, max: 2 }),
        pick: fc.nat(),
      }),
    );
    fc.assert(
      fc.property(fc.array(edit, { maxLength: 60 }), fc.nat(), (steps, seed) => {
        const replicas = ['a', 'b', 'c'].map((name) => new TextSequence(replicaId(name)));
        const inboxes: TextOp[][] = replicas.map(() => []);
        const everything: TextOp[] = [];
        const publish = (from: number, ops: readonly TextOp[]): void => {
          everything.push(...ops);
          inboxes.forEach((inbox, to) => {
            if (to !== from) inbox.push(...ops);
          });
        };
        for (const step of steps) {
          const target = must(replicas[step.replica]);
          if (step.kind === 'type') {
            publish(step.replica, target.insert(step.at % (target.length + 1), step.text));
          } else if (step.kind === 'erase') {
            if (target.length === 0) continue;
            const from = step.at % target.length;
            publish(step.replica, target.delete(from, Math.min(step.count, target.length - from)));
          } else {
            const inbox = must(inboxes[step.replica]);
            if (inbox.length > 0) {
              const [taken] = inbox.splice(step.pick % inbox.length, 1);
              target.apply(must(taken));
            }
          }
        }
        // Whatever is left in the inboxes arrives, in an order of the seed's choosing.
        const random = lcg(seed);
        replicas.forEach((replica, i) => {
          const inbox = must(inboxes[i]);
          while (inbox.length > 0) {
            const [taken] = inbox.splice(Math.floor(random() * inbox.length), 1);
            replica.apply(must(taken));
          }
        });
        const expected = walkOrder(insertsOf(everything));
        for (const replica of replicas) {
          replica.assertConsistent();
          expect(replica.pendingCount).toBe(0);
          expect(orderOf(replica)).toEqual(expected);
          expect(replica.toString()).toBe(must(replicas[0]).toString());
        }
      }),
      { numRuns: 300 },
    );
  });

  it('keeps the order right when operations arrive scrambled and some more than once', () => {
    const random = lcg(3);
    const author = new TextSequence(replicaId('a'));
    const other = new TextSequence(replicaId('b'));
    const ops: TextOp[] = [];
    const length = (s: TextSequence) => s.length;
    for (let step = 0; step < 800; step += 1) {
      const typist = random() < 0.5 ? author : other;
      if (random() < 0.8 || length(typist) === 0) {
        ops.push(...typist.insert(Math.floor(random() * (length(typist) + 1)), 'q'));
      } else {
        ops.push(...typist.delete(Math.floor(random() * length(typist)), 1));
      }
    }
    const shuffled = [...ops, ...ops.filter(() => random() < 0.3)];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [must(shuffled[j]), must(shuffled[i])];
    }
    const receiver = new TextSequence(replicaId('r'));
    for (const op of shuffled) receiver.apply(op);
    receiver.assertConsistent();
    expect(receiver.pendingCount).toBe(0);
    expect(orderOf(receiver)).toEqual(walkOrder(insertsOf(ops)));
    // The two authors lacked each other's edits, so neither shows the merged text; the receiver
    // got everything and a third replica fed in order agrees with it.
    const inOrder = new TextSequence(replicaId('s'));
    for (const op of ops) inOrder.apply(op);
    expect(receiver.toString()).toBe(inOrder.toString());
  });
});
