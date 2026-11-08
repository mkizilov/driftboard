import { opIdKey, type OpId } from './op-id';

/** The buffer already holds as many operations as it may; the new one was not kept. */
export class PendingLimitError extends Error {
  override readonly name = 'PendingLimitError';
}

/**
 * How many operations may be held back in all, shared by several buffers (a board's note map and
 * the text of each note) so that one limit covers them.
 */
export class PendingBudget {
  readonly limit: number;
  #used = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Operations held back now, in every buffer that shares this budget. */
  get used(): number {
    return this.#used;
  }

  /** Reserves a place for one operation; `false` when the limit is reached. */
  tryTake(): boolean {
    if (this.#used >= this.limit) return false;
    this.#used += 1;
    return true;
  }

  take(count: number): void {
    this.#used += count;
  }

  give(count: number): void {
    this.#used -= count;
  }
}

/** How many refused ids a buffer remembers, to refuse what arrives later and needs them. */
const MAX_REMEMBERED_REFUSALS = 10_000;

export interface CausalBufferOptions<Op> {
  /** The id this operation introduces, if other operations can depend on it. */
  readonly provides: (op: Op) => OpId | undefined;
  /** Ids that must have been applied before this operation can be. */
  readonly requires: (op: Op) => readonly OpId[];
  /** Whether the operation that introduced `id` has been applied (including before the buffer existed). */
  readonly isApplied: (id: OpId) => boolean;
  /** Caps how many operations are held back; without it the buffer has no limit. */
  readonly budget?: PendingBudget;
}

/**
 * Causal delivery buffer. `receive` applies an operation at once if everything it requires has
 * been applied; otherwise it holds the operation until the missing operation arrives, then applies
 * it together with anything else that this unblocks, always parents before children.
 *
 * Without a budget the buffer never drops anything and has no size limit or timeout: a caller that
 * can lose operations should watch `size` and re-request what is missing. With one, an operation
 * that would have to be held while the budget is used up is refused (`PendingLimitError`) instead.
 * Each parked operation waits on exactly one missing id at a time, so unblocking costs O(1) per
 * operation.
 */
export class CausalBuffer<Op> {
  readonly #options: CausalBufferOptions<Op>;
  /** Operations waiting for one missing id, keyed by that id. */
  readonly #waiting = new Map<string, Op[]>();
  /** Operations that became ready but were not applied because an earlier `apply` threw. */
  #retry: Op[] = [];
  /** Ids of operations that were refused, oldest first: nothing that needs them can be applied. */
  readonly #refused = new Set<string>();
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
   * many were applied.
   *
   * If `apply` throws, that operation is dropped. Without `reject` the error propagates and the
   * operations it would have unblocked are retried by the next `receive`. With `reject` the error
   * (and a refusal because of the budget) goes to it instead, and the rest carries on: for input
   * that may come from a hostile peer, where one bad operation must not hold up the others.
   */
  receive(op: Op, apply: (op: Op) => void, reject?: (op: Op, error: unknown) => void): number {
    return this.#process([op], apply, reject);
  }

  /**
   * Tells the buffer that `id` now exists although no operation offered here introduced it (the
   * replica wrote it itself), so that what was waiting for it is applied, as `receive` would have.
   * Without this, an operation that refers to an id of this replica before the replica has made it
   * would wait for ever here, and be applied on every other replica: they would never agree.
   */
  supplied(id: OpId, apply: (op: Op) => void, reject?: (op: Op, error: unknown) => void): number {
    return this.#process(this.#release(id), apply, reject);
  }

  #process(
    offered: readonly Op[],
    apply: (op: Op) => void,
    reject: ((op: Op, error: unknown) => void) | undefined,
  ): number {
    const queue = [...this.#retry, ...offered];
    this.#unhold(this.#retry.length);
    this.#retry = [];
    let consumed = 0;
    let applied = 0;
    try {
      for (const current of queue) {
        consumed += 1;
        try {
          applied += this.#offer(current, apply, queue);
        } catch (error) {
          if (reject === undefined) throw error;
          reject(current, error);
          // An `apply` can throw after it took effect. What waits for the id then goes ahead, as it
          // does on a replica where nothing threw; otherwise replicas would differ in what they hold.
          const provided = this.#options.provides(current);
          if (provided !== undefined && this.#options.isApplied(provided)) {
            for (const released of this.#release(provided)) queue.push(released);
          } else {
            this.#refuseDependents(current, reject);
          }
        }
      }
    } catch (error) {
      const rest = queue.slice(consumed);
      this.#retry = rest;
      this.#hold(rest.length);
      throw error;
    }
    return applied;
  }

  /** Applies `current` if it is ready (and queues what that unblocks), else parks it. */
  #offer(current: Op, apply: (op: Op) => void, queue: Op[]): number {
    const missing = this.#options
      .requires(current)
      .find((dependency) => !this.#options.isApplied(dependency));
    if (missing !== undefined) {
      if (this.#refused.has(opIdKey(missing))) {
        throw new Error('it depends on an operation that was refused');
      }
      this.#park(missing, current);
      return 0;
    }
    apply(current);
    const provided = this.#options.provides(current);
    if (provided !== undefined) {
      for (const released of this.#release(provided)) queue.push(released);
    }
    return 1;
  }

  /**
   * Whatever needs an operation that was just refused can never be applied, and would hold a place
   * in the buffer for ever: refuse what waits for it now, and (by remembering its id) what arrives
   * later, and so on down the chain.
   */
  #refuseDependents(refused: Op, reject: (op: Op, error: unknown) => void): void {
    const stack = [refused];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      const provided = this.#options.provides(next);
      if (provided === undefined || this.#options.isApplied(provided)) continue;
      this.#refused.add(opIdKey(provided));
      if (this.#refused.size > MAX_REMEMBERED_REFUSALS) {
        for (const oldest of this.#refused) {
          this.#refused.delete(oldest);
          break;
        }
      }
      for (const dependent of this.#release(provided)) {
        reject(dependent, new Error('it depends on an operation that was refused'));
        stack.push(dependent);
      }
    }
  }

  #park(missing: OpId, op: Op): void {
    if (this.#options.budget?.tryTake() === false) {
      throw new PendingLimitError(
        `more than ${this.#options.budget.limit} operations are waiting for others`,
      );
    }
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
    this.#unhold(released.length);
    return released;
  }

  #hold(count: number): void {
    this.#size += count;
    this.#options.budget?.take(count);
  }

  #unhold(count: number): void {
    this.#size -= count;
    this.#options.budget?.give(count);
  }
}
