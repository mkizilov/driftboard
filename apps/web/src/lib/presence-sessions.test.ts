import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Peer } from './presence-store';
import { Device } from './test-device';
import { FakeNetwork, type FakeSocket } from './test-network';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/** People with these names on one board, all online, with the page open. */
async function board(...names: string[]) {
  const net = new FakeNetwork();
  const devices = names.map((name, index) => {
    const device = new Device(net, index + 1);
    device.identity.rename(name);
    return device;
  });
  for (const device of devices) await device.openPage();
  return { net, timers: net.timers, devices };
}

const peers = (device: Device): readonly Peer[] => device.page.presence.store.getPeers();
const names = (device: Device) => peers(device).map((peer) => peer.name);
const shown = (peer: Peer) => ({
  name: peer.name,
  color: peer.color,
  cursor: peer.cursor,
  editing: peer.editing,
});

/** How many presence messages a socket carried. */
const presenceFrames = (socket: FakeSocket) =>
  socket.sent.filter((frame) => typeof frame === 'string' && frame.includes('"type":"presence"'))
    .length;

describe('seeing each other', () => {
  it('shows the other people, with their names, colours and where their pointers are', async () => {
    const { devices, timers } = await board('Ada', 'Bob');
    const [ada, bob] = [must(devices[0]), must(devices[1])];
    timers.advance(100);
    ada.page.presence.moveCursor({ x: 100, y: 200 });
    bob.page.presence.moveCursor({ x: 5, y: 6 });

    const colour = (device: Device) => device.identity.getIdentity().color;
    expect(peers(bob).map(shown)).toEqual([
      { name: 'Ada', color: colour(ada), cursor: { x: 100, y: 200 }, editing: null },
    ]);
    expect(peers(ada).map(shown)).toEqual([
      { name: 'Bob', color: colour(bob), cursor: { x: 5, y: 6 }, editing: null },
    ]);
  });

  it('does not show a person to themselves', async () => {
    const { devices } = await board('Ada', 'Bob', 'Cy');
    for (const device of devices) {
      expect(names(device)).not.toContain(device.identity.getIdentity().name);
      expect(peers(device)).toHaveLength(2);
    }
  });

  it('tells a person who joins late who is on the board at once, without anyone doing anything', async () => {
    const { net, devices, timers } = await board('Ada', 'Bob');
    timers.advance(100);
    must(devices[0]).page.presence.moveCursor({ x: 7, y: 7 });
    const late = new Device(net, 9);
    late.identity.rename('Cy');
    await late.openPage();
    expect(names(late)).toEqual(['Ada', 'Bob']);
    expect(must(peers(late).find((peer) => peer.name === 'Ada')).cursor).toEqual({ x: 7, y: 7 });
    // And they know of the newcomer.
    expect(names(must(devices[0]))).toEqual(['Bob', 'Cy']);
  });

  it('shows which note someone is editing, on that note only, and when they stop', async () => {
    const { devices, timers } = await board('Ada', 'Bob');
    const [ada, bob] = [must(devices[0]), must(devices[1])];
    timers.advance(100);
    ada.page.presence.startEditing('1@x');
    const store = bob.page.presence.store;
    expect(store.getEditors('1@x').map((editor) => editor.name)).toEqual(['Ada']);
    expect(store.getEditors('2@x')).toEqual([]);

    timers.advance(100);
    ada.page.presence.startEditing('2@x');
    expect(store.getEditors('1@x')).toEqual([]);
    expect(store.getEditors('2@x').map((editor) => editor.name)).toEqual(['Ada']);

    timers.advance(100);
    ada.page.presence.stopEditing('2@x');
    expect(store.getEditors('2@x')).toEqual([]);
  });

  it('shows a new name as soon as someone changes it', async () => {
    const { devices, timers } = await board('Ada', 'Bob');
    const [ada, bob] = [must(devices[0]), must(devices[1])];
    timers.advance(100);
    ada.identity.rename('Grace');
    expect(names(bob)).toEqual(['Grace']);
  });

  it('keeps a person’s name and colour across a reload, as one person who is not shown twice', async () => {
    const { devices } = await board('Ada', 'Bob');
    const [ada, bob] = [must(devices[0]), must(devices[1])];
    const before = must(peers(bob)[0]);
    await ada.reload();
    expect(peers(bob)).toHaveLength(1);
    const after = must(peers(bob)[0]);
    expect(after.id).not.toBe(before.id);
    expect([after.name, after.color]).toEqual([before.name, before.color]);
  });
});

