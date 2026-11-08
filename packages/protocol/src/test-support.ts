import { Board, createManualClock, type BoardOp, type ReplicaId } from '@driftboard/crdt';
import { stampOps, type StampedOp } from './ops';
import { storeAdd, emptyStore, type OpStore } from './store';

/** `count` valid board operations, each creating one note. */
export function boardOps(origin: ReplicaId, count: number): BoardOp[] {
  const board = new Board({ replicaId: origin, clock: createManualClock(1000) });
  return Array.from({ length: count }, () => board.createNote().ops).flat();
}

/** Operations `firstSeq` to `firstSeq + count - 1` of `origin`'s stream. */
export function stamped(origin: ReplicaId, firstSeq: number, count: number): StampedOp[] {
  return stampOps(origin, firstSeq, boardOps(origin, firstSeq + count - 1).slice(firstSeq - 1));
}

/** A store holding the given operations, which must be in order per origin. */
export function storeOf(...batches: StampedOp[][]): OpStore {
  let store = emptyStore;
  for (const batch of batches) {
    const result = storeAdd(store, batch);
    if (!result.ok) throw new Error(result.detail);
    store = result.store;
  }
  return store;
}

/** Unwraps a value a test knows exists (noUncheckedIndexedAccess helper). */
export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}
