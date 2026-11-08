import type { ReplicaId } from '@driftboard/crdt';
import type { StampedOp } from '@driftboard/protocol';

/** `[replica, count]` pairs: how many operations of each replica a vector covers. */
export type HeldEntries = readonly (readonly [ReplicaId, number])[];

/** Everything a board keeps on this device. */
export interface StoredBoard {
  /** Every operation the replica holds, in no particular order and possibly with repeats. */
  readonly ops: readonly StampedOp[];
  /** What the server was last known to hold. It only feeds the count of pending changes. */
  readonly held: HeldEntries;
}

/** One write: operations to add and, when it changed, what the server is known to hold. */
export interface WriteBatch {
  readonly ops: readonly StampedOp[];
  readonly held: HeldEntries | null;
}

/**
 * Durable storage for one board. A write is atomic: after a failure none of it is stored. Writing
 * an operation that is already stored changes nothing.
 */
export interface BoardStorage {
  /** False for a stand-in that is lost with the page (used when IndexedDB is not available). */
  readonly durable: boolean;
  load(): Promise<StoredBoard>;
  write(batch: WriteBatch): Promise<void>;
  /** Releases the connection to the database. */
  close(): Promise<void>;
}

interface MemoryBoard {
  readonly ops: Map<string, StampedOp>;
  held: HeldEntries;
}

const opKey = (op: { origin: string; seq: number }) => `${op.origin}\u0000${op.seq}`;

/**
 * Storage in memory that outlives the `BoardStorage` handles opened on it, as a disk outlives a
 * page: close a handle, open the board again and the data is there. It stands in for IndexedDB in
 * tests and when IndexedDB cannot be used.
 */
export class MemoryDisk {
  readonly #boards = new Map<string, MemoryBoard>();
  readonly #durable: boolean;
  #failures = 0;

  constructor(options: { durable?: boolean } = {}) {
    this.#durable = options.durable ?? true;
  }

  /** Makes the next `count` writes fail, as a full or broken disk would. */
  failNextWrites(count: number): void {
    this.#failures = count;
  }

  /** How many operations of a board are stored. */
  size(boardId: string): number {
    return this.#boards.get(boardId)?.ops.size ?? 0;
  }

  open(boardId: string): BoardStorage {
    let closed = false;
    const board = (): MemoryBoard => {
      let found = this.#boards.get(boardId);
      if (found === undefined) {
        found = { ops: new Map(), held: [] };
        this.#boards.set(boardId, found);
      }
      return found;
    };
    return {
      durable: this.#durable,
      load: () => {
        if (closed) return Promise.reject(new Error('the storage is closed'));
        const stored = board();
        return Promise.resolve({ ops: [...stored.ops.values()], held: stored.held });
      },
      write: (batch) => {
        if (closed) return Promise.reject(new Error('the storage is closed'));
        if (this.#failures > 0) {
          this.#failures -= 1;
          return Promise.reject(new Error('the disk is full'));
        }
        const stored = board();
        for (const op of batch.ops) stored.ops.set(opKey(op), op);
        if (batch.held !== null) stored.held = batch.held;
        return Promise.resolve();
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
  }
}
