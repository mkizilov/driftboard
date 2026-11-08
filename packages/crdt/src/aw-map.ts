import { compareOpIds, opId, opIdKey, type OpId } from './op-id';
import { compareValues } from './ordering';
import type { ReplicaId } from './replica-id';
import { VersionVector } from './version-vector';

/** Combines two values of the same key. Must be commutative, associative and idempotent. */
export type AwMapJoin<V> = (a: V, b: V) => V;

export interface AwMapPutOp<V> {
  readonly type: 'put';
  readonly key: string;
  /** Unique id of this write: the issuing replica's next map counter. */
  readonly dot: OpId;
  readonly value: V;
  /** Dots of this key that the issuer had seen; this write replaces them. */
  readonly supersedes: readonly OpId[];
}

export interface AwMapRemoveOp {
  readonly type: 'remove';
  readonly key: string;
  /** Dots of this key that the issuer had seen; only these are removed. */
  readonly dots: readonly OpId[];
}

export type AwMapOp<V> = AwMapPutOp<V> | AwMapRemoveOp;

export interface AwMapDotEntry<V> {
  readonly key: string;
  readonly dot: OpId;
  readonly value: V;
}

/** An operation arrived before one of its causal predecessors, or the stream skipped an operation. */
export class CausalOrderError extends Error {
  override readonly name = 'CausalOrderError';
}

interface Entry<V> {
  readonly dot: OpId;
  readonly value: V;
}

type DotStore<V> = ReadonlyMap<string, Entry<V>>;

const NO_DOTS: DotStore<never> = new Map();

/**
 * Add-wins observed-remove map from string keys to values.
 *
 * Every write adds a unique *dot* and carries the value for that dot. A key is present while at
 * least one of its dots survives. A write replaces only the dots its issuer had observed and a
 * remove deletes only the dots its issuer had observed, so a concurrent write always survives a
 * remove (add wins). If several dots survive concurrently the visible value is their `join`.
 *
 * The version vector doubles as the causal context: a dot it covers that is no longer in the map
 * has been removed or replaced, so no tombstones are kept. This requires each replica's writes to
 * be applied in order and every operation to be applied after the ones it observed (causal
 * delivery); `apply` throws `CausalOrderError` otherwise. Re-applying a write is a no-op.
 *
 * Keep values small and join-able (for example LWW registers); each write carries its whole value.
 */
export class AwMap<V> {
  readonly #join: AwMapJoin<V>;
  readonly #entries: ReadonlyMap<string, DotStore<V>>;
  readonly #version: VersionVector;

  private constructor(
    join: AwMapJoin<V>,
    entries: ReadonlyMap<string, DotStore<V>>,
    version: VersionVector,
  ) {
    this.#join = join;
    this.#entries = entries;
    this.#version = version;
  }

  static empty<V>(join: AwMapJoin<V>): AwMap<V> {
    return new AwMap<V>(join, new Map(), VersionVector.empty);
  }

  /** Highest write counter seen per replica. */
  get version(): VersionVector {
    return this.#version;
  }

  get size(): number {
    return this.#entries.size;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  get(key: string): V | undefined {
    const store = this.#entries.get(key);
    return store === undefined ? undefined : this.#resolve(store);
  }

