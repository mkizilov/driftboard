import type { OpId } from './op-id';
import { compareReplicaIds, type ReplicaId } from './replica-id';

export type VersionVectorOrder = 'before' | 'after' | 'equal' | 'concurrent';

/**
 * Immutable version vector: for each replica, the highest operation counter observed from it.
 * It assumes operations from one replica are applied in counter order (causal delivery), so
 * "counter n seen" implies "every counter below n seen". Absent replicas count as 0.
 */
export class VersionVector {
  static readonly empty = new VersionVector(new Map());

  readonly #counters: ReadonlyMap<ReplicaId, number>;

  private constructor(counters: ReadonlyMap<ReplicaId, number>) {
    this.#counters = counters;
  }

  /** Builds a vector from `[replicaId, counter]` pairs; repeated replicas keep the maximum. */
  static from(entries: Iterable<readonly [ReplicaId, number]>): VersionVector {
    const counters = new Map<ReplicaId, number>();
    for (const [replica, counter] of entries) {
      if (!Number.isSafeInteger(counter) || counter < 0) {
        throw new RangeError(`Counter must be a non-negative safe integer, got ${counter}`);
      }
      if (counter > (counters.get(replica) ?? 0)) counters.set(replica, counter);
    }
    return new VersionVector(counters);
  }

  get size(): number {
    return this.#counters.size;
  }

  get(replica: ReplicaId): number {
    return this.#counters.get(replica) ?? 0;
  }

  /** Entries sorted by replica id, so output is deterministic. */
  entries(): [ReplicaId, number][] {
    return [...this.#counters].sort(([a], [b]) => compareReplicaIds(a, b));
  }

  /** True if the operation is covered by this vector. */
  includes(op: OpId): boolean {
    return op.counter <= this.get(op.replicaId);
  }

  /** Returns a vector that also covers `op` (and every earlier op from its replica). */
  advance(op: OpId): VersionVector {
    if (this.includes(op)) return this;
    return new VersionVector(new Map(this.#counters).set(op.replicaId, op.counter));
  }

  /** Pointwise maximum (least upper bound). */
  merge(other: VersionVector): VersionVector {
    const counters = new Map(this.#counters);
    for (const [replica, counter] of other.#counters) {
      if (counter > (counters.get(replica) ?? 0)) counters.set(replica, counter);
    }
    return new VersionVector(counters);
  }

  /** `before`: `this` is strictly behind `other`; `after`: strictly ahead; `concurrent`: neither dominates. */
  compare(other: VersionVector): VersionVectorOrder {
    let behind = false;
    let ahead = false;
    for (const replica of new Set([...this.#counters.keys(), ...other.#counters.keys()])) {
      const mine = this.get(replica);
      const theirs = other.get(replica);
      if (mine < theirs) behind = true;
      else if (mine > theirs) ahead = true;
    }
    if (behind && ahead) return 'concurrent';
    if (behind) return 'before';
    if (ahead) return 'after';
    return 'equal';
  }

  equals(other: VersionVector): boolean {
    return this.compare(other) === 'equal';
  }
}
