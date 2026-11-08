import { NOTE_COLORS } from '@driftboard/crdt';
import { storeVector } from '@driftboard/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { restoreStore } from './persistence';
import { Device, sharedNotes } from './test-device';
import { FakeNetwork } from './test-network';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/** A board with three people on it, all online and with the page open. */
async function board(count = 2) {
  const net = new FakeNetwork();
  const devices = Array.from({ length: count }, (_, index) => new Device(net, index + 1));
  for (const device of devices) await device.openPage();
  return { net, devices };
}

describe('reloading while offline', () => {
  it('keeps the changes made offline, still shows them offline, and sends them when the network returns', async () => {
    const { devices } = await board();
    const [alice, bob] = [must(devices[0]), must(devices[1])];
    expect(alice.indicator).toMatchObject({ kind: 'online', pending: 0 });

    alice.goOffline();
    expect(alice.indicator.kind).toBe('offline');
    const id = must(alice.store.createNote(10, 20));
    alice.store.editText(id, { start: 0, deleteCount: 0, insert: 'hello' });
    alice.store.setColor(id, 'pink');
    const { pending } = alice.indicator;
    expect(pending).toBeGreaterThan(0);
    expect(alice.indicator.detail).toBe(`${pending} pending changes`);
    expect(bob.notes).toEqual([]);

    // The page is closed and opened again, and the network is still down.
    await alice.reload();
    expect(alice.notes).toMatchObject([{ id, x: 10, y: 20, color: 'pink', text: 'hello' }]);
    expect(alice.indicator).toMatchObject({ kind: 'offline', pending });
    expect(bob.notes).toEqual([]);

    alice.goOnline();
    expect(alice.indicator).toMatchObject({ kind: 'online', pending: 0 });
    expect(bob.notes).toMatchObject([{ id, x: 10, y: 20, color: 'pink', text: 'hello' }]);
    expect(sharedNotes([alice, bob])).toHaveLength(1);
  });

  it('keeps changes made across several page loads, each of which is a new replica', async () => {
    const { devices } = await board();
    const [alice, bob] = [must(devices[0]), must(devices[1])];
    alice.goOffline();
    const first = must(alice.store.createNote(1, 1));
    await alice.reload();
    const firstReplica = alice.page.replicaId;
    alice.store.editText(first, { start: 0, deleteCount: 0, insert: 'one ' });
    const second = must(alice.store.createNote(2, 2));
    await alice.reload();
    expect(alice.page.replicaId).not.toBe(firstReplica);
    alice.store.editText(second, { start: 0, deleteCount: 0, insert: 'two' });
    await alice.reload();
    expect(alice.notes.map((note) => note.text)).toEqual(['one ', 'two']);

    alice.goOnline();
    expect(sharedNotes([alice, bob]).map((note) => note.text)).toEqual(['one ', 'two']);
    expect(alice.indicator).toMatchObject({ kind: 'online', pending: 0 });
  });

  it('shows nothing pending after a reload once the server has everything', async () => {
    const { devices } = await board();
    const alice = must(devices[0]);
    alice.store.createNote(1, 1);
    alice.goOffline();
    await alice.reload();
    expect(alice.indicator).toMatchObject({ kind: 'offline', pending: 0, detail: null });
    expect(alice.notes).toHaveLength(1);
  });

  it('shows what other people did, which it was given while online, when reopened offline', async () => {
    const { devices } = await board();
    const [alice, bob] = [must(devices[0]), must(devices[1])];
    const id = must(bob.store.createNote(3, 4));
    bob.store.editText(id, { start: 0, deleteCount: 0, insert: 'from bob' });
    alice.goOffline();
    await alice.reload();
    expect(alice.notes).toMatchObject([{ id, x: 3, y: 4, text: 'from bob' }]);
    expect(alice.indicator.pending).toBe(0);
  });

  it('opens a board offline for the first time, and the board reaches the server later', async () => {
    const net = new FakeNetwork();
    const alice = new Device(net, 1);
    alice.online = false;
    await alice.openPage();
    expect(alice.indicator.kind).toBe('offline');
    const id = must(alice.store.createNote(5, 5));
    alice.store.editText(id, { start: 0, deleteCount: 0, insert: 'draft' });
    await alice.reload();
    expect(alice.notes).toHaveLength(1);

    alice.goOnline();
    const bob = new Device(net, 2);
    await bob.openPage();
    expect(bob.notes).toMatchObject([{ id, text: 'draft' }]);
  });

  it('opens with the board on the screen before anything connects', async () => {
    const { devices } = await board();
    const alice = must(devices[0]);
    alice.store.createNote(1, 1);
    await alice.closePage();
    alice.online = false;
    const page = await alice.openPage();
    expect(page.store.getIds()).toHaveLength(1);
  });

  it('survives the disk failing for a moment: nothing is lost and nothing is stored out of order', async () => {
    const { devices } = await board();
    const alice = must(devices[0]);
    alice.goOffline();
    alice.disk.failNextWrites(2);
    const id = must(alice.store.createNote(1, 1));
    expect(alice.page.persistence.getError()).toBeNull();
    await alice.page.persistence.flush();
    expect(alice.page.persistence.getError()?.message).toContain('disk is full');

    alice.store.editText(id, { start: 0, deleteCount: 0, insert: 'abc' });
    await alice.page.persistence.flush();
    expect(alice.page.persistence.getError()).not.toBeNull();
    alice.store.editText(id, { start: 3, deleteCount: 0, insert: 'def' });
    await alice.page.persistence.flush();
    expect(alice.page.persistence.getError()).toBeNull();

    await alice.reload();
    expect(alice.notes).toMatchObject([{ id, text: 'abcdef' }]);
  });

  it('works on a device whose storage cannot be written at all, until the page closes', async () => {
    const { devices } = await board();
    const [alice, bob] = [must(devices[0]), must(devices[1])];
    alice.disk.failNextWrites(1000);
    const id = must(alice.store.createNote(1, 1));
    alice.store.editText(id, { start: 0, deleteCount: 0, insert: 'live' });
    expect(bob.notes).toMatchObject([{ text: 'live' }]);
    await alice.page.persistence.flush();
    expect(alice.page.persistence.getError()).not.toBeNull();
    // What the server has comes back on the next load.
    await alice.closePage();
    alice.disk.failNextWrites(0);
    await alice.openPage();
    expect(alice.notes).toMatchObject([{ id, text: 'live' }]);
  });
});

