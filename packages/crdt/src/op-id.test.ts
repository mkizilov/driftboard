import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareOpIds, opId, opIdEquals } from './op-id';
import { replicaId } from './replica-id';
import { opIdArb } from './test-support';

const a = replicaId('a');
const b = replicaId('b');

describe('opId', () => {
  it('requires a positive safe integer counter', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => opId(bad, a)).toThrow(RangeError);
    }
    expect(opId(1, a)).toEqual({ counter: 1, replicaId: 'a' });
  });
});

describe('compareOpIds', () => {
  it('orders by counter first, then by replica id', () => {
    expect(compareOpIds(opId(1, b), opId(2, a))).toBe(-1);
    expect(compareOpIds(opId(2, a), opId(2, b))).toBe(-1);
    expect(compareOpIds(opId(2, b), opId(2, a))).toBe(1);
    expect(compareOpIds(opId(2, a), opId(2, a))).toBe(0);
  });

  it('is a total order (reflexive, antisymmetric, transitive, total)', () => {
    fc.assert(
      fc.property(opIdArb, opIdArb, opIdArb, (x, y, z) => {
        expect(compareOpIds(x, x)).toBe(0);
        expect(compareOpIds(x, y)).toBe(-compareOpIds(y, x) || 0);
        expect(compareOpIds(x, y) === 0).toBe(opIdEquals(x, y));
        if (compareOpIds(x, y) <= 0 && compareOpIds(y, z) <= 0) {
          expect(compareOpIds(x, z)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it('gives every permutation the same sorted result', () => {
    fc.assert(
      fc.property(
        fc.array(opIdArb, { maxLength: 12 }).chain((ids) =>
          fc.tuple(
            fc.constant(ids),
            fc.shuffledSubarray(ids, { minLength: ids.length, maxLength: ids.length }),
          ),
        ),
        ([ids, shuffled]) => {
          expect([...shuffled].sort(compareOpIds)).toEqual([...ids].sort(compareOpIds));
        },
      ),
    );
  });
});
