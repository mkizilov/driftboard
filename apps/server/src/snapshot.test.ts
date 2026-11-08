import { gzipSync } from 'node:zlib';
import { replicaId } from '@driftboard/crdt';
import { describe, expect, it } from 'vitest';
import { SnapshotError, decodeSnapshot, encodeSnapshot } from './snapshot';
import { must, stamped } from './test-support';

const a = replicaId('a');
const b = replicaId('b');

const gz = (value: unknown) => gzipSync(JSON.stringify(value));

describe('snapshots', () => {
  it('round-trips operations grouped by origin', () => {
    const ops = [...stamped(a, 1, 4), ...stamped(b, 1, 2)];
    expect(decodeSnapshot(encodeSnapshot(ops))).toEqual(ops);
    expect(decodeSnapshot(encodeSnapshot([]))).toEqual([]);
  });

  it('orders origins by id whatever order they come in', () => {
    const ops = [...stamped(b, 1, 2), ...stamped(a, 1, 1)];
    expect(decodeSnapshot(encodeSnapshot(ops)).map((op) => `${op.origin}${op.seq}`)).toEqual([
      'a1',
      'b1',
      'b2',
    ]);
  });

  it('keeps an origin called __proto__ as plain data', () => {
    const origin = replicaId('__proto__');
    const ops = stamped(origin, 1, 2);
    const decoded = decodeSnapshot(encodeSnapshot(ops));
    expect(decoded).toEqual(ops);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('is much smaller than the plain JSON', () => {
    const ops = stamped(a, 1, 500);
    const plain = Buffer.byteLength(JSON.stringify(ops));
    expect(encodeSnapshot(ops).length).toBeLessThan(plain / 5);
  });

  it('refuses to encode operations that are not numbered 1, 2, 3 per origin', () => {
    expect(() => encodeSnapshot(stamped(a, 2, 2))).toThrow(SnapshotError);
    const ops = stamped(a, 1, 3);
    expect(() => encodeSnapshot([must(ops[0]), must(ops[2])])).toThrow(SnapshotError);
  });

  it('rejects data that is not a snapshot', () => {
    const body = [['a', [{}]]];
    const bad: Uint8Array[] = [
      new Uint8Array(),
      Buffer.from('not gzip'),
      gzipSync('not json'),
      gz(null),
      gz([]),
      gz({ v: 2, origins: body }),
      gz({ v: 1 }),
      gz({ v: 1, origins: {} }),
      gz({ v: 1, origins: [['a']] }),
      gz({ v: 1, origins: [['bad id', [{}]]] }),
      gz({ v: 1, origins: [['a', 'x']] }),
      gz({ v: 1, origins: [['a', [1]]] }),
      gz({ v: 1, origins: [['a', [[]]]] }),
      encodeSnapshot(stamped(a, 1, 3)).subarray(0, 20),
    ];
    for (const data of bad) expect(() => decodeSnapshot(data)).toThrow(SnapshotError);
    expect(decodeSnapshot(gz({ v: 1, origins: body }))).toEqual([{ origin: 'a', seq: 1, op: {} }]);
  });
});
