import { compareValues, type Ordering } from './ordering';
import { compareReplicaIds, type ReplicaId } from './replica-id';

/**
 * Identifies one operation: the replica that issued it and that replica's Lamport counter at the
 * time. Counters start at 1. Ids are totally ordered by `(counter, replicaId)`, and because each
 * replica issues a counter at most once, an id names exactly one operation.
 */
export interface OpId {
  readonly counter: number;
  readonly replicaId: ReplicaId;
}

/** A Lamport timestamp has the same shape as an operation id. */
export type LamportTimestamp = OpId;

export function opId(counter: number, replica: ReplicaId): OpId {
  if (!Number.isSafeInteger(counter) || counter < 1) {
    throw new RangeError(`Operation counter must be a positive safe integer, got ${counter}`);
  }
  return Object.freeze({ counter, replicaId: replica });
}

/** Total order: by counter, then by replica id (code-unit order). */
export function compareOpIds(a: OpId, b: OpId): Ordering {
  return compareValues(a.counter, b.counter) || compareReplicaIds(a.replicaId, b.replicaId);
}

export function opIdEquals(a: OpId, b: OpId): boolean {
  return a.counter === b.counter && a.replicaId === b.replicaId;
}
