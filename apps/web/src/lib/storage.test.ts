import 'fake-indexeddb/auto';
import type { StampedOp } from '@driftboard/protocol';
import { describe, expect, it } from 'vitest';
import { COMPACT_AT, openIdbStorage } from './idb-storage';
import { MemoryDisk, type BoardStorage } from './storage';
import { operations, order } from './test-support';

/** Something that opens the storage of a board, again and again on the same data. */
interface Disk {
  open(boardId: string): Promise<BoardStorage>;
}

function contract(name: string, createDisk: () => Disk) {
  describe(`BoardStorage (${name})`, () => {
    it('starts empty', async () => {
      const storage = await createDisk().open('board-1');
      expect(await storage.load()).toEqual({ ops: [], held: [] });
    });

    it('keeps what was written, and gives it back after closing and opening again', async () => {
      const disk = createDisk();
      const ops = operations(1);
      const first = await disk.open('board-1');
      await first.write({ ops: ops.slice(0, 2), held: null });
      await first.write({ ops: ops.slice(2), held: null });
      await first.close();

      const second = await disk.open('board-1');
      const stored = await second.load();
      expect(order(stored.ops)).toEqual(order(ops));
    });

    it('keeps operations of several replicas', async () => {
      const disk = createDisk();
      const mine = operations(1);
      const theirs = operations(2, ['x', 'y']);
      const storage = await disk.open('board-1');
      await storage.write({ ops: [...mine, ...theirs], held: null });
      expect(order((await storage.load()).ops)).toEqual(order([...mine, ...theirs]));
    });

    it('writes an operation that is already stored without storing it twice', async () => {
      const disk = createDisk();
      const ops = operations(1);
      const storage = await disk.open('board-1');
      await storage.write({ ops, held: null });
      await storage.write({ ops: ops.slice(1, 3), held: null });
      expect(order((await storage.load()).ops)).toEqual(order(ops));
    });

    it('keeps what the server holds, replacing it on each write that has one', async () => {
      const disk = createDisk();
      const storage = await disk.open('board-1');
      const [a, b] = [operations(1)[0]?.origin, operations(2)[0]?.origin];
      if (a === undefined || b === undefined) throw new Error('no operations');
      await storage.write({ ops: [], held: [[a, 3]] });
      expect((await storage.load()).held).toEqual([[a, 3]]);
      await storage.write({
        ops: operations(1),
        held: [
          [a, 4],
          [b, 2],
        ],
      });
      await storage.write({ ops: [], held: null });
      expect((await (await disk.open('board-1')).load()).held).toEqual([
        [a, 4],
        [b, 2],
      ]);
    });

    it('keeps boards apart', async () => {
      const disk = createDisk();
      const one = await disk.open('board-1');
      const two = await disk.open('board-2');
      await one.write({ ops: operations(1), held: null });
      expect((await two.load()).ops).toEqual([]);
    });

    it('lets two handles on the same board add to it, as two tabs do', async () => {
      const disk = createDisk();
      const first = await disk.open('board-1');
      const second = await disk.open('board-1');
      const mine = operations(1);
      const theirs = operations(2);
      await first.write({ ops: mine, held: null });
      await second.write({ ops: theirs, held: null });
      expect(order((await first.load()).ops)).toEqual(order([...mine, ...theirs]));
    });
  });
}

contract('memory', () => {
  const disk = new MemoryDisk();
  return { open: (boardId) => Promise.resolve(disk.open(boardId)) };
});

let databases = 0;
contract('IndexedDB', () => {
  const name = `driftboard-test-${databases}`;
  databases += 1;
  return { open: (boardId) => openIdbStorage(boardId, { name }) };
});

describe('MemoryDisk', () => {
  it('stores nothing from a write that fails, and recovers afterwards', async () => {
    const disk = new MemoryDisk();
    const storage = disk.open('board-1');
    disk.failNextWrites(1);
    await expect(storage.write({ ops: operations(1), held: null })).rejects.toThrow('disk is full');
    expect((await storage.load()).ops).toEqual([]);
    await storage.write({ ops: operations(1), held: null });
    expect((await storage.load()).ops).not.toEqual([]);
  });

  it('refuses to be used after it is closed', async () => {
    const storage = new MemoryDisk().open('board-1');
    await storage.close();
    await expect(storage.load()).rejects.toThrow('closed');
    await expect(storage.write({ ops: [], held: null })).rejects.toThrow('closed');
  });

  it('says whether it is durable', () => {
    expect(new MemoryDisk().open('x').durable).toBe(true);
    expect(new MemoryDisk({ durable: false }).open('x').durable).toBe(false);
  });
});

