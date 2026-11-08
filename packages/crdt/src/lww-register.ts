import { compareHlc, type HlcTimestamp } from './hlc';

export interface LwwSetOp<T> {
  readonly type: 'set';
  readonly value: T;
  readonly timestamp: HlcTimestamp;
}

interface Entry<T> {
  readonly value: T;
  readonly timestamp: HlcTimestamp;
}

/**
 * Last-writer-wins register. The write with the greatest HLC timestamp wins, so applying
 * operations (or merging snapshots) in any order, any number of times, gives the same result.
 *
 * Timestamps must be unique per write (an HLC guarantees this); two different values stamped with
 * the same timestamp are a caller bug and the first one applied is kept. To make a write win over
 * everything its replica has seen, feed every received timestamp to the replica's clock
 * (`HybridLogicalClock.receive`) before calling `tick()` for the new write.
 */
export class LwwRegister<T> {
  readonly #entry: Entry<T> | undefined;

  private constructor(entry: Entry<T> | undefined) {
    this.#entry = entry;
  }

  static empty<T>(): LwwRegister<T> {
    return new LwwRegister<T>(undefined);
  }

  /** The current value, or `undefined` if nothing was ever written. */
  get value(): T | undefined {
    return this.#entry?.value;
  }

  /** The timestamp of the winning write, or `undefined` if nothing was ever written. */
  get timestamp(): HlcTimestamp | undefined {
    return this.#entry?.timestamp;
  }

  /** Builds the operation for a local write; apply it locally and send it to the other replicas. */
  prepareSet(value: T, timestamp: HlcTimestamp): LwwSetOp<T> {
    return { type: 'set', value, timestamp };
  }

  apply(op: LwwSetOp<T>): LwwRegister<T> {
    return this.#isNewer(op.timestamp)
      ? new LwwRegister<T>({ value: op.value, timestamp: op.timestamp })
      : this;
  }

  /** State merge for snapshots: keeps the write with the greater timestamp. */
  merge(other: LwwRegister<T>): LwwRegister<T> {
    const theirs = other.#entry;
    return theirs !== undefined && this.#isNewer(theirs.timestamp) ? other : this;
  }

  #isNewer(timestamp: HlcTimestamp): boolean {
    return this.#entry === undefined || compareHlc(timestamp, this.#entry.timestamp) > 0;
  }
}
