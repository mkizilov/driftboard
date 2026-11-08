import { VersionVector, type ReplicaId } from '@driftboard/crdt';
import { emptyStore, storeAdd, type OpStore, type StampedOp } from '@driftboard/protocol';
import type { BoardStorage } from './storage';

/**
 * The longest start of `run` (one origin's operations, numbered from 1 without a gap) that the
 * store accepts. What it accepts of an origin does not depend on other origins, and a start of an
 * acceptable run is acceptable, so this can look for the end by halving.
 */
function acceptableStart(run: readonly StampedOp[]): readonly StampedOp[] {
  let good = 0;
  let bad = run.length;
  while (bad - good > 1) {
    const middle = Math.floor((good + bad) / 2);
    if (storeAdd(emptyStore, run.slice(0, middle)).ok) good = middle;
    else bad = middle;
  }
  return run.slice(0, good);
}

/**
 * Rebuilds the operation store from what was read from storage. Only an origin's operations 1..n
 * without a gap, and without one the store refuses (a damaged disk can hold anything), can be used
 * (the sync layer numbers them that way), so anything after such an operation is left out and
 * counted in `dropped`; the server sends it again if it has it. Repeats are ignored.
 */
export function restoreStore(ops: readonly StampedOp[]): { store: OpStore; dropped: number } {
  const byOrigin = new Map<ReplicaId, Map<number, StampedOp>>();
  for (const op of ops) {
    let log = byOrigin.get(op.origin);
    if (log === undefined) {
      log = new Map();
      byOrigin.set(op.origin, log);
    }
    if (!log.has(op.seq)) log.set(op.seq, op);
  }
  let store = emptyStore;
  let distinct = 0;
  let kept = 0;
  for (const log of byOrigin.values()) {
    distinct += log.size;
    const run: StampedOp[] = [];
    for (let seq = 1; ; seq += 1) {
      const op = log.get(seq);
      if (op === undefined) break;
      run.push(op);
    }
    let added = storeAdd(store, run);
    let usable: readonly StampedOp[] = run;
    if (!added.ok) {
      usable = acceptableStart(run);
      added = storeAdd(store, usable);
    }
    if (!added.ok) throw new Error(`Invariant violated: ${added.detail}`);
    store = added.store;
    kept += usable.length;
  }
  return { store, dropped: distinct - kept };
}

/**
 * Writes behind the app: the board never waits for storage. Operations and the held vector are
 * queued and written in order, in as few transactions as possible. If a write fails, what was in
 * it stays at the front of the queue, so nothing later is stored ahead of it (that would leave a
 * gap in an origin's operations), `error` is set, and the next change or `flush` tries again.
 */
export class Persistence {
  readonly #storage: BoardStorage;
  readonly #listeners = new Set<() => void>();
  #queued: StampedOp[] = [];
  #held: VersionVector | null = null;
  #running = false;
  #draining: Promise<void> = Promise.resolve();
  #error: Error | null = null;

  constructor(storage: BoardStorage) {
    this.#storage = storage;
  }

  /** Whether the data survives the page. */
  get durable(): boolean {
    return this.#storage.durable;
  }

  /** The last write's failure, or `null` once a write has worked. */
  readonly getError = (): Error | null => this.#error;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Queues operations that just entered the store. */
  add(ops: readonly StampedOp[]): void {
    this.#queued.push(...ops);
    this.#schedule();
  }

  /** Queues what the server is now known to hold; only the latest value is ever written. */
  setHeld(held: VersionVector): void {
    this.#held = held;
    this.#schedule();
  }

  /** Resolves when everything queued so far has been written, or a write has failed. */
  async flush(): Promise<void> {
    this.#schedule();
    await this.#draining;
  }

  /** Writes what is queued, then releases the storage. */
  async close(): Promise<void> {
    await this.flush();
    await this.#storage.close();
  }

  #schedule(): void {
    if (this.#running) return;
    this.#running = true;
    this.#draining = this.#drain();
  }

  async #drain(): Promise<void> {
    try {
      while (this.#queued.length > 0 || this.#held !== null) {
        const ops = this.#queued;
        const held = this.#held;
        this.#queued = [];
        this.#held = null;
        try {
          await this.#storage.write({ ops, held: held === null ? null : held.entries() });
          this.#setError(null);
        } catch (error) {
          this.#queued = [...ops, ...this.#queued];
          this.#held ??= held;
          this.#setError(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    } finally {
      this.#running = false;
    }
  }

  #setError(error: Error | null): void {
    if (this.#error === error) return;
    this.#error = error;
    for (const listener of [...this.#listeners]) listener();
  }
}
