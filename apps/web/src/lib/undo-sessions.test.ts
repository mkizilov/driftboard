import { NOTE_COLORS } from '@driftboard/crdt';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { restoreStore } from './persistence';
import { Device, sharedNotes } from './test-device';
import { FakeNetwork } from './test-network';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/** People on one board, all online, with the page open. */
async function board(count: number) {
  const net = new FakeNetwork();
  const devices = Array.from({ length: count }, (_, index) => new Device(net, index + 1));
  for (const device of devices) await device.openPage();
  return { net, devices };
}

/** Types `text` into a note one character at a time, 20 ms apart, as a person does. */
function type(device: Device, id: string, start: number, text: string): void {
  [...text].forEach((char, offset) => {
    device.store.editText(id, { start: start + offset, deleteCount: 0, insert: char });
    device.timers.advance(20);
  });
}

const textOf = (device: Device, id: string) => device.store.getNote(id)?.text;

/** Alice and Bob share a note saying "hello world", and a pause has closed the typing. */
async function shared() {
  const { net, devices } = await board(2);
  const [alice, bob] = [must(devices[0]), must(devices[1])];
  const id = must(alice.store.createNote(10, 20));
  type(alice, id, 0, 'hello world');
  alice.timers.advance(5000);
  expect(textOf(bob, id)).toBe('hello world');
  return { net, alice, bob, id };
}

describe('undo through the whole stack', () => {
  it('undoes the user’s own typing after both of them typed in the same note while apart', async () => {
    const { alice, bob, id } = await shared();
    alice.goOffline();
    bob.goOffline();
    type(alice, id, 11, '!');
    type(bob, id, 0, '>> ');
    alice.goOnline();
    bob.goOnline();
    expect(textOf(alice, id)).toBe('>> hello world!');
    expect(textOf(bob, id)).toBe('>> hello world!');

    alice.store.undo();
    expect(textOf(alice, id)).toBe('>> hello world');
    expect(textOf(bob, id)).toBe('>> hello world');
    expect(alice.indicator).toMatchObject({ kind: 'online', pending: 0 });
    sharedNotes([alice, bob]);

    alice.store.redo();
    expect(textOf(bob, id)).toBe('>> hello world!');
    sharedNotes([alice, bob]);
  });

  it('puts back deleted text after the other person added to the same note meanwhile', async () => {
    const { alice, bob, id } = await shared();
    alice.goOffline();
    bob.goOffline();
    alice.store.editText(id, { start: 6, deleteCount: 5, insert: '' });
    type(bob, id, 11, '!');
    alice.goOnline();
    bob.goOnline();
    expect(textOf(bob, id)).toBe('hello !');

    alice.store.undo();
    expect(textOf(alice, id)).toBe('hello world!');
    expect(textOf(bob, id)).toBe('hello world!');
    sharedNotes([alice, bob]);
  });

  it('undoes the deletion of a note for everyone, with its colour, position and text', async () => {
    const { alice, bob, id } = await shared();
    alice.store.setColor(id, 'purple');
    alice.store.moveNote(id, 77, 88);
    alice.store.deleteNote(id);
    expect(bob.store.getNote(id)).toBeUndefined();

    alice.store.undo();
    expect(bob.store.getNote(id)).toMatchObject({
      x: 77,
      y: 88,
      color: 'purple',
      text: 'hello world',
    });
    sharedNotes([alice, bob]);

    alice.store.redo();
    expect(bob.store.getNote(id)).toBeUndefined();
    sharedNotes([alice, bob]);
  });

  it('does not bring back a note the other person deleted, and undoes the step before it instead', async () => {
    const { alice, bob, id } = await shared();
    alice.store.setColor(id, 'green');
    bob.store.deleteNote(id);
    expect(alice.store.getNote(id)).toBeUndefined();
    alice.store.undo();
    alice.store.undo();
    expect(alice.store.getNote(id)).toBeUndefined();
    expect(bob.store.getNote(id)).toBeUndefined();
  });

  it('never undoes what the other person did, however often it is asked to', async () => {
    const { alice, bob, id } = await shared();
    bob.store.moveNote(id, 500, 500);
    type(bob, id, 11, ' (bob)');
    bob.store.setColor(id, 'orange');
    for (let times = 0; times < 5; times += 1) alice.store.undo();
    // Alice's only steps were making the note and typing its text; everything of Bob's stays.
    expect(alice.store.getNote(id)).toBeUndefined();
    alice.store.redo();
    alice.store.redo();
    expect(alice.store.getNote(id)).toMatchObject({
      x: 500,
      y: 500,
      color: 'orange',
      text: 'hello world (bob)',
    });
    sharedNotes([alice, bob]);
  });

  it('works offline, and what it did is a pending change until the connection returns', async () => {
    const { alice, bob, id } = await shared();
    alice.goOffline();
    alice.store.moveNote(id, 1, 2);
    const pending = alice.indicator.pending;
    alice.store.undo();
    expect(alice.indicator.pending).toBeGreaterThan(pending);
    expect(alice.store.getNote(id)).toMatchObject({ x: 10, y: 20 });
    alice.goOnline();
    expect(bob.store.getNote(id)).toMatchObject({ x: 10, y: 20 });
    expect(alice.indicator.pending).toBe(0);
  });

  it('is kept as operations: after a reload the board shows the undone state and the history starts empty', async () => {
    const { alice, bob, id } = await shared();
    alice.store.moveNote(id, 1, 2);
    alice.store.undo();
    await alice.reload();
    expect(alice.store.getNote(id)).toMatchObject({ x: 10, y: 20, text: 'hello world' });
    expect(alice.store.getHistoryState()).toEqual({ canUndo: false, canRedo: false });
    alice.store.undo();
    expect(alice.store.getNote(id)?.text).toBe('hello world');
    expect(bob.store.getNote(id)).toMatchObject({ x: 10, y: 20 });
  });

  it('keeps the other person’s history apart: each has their own', async () => {
    const { alice, bob, id } = await shared();
    bob.store.setColor(id, 'blue');
    alice.store.moveNote(id, 3, 4);
    bob.store.undo();
    expect(alice.store.getNote(id)).toMatchObject({ x: 3, y: 4, color: 'yellow' });
    alice.store.undo();
    expect(bob.store.getNote(id)).toMatchObject({ x: 10, y: 20, color: 'yellow' });
    sharedNotes([alice, bob]);
  });
});

