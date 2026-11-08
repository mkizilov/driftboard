import { VersionVector, replicaId, type ReplicaId } from '@driftboard/crdt';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StampedOp } from './ops';
import { emptyStore, storeAdd, storeMissing, storeSize, storeVector } from './store';
import { must, stamped, storeOf } from './test-support';

const a = replicaId('a');
const b = replicaId('b');
const c = replicaId('c');

const ids = (ops: readonly StampedOp[]) => ops.map((op) => `${op.origin}${op.seq}`);

/** A well-formed payload that differs from the one `stamped` makes for any number. */
const DIFFERENT_BODY = { type: 'note-remove', noteId: 'n', dots: ['1@a'] };

function added(store: ReturnType<typeof storeOf>, ops: readonly StampedOp[]) {
  const result = storeAdd(store, ops);
  if (!result.ok) throw new Error(result.detail);
  return result;
}

describe('OpStore', () => {
  it('starts empty', () => {
    expect(storeSize(emptyStore)).toBe(0);
    expect(storeVector(emptyStore).size).toBe(0);
    expect(storeMissing(emptyStore, VersionVector.empty)).toEqual([]);
  });

  it('adds operations in order and reports them with the vector', () => {
    const result = added(emptyStore, [...stamped(a, 1, 3), ...stamped(b, 1, 1)]);
    expect(ids(result.added)).toEqual(['a1', 'a2', 'a3', 'b1']);
    expect(storeSize(result.store)).toBe(4);
    expect(storeVector(result.store).entries()).toEqual([
      ['a', 3],
      ['b', 1],
    ]);
  });

  it('skips operations it already holds, so repeated delivery is harmless', () => {
    const store = storeOf(stamped(a, 1, 3));
    const again = added(store, stamped(a, 2, 2));
    expect(again.added).toEqual([]);
    expect(again.store).toBe(store);
    const overlapping = added(store, stamped(a, 3, 2));
    expect(ids(overlapping.added)).toEqual(['a4']);
  });

  it('skips duplicates inside one batch', () => {
    const ops = stamped(a, 1, 2);
    const result = added(emptyStore, [...ops, ...ops, ...ops]);
    expect(ids(result.added)).toEqual(['a1', 'a2']);
    expect(storeSize(result.store)).toBe(2);
  });

  it('rejects a gap and leaves the store untouched, even if the batch starts well', () => {
    const store = storeOf(stamped(a, 1, 2));
    const batch = [...stamped(a, 3, 1), ...stamped(b, 1, 1), ...stamped(c, 2, 1)];
    const result = storeAdd(store, batch);
    expect(result).toMatchObject({ ok: false, reason: 'gap' });
    expect(storeSize(store)).toBe(2);
    expect(storeVector(store).get(b)).toBe(0);
  });

  it('rejects an operation that differs from the one stored under the same number', () => {
    const store = storeOf(stamped(a, 1, 2));
    const different: StampedOp = { ...must(stamped(a, 1, 1)[0]), op: DIFFERENT_BODY };
    expect(storeAdd(store, [different])).toMatchObject({ ok: false, reason: 'conflict' });
    const inBatch = storeAdd(emptyStore, [must(stamped(a, 1, 1)[0]), different]);
    expect(inBatch).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it('lists exactly the operations a vector does not cover', () => {
    const store = storeOf(stamped(a, 1, 4), stamped(b, 1, 2), stamped(c, 1, 1));
    const known = VersionVector.from([
      [a, 2],
      [b, 2],
    ]);
    expect(ids(storeMissing(store, known))).toEqual(['a3', 'a4', 'c1']);
    expect(ids(storeMissing(store, storeVector(store)))).toEqual([]);
    expect(ids(storeMissing(store, VersionVector.empty))).toEqual([
      'a1',
      'a2',
      'a3',
      'a4',
      'b1',
      'b2',
      'c1',
    ]);
    // A peer that holds more than the store has nothing to be sent.
    expect(storeMissing(store, VersionVector.from([[a, 99]])).map((op) => op.origin)).toEqual([
      'b',
      'b',
      'c',
    ]);
  });

  it('keeps older versions intact when two versions grow from the same one', () => {
    const base = storeOf(stamped(a, 1, 2));
    const left = added(base, stamped(a, 3, 1)).store;
    const other = { ...must(stamped(a, 3, 1)[0]), op: DIFFERENT_BODY };
    const right = added(base, [other]).store;
    const further = added(left, stamped(a, 4, 2)).store;

    expect(storeSize(base)).toBe(2);
    expect(storeSize(left)).toBe(3);
    expect(storeSize(right)).toBe(3);
    expect(storeSize(further)).toBe(5);
    expect(must(storeMissing(left, storeVector(base))[0]).op).toEqual(must(stamped(a, 3, 1)[0]).op);
    expect(must(storeMissing(right, storeVector(base))[0]).op).toEqual(other.op);
    expect(storeMissing(further, storeVector(left)).map((op) => op.seq)).toEqual([4, 5]);
    expect(storeMissing(left, storeVector(base)).map((op) => op.seq)).toEqual([3]);
  });

  it('matches a plain model for any sequence of batches', () => {
    const originArb = fc.constantFrom<ReplicaId>(a, b, c);
    const batchesArb = fc.array(
      fc.array(fc.tuple(originArb, fc.integer({ min: 1, max: 6 })), { maxLength: 6 }),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(batchesArb, (batches) => {
        // The payload is determined by (origin, seq), so a repeated pair is always identical.
        const body = (origin: ReplicaId, seq: number): StampedOp => ({
          origin,
          seq,
          op: { n: `${origin}${seq}` },
        });
        let store = emptyStore;
        const model = new Map<ReplicaId, number>();
        for (const batch of batches) {
          const ops = batch.map(([origin, seq]) => body(origin, seq));
          const progress = new Map(model);
          let gap = false;
          for (const op of ops) {
            const have = progress.get(op.origin) ?? 0;
            if (op.seq > have + 1) gap = true;
            else if (op.seq === have + 1) progress.set(op.origin, op.seq);
          }
          const result = storeAdd(store, ops);
          expect(result.ok).toBe(!gap);
          if (result.ok) {
            store = result.store;
            for (const [origin, count] of progress) model.set(origin, count);
          }
          for (const origin of [a, b, c]) {
            expect(storeVector(store).get(origin)).toBe(model.get(origin) ?? 0);
          }
        }
        const everything = storeMissing(store, VersionVector.empty);
        expect(everything).toHaveLength([...model.values()].reduce((sum, n) => sum + n, 0));
        for (const op of everything) expect(op.op).toEqual({ n: `${op.origin}${op.seq}` });
      }),
    );
  });
});
