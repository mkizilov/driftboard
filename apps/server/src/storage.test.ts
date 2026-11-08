import { VersionVector, replicaId } from '@driftboard/crdt';
import { storeMissing, storeSize, storeVector, type StampedOp } from '@driftboard/protocol';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase } from './db';
import { SnapshotError } from './snapshot';
import { StorageError, BoardStorage } from './storage';
import { stamped } from './test-support';

const a = replicaId('a');
const b = replicaId('b');
const BOARD = 'board-aaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'board-bbbbbbbbbbbbbbbbbbbbbb';

let db: Database.Database;
let storage: BoardStorage;
let clock = 1000;

beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  clock = 1000;
  storage = new BoardStorage(db, () => (clock += 1));
});

afterEach(() => {
  db.close();
});

const labels = (ops: readonly StampedOp[]) => ops.map((op) => `${op.origin}${op.seq}`);
const everything = (boardId: string) =>
  storeMissing(storage.load(boardId).store, VersionVector.empty);
const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('BoardStorage', () => {
  it('has an empty log for a board it has never seen', () => {
    const loaded = storage.load(BOARD);
    expect(storeSize(loaded.store)).toBe(0);
    expect(loaded.tail).toBe(0);
    expect(storage.tailSize(BOARD)).toBe(0);
  });

  it('stores appended operations and loads them back, in order per origin', () => {
    storage.append(BOARD, [...stamped(b, 1, 2), ...stamped(a, 1, 3)]);
    const loaded = storage.load(BOARD);
    expect(loaded.tail).toBe(5);
    expect(labels(everything(BOARD))).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']);
    expect(everything(BOARD)).toEqual([...stamped(a, 1, 3), ...stamped(b, 1, 2)]);
  });

  it('adds to what is already there, and ignores operations it already holds', () => {
    storage.append(BOARD, stamped(a, 1, 3));
    storage.append(BOARD, stamped(a, 3, 3));
    expect(labels(everything(BOARD))).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(storage.tailSize(BOARD)).toBe(5);
    storage.append(BOARD, []);
    expect(storage.tailSize(BOARD)).toBe(5);
  });

  it('keeps boards apart', () => {
    storage.append(BOARD, stamped(a, 1, 2));
    storage.append(OTHER, stamped(a, 1, 4));
    expect(storeSize(storage.load(BOARD).store)).toBe(2);
    expect(storeSize(storage.load(OTHER).store)).toBe(4);
    expect(storage.compact(BOARD)).toBe(2);
    expect(storage.tailSize(OTHER)).toBe(4);
    expect(storeSize(storage.load(OTHER).store)).toBe(4);
  });

  it('writes a batch atomically', () => {
    storage.append(BOARD, stamped(a, 1, 2));
    // Operation 4 cannot be stored, so operation 3 of the same batch must not stay behind either.
    db.exec(
      "CREATE TRIGGER refuse_four BEFORE INSERT ON ops WHEN NEW.seq = 4 BEGIN SELECT RAISE(ABORT, 'no'); END",
    );
    expect(() => storage.append(BOARD, stamped(a, 3, 3))).toThrow();
    expect(storage.tailSize(BOARD)).toBe(2);
    db.exec('DROP TRIGGER refuse_four');
    storage.append(BOARD, stamped(a, 3, 3));
    expect(storage.tailSize(BOARD)).toBe(5);
  });
});

