import { gunzipSync, gzipSync } from 'node:zlib';
import { Board, createManualClock, replicaId } from '@driftboard/crdt';
import { encodeOps, stampOps } from '@driftboard/protocol';
import { describe, expect, it } from 'vitest';
import { SnapshotError, decodeSnapshot, encodeSnapshot } from './snapshot';
import { must, stamped } from './test-support';

const a = replicaId('a');
const b = replicaId('b');

const gz = (value: unknown) => gzipSync(JSON.stringify(value));

/** What a person typing a key at a time makes: a character and the note put again, over and over. */
function typing(keys: number) {
  const board = new Board({ replicaId: a, clock: createManualClock(1_700_000_000_000) });
  const { id, ops } = board.createNote({ x: 5, y: 6 });
  const typed = Array.from({ length: keys }, (_, i) => board.editText(id, i, 0, 'k')).flat();
  return stampOps(a, 1, [...ops, ...typed]);
}

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

describe('snapshot formats', () => {
  it('writes the gzip of a binary batch, not JSON', () => {
    const ops = typing(50);
    const inner = gunzipSync(encodeSnapshot(ops));
    expect(inner[0]).toBe(0xdb);
    expect(Array.from(inner)).toEqual(Array.from(encodeOps(ops)));
  });

  it('still reads the version 1 snapshots (gzipped JSON) that earlier servers stored', () => {
    const ops = [...stamped(a, 1, 4), ...stamped(b, 1, 2)];
    const v1 = gz({
      v: 1,
      origins: [
        ['a', ops.filter((op) => op.origin === a).map((op) => op.op)],
        ['b', ops.filter((op) => op.origin === b).map((op) => op.op)],
      ],
    });
    expect(decodeSnapshot(v1)).toEqual(ops);
  });

  it('is much smaller than version 1 was, and much smaller than the plain JSON', () => {
    const ops = typing(2000);
    const v1 = gz({ v: 1, origins: [['a', ops.map((op) => op.op)]] });
    const v2 = encodeSnapshot(ops);
    const plain = Buffer.byteLength(JSON.stringify(ops));
    expect(decodeSnapshot(v2)).toEqual(ops);
    expect(v2.length).toBeLessThan(v1.length / 5);
    expect(v2.length).toBeLessThan(plain / 500);
  });

  it('rejects a binary snapshot that is cut short, damaged or numbered wrong', () => {
    const batch = encodeOps(typing(20));
    const truncated = gzipSync(batch.subarray(0, batch.length - 3));
    expect(() => decodeSnapshot(truncated)).toThrow(SnapshotError);
    expect(() => decodeSnapshot(gzipSync(Uint8Array.from([0xdb, 9, 0])))).toThrow(SnapshotError);
    expect(() => decodeSnapshot(gzipSync(encodeOps(stamped(a, 2, 2))))).toThrow('not numbered');
    const twice = [...stamped(a, 1, 2), ...stamped(a, 1, 2)];
    expect(() => decodeSnapshot(gzipSync(encodeOps(twice)))).toThrow('not numbered');
  });
});