describe('random sessions on three devices with undo and redo', () => {
  type Action =
    | { kind: 'create'; device: number; x: number; y: number }
    | { kind: 'move'; device: number; pick: number; x: number; y: number }
    | { kind: 'color'; device: number; pick: number; color: number }
    | { kind: 'type'; device: number; pick: number; at: number; text: string }
    | { kind: 'erase'; device: number; pick: number; at: number; count: number }
    | { kind: 'delete'; device: number; pick: number }
    | { kind: 'undo'; device: number }
    | { kind: 'redo'; device: number }
    | { kind: 'offline'; device: number }
    | { kind: 'online'; device: number }
    | { kind: 'wait'; ms: number };

  const device = fc.nat(2);
  const spot = fc.nat(50);
  const word = fc
    .array(fc.constantFrom('a', 'b', ' ', '😀'), { minLength: 1, maxLength: 3 })
    .map((parts) => parts.join(''));
  const action = fc.oneof(
    {
      weight: 2,
      arbitrary: fc.record({ kind: fc.constant('create' as const), device, x: spot, y: spot }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant('move' as const),
        device,
        pick: fc.nat(),
        x: spot,
        y: spot,
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('color' as const),
        device,
        pick: fc.nat(),
        color: fc.nat(5),
      }),
    },
    {
      weight: 6,
      arbitrary: fc.record({
        kind: fc.constant('type' as const),
        device,
        pick: fc.nat(),
        at: fc.nat(),
        text: word,
      }),
    },
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant('erase' as const),
        device,
        pick: fc.nat(),
        at: fc.nat(),
        count: fc.integer({ min: 1, max: 3 }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({ kind: fc.constant('delete' as const), device, pick: fc.nat() }),
    },
    { weight: 5, arbitrary: fc.record({ kind: fc.constant('undo' as const), device }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('redo' as const), device }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('offline' as const), device }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('online' as const), device }) },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant('wait' as const),
        ms: fc.integer({ min: 0, max: 2500 }),
      }),
    },
  );

  function perform(devices: readonly Device[], step: Action): void {
    if (step.kind === 'wait') {
      must(devices[0]).timers.advance(step.ms);
      return;
    }
    const target = must(devices[step.device]);
    const { store } = target;
    const ids = store.getIds();
    const pick = (value: number) => (ids.length === 0 ? undefined : ids[value % ids.length]);
    switch (step.kind) {
      case 'create':
        store.createNote(step.x, step.y);
        break;
      case 'undo':
        store.undo();
        break;
      case 'redo':
        store.redo();
        break;
      case 'offline':
        target.goOffline();
        break;
      case 'online':
        target.goOnline();
        break;
      case 'move': {
        const id = pick(step.pick);
        if (id !== undefined) store.moveNote(id, step.x, step.y);
        break;
      }
      case 'color': {
        const id = pick(step.pick);
        if (id !== undefined) store.setColor(id, must(NOTE_COLORS[step.color]));
        break;
      }
      case 'type': {
        const id = pick(step.pick);
        if (id === undefined) break;
        const length = [...(store.getNote(id)?.text ?? '')].length;
        store.editText(id, { start: step.at % (length + 1), deleteCount: 0, insert: step.text });
        break;
      }
      case 'erase': {
        const id = pick(step.pick);
        if (id === undefined) break;
        const length = [...(store.getNote(id)?.text ?? '')].length;
        if (length === 0) break;
        const start = step.at % length;
        const deleteCount = Math.min(step.count, length - start);
        store.editText(id, { start, deleteCount, insert: '' });
        break;
      }
      case 'delete': {
        const id = pick(step.pick);
        if (id !== undefined) store.deleteNote(id);
        break;
      }
    }
  }

  it('always converge once everyone is back online, and every device’s disk holds what the server holds', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(action, { maxLength: 40 }), async (actions: Action[]) => {
        const { net, devices } = await board(3);
        for (const step of actions) perform(devices, step);
        for (const each of devices) each.goOnline();

        sharedNotes(devices);
        for (const each of devices) {
          expect(each.indicator).toMatchObject({ kind: 'online', pending: 0 });
          await each.page.persistence.flush();
          expect(each.page.persistence.getError()).toBeNull();
          const stored = await each.disk.open(net.boardId).load();
          expect(restoreStore(stored.ops).dropped).toBe(0);
        }
      }),
      { numRuns: 80 },
    );
  });
});
