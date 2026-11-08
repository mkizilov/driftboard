import { opId, type OpId } from './op-id';
import type { ReplicaId } from './replica-id';

/**
 * Lamport clock for one replica. If event `a` happened before event `b` (on this or any replica
 * that exchanged ids through `observe`), then `a`'s id is smaller than `b`'s.
 */
export class LamportClock {
  readonly replicaId: ReplicaId;
  #counter: number;

  /** `counter` is the last counter already used; pass the persisted value when restoring. */
  constructor(replicaId: ReplicaId, counter = 0) {
    if (!Number.isSafeInteger(counter) || counter < 0) {
      throw new RangeError(`Lamport counter must be a non-negative safe integer, got ${counter}`);
    }
    this.replicaId = replicaId;
    this.#counter = counter;
  }

  get counter(): number {
    return this.#counter;
  }

  /** Issues the id for a new local operation. */
  tick(): OpId {
    if (this.#counter >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Lamport counter exhausted');
    }
    this.#counter += 1;
    return opId(this.#counter, this.replicaId);
  }

  /** Records an id seen from another replica so later local ids sort after it. */
  observe(remote: OpId): void {
    this.#counter = Math.max(this.#counter, remote.counter);
  }
}
