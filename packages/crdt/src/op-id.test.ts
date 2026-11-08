import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareOpIds, isOpId, opId, opIdEquals, opIdKey, parseOpIdKey } from './op-id';
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

describe('opIdKey and parseOpIdKey', () => {
  it('write ids as counter@replica and read them back', () => {
    expect(opIdKey(opId(12, replicaId('ab-1')))).toBe('12@ab-1');
    expect(parseOpIdKey('12@ab-1')).toEqual({ counter: 12, replicaId: 'ab-1' });
    fc.assert(
      fc.property(opIdArb, (id) => {
        expect(parseOpIdKey(opIdKey(id))).toEqual(id);
      }),
    );
  });

  it('reject anything that is not exactly an id', () => {
    const bad = ['', '0@a', '01@a', '1@', '@a', '1@a b', 'x', '1.5@a', '-1@a', '1@a@b', ' 1@a'];
    for (const text of [...bad, '9007199254740993@a', `1@${'x'.repeat(65)}`]) {
      expect(() => parseOpIdKey(text)).toThrow(RangeError);
    }
  });
});

describe('isOpId', () => {
  it('accepts well-formed ids and rejects other data', () => {
    expect(isOpId(opId(1, a))).toBe(true);
    expect(isOpId({ counter: 3, replicaId: 'b' })).toBe(true);
    const bad = [null, undefined, 1, 'x', [], {}, { counter: 0, replicaId: 'a' }];
    for (const value of [...bad, { counter: 1.5, replicaId: 'a' }, { counter: 1, replicaId: 'a b' }]) {
      expect(isOpId(value)).toBe(false);
    }
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
