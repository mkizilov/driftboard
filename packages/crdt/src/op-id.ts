import { compareValues, type Ordering } from './ordering';
import { compareReplicaIds, isReplicaId, replicaId, type ReplicaId } from './replica-id';

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

/** Canonical string form (`counter@replicaId`), unambiguous because replica ids never contain `@`. */
export function opIdKey(id: OpId): string {
  return `${id.counter}@${id.replicaId}`;
}

const OP_ID_KEY = /^([1-9][0-9]*)@([A-Za-z0-9_-]{1,64})$/;

/** Inverse of `opIdKey`; throws `RangeError` on anything else. */
export function parseOpIdKey(text: string): OpId {
  const [, counter, replica] = OP_ID_KEY.exec(text) ?? [];
  if (counter === undefined || replica === undefined) {
    throw new RangeError(`Invalid operation id: ${JSON.stringify(text)}`);
  }
  return opId(Number(counter), replicaId(replica));
}

/** Structural check for ids that arrive as untyped data. */
export function isOpId(value: unknown): value is OpId {
  if (typeof value !== 'object' || value === null) return false;
  const { counter, replicaId: replica } = value as { counter?: unknown; replicaId?: unknown };
  return (
    typeof counter === 'number' &&
    Number.isSafeInteger(counter) &&
    counter >= 1 &&
    isReplicaId(replica)
  );
}