describe('two clients that both edit offline and then reconnect', () => {
  /** Alice and Bob share a board with two notes, then both lose the network. */
  async function both() {
    const { net, devices } = await board(3);
    const [alice, bob, carol] = [must(devices[0]), must(devices[1]), must(devices[2])];
    const first = must(alice.store.createNote(0, 0));
    alice.store.editText(first, { start: 0, deleteCount: 0, insert: 'hello world' });
    const second = must(alice.store.createNote(50, 50));
    alice.store.editText(second, { start: 0, deleteCount: 0, insert: 'keep me?' });
    expect(sharedNotes([alice, bob, carol])).toHaveLength(2);
    alice.goOffline();
    bob.goOffline();
    return { net, alice, bob, carol, first, second };
  }

  function edit(alice: Device, bob: Device, first: string, second: string) {
    alice.store.editText(first, { start: 0, deleteCount: 0, insert: 'Oh, ' });
    alice.store.moveNote(first, 100, 100);
    alice.store.deleteNote(second);
    alice.store.createNote(7, 7);

    bob.store.editText(first, { start: 11, deleteCount: 0, insert: '!' });
    bob.store.moveNote(first, 300, 300);
    bob.store.editText(second, { start: 0, deleteCount: 0, insert: 'Yes! ' });
    bob.store.createNote(9, 9);
  }

  function expectMerged(devices: readonly Device[], first: string, second: string) {
    const notes = sharedNotes(devices);
    expect(notes).toHaveLength(4);
    const byId = new Map(notes.map((note) => [note.id, note]));
    expect(byId.get(first)?.text).toBe('Oh, hello world!');
    // Editing a note while someone else deletes it keeps it, with the edit.
    expect(byId.get(second)?.text).toBe('Yes! keep me?');
    // The two moves did not tear: the note is where one of them put it.
    const { x, y } = must(byId.get(first));
    expect(['100,100', '300,300']).toContain(`${x},${y}`);
    for (const device of devices) {
      expect(device.indicator).toMatchObject({ kind: 'online', pending: 0 });
    }
  }

  it('merges what both did, and everyone ends with the same board', async () => {
    const { alice, bob, carol, first, second } = await both();
    edit(alice, bob, first, second);
    expect(alice.indicator.kind).toBe('offline');
    expect(bob.indicator.kind).toBe('offline');
    expect(alice.indicator.pending).toBeGreaterThan(0);
    expect(bob.indicator.pending).toBeGreaterThan(0);
    expect(carol.notes).toHaveLength(2);

    alice.goOnline();
    bob.goOnline();
    expectMerged([alice, bob, carol], first, second);
  });

  it('gives the same result whichever of them reconnects first', async () => {
    const one = await both();
    edit(one.alice, one.bob, one.first, one.second);
    one.alice.goOnline();
    one.bob.goOnline();

    const two = await both();
    edit(two.alice, two.bob, two.first, two.second);
    two.bob.goOnline();
    two.alice.goOnline();

    expect(sharedNotes([two.alice, two.bob, two.carol]).map((note) => note.text)).toEqual(
      sharedNotes([one.alice, one.bob, one.carol]).map((note) => note.text),
    );
  });

  it('merges when both reload before the network returns', async () => {
    const { alice, bob, carol, first, second } = await both();
    edit(alice, bob, first, second);
    const pending = [alice.indicator.pending, bob.indicator.pending];

    await alice.reload();
    await bob.reload();
    expect([alice.indicator.pending, bob.indicator.pending]).toEqual(pending);
    expect(alice.notes.find((note) => note.id === first)?.text).toBe('Oh, hello world');
    expect(bob.notes.find((note) => note.id === first)?.text).toBe('hello world!');

    bob.goOnline();
    alice.goOnline();
    expectMerged([alice, bob, carol], first, second);
  });

  it('merges when only one of them reloads, and one reconnects while the other is still offline', async () => {
    const { alice, bob, carol, first, second } = await both();
    edit(alice, bob, first, second);
    await bob.reload();

    alice.goOnline();
    // Alice's side is on the server; Bob has not heard of it yet.
    expect(carol.notes.find((note) => note.id === first)?.text).toBe('Oh, hello world');
    expect(bob.notes.find((note) => note.id === first)?.text).toBe('hello world!');

    bob.goOnline();
    expectMerged([alice, bob, carol], first, second);
  });

  it('merges edits to the very same word typed at the very same place', async () => {
    const { alice, bob, carol, first } = await both();
    alice.store.editText(first, { start: 5, deleteCount: 0, insert: 'AAA' });
    bob.store.editText(first, { start: 5, deleteCount: 0, insert: 'BBB' });
    await alice.reload();
    alice.goOnline();
    bob.goOnline();
    const text = must(sharedNotes([alice, bob, carol]).find((note) => note.id === first)).text;
    // Each person's word stays in one piece, in one order or the other.
    expect(['helloAAABBB world', 'helloBBBAAA world']).toContain(text);
  });

  it('keeps going when a device was away while many changes were made', async () => {
    const { alice, bob, carol, first } = await both();
    for (let index = 0; index < 20; index += 1) {
      carol.store.editText(first, { start: 0, deleteCount: 0, insert: `${index % 10}` });
      carol.store.createNote(index, index);
    }
    alice.store.editText(first, { start: 0, deleteCount: 0, insert: 'alice ' });
    await alice.reload();
    alice.goOnline();
    bob.goOnline();
    const notes = sharedNotes([alice, bob, carol]);
    expect(notes).toHaveLength(2 + 20);
    expect(must(notes.find((note) => note.id === first)).text).toContain('alice ');
  });
});