describe('leaving', () => {
  it('removes a person at once when they close the page', async () => {
    const { devices } = await board('Ada', 'Bob');
    await must(devices[0]).closePage();
    expect(peers(must(devices[1]))).toEqual([]);
  });

  it('removes a person at once when their connection drops', async () => {
    const { devices } = await board('Ada', 'Bob');
    must(devices[0]).goOffline();
    expect(peers(must(devices[1]))).toEqual([]);
  });

  it('forgets everyone when the connection is lost, and learns who is here again when it is back', async () => {
    const { devices, timers } = await board('Ada', 'Bob', 'Cy');
    const [ada, bob, cy] = [must(devices[0]), must(devices[1]), must(devices[2])];
    ada.goOffline();
    expect(peers(ada)).toEqual([]);
    expect(names(bob)).toEqual(['Cy']);

    bob.page.presence.moveCursor({ x: 1, y: 1 });
    timers.advance(100);
    cy.page.presence.moveCursor({ x: 2, y: 2 });
    ada.goOnline();
    expect(names(ada)).toEqual(['Bob', 'Cy']);
    expect(must(peers(ada).find((peer) => peer.name === 'Bob')).cursor).toEqual({ x: 1, y: 1 });
    expect(names(bob)).toEqual(['Ada', 'Cy']);
    expect(names(cy)).toEqual(['Ada', 'Bob']);
  });

  it('removes someone who is editing a note from that note, too', async () => {
    const { devices, timers } = await board('Ada', 'Bob');
    const [ada, bob] = [must(devices[0]), must(devices[1])];
    timers.advance(100);
    ada.page.presence.startEditing('1@x');
    ada.goOffline();
    expect(bob.page.presence.store.getEditors('1@x')).toEqual([]);
  });
});

describe('silence', () => {
  it('keeps a person who is perfectly still, for as long as they are there, by heartbeats', async () => {
    const { devices, timers } = await board('Ada', 'Bob');
    const [ada, bob] = [must(devices[0]), must(devices[1])];
    for (let second = 0; second < 60; second += 1) {
      timers.advance(1000);
      expect(names(bob)).toEqual(['Ada']);
      expect(names(ada)).toEqual(['Bob']);
    }
  });

  it('sends a heartbeat every two seconds and nothing else when nobody moves', async () => {
    const { net, devices, timers } = await board('Ada', 'Bob');
    const adaSocket = must(net.sockets[0]);
    const before = presenceFrames(adaSocket);
    timers.advance(60_000);
    const sent = presenceFrames(adaSocket) - before;
    expect(sent).toBe(30);
    expect(devices).toHaveLength(2);
  });

  it('drops a person whose page has frozen, with the connection still open, after six seconds', async () => {
    const { devices, timers } = await board('Ada', 'Bob');
    const [ada, bob] = [must(devices[0]), must(devices[1])];
    // Nothing more is sent from here, and the connection is not closed: the dead-tab case.
    ada.page.presence.dispose();
    timers.advance(5999);
    expect(names(bob)).toEqual(['Ada']);
    timers.advance(1);
    expect(peers(bob)).toEqual([]);
  });

  it('drops a frozen person from the note they were editing, too', async () => {
    const { devices, timers } = await board('Ada', 'Bob');
    const [ada, bob] = [must(devices[0]), must(devices[1])];
    timers.advance(100);
    ada.page.presence.startEditing('1@x');
    ada.page.presence.dispose();
    timers.advance(6000);
    expect(bob.page.presence.store.getEditors('1@x')).toEqual([]);
  });

  it('does not drop anyone else when one person freezes', async () => {
    const { devices, timers } = await board('Ada', 'Bob', 'Cy');
    const [ada, bob, cy] = [must(devices[0]), must(devices[1]), must(devices[2])];
    ada.page.presence.dispose();
    timers.advance(30_000);
    expect(names(bob)).toEqual(['Cy']);
    expect(names(cy)).toEqual(['Bob']);
  });
});

describe('throttling on the wire', () => {
  it('sends at most twenty presence messages a second however fast the pointer moves', async () => {
    const { net, devices, timers } = await board('Ada', 'Bob');
    const ada = must(devices[0]);
    const socket = must(net.sockets[0]);
    const times: number[] = [];
    let counted = presenceFrames(socket);
    for (let step = 1; step <= 3000; step += 1) {
      timers.advance(1);
      ada.page.presence.moveCursor({ x: step, y: step });
      const now = presenceFrames(socket);
      for (; counted < now; counted += 1) times.push(timers.now);
    }
    for (const first of times) {
      const inSecond = times.filter((at) => at >= first && at < first + 1000);
      expect(inSecond.length).toBeLessThanOrEqual(20);
    }
    expect(times.length).toBeGreaterThanOrEqual(58);
    // The other person still ends up with the final position.
    timers.advance(100);
    expect(must(peers(must(devices[1]))[0]).cursor).toEqual({ x: 3000, y: 3000 });
  });

  it('does not send anything for a pointer that has not moved', async () => {
    const { net, devices, timers } = await board('Ada', 'Bob');
    const ada = must(devices[0]);
    timers.advance(100);
    ada.page.presence.moveCursor({ x: 5, y: 5 });
    const socket = must(net.sockets[0]);
    const before = presenceFrames(socket);
    for (let step = 0; step < 100; step += 1) {
      timers.advance(10);
      ada.page.presence.moveCursor({ x: 5.2, y: 4.9 });
    }
    // Only the heartbeat, which is due about every two seconds.
    expect(presenceFrames(socket) - before).toBeLessThanOrEqual(1);
  });
});

