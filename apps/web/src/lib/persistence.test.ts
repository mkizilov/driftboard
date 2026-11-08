import { VersionVector } from '@driftboard/crdt';
import { storeVector, storeSize } from '@driftboard/protocol';
import { describe, expect, it } from 'vitest';
import { Persistence, restoreStore } from './persistence';
import type { BoardStorage, StoredBoard, WriteBatch } from './storage';
import { operations, order } from './test-support';

describe('restoreStore', () => {
  it('rebuilds the store from operations in any order', () => {
    const mine = operations(1, ['ab', 'cd']);
    const theirs = operations(2);
    const shuffled = [...theirs, ...mine].reverse();
    const { store, dropped } = restoreStore(shuffled);
    expect(dropped).toBe(0);
    expect(storeSize(store)).toBe(mine.length + theirs.length);
    expect(storeVector(store).entries()).toEqual(
      VersionVector.from([
        [must(mine[0]).origin, mine.length],
        [must(theirs[0]).origin, theirs.length],
      ]).entries(),
    );
  });

  it('ignores repeats', () => {
    const ops = operations(1);
    const { store, dropped } = restoreStore([...ops, ...ops, ...ops.slice(0, 2)]);
    expect(storeSize(store)).toBe(ops.length);
    expect(dropped).toBe(0);
  });

  it('is empty for nothing', () => {
    expect(storeSize(restoreStore([]).store)).toBe(0);
  });

  it('keeps only the operations before a gap, and counts the rest as dropped', () => {
    const ops = operations(1, ['abcd']);
    const withGap = ops.filter((op) => op.seq !== 3);
    const { store, dropped } = restoreStore(withGap);
    expect(storeSize(store)).toBe(2);
    expect(dropped).toBe(ops.length - 3);
  });

  it('uses the first copy when two stored copies of an operation differ', () => {
    const ops = operations(1, ['ab']);
    const original = must(ops[1]);
    const other = { ...original, op: { ...original.op, changed: true } };
    const { store } = restoreStore([...ops, other]);
    const kept = store.logs.get(original.origin)?.items[1];
    expect(kept).toEqual(original);
  });

  it('judges each origin on its own', () => {
    const mine = operations(1, ['abcd']);
    const theirs = operations(2, ['xy']);
    const { store, dropped } = restoreStore([...mine.filter((op) => op.seq !== 2), ...theirs]);
    expect(storeSize(store)).toBe(1 + theirs.length);
    expect(dropped).toBe(mine.length - 2);
  });

  it('keeps nothing of an origin whose first operation is missing', () => {
    const ops = operations(1);
    const { store, dropped } = restoreStore(ops.filter((op) => op.seq !== 1));
    expect(storeSize(store)).toBe(0);
    expect(dropped).toBe(ops.length - 1);
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/** A storage the test controls: writes can be held back and made to fail. */
class ScriptedStorage implements BoardStorage {
  durable = true;
  /** Every write that was tried. */
  readonly attempts: WriteBatch[] = [];
  /** Writes that went through. */
  readonly written: WriteBatch[] = [];
  failures = 0;
  closed = false;
  gate: Promise<void> | null = null;

  load(): Promise<StoredBoard> {
    return Promise.resolve({ ops: [], held: [] });
  }

  async write(batch: WriteBatch): Promise<void> {
    this.attempts.push(batch);
    if (this.gate !== null) await this.gate;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('the disk is full');
    }
    this.written.push(batch);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** Every operation written, in order. */
  get opsWritten() {
    return this.written.flatMap((batch) => batch.ops);
  }
}

function held(origin: string, count: number): VersionVector {
  return VersionVector.from([[origin as never, count]]);
}

describe('Persistence', () => {
  it('writes what is added', async () => {
    const storage = new ScriptedStorage();
    const persistence = new Persistence(storage);
    const ops = operations(1);
    persistence.add(ops);
    await persistence.flush();
    expect(storage.opsWritten).toEqual(ops);
    expect(persistence.getError()).toBeNull();
  });

  it('writes the server’s holdings along with the operations, or alone', async () => {
    const storage = new ScriptedStorage();
    const persistence = new Persistence(storage);
    const ops = operations(1);
    const origin = must(ops[0]).origin;
    persistence.add(ops.slice(0, 1));
    persistence.setHeld(held(origin, 1));
    await persistence.flush();
    persistence.setHeld(held(origin, 4));
    await persistence.flush();
    const heldWritten = storage.written.flatMap((batch) =>
      batch.held === null ? [] : [batch.held],
    );
    expect(heldWritten).toEqual([[[origin, 1]], [[origin, 4]]]);
    expect(storage.written.at(-1)?.ops).toEqual([]);
    expect(storage.opsWritten).toEqual(ops.slice(0, 1));
  });

  it('writes nothing when there is nothing to write', async () => {
    const storage = new ScriptedStorage();
    const persistence = new Persistence(storage);
    persistence.add([]);
    await persistence.flush();
    expect(storage.attempts).toEqual([]);
  });

  it('writes again after it has caught up', async () => {
    const storage = new ScriptedStorage();
    const persistence = new Persistence(storage);
    const ops = operations(1, ['ab']);
    persistence.add(ops.slice(0, 2));
    await persistence.flush();
    persistence.add(ops.slice(2));
    await persistence.flush();
    expect(storage.opsWritten).toEqual(ops);
  });

  it('collects what is added during a write into the next one, keeping the order', async () => {
    const storage = new ScriptedStorage();
    let release = () => {};
    storage.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persistence = new Persistence(storage);
    const ops = operations(1, ['abc']);
    const origin = must(ops[0]).origin;

    persistence.add(ops.slice(0, 2));
    persistence.add(ops.slice(2, 4));
    persistence.setHeld(held(origin, 2));
    persistence.add(ops.slice(4));
    persistence.setHeld(held(origin, 5));
    release();
    await persistence.flush();

    expect(storage.written).toHaveLength(2);
    expect(storage.written[0]?.ops).toEqual(ops.slice(0, 2));
    expect(storage.written[1]?.ops).toEqual(ops.slice(2));
    expect(storage.written[1]?.held).toEqual([[origin, 5]]);
  });

  it('keeps a failed write in front of what comes later, and tells about the error', async () => {
    const storage = new ScriptedStorage();
    const persistence = new Persistence(storage);
    const ops = operations(1, ['abc']);
    storage.failures = 1;
    persistence.add(ops.slice(0, 3));
    await persistence.flush();
    expect(storage.written).toEqual([]);
    expect(persistence.getError()?.message).toBe('the disk is full');

    persistence.add(ops.slice(3));
    await persistence.flush();
    expect(storage.opsWritten).toEqual(ops);
    expect(persistence.getError()).toBeNull();
  });

  it('keeps the order when more is added while the write that fails is in flight', async () => {
    const storage = new ScriptedStorage();
    let release = () => {};
    storage.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.failures = 1;
    const persistence = new Persistence(storage);
    const ops = operations(1, ['abc']);

    persistence.add(ops.slice(0, 2));
    persistence.add(ops.slice(2));
    release();
    await persistence.flush();
    expect(persistence.getError()).not.toBeNull();
    await persistence.flush();

    expect(persistence.getError()).toBeNull();
    expect(storage.opsWritten).toEqual(ops);
  });

  it('tries a failed write again when flushed', async () => {
    const storage = new ScriptedStorage();
    const persistence = new Persistence(storage);
    const ops = operations(1);
    storage.failures = 2;
    persistence.add(ops);
    await persistence.flush();
    expect(persistence.getError()).not.toBeNull();
    await persistence.flush();
    expect(persistence.getError()).not.toBeNull();
    await persistence.flush();
    expect(persistence.getError()).toBeNull();
    expect(storage.opsWritten).toEqual(ops);
  });

  it('keeps the latest holdings through a failed write', async () => {
    const storage = new ScriptedStorage();
    const persistence = new Persistence(storage);
    const origin = must(operations(1)[0]).origin;
    storage.failures = 1;
    persistence.setHeld(held(origin, 3));
    await persistence.flush();
    await persistence.flush();
    expect(storage.written.at(-1)?.held).toEqual([[origin, 3]]);
  });

  it('tells its listeners when the error appears and when it goes', async () => {
    const storage = new ScriptedStorage();
    const persistence = new Persistence(storage);
    const seen: (string | null)[] = [];
    const stop = persistence.subscribe(() => {
      seen.push(persistence.getError()?.message ?? null);
    });
    storage.failures = 1;
    persistence.add(operations(1));
    await persistence.flush();
    await persistence.flush();
    expect(seen).toEqual(['the disk is full', null]);
    stop();
    storage.failures = 1;
    persistence.add(operations(2));
    await persistence.flush();
    expect(seen).toHaveLength(2);
  });

  it('writes what is queued before it releases the storage', async () => {
    const storage = new ScriptedStorage();
    const persistence = new Persistence(storage);
    const ops = operations(1);
    persistence.add(ops);
    await persistence.close();
    expect(storage.opsWritten).toEqual(ops);
    expect(storage.closed).toBe(true);
  });

  it('reports whether the storage is durable', () => {
    const storage = new ScriptedStorage();
    storage.durable = false;
    expect(new Persistence(storage).durable).toBe(false);
  });

  it('writes operations in the order they were added, whatever they are', async () => {
    const storage = new ScriptedStorage();
    const persistence = new Persistence(storage);
    const mine = operations(1, ['ab']);
    const theirs = operations(2);
    persistence.add(mine.slice(0, 2));
    persistence.add(theirs);
    persistence.add(mine.slice(2));
    await persistence.flush();
    expect(order(storage.opsWritten)).toEqual(order([...mine, ...theirs]));
    expect(storage.opsWritten).toEqual([...mine.slice(0, 2), ...theirs, ...mine.slice(2)]);
  });
});
