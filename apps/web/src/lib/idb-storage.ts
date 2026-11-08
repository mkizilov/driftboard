import type { JsonObject, ReplicaId } from '@driftboard/crdt';
import type { StampedOp } from '@driftboard/protocol';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { BoardStorage, StoredBoard, WriteBatch } from './storage';

export const DATABASE_NAME = 'driftboard';
const DATABASE_VERSION = 1;

/** Number of tail rows at which they are folded into the snapshot. */
export const COMPACT_AT = 500;

/** One operation of one board. The key makes writing the same operation twice harmless. */
interface OpRow {
  boardId: string;
  origin: ReplicaId;
  seq: number;
  op: JsonObject;
}

/** Operations folded together, so that loading a long log reads one record and not thousands. */
interface SnapshotRow {
  boardId: string;
  ops: StampedOp[];
}

interface SyncRow {
  boardId: string;
  held: [ReplicaId, number][];
}

interface DriftboardDb extends DBSchema {
  ops: { key: [string, string, number]; value: OpRow; indexes: { byBoard: string } };
  snapshots: { key: string; value: SnapshotRow };
  sync: { key: string; value: SyncRow };
}

const keyOf = (op: { origin: string; seq: number }) => `${op.origin}\u0000${op.seq}`;

export interface IdbOptions {
  /** Database name; tests use their own. */
  readonly name?: string;
  /** Tail length that triggers compaction. */
  readonly compactAt?: number;
}

/**
 * A board's log in IndexedDB: a snapshot record with the operations folded so far, a tail of
 * single-operation rows written since, and the vector of what the server is known to hold. When the
 * tail reaches `compactAt` rows it is folded into the snapshot in one transaction. Nothing is
 * discarded: other replicas are caught up from the full log by version vector.
 *
 * Several tabs may share a board's rows. They write under different replica ids, and an operation
 * received by two of them is the same row written twice.
 */
export class IdbBoardStorage implements BoardStorage {
  readonly durable = true;
  readonly #db: IDBPDatabase<DriftboardDb>;
  readonly #boardId: string;
  readonly #compactAt: number;
  #tail = 0;

  constructor(db: IDBPDatabase<DriftboardDb>, boardId: string, compactAt: number) {
    this.#db = db;
    this.#boardId = boardId;
    this.#compactAt = compactAt;
  }

  async load(): Promise<StoredBoard> {
    const tx = this.#db.transaction(['ops', 'snapshots', 'sync'], 'readonly');
    const [snapshot, rows, sync] = await Promise.all([
      tx.objectStore('snapshots').get(this.#boardId),
      tx.objectStore('ops').index('byBoard').getAll(this.#boardId),
      tx.objectStore('sync').get(this.#boardId),
      tx.done,
    ]);
    this.#tail = rows.length;
    const tail = rows.map(({ origin, seq, op }) => ({ origin, seq, op }));
    return { ops: [...(snapshot?.ops ?? []), ...tail], held: sync?.held ?? [] };
  }

  async write(batch: WriteBatch): Promise<void> {
    if (batch.ops.length > 0 || batch.held !== null) {
      const tx = this.#db.transaction(['ops', 'sync'], 'readwrite');
      const ops = tx.objectStore('ops');
      const writes: Promise<unknown>[] = batch.ops.map((op) =>
        ops.put({ boardId: this.#boardId, origin: op.origin, seq: op.seq, op: op.op }),
      );
      if (batch.held !== null) {
        const held = batch.held.map(([replica, count]): [ReplicaId, number] => [replica, count]);
        writes.push(tx.objectStore('sync').put({ boardId: this.#boardId, held }));
      }
      await Promise.all([...writes, tx.done]);
      this.#tail += batch.ops.length;
    }
    if (this.#tail >= this.#compactAt) await this.compact();
  }

  /** Folds the tail into the snapshot. */
  async compact(): Promise<void> {
    const tx = this.#db.transaction(['ops', 'snapshots'], 'readwrite');
    const ops = tx.objectStore('ops');
    const snapshots = tx.objectStore('snapshots');
    const [snapshot, rows] = await Promise.all([
      snapshots.get(this.#boardId),
      ops.index('byBoard').getAll(this.#boardId),
    ]);
    if (rows.length === 0) {
      await tx.done;
      this.#tail = 0;
      return;
    }
    const folded = new Map<string, StampedOp>();
    for (const op of snapshot?.ops ?? []) folded.set(keyOf(op), op);
    for (const { origin, seq, op } of rows) folded.set(keyOf({ origin, seq }), { origin, seq, op });
    await Promise.all([
      snapshots.put({ boardId: this.#boardId, ops: [...folded.values()] }),
      ...rows.map((row) => ops.delete([row.boardId, row.origin, row.seq])),
      tx.done,
    ]);
    this.#tail = 0;
  }

  /** How the log is stored: operations in the snapshot and rows in the tail. */
  async inspect(): Promise<{ snapshotOps: number; tailRows: number }> {
    const [snapshot, rows] = await Promise.all([
      this.#db.get('snapshots', this.#boardId),
      this.#db.getAllFromIndex('ops', 'byBoard', this.#boardId),
    ]);
    return { snapshotOps: snapshot?.ops.length ?? 0, tailRows: rows.length };
  }

  close(): Promise<void> {
    this.#db.close();
    return Promise.resolve();
  }
}

/** Opens (creating it if needed) the database and the storage of one board. */
export async function openIdbStorage(
  boardId: string,
  options: IdbOptions = {},
): Promise<IdbBoardStorage> {
  const db = await openDB<DriftboardDb>(options.name ?? DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database) {
      const ops = database.createObjectStore('ops', { keyPath: ['boardId', 'origin', 'seq'] });
      ops.createIndex('byBoard', 'boardId');
      database.createObjectStore('snapshots', { keyPath: 'boardId' });
      database.createObjectStore('sync', { keyPath: 'boardId' });
    },
  });
  return new IdbBoardStorage(db, boardId, options.compactAt ?? COMPACT_AT);
}
