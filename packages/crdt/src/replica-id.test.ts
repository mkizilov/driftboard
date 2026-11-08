import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareReplicaIds, generateReplicaId, isReplicaId, replicaId } from './replica-id';

describe('replicaId', () => {
  it('accepts 1-64 chars of [A-Za-z0-9_-]', () => {
    for (const ok of ['a', 'Z9_-', 'x'.repeat(64)]) {
      expect(isReplicaId(ok)).toBe(true);
      expect(replicaId(ok)).toBe(ok);
    }
  });

  it('rejects everything else', () => {
    for (const bad of ['', 'x'.repeat(65), 'a b', 'a/b', 'é', 'a\n']) {
      expect(isReplicaId(bad)).toBe(false);
      expect(() => replicaId(bad)).toThrow(RangeError);
    }
    expect(isReplicaId(42)).toBe(false);
    expect(isReplicaId(undefined)).toBe(false);
  });
});

describe('compareReplicaIds', () => {
  it('orders by code unit, not locale', () => {
    expect(compareReplicaIds(replicaId('B'), replicaId('a'))).toBe(-1);
    expect(compareReplicaIds(replicaId('a'), replicaId('ab'))).toBe(-1);
    expect(compareReplicaIds(replicaId('a'), replicaId('a'))).toBe(0);
    expect(compareReplicaIds(replicaId('b'), replicaId('a'))).toBe(1);
  });
});

describe('generateReplicaId', () => {
  const bytesOf = (...values: number[]) => new Uint8Array(values);

  it('hex-encodes injected random bytes and asks for 8 of them', () => {
    let requested = -1;
    const id = generateReplicaId((length) => {
      requested = length;
      return bytesOf(0, 1, 15, 16, 171, 205, 239, 255);
    });
    expect(requested).toBe(8);
    expect(id).toBe('00010f10abcdefff');
  });

  it('rejects a source that returns the wrong number of bytes', () => {
    expect(() => generateReplicaId(() => bytesOf(1, 2, 3))).toThrow(RangeError);
  });

  it('is injective and always yields a valid id', () => {
    const bytesArb = fc.uint8Array({ minLength: 8, maxLength: 8 });
    fc.assert(
      fc.property(bytesArb, bytesArb, (a, b) => {
        const idA = generateReplicaId(() => a);
        const idB = generateReplicaId(() => b);
        expect(isReplicaId(idA)).toBe(true);
        expect(idA === idB).toBe(a.every((byte, i) => byte === b[i]));
      }),
    );
  });
});
