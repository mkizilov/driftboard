import { opIdKey, type OpId } from './op-id';

export interface CausalBufferOptions<Op> {
  /** The id this operation introduces, if other operations can depend on it. */
  readonly provides: (op: Op) => OpId | undefined;
  /** Ids that must have been applied before this operation can be. */
  readonly requires: (op: Op) => readonly OpId[];
  /** Whether the operation that introduced `id` has been applied (including before the buffer existed). */
  readonly isApplied: (id: OpId) => boolean;
}

/**
 * Causal delivery buffer. `receive` applies an operation at once if everything it requires has
 * been applied; otherwise it holds the operation until the missing operation arrives, then applies
 * it together with anything else that this unblocks, always parents before children.
 *
 * The buffer never drops anything and has no size limit or timeout: a caller that can lose
 * operations should watch `size` and re-request what is missing. Each parked operation waits on
 * exactly one missing id at a time, so unblocking costs O(1) per operation.
 */
export class CausalBuffer<Op> {
  readonly #options: CausalBufferOptions<Op>;
  /** Operations waiting for one missing id, keyed by that id. */
  readonly #waiting = new Map<string, Op[]>();
  /** Operations that became ready but were not applied because an earlier `apply` threw. */
  #retry: Op[] = [];
  #size = 0;

  constructor(options: CausalBufferOptions<Op>) {
    this.#options = options;
  }

  /** Number of operations currently held back. */
  get size(): number {
    return this.#size;
  }

  /** The held operations, for diagnostics. */
  pending(): Op[] {
    return [...this.#retry, ...[...this.#waiting.values()].flat()];
  }

  /**
   * Offers `op`. Calls `apply` for each operation that is ready, in causal order, and returns how
   * many were applied. If `apply` throws, that operation is dropped, the error propagates, and the
   * operations it would have unblocked are retried by the next `receive`.
   */
  receive(op: Op, apply: (op: Op) => void): number {
    const queue = [...this.#retry, op];
    this.#size -= this.#retry.length;
    this.#retry = [];
    let consumed = 0;
    let applied = 0;
    try {
      for (const current of queue) {
        consumed += 1;
        const missing = this.#options
          .requires(current)
          .find((dependency) => !this.#options.isApplied(dependency));
        if (missing !== undefined) {
          this.#park(missing, current);
          continue;
        }
        apply(current);
        applied += 1;
        const provided = this.#options.provides(current);
        if (provided !== undefined) {
          for (const released of this.#release(provided)) queue.push(released);
        }
      }
    } catch (error) {
      const rest = queue.slice(consumed);
      this.#retry = rest;
      this.#size += rest.length;
      throw error;
    }
    return applied;
  }

  #park(missing: OpId, op: Op): void {
    const key = opIdKey(missing);
    const waiting = this.#waiting.get(key);
    if (waiting === undefined) this.#waiting.set(key, [op]);
    else waiting.push(op);
    this.#size += 1;
  }

  #release(id: OpId): Op[] {
    const key = opIdKey(id);
    const released = this.#waiting.get(key) ?? [];
    this.#waiting.delete(key);
    this.#size -= released.length;
    return released;
  }
}
