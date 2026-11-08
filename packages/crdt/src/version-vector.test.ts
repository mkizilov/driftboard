import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { opId } from './op-id';
import { replicaId } from './replica-id';
import { opIdArb, replicaIdArb, versionVectorArb } from './test-support';
import { VersionVector } from './version-vector';

const a = replicaId('a');
const b = replicaId('b');
const c = replicaId('c');

const vv = (...entries: [typeof a, number][]) => VersionVector.from(entries);

describe('VersionVector basics', () => {
  it('treats absent replicas as 0 and drops zero entries', () => {
    const v = vv([a, 3], [b, 0]);
    expect(v.get(a)).toBe(3);
    expect(v.get(b)).toBe(0);
    expect(v.size).toBe(1);
    expect(VersionVector.empty.size).toBe(0);
  });

  it('keeps the maximum for repeated replicas and sorts entries', () => {
    expect(vv([b, 1], [a, 2], [b, 5], [a, 1]).entries()).toEqual([
      ['a', 2],
      ['b', 5],
    ]);
  });

  it('rejects invalid counters', () => {
    expect(() => vv([a, -1])).toThrow(RangeError);
    expect(() => vv([a, 1.5])).toThrow(RangeError);
  });

  it('includes(opId) covers all counters up to the recorded one', () => {
    const v = vv([a, 3]);
    expect(v.includes(opId(1, a))).toBe(true);
    expect(v.includes(opId(3, a))).toBe(true);
    expect(v.includes(opId(4, a))).toBe(false);
    expect(v.includes(opId(1, b))).toBe(false);
    expect(VersionVector.empty.includes(opId(1, a))).toBe(false);
  });

  it('advance covers the op, never lowers a counter, and does not mutate', () => {
    const v = vv([a, 3]);
    const advanced = v.advance(opId(5, a));
    expect(advanced.get(a)).toBe(5);
    expect(v.get(a)).toBe(3);
    expect(v.advance(opId(2, a))).toBe(v);
    expect(v.advance(opId(1, b)).get(b)).toBe(1);
  });

  it('merge takes the pointwise maximum without mutating inputs', () => {
    const left = vv([a, 3], [b, 1]);
    const right = vv([b, 4], [c, 2]);
    expect(left.merge(right).entries()).toEqual([
      ['a', 3],
      ['b', 4],
      ['c', 2],
    ]);
    expect(left.entries()).toEqual([
      ['a', 3],
      ['b', 1],
    ]);
  });
});

describe('VersionVector.compare', () => {
  it('reports before, after, equal and concurrent', () => {
    expect(vv([a, 1]).compare(vv([a, 2]))).toBe('before');
    expect(vv([a, 2], [b, 1]).compare(vv([a, 1]))).toBe('after');
    expect(vv([a, 1]).compare(vv([a, 1]))).toBe('equal');
    expect(VersionVector.empty.compare(VersionVector.empty)).toBe('equal');
    expect(VersionVector.empty.compare(vv([a, 1]))).toBe('before');
    expect(vv([a, 2]).compare(vv([b, 1]))).toBe('concurrent');
    expect(vv([a, 2], [b, 1]).compare(vv([a, 1], [b, 2]))).toBe('concurrent');
  });

  it('is antisymmetric: swapping the arguments swaps before and after', () => {
    const flip = { before: 'after', after: 'before', equal: 'equal', concurrent: 'concurrent' };
    fc.assert(
      fc.property(versionVectorArb, versionVectorArb, (x, y) => {
        expect(y.compare(x)).toBe(flip[x.compare(y)]);
      }),
    );
  });

  it('is reflexive, and equal exactly when every counter matches', () => {
    fc.assert(
      fc.property(versionVectorArb, versionVectorArb, (x, y) => {
        expect(x.compare(x)).toBe('equal');
        expect(x.equals(y)).toBe(JSON.stringify(x.entries()) === JSON.stringify(y.entries()));
      }),
    );
  });

  it('is transitive: x <= y <= z implies x <= z, strictly if either step is strict', () => {
    fc.assert(
      fc.property(versionVectorArb, versionVectorArb, versionVectorArb, (x, d1, d2) => {
        const y = x.merge(d1);
        const z = y.merge(d2);
        expect(['before', 'equal']).toContain(x.compare(z));
        if (x.compare(y) === 'before' || y.compare(z) === 'before') {
          expect(x.compare(z)).toBe('before');
        }
      }),
    );
  });
});

describe('VersionVector.merge laws', () => {
  it('is commutative', () => {
    fc.assert(
      fc.property(versionVectorArb, versionVectorArb, (x, y) => {
        expect(x.merge(y).equals(y.merge(x))).toBe(true);
      }),
    );
  });

  it('is associative', () => {
    fc.assert(
      fc.property(versionVectorArb, versionVectorArb, versionVectorArb, (x, y, z) => {
        expect(x.merge(y).merge(z).equals(x.merge(y.merge(z)))).toBe(true);
      }),
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(versionVectorArb, (x) => {
        expect(x.merge(x).equals(x)).toBe(true);
      }),
    );
  });

  it('has the empty vector as identity', () => {
    fc.assert(
      fc.property(versionVectorArb, (x) => {
        expect(x.merge(VersionVector.empty).equals(x)).toBe(true);
        expect(VersionVector.empty.merge(x).equals(x)).toBe(true);
      }),
    );
  });

  it('is the least upper bound: dominates both inputs and is their pointwise maximum', () => {
    fc.assert(
      fc.property(versionVectorArb, versionVectorArb, replicaIdArb, (x, y, replica) => {
        const merged = x.merge(y);
        expect(['before', 'equal']).toContain(x.compare(merged));
        expect(['before', 'equal']).toContain(y.compare(merged));
        expect(merged.get(replica)).toBe(Math.max(x.get(replica), y.get(replica)));
      }),
    );
  });

  it('includes an op iff one of the inputs does', () => {
    fc.assert(
      fc.property(versionVectorArb, versionVectorArb, opIdArb, (x, y, op) => {
        expect(x.merge(y).includes(op)).toBe(x.includes(op) || y.includes(op));
      }),
    );
  });
});

describe('VersionVector.advance properties', () => {
  it('makes includes true and is monotonic', () => {
    fc.assert(
      fc.property(versionVectorArb, opIdArb, opIdArb, (v, op, other) => {
        const advanced = v.advance(op);
        expect(advanced.includes(op)).toBe(true);
        expect(['before', 'equal']).toContain(v.compare(advanced));
        if (v.includes(other)) expect(advanced.includes(other)).toBe(true);
      }),
    );
  });

  it('is commutative and idempotent over a set of ops', () => {
    fc.assert(
      fc.property(
        fc.array(opIdArb, { maxLength: 10 }).chain((ops) =>
          fc.tuple(fc.constant(ops), fc.shuffledSubarray(ops, { minLength: ops.length })),
        ),
        ([ops, shuffled]) => {
          const fold = (list: typeof ops) =>
            list.reduce((acc, op) => acc.advance(op), VersionVector.empty);
          expect(fold(shuffled).equals(fold(ops))).toBe(true);
          expect(fold([...ops, ...ops]).equals(fold(ops))).toBe(true);
        },
      ),
    );
  });
});