describe('random sessions on three devices', () => {
  type Action =
    | {
        kind: 'edit';
        device: number;
        what: number;
        pick: number;
        x: number;
        y: number;
        text: string;
      }
    | { kind: 'offline'; device: number }
    | { kind: 'online'; device: number }
    | { kind: 'reload'; device: number };

  const device = fc.nat(2);
  const action = fc.oneof(
    fc.record({
      kind: fc.constant('edit' as const),
      device,
      what: fc.nat(5),
      pick: fc.nat(10),
      x: fc.integer({ min: 0, max: 500 }),
      y: fc.integer({ min: 0, max: 500 }),
      text: fc
        .array(fc.constantFrom('a', 'b', 'c', ' ', '😀'), { minLength: 1, maxLength: 3 })
        .map((parts) => parts.join('')),
    }),
    fc.record({ kind: fc.constant('offline' as const), device }),
    fc.record({ kind: fc.constant('online' as const), device }),
    fc.record({ kind: fc.constant('reload' as const), device }),
  );

  async function perform(devices: readonly Device[], step: Action): Promise<void> {
    const target = must(devices[step.device]);
    switch (step.kind) {
      case 'offline':
        target.goOffline();
        return;
      case 'online':
        target.goOnline();
        return;
      case 'reload':
        await target.reload();
        return;
      case 'edit': {
        const { store } = target;
        const ids = store.getIds();
        const id = ids.length === 0 ? undefined : ids[step.pick % ids.length];
        if (id === undefined || step.what === 0) {
          store.createNote(step.x, step.y);
          return;
        }
        switch (step.what) {
          case 1:
            store.moveNote(id, step.x, step.y);
            return;
          case 2: {
            const length = [...(store.getNote(id)?.text ?? '')].length;
            const start = step.pick % (length + 1);
            store.editText(id, { start, deleteCount: 0, insert: step.text });
            return;
          }
          case 3: {
            const length = [...(store.getNote(id)?.text ?? '')].length;
            const start = step.pick % (length + 1);
            store.editText(id, { start, deleteCount: Math.min(2, length - start), insert: '' });
            return;
          }
          case 4:
            store.setColor(id, must(NOTE_COLORS[step.pick % NOTE_COLORS.length]));
            return;
          default:
            if (step.pick % 3 === 0) store.deleteNote(id);
            else store.bringToFront(id);
        }
      }
    }
  }

  it('always converge once everyone is back online, and each device can rebuild its board from its disk', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 30 }), async (actions) => {
        const { net, devices } = await board(3);
        for (const step of actions) await perform(devices, step);
        for (const each of devices) each.goOnline();

        // Everyone has the same board and nothing is waiting to be sent.
        const notes = sharedNotes(devices);
        for (const each of devices) {
          expect(each.indicator).toMatchObject({ kind: 'online', pending: 0 });
        }

        // Every device stored the whole log, and the server has the same.
        const serverVector = storeVector(net.room.store);
        for (const each of devices) {
          await each.page.persistence.flush();
          expect(each.page.persistence.getError()).toBeNull();
          const stored = await each.disk.open(net.boardId).load();
          const { store, dropped } = restoreStore(stored.ops);
          expect(dropped).toBe(0);
          expect(storeVector(store).equals(serverVector)).toBe(true);
          expect(stored.held).toEqual(serverVector.entries());
        }

        // A reload with no network rebuilds exactly the same board from the disk alone.
        for (const each of devices) {
          each.online = false;
          await each.reload();
          expect(each.notes).toEqual(notes);
          expect(each.indicator.pending).toBe(0);
        }
      }),
      { numRuns: 60 },
    );
  });
});