describe('IdbBoardStorage', () => {
  const unique = () => {
    databases += 1;
    return `driftboard-test-${databases}`;
  };

  it('is durable', async () => {
    expect((await openIdbStorage('board-1', { name: unique() })).durable).toBe(true);
  });

  it('stores nothing from a write that fails halfway', async () => {
    const storage = await openIdbStorage('board-1', { name: unique() });
    const good = operations(1);
    const origin = good[0]?.origin;
    if (origin === undefined) throw new Error('no operations');
    // A function cannot be stored in IndexedDB, so this write fails after the others were queued.
    const broken = { origin, seq: 99, op: { type: () => 1 } } as unknown as StampedOp;
    await expect(storage.write({ ops: [...good, broken], held: [] })).rejects.toThrow();
    expect(await storage.load()).toEqual({ ops: [], held: [] });
  });

  it('folds the tail into the snapshot once it is long enough, losing nothing', async () => {
    const name = unique();
    const storage = await openIdbStorage('board-1', { name, compactAt: 5 });
    const ops = operations(1, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    await storage.write({ ops: ops.slice(0, 3), held: [] });
    expect(await storage.inspect()).toEqual({ snapshotOps: 0, tailRows: 3 });

    await storage.write({ ops: ops.slice(3, 6), held: [] });
    expect(await storage.inspect()).toEqual({ snapshotOps: 6, tailRows: 0 });

    await storage.write({ ops: ops.slice(6, 8), held: [] });
    expect(await storage.inspect()).toEqual({ snapshotOps: 6, tailRows: 2 });
    await storage.close();

    const reopened = await openIdbStorage('board-1', { name, compactAt: 5 });
    expect(order((await reopened.load()).ops)).toEqual(order(ops.slice(0, 8)));
  });

  it('folds exactly when the tail reaches the limit', async () => {
    const storage = await openIdbStorage('board-1', { name: unique(), compactAt: 3 });
    const ops = operations(1, ['abc']);
    await storage.write({ ops: ops.slice(0, 2), held: null });
    expect((await storage.inspect()).snapshotOps).toBe(0);
    await storage.write({ ops: ops.slice(2, 3), held: null });
    expect(await storage.inspect()).toEqual({ snapshotOps: 3, tailRows: 0 });
  });

  it('keeps what the server holds when it folds', async () => {
    const storage = await openIdbStorage('board-1', { name: unique(), compactAt: 2 });
    const ops = operations(1);
    const origin = ops[0]?.origin;
    if (origin === undefined) throw new Error('no operations');
    await storage.write({ ops, held: [[origin, 2]] });
    expect((await storage.inspect()).tailRows).toBe(0);
    expect((await storage.load()).held).toEqual([[origin, 2]]);
  });

  it('does not store an operation twice when it is written again after folding', async () => {
    const storage = await openIdbStorage('board-1', { name: unique(), compactAt: 3 });
    const ops = operations(1);
    await storage.write({ ops, held: null });
    expect((await storage.inspect()).snapshotOps).toBe(ops.length);
    await storage.write({ ops: ops.slice(0, 2), held: null });
    await storage.compact();
    expect(await storage.inspect()).toEqual({ snapshotOps: ops.length, tailRows: 0 });
    expect(order((await storage.load()).ops)).toEqual(order(ops));
  });

  it('can be folded when there is nothing to fold', async () => {
    const storage = await openIdbStorage('board-1', { name: unique() });
    await storage.compact();
    expect(await storage.inspect()).toEqual({ snapshotOps: 0, tailRows: 0 });
  });

  it('keeps boards apart when folding', async () => {
    const name = unique();
    const one = await openIdbStorage('board-1', { name, compactAt: 1 });
    const two = await openIdbStorage('board-2', { name, compactAt: 1000 });
    await two.write({ ops: operations(2), held: null });
    await one.write({ ops: operations(1), held: null });
    expect((await one.inspect()).snapshotOps).toBeGreaterThan(0);
    expect(await two.inspect()).toEqual({ snapshotOps: 0, tailRows: operations(2).length });
  });

  it('folds by default after a few hundred operations', () => {
    expect(COMPACT_AT).toBeGreaterThanOrEqual(100);
  });
});