  keys(): string[] {
    return [...this.#entries.keys()].sort(compareValues);
  }

  entries(): [string, V][] {
    return this.keys().map((key) => [key, this.#resolve(this.#store(key))]);
  }

  /** Every surviving dot with its value, sorted by key then dot. For snapshots and debugging. */
  dotEntries(): AwMapDotEntry<V>[] {
    return this.keys().flatMap((key) =>
      this.#sortedEntries(this.#store(key)).map(({ dot, value }) => ({ key, dot, value })),
    );
  }

  /** Builds the operation for `key = value` issued by `replica`; apply it locally and send it on. */
  prepareSet(replica: ReplicaId, key: string, value: V): AwMapPutOp<V> {
    return {
      type: 'put',
      key,
      dot: opId(this.#version.get(replica) + 1, replica),
      value,
      supersedes: this.#observedDots(key),
    };
  }

  /** Builds the operation removing `key`, or `undefined` if the key is not present. */
  prepareRemove(key: string): AwMapRemoveOp | undefined {
    const dots = this.#observedDots(key);
    return dots.length === 0 ? undefined : { type: 'remove', key, dots };
  }

  apply(op: AwMapOp<V>): AwMap<V> {
    return op.type === 'put' ? this.#applyPut(op) : this.#applyRemove(op);
  }

  /**
   * State merge for snapshots. A dot present on one side only survives if the other side's
   * version vector has not seen it; if the other side has seen it, it was removed or replaced there.
   */
  merge(other: AwMap<V>): AwMap<V> {
    const entries = new Map<string, DotStore<V>>();
    for (const key of new Set([...this.#entries.keys(), ...other.#entries.keys()])) {
      const mine = this.#entries.get(key) ?? NO_DOTS;
      const theirs = other.#entries.get(key) ?? NO_DOTS;
      const store = new Map<string, Entry<V>>();
      for (const [dotKey, entry] of mine) {
        if (theirs.has(dotKey) || !other.#version.includes(entry.dot)) store.set(dotKey, entry);
      }
      for (const [dotKey, entry] of theirs) {
        if (!mine.has(dotKey) && !this.#version.includes(entry.dot)) store.set(dotKey, entry);
      }
      if (store.size > 0) entries.set(key, store);
    }
    return new AwMap(this.#join, entries, this.#version.merge(other.#version));
  }

  #applyPut(op: AwMapPutOp<V>): AwMap<V> {
    const seen = this.#version.get(op.dot.replicaId);
    if (op.dot.counter <= seen) return this;
    if (op.dot.counter !== seen + 1) {
      throw new CausalOrderError(
        `Expected write ${seen + 1} from ${op.dot.replicaId} but got ${op.dot.counter}`,
      );
    }
    this.#assertObserved(op.supersedes);
    const replaced = new Set(op.supersedes.map(opIdKey));
    const store = new Map<string, Entry<V>>();
    for (const [dotKey, entry] of this.#entries.get(op.key) ?? NO_DOTS) {
      if (!replaced.has(dotKey)) store.set(dotKey, entry);
    }
    store.set(opIdKey(op.dot), { dot: op.dot, value: op.value });
    return new AwMap(
      this.#join,
      new Map(this.#entries).set(op.key, store),
      this.#version.advance(op.dot),
    );
  }

  #applyRemove(op: AwMapRemoveOp): AwMap<V> {
    this.#assertObserved(op.dots);
    const current = this.#entries.get(op.key);
    if (current === undefined) return this;
    const removed = new Set(op.dots.map(opIdKey));
    const store = new Map([...current].filter(([dotKey]) => !removed.has(dotKey)));
    if (store.size === current.size) return this;
    const entries = new Map(this.#entries);
    if (store.size === 0) entries.delete(op.key);
    else entries.set(op.key, store);
    return new AwMap(this.#join, entries, this.#version);
  }

  #assertObserved(dots: readonly OpId[]): void {
    for (const dot of dots) {
      if (!this.#version.includes(dot)) {
        throw new CausalOrderError(`Operation refers to unseen write ${opIdKey(dot)}`);
      }
    }
  }

  #store(key: string): DotStore<V> {
    return this.#entries.get(key) ?? NO_DOTS;
  }

  #observedDots(key: string): OpId[] {
    return this.#sortedEntries(this.#store(key)).map((entry) => entry.dot);
  }

  #sortedEntries(store: DotStore<V>): Entry<V>[] {
    return [...store.values()].sort((a, b) => compareOpIds(a.dot, b.dot));
  }

  #resolve(store: DotStore<V>): V {
    const [head, ...rest] = this.#sortedEntries(store);
    if (head === undefined) throw new Error('Invariant violated: key without dots');
    return rest.reduce((acc, entry) => this.#join(acc, entry.value), head.value);
  }
}
