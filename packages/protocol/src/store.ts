import { VersionVector, compareReplicaIds, type ReplicaId } from '@driftboard/crdt';
import type { StampedOp } from './ops';

/**
 * The operations of one origin, in order. Newer versions of a store append to the same backing
 * array, and each version only reads the first `length` entries, so appending is cheap and older
 * versions stay valid. Only this file touches the array.
 */
export interface OriginLog {
  readonly items: StampedOp[];
  readonly length: number;
}

/**
 * Everything one side of the sync knows: for every origin, operations 1..n without gaps. The
 * version vector of a store is therefore just the length of each log. A store is immutable: every
 * function returns a new one.
 */
export interface OpStore {
  readonly logs: ReadonlyMap<ReplicaId, OriginLog>;
}

export const emptyStore: OpStore = { logs: new Map() };

export type AddResult =
  | { readonly ok: true; readonly store: OpStore; readonly added: readonly StampedOp[] }
  | { readonly ok: false; readonly reason: 'gap' | 'conflict'; readonly detail: string };

/** `count` operations from each origin. */
export function storeVector(store: OpStore): VersionVector {
  return VersionVector.from([...store.logs].map(([origin, log]) => [origin, log.length] as const));
}

export function storeSize(store: OpStore): number {
  let size = 0;
  for (const log of store.logs.values()) size += log.length;
  return size;
}

/**
 * The operations `vector` does not cover, i.e. exactly the ones a peer with that vector is
 * missing: per origin sorted by replica id, each origin in sequence order.
 */
export function storeMissing(store: OpStore, vector: VersionVector): StampedOp[] {
  const missing: StampedOp[] = [];
  for (const origin of [...store.logs.keys()].sort(compareReplicaIds)) {
    const log = store.logs.get(origin);
    if (log === undefined) continue;
    for (let index = vector.get(origin); index < log.length; index += 1) {
      const op = log.items[index];
      if (op !== undefined) missing.push(op);
    }
  }
  return missing;
}

function append(log: OriginLog | undefined, items: readonly StampedOp[]): OriginLog {
  if (log === undefined) return { items: [...items], length: items.length };
  if (log.items.length === log.length) {
    for (const item of items) log.items.push(item);
    return { items: log.items, length: log.length + items.length };
  }
  // Another version already appended past this one: copy instead of overwriting its entries.
  return {
    items: [...log.items.slice(0, log.length), ...items],
    length: log.length + items.length,
  };
}

/**
 * Adds operations that must arrive in order per origin. An operation the store already holds is
 * skipped if it is identical, so repeated delivery is harmless. The whole batch is rejected, and
 * the store left as it was, if an operation skips ahead of its origin's stream (`gap`) or
 * differs from the one already stored under the same origin and number (`conflict`).
 */
export function storeAdd(store: OpStore, ops: readonly StampedOp[]): AddResult {
  const fresh = new Map<ReplicaId, StampedOp[]>();
  const added: StampedOp[] = [];
  for (const op of ops) {
    const log = store.logs.get(op.origin);
    const stored = log?.length ?? 0;
    const pending = fresh.get(op.origin) ?? [];
    const length = stored + pending.length;
    if (op.seq > length + 1) {
      const detail = `expected operation ${length + 1} from ${op.origin}, got ${op.seq}`;
      return { ok: false, reason: 'gap', detail };
    }
    if (op.seq <= length) {
      const existing = op.seq <= stored ? log?.items[op.seq - 1] : pending[op.seq - stored - 1];
      if (existing === undefined) throw new Error('Invariant violated: stored operation missing');
      if (JSON.stringify(existing.op) !== JSON.stringify(op.op)) {
        const detail = `operation ${op.seq} from ${op.origin} differs from the one already stored`;
        return { ok: false, reason: 'conflict', detail };
      }
      continue;
    }
    pending.push(op);
    fresh.set(op.origin, pending);
    added.push(op);
  }
  if (added.length === 0) return { ok: true, store, added };
  const logs = new Map(store.logs);
  for (const [origin, pending] of fresh) logs.set(origin, append(store.logs.get(origin), pending));
  return { ok: true, store: { logs }, added };
}