describe('never persisted', () => {
  it('is not written to the device, not counted as a change and not kept by the room’s operations', async () => {
    const { net, devices, timers } = await board('Ada', 'Bob');
    const [ada, bob] = [must(devices[0]), must(devices[1])];
    const stored = ada.disk.size(net.boardId);
    const operations = net.room.store;
    for (let step = 0; step < 50; step += 1) {
      timers.advance(60);
      ada.page.presence.moveCursor({ x: step, y: step });
      bob.page.presence.startEditing(`${step}@x`);
    }
    ada.identity.rename('Grace');
    await ada.page.persistence.flush();
    expect(ada.disk.size(net.boardId)).toBe(stored);
    expect(bob.disk.size(net.boardId)).toBe(stored);
    expect(net.room.store).toBe(operations);
    expect(ada.indicator.pending).toBe(0);
  });

  it('is held by the room only while the person is there', async () => {
    const { net, devices } = await board('Ada', 'Bob');
    expect(net.room.presence.size).toBe(2);
    await must(devices[0]).closePage();
    expect(net.room.presence.size).toBe(1);
    await must(devices[1]).closePage();
    expect(net.room.presence.size).toBe(0);
  });

  it('is not there after a reload of the page that was never saved', async () => {
    const { devices } = await board('Ada', 'Bob');
    const ada = must(devices[0]);
    ada.page.presence.startEditing('1@x');
    ada.goOffline();
    await ada.reload();
    expect(ada.page.presence.getState().editing).toBeNull();
    expect(ada.page.presence.getState().cursor).toBeNull();
  });
});

describe('random sessions on three devices', () => {
  type Action =
    | { kind: 'move'; device: number; x: number; y: number }
    | { kind: 'leaveBoard'; device: number }
    | { kind: 'edit'; device: number; note: number }
    | { kind: 'rename'; device: number; name: number }
    | { kind: 'offline'; device: number }
    | { kind: 'online'; device: number }
    | { kind: 'reload'; device: number }
    | { kind: 'wait'; ms: number };

  const device = fc.nat(2);
  const action = fc.oneof(
    fc.record({
      kind: fc.constant('move' as const),
      device,
      x: fc.integer({ min: 0, max: 400 }),
      y: fc.integer({ min: 0, max: 400 }),
    }),
    fc.record({ kind: fc.constant('leaveBoard' as const), device }),
    fc.record({ kind: fc.constant('edit' as const), device, note: fc.nat(3) }),
    fc.record({ kind: fc.constant('rename' as const), device, name: fc.nat(4) }),
    fc.record({ kind: fc.constant('offline' as const), device }),
    fc.record({ kind: fc.constant('online' as const), device }),
    fc.record({ kind: fc.constant('reload' as const), device }),
    fc.record({ kind: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 5000 }) }),
  );

  it('always end with everyone seeing exactly the others who are online, as they last said', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(action, { maxLength: 40 }), async (actions: Action[]) => {
        const { devices, timers } = await board('Ann', 'Ben', 'Cat');
        for (const step of actions) {
          if (step.kind === 'wait') {
            timers.advance(step.ms);
            continue;
          }
          const target = must(devices[step.device]);
          switch (step.kind) {
            case 'move':
              target.page.presence.moveCursor({ x: step.x, y: step.y });
              break;
            case 'leaveBoard':
              target.page.presence.moveCursor(null);
              break;
            case 'edit':
              if (step.note === 0) {
                const current = target.page.presence.getState().editing;
                if (current !== null) target.page.presence.stopEditing(current);
              } else {
                target.page.presence.startEditing(`${step.note}@x`);
              }
              break;
            case 'rename':
              target.identity.rename(`Name ${step.name}`);
              break;
            case 'offline':
              target.goOffline();
              break;
            case 'online':
              target.goOnline();
              break;
            case 'reload':
              await target.reload();
              break;
          }
        }
        // Let every throttled message go out.
        timers.advance(100);

        const online = devices.filter((each) => each.online);
        for (const viewer of online) {
          const expected = online
            .filter((each) => each !== viewer)
            .map((each) => ({
              id: each.page.replicaId,
              ...each.page.presence.getState(),
            }))
            .sort((a, b) => (a.id < b.id ? -1 : 1));
          const actual = peers(viewer)
            .map((peer) => ({
              id: peer.id,
              cursor: peer.cursor,
              editing: peer.editing,
              name: peer.name,
              color: peer.color,
            }))
            .sort((a, b) => (a.id < b.id ? -1 : 1));
          expect(actual).toEqual(expected);
        }
        // Someone who is offline sees nobody.
        for (const each of devices.filter((other) => !other.online)) {
          expect(peers(each)).toEqual([]);
        }
        // And nothing is waiting that was not due: only timers that keep things alive.
        for (const each of devices) await each.closePage();
        expect(timers.delays).toEqual([]);
      }),
      { numRuns: 80 },
    );
  });
});
