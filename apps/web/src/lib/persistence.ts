import { VersionVector, type ReplicaId } from '@driftboard/crdt';
import { emptyStore, storeAdd, type OpStore, type StampedOp } from '@driftboard/protocol';
import type { BoardStorage } from './storage';

/**
 * Rebuilds the operation store from what was read from storage. Only an origin's operations 1..n
 * without a gap can be used (the sync layer numbers them that way), so anything after a gap is
 * left out and counted in `dropped`; the server sends it again if it has it. Repeats are ignored.
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
  const usable: StampedOp[] = [];
  let distinct = 0;
  for (const log of byOrigin.values()) {
    distinct += log.size;
    for (let seq = 1; ; seq += 1) {
      const op = log.get(seq);
      if (op === undefined) break;
      usable.push(op);
    }
  }
  const added = storeAdd(emptyStore, usable);
  if (!added.ok) throw new Error(`Invariant violated: ${added.detail}`);
  return { store: added.store, dropped: distinct - usable.length };
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
