import { VersionVector, isReplicaId, type JsonObject } from '@driftboard/crdt';
import {
  emptyStore,
  storeAdd,
  storeMissing,
  type OpStore,
  type StampedOp,
} from '@driftboard/protocol';
import type Database from 'better-sqlite3';
import { decodeSnapshot, encodeSnapshot } from './snapshot';

/** The stored data does not hold together (a snapshot or the operations after it are damaged). */
export class StorageError extends Error {
  override readonly name = 'StorageError';
}

interface OpRow {
  origin: string;
  seq: number;
  payload: string;
}

interface SnapshotRow {
  op_count: number;
  payload: Uint8Array;
}

export interface LoadedBoard {
  readonly store: OpStore;
  /** Operations that were read from the tail rather than from the snapshot. */
  readonly tail: number;
}

/**
 * Durable storage of every board's operation log. A board's operations live in two places: a
 * snapshot (all operations up to the last compaction, in one compressed row) and a tail (one row per
 * operation since). New operations are appended to the tail; `compact` folds the tail into the
 * snapshot. Reading a board is one snapshot row plus the tail, however large the board is.
 *
 * Everything is synchronous (better-sqlite3), and every write is one transaction, so a crash leaves
 * either the old or the new state.
 */
export class BoardStorage {
  readonly #db: Database.Database;
  readonly #now: () => number;
  readonly #selectSnapshot: Database.Statement;
  readonly #selectTail: Database.Statement;
  readonly #insertOp: Database.Statement;
  readonly #countTail: Database.Statement;
  readonly #boardsWithTail: Database.Statement;
  readonly #upsertSnapshot: Database.Statement;
  readonly #deleteTail: Database.Statement;
  readonly #appendMany: (boardId: string, ops: readonly StampedOp[]) => void;
  readonly #compactOne: (boardId: string) => number;

  constructor(db: Database.Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    this.#selectSnapshot = db.prepare('SELECT op_count, payload FROM snapshots WHERE board_id = ?');
    this.#selectTail = db.prepare(
      'SELECT origin, seq, payload FROM ops WHERE board_id = ? ORDER BY origin, seq',
    );
    this.#insertOp = db.prepare(
      'INSERT OR IGNORE INTO ops (board_id, origin, seq, payload) VALUES (?, ?, ?, ?)',
    );
    this.#countTail = db.prepare('SELECT COUNT(*) AS n FROM ops WHERE board_id = ?');
    this.#boardsWithTail = db.prepare(
      'SELECT board_id FROM ops GROUP BY board_id HAVING COUNT(*) >= ? ORDER BY board_id',
    );
    this.#upsertSnapshot = db.prepare(
      `INSERT INTO snapshots (board_id, op_count, payload, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (board_id) DO UPDATE SET
         op_count = excluded.op_count, payload = excluded.payload, updated_at = excluded.updated_at`,
    );
    this.#deleteTail = db.prepare('DELETE FROM ops WHERE board_id = ?');

    this.#appendMany = db.transaction((boardId: string, ops: readonly StampedOp[]) => {
      for (const { origin, seq, op } of ops) {
        this.#insertOp.run(boardId, origin, seq, JSON.stringify(op));
      }
    });
    this.#compactOne = db.transaction((boardId: string) => {
      const { store, tail } = this.#read(boardId);
      if (tail === 0) return 0;
      const ops = storeMissing(store, VersionVector.empty);
      this.#upsertSnapshot.run(boardId, ops.length, encodeSnapshot(ops), this.#now());
      this.#deleteTail.run(boardId);
      return tail;
    });
  }

  /** Throws if the database cannot be queried; for health checks. */
  ping(): void {
    this.#db.prepare('SELECT 1').get();
  }

  /** Reads a board's whole log (an unknown board has an empty one). */
  load(boardId: string): LoadedBoard {
    const { store, tail } = this.#read(boardId);
    return { store, tail };
  }

  /** Adds operations to the tail, atomically. Operations already stored are ignored. */
  append(boardId: string, ops: readonly StampedOp[]): void {
    if (ops.length > 0) this.#appendMany(boardId, ops);
  }

  /** Folds the tail into the snapshot. Returns the number of operations that were in the tail. */
  compact(boardId: string): number {
    return this.#compactOne(boardId);
  }

  tailSize(boardId: string): number {
    return (this.#countTail.get(boardId) as { n: number }).n;
  }

  /** Boards whose tail has at least `minTail` operations. */
  boardsWithTail(minTail: number): string[] {
    const rows = this.#boardsWithTail.all(minTail) as { board_id: string }[];
    return rows.map((row) => row.board_id);
  }

  #read(boardId: string): { store: OpStore; tail: number } {
    const snapshot = this.#selectSnapshot.get(boardId) as SnapshotRow | undefined;
    const fromSnapshot: StampedOp[] =
      snapshot === undefined ? [] : decodeSnapshot(snapshot.payload);
    if (snapshot !== undefined && fromSnapshot.length !== snapshot.op_count) {
      const held = `${fromSnapshot.length} operations, not ${snapshot.op_count}`;
      throw new StorageError(`snapshot of ${boardId} holds ${held}`);
    }
    const rows = this.#selectTail.all(boardId) as OpRow[];
    const tail = rows.map((row): StampedOp => {
      if (!isReplicaId(row.origin)) throw new StorageError(`invalid origin in ${boardId}`);
      return { origin: row.origin, seq: row.seq, op: JSON.parse(row.payload) as JsonObject };
    });
    // Snapshot operations come first, grouped by origin; the tail continues each origin's numbering.
    const result = storeAdd(emptyStore, [...fromSnapshot, ...tail]);
    if (!result.ok) throw new StorageError(`the log of ${boardId} is damaged: ${result.detail}`);
    return { store: result.store, tail: tail.length };
  }
}