describe('compaction', () => {
  it('folds the tail into the snapshot without changing the log', () => {
    storage.append(BOARD, [...stamped(a, 1, 6), ...stamped(b, 1, 3)]);
    const before = everything(BOARD);
    expect(storage.compact(BOARD)).toBe(9);

    expect(count('ops')).toBe(0);
    expect(count('snapshots')).toBe(1);
    const loaded = storage.load(BOARD);
    expect(loaded.tail).toBe(0);
    expect(everything(BOARD)).toEqual(before);
    expect(storeVector(loaded.store).entries()).toEqual([
      ['a', 6],
      ['b', 3],
    ]);
  });

  it('has nothing to do for an empty tail or an unknown board', () => {
    expect(storage.compact(BOARD)).toBe(0);
    storage.append(BOARD, stamped(a, 1, 2));
    storage.compact(BOARD);
    expect(storage.compact(BOARD)).toBe(0);
    expect(count('snapshots')).toBe(1);
  });

  it('keeps working when operations arrive after a compaction', () => {
    storage.append(BOARD, stamped(a, 1, 4));
    storage.compact(BOARD);
    storage.append(BOARD, [...stamped(a, 5, 3), ...stamped(b, 1, 2)]);

    const loaded = storage.load(BOARD);
    expect(loaded.tail).toBe(5);
    const expected = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'b1', 'b2'];
    expect(labels(everything(BOARD))).toEqual(expected);

    expect(storage.compact(BOARD)).toBe(5);
    expect(count('snapshots')).toBe(1);
    expect(labels(everything(BOARD))).toHaveLength(9);
    expect(storage.load(BOARD).tail).toBe(0);
  });

  it('lists the boards whose tail is long enough', () => {
    storage.append(BOARD, stamped(a, 1, 5));
    storage.append(OTHER, stamped(a, 1, 2));
    expect(storage.boardsWithTail(1)).toEqual([BOARD, OTHER]);
    expect(storage.boardsWithTail(3)).toEqual([BOARD]);
    expect(storage.boardsWithTail(6)).toEqual([]);
    storage.compact(BOARD);
    expect(storage.boardsWithTail(1)).toEqual([OTHER]);
  });

  it('records when the snapshot was written', () => {
    storage.append(BOARD, stamped(a, 1, 1));
    storage.compact(BOARD);
    const row = db.prepare('SELECT op_count, updated_at FROM snapshots').get() as {
      op_count: number;
      updated_at: number;
    };
    expect(row).toEqual({ op_count: 1, updated_at: 1001 });
  });

  it('survives a large log: the snapshot is a single row that loads back complete', () => {
    storage.append(BOARD, stamped(a, 1, 1500));
    storage.compact(BOARD);
    storage.append(BOARD, stamped(a, 1501, 10));
    const loaded = storage.load(BOARD);
    expect(storeSize(loaded.store)).toBe(1510);
    expect(loaded.tail).toBe(10);
    expect(count('snapshots')).toBe(1);
  });
});

describe('damaged data', () => {
  it('reports a snapshot that cannot be read', () => {
    storage.append(BOARD, stamped(a, 1, 3));
    storage.compact(BOARD);
    db.prepare('UPDATE snapshots SET payload = ?').run(Buffer.from('garbage'));
    expect(() => storage.load(BOARD)).toThrow(SnapshotError);
  });

  it('reports a snapshot whose operation count is wrong', () => {
    storage.append(BOARD, stamped(a, 1, 3));
    storage.compact(BOARD);
    db.prepare('UPDATE snapshots SET op_count = 99').run();
    expect(() => storage.load(BOARD)).toThrow(StorageError);
  });

  it('reports a tail that does not continue the snapshot', () => {
    storage.append(BOARD, stamped(a, 1, 3));
    storage.compact(BOARD);
    storage.append(BOARD, stamped(a, 6, 1));
    expect(() => storage.load(BOARD)).toThrow(StorageError);
    expect(() => storage.compact(BOARD)).toThrow(StorageError);
    expect(count('snapshots')).toBe(1);
  });

  it('reports a row with an invalid origin', () => {
    db.prepare('INSERT INTO ops (board_id, origin, seq, payload) VALUES (?, ?, ?, ?)').run(
      BOARD,
      'bad id',
      1,
      '{}',
    );
    expect(() => storage.load(BOARD)).toThrow(StorageError);
  });
});
