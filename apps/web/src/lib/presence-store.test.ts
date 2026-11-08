import { replicaId, type ReplicaId } from '@driftboard/crdt';
import type { PresenceState } from '@driftboard/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PresenceStore, type Peer } from './presence-store';
import { PEER_TIMEOUT_MS } from './presence-timing';
import type { Timers } from './sync-connection';
import { FakeTimers } from './test-network';

const me = replicaId('me');
const ada = replicaId('ada');
const bob = replicaId('bob');
const cy = replicaId('cy');

const state = (change: Partial<PresenceState> = {}): PresenceState => ({
  cursor: null,
  editing: null,
  name: 'Someone',
  color: '#1971c2',
  ...change,
});

function setup() {
  const timers = new FakeTimers();
  const store = new PresenceStore({ self: me, now: () => timers.now, timers });
  const say = (who: ReplicaId, change: Partial<PresenceState> | null = {}) => {
    const next = change === null ? null : state(change);
    store.receive({ type: 'presence', replicaId: who, state: next });
  };
  let calls = 0;
  store.subscribe(() => {
    calls += 1;
  });
  return { timers, store, say, calls: () => calls };
}

const ids = (peers: readonly Peer[]) => peers.map((peer) => peer.id);

describe('PresenceStore: who is here', () => {
  it('starts with nobody, and no timer', () => {
    const { store, timers } = setup();
    expect(store.getPeers()).toEqual([]);
    expect(timers.delays).toEqual([]);
  });

  it('shows someone who sends presence, with what they sent', () => {
    const { store, say } = setup();
    say(ada, { name: 'Ada', color: '#e03131', cursor: { x: 10, y: 20 }, editing: '1@ada' });
    expect(store.getPeers()).toEqual([
      { id: ada, name: 'Ada', color: '#e03131', cursor: { x: 10, y: 20 }, editing: '1@ada' },
    ]);
  });

  it('ignores presence about itself', () => {
    const { store, say, calls } = setup();
    say(me, { name: 'Me' });
    expect(store.getPeers()).toEqual([]);
    expect(calls()).toBe(0);
  });

  it('lists people by name, then by id', () => {
    const { store, say } = setup();
    say(cy, { name: 'Zed' });
    say(bob, { name: 'Ann' });
    say(ada, { name: 'Ann' });
    expect(ids(store.getPeers())).toEqual([ada, bob, cy]);
  });

  it('updates someone who moves or changes, and tells its listeners', () => {
    const { store, say, calls } = setup();
    say(ada, { cursor: { x: 1, y: 1 } });
    expect(calls()).toBe(1);
    say(ada, { cursor: { x: 2, y: 2 } });
    expect(calls()).toBe(2);
    expect(store.getPeers()[0]?.cursor).toEqual({ x: 2, y: 2 });
    say(ada, { cursor: { x: 2, y: 2 }, name: 'Ada' });
    expect(store.getPeers()[0]?.name).toBe('Ada');
    expect(calls()).toBe(3);
  });

  it('keeps its own copy of what it was told', () => {
    const { store, say } = setup();
    const cursor = { x: 1, y: 1 };
    say(ada, { cursor });
    cursor.x = 99;
    expect(store.getPeers()[0]?.cursor).toEqual({ x: 1, y: 1 });
  });

  it('hands out the same array until something changes', () => {
    const { store, say } = setup();
    const empty = store.getPeers();
    expect(store.getPeers()).toBe(empty);
    say(ada, {});
    const one = store.getPeers();
    expect(one).not.toBe(empty);
    expect(store.getPeers()).toBe(one);
    say(ada, {});
    expect(store.getPeers()).toBe(one);
  });

  it('forgets someone who says they have left, and notices nothing when it was not told of them', () => {
    const { store, say, calls } = setup();
    say(ada, {});
    say(ada, null);
    expect(store.getPeers()).toEqual([]);
    expect(calls()).toBe(2);
    say(bob, null);
    expect(calls()).toBe(2);
  });

  it('stops telling a listener that unsubscribed', () => {
    const { store, say } = setup();
    let calls = 0;
    const stop = store.subscribe(() => {
      calls += 1;
    });
    stop();
    say(ada, {});
    expect(calls).toBe(0);
  });
});

describe('PresenceStore: timeouts', () => {
  it('is six seconds, which is three heartbeats', () => {
    expect(PEER_TIMEOUT_MS).toBe(6000);
  });

  it('drops someone after six seconds of silence, and not before', () => {
    const { store, say, timers, calls } = setup();
    say(ada, {});
    timers.advance(5999);
    expect(ids(store.getPeers())).toEqual([ada]);
    const before = calls();
    timers.advance(1);
    expect(store.getPeers()).toEqual([]);
    expect(calls()).toBe(before + 1);
  });

  it('keeps someone who keeps being heard from, however long that goes on', () => {
    const { store, say, timers } = setup();
    for (let beat = 0; beat < 30; beat += 1) {
      say(ada, { cursor: { x: 5, y: 5 } });
      timers.advance(2000);
      expect(ids(store.getPeers())).toEqual([ada]);
    }
    timers.advance(6000);
    expect(store.getPeers()).toEqual([]);
  });

  it('counts a heartbeat that changes nothing as being heard from', () => {
    const { store, say, timers } = setup();
    say(ada, {});
    timers.advance(5000);
    say(ada, {});
    timers.advance(5999);
    expect(ids(store.getPeers())).toEqual([ada]);
    timers.advance(1);
    expect(store.getPeers()).toEqual([]);
  });

  it('counts a change as being heard from, too', () => {
    const { store, say, timers } = setup();
    say(ada, {});
    timers.advance(5000);
    say(ada, { cursor: { x: 1, y: 1 } });
    timers.advance(5999);
    expect(ids(store.getPeers())).toEqual([ada]);
  });

  it('judges each person on their own', () => {
    const { store, say, timers } = setup();
    say(ada, { name: 'Ada' });
    timers.advance(3000);
    say(bob, { name: 'Bob' });
    timers.advance(2999);
    expect(ids(store.getPeers())).toEqual([ada, bob]);
    timers.advance(1);
    expect(ids(store.getPeers())).toEqual([bob]);
    timers.advance(2999);
    expect(ids(store.getPeers())).toEqual([bob]);
    timers.advance(1);
    expect(store.getPeers()).toEqual([]);
  });

  it('drops everyone who has gone quiet at once, and tells its listeners once', () => {
    const { store, say, timers, calls } = setup();
    say(ada, {});
    say(bob, {});
    say(cy, {});
    const before = calls();
    timers.advance(6000);
    expect(store.getPeers()).toEqual([]);
    expect(calls()).toBe(before + 1);
  });

  it('drops each of several people at their own time, the one who has been quiet longest first', () => {
    const { store, say, timers } = setup();
    say(ada, { name: 'Ada' });
    timers.advance(1000);
    say(bob, { name: 'Bob' });
    timers.advance(3000);
    say(cy, { name: 'Cy' });
    timers.advance(2000);
    expect(ids(store.getPeers())).toEqual([bob, cy]);
    timers.advance(999);
    expect(ids(store.getPeers())).toEqual([bob, cy]);
    timers.advance(1);
    expect(ids(store.getPeers())).toEqual([cy]);
    // Cy was last heard from at 4000, so is dropped at 10000, which is 3000 after Bob.
    timers.advance(2999);
    expect(ids(store.getPeers())).toEqual([cy]);
    timers.advance(1);
    expect(store.getPeers()).toEqual([]);
  });

  it('drops someone who went quiet on time even if the person heard of first keeps talking', () => {
    const { store, say, timers } = setup();
    say(ada, { name: 'Ada' });
    timers.advance(1000);
    say(bob, { name: 'Bob' });
    for (let beat = 0; beat < 3; beat += 1) {
      timers.advance(2000);
      say(ada, { name: 'Ada' });
    }
    // Time is 7000: Bob, last heard of at 1000, is gone, and Ada, heard of at 6000, is not.
    expect(ids(store.getPeers())).toEqual([ada]);
  });

  it('brings someone back who says something after being dropped', () => {
    const { store, say, timers } = setup();
    say(ada, {});
    timers.advance(7000);
    say(ada, {});
    expect(ids(store.getPeers())).toEqual([ada]);
    timers.advance(5999);
    expect(ids(store.getPeers())).toEqual([ada]);
  });

  it('honours the timeout it is given', () => {
    const timers = new FakeTimers();
    const store = new PresenceStore({ self: me, now: () => timers.now, timers, timeoutMs: 1000 });
    store.receive({ type: 'presence', replicaId: ada, state: state() });
    timers.advance(999);
    expect(store.getPeers()).toHaveLength(1);
    timers.advance(1);
    expect(store.getPeers()).toHaveLength(0);
  });

  it('has one timer pending while anyone is here, however many messages come, and none otherwise', () => {
    const { store, say, timers } = setup();
    expect(timers.delays).toEqual([]);
    say(ada, {});
    for (let message = 0; message < 100; message += 1) {
      say(ada, { cursor: { x: message, y: 0 } });
      say(bob, { name: 'Bob' });
    }
    expect(timers.delays).toHaveLength(1);
    say(ada, null);
    say(bob, null);
    expect(timers.delays).toEqual([]);
    say(ada, {});
    expect(timers.delays).toHaveLength(1);
    timers.advance(6000);
    expect(timers.delays).toEqual([]);
    store.dispose();
  });

  it('wakes up only when someone could have expired, not on every heartbeat', () => {
    const { say, timers } = setup();
    let wakeups = 0;
    const counting: Timers = {
      setTimeout: (callback, ms) => {
        wakeups += 1;
        return timers.setTimeout(callback, ms);
      },
      clearTimeout: (handle) => {
        timers.clearTimeout(handle);
      },
    };
    const store = new PresenceStore({ self: me, now: () => timers.now, timers: counting });
    const hear = () => {
      store.receive({ type: 'presence', replicaId: ada, state: state() });
    };
    for (let second = 0; second < 60; second += 2) {
      hear();
      timers.advance(2000);
    }
    // A minute of heartbeats every two seconds (30 of them): the timer wakes about every four
    // seconds, when the oldest message could have expired, and not for each heartbeat.
    expect(wakeups).toBeLessThanOrEqual(16);
    say(bob, {});
  });

  it('waits again when a timer fires before anyone has expired', () => {
    let fire: () => void = () => undefined;
    let clock = 0;
    const waits: number[] = [];
    const timers: Timers = {
      setTimeout: (callback, ms) => {
        fire = callback;
        waits.push(ms);
        return 1;
      },
      clearTimeout: () => undefined,
    };
    const store = new PresenceStore({ self: me, now: () => clock, timers });
    store.receive({ type: 'presence', replicaId: ada, state: state() });
    clock = 5990;
    fire();
    expect(store.getPeers()).toHaveLength(1);
    expect(waits).toEqual([6000, 10]);
    clock = 6000;
    fire();
    expect(store.getPeers()).toEqual([]);
  });
});

describe('PresenceStore: losing the connection', () => {
  it('forgets everyone at once, cancels its timer and tells its listeners once', () => {
    const { store, say, timers, calls } = setup();
    say(ada, {});
    say(bob, {});
    const before = calls();
    store.clear();
    expect(store.getPeers()).toEqual([]);
    expect(timers.delays).toEqual([]);
    expect(calls()).toBe(before + 1);
  });

  it('says nothing when there was nobody', () => {
    const { store, calls } = setup();
    store.clear();
    expect(calls()).toBe(0);
  });

  it('can be filled again afterwards', () => {
    const { store, say, timers } = setup();
    say(ada, {});
    store.clear();
    say(bob, {});
    expect(ids(store.getPeers())).toEqual([bob]);
    expect(timers.delays).toHaveLength(1);
  });

  it('stops its timer when disposed', () => {
    const { store, say, timers } = setup();
    say(ada, {});
    store.dispose();
    expect(timers.delays).toEqual([]);
  });
});

describe('PresenceStore: who is editing which note', () => {
  it('has nobody editing a note nobody is editing, and the same empty list each time', () => {
    const { store } = setup();
    expect(store.getEditors('1@a')).toEqual([]);
    expect(store.getEditors('1@a')).toBe(store.getEditors('2@a'));
  });

  it('lists the people editing a note, with their name and colour, and tells that note', () => {
    const { store, say } = setup();
    let calls = 0;
    store.subscribeEditors('1@a', () => {
      calls += 1;
    });
    say(ada, { name: 'Ada', color: '#e03131', editing: '1@a' });
    expect(store.getEditors('1@a')).toEqual([{ id: ada, name: 'Ada', color: '#e03131' }]);
    expect(calls).toBe(1);
  });

  it('does not tell a note about a cursor that moves, or about people editing other notes', () => {
    const { store, say } = setup();
    let notified = 0;
    store.subscribeEditors('1@a', () => {
      notified += 1;
    });
    say(ada, { editing: '1@a', cursor: { x: 0, y: 0 } });
    const editors = store.getEditors('1@a');
    for (let step = 1; step < 20; step += 1) {
      say(ada, { editing: '1@a', cursor: { x: step, y: step } });
    }
    say(bob, { editing: '2@a' });
    say(cy, { cursor: { x: 1, y: 1 } });
    expect(notified).toBe(1);
    expect(store.getEditors('1@a')).toBe(editors);
  });

  it('tells a note when an editor changes name or colour', () => {
    const { store, say } = setup();
    say(ada, { name: 'Ada', editing: '1@a' });
    let calls = 0;
    store.subscribeEditors('1@a', () => {
      calls += 1;
    });
    say(ada, { name: 'Grace', editing: '1@a' });
    say(ada, { name: 'Grace', color: '#e03131', editing: '1@a' });
    expect(calls).toBe(2);
    expect(store.getEditors('1@a')[0]).toMatchObject({ name: 'Grace', color: '#e03131' });
  });

  it('tells both notes when someone moves from one to the other', () => {
    const { store, say } = setup();
    say(ada, { editing: '1@a' });
    const calls: string[] = [];
    store.subscribeEditors('1@a', () => calls.push('1@a'));
    store.subscribeEditors('2@a', () => calls.push('2@a'));
    say(ada, { editing: '2@a' });
    expect(calls.sort()).toEqual(['1@a', '2@a']);
    expect(store.getEditors('1@a')).toEqual([]);
    expect(ids(store.getEditors('2@a') as never)).toEqual([ada]);
  });

  it('tells the note when someone stops editing it', () => {
    const { store, say } = setup();
    say(ada, { editing: '1@a' });
    let calls = 0;
    store.subscribeEditors('1@a', () => {
      calls += 1;
    });
    say(ada, { editing: null });
    expect(calls).toBe(1);
    expect(store.getEditors('1@a')).toEqual([]);
  });

  it('lists several editors of one note by name', () => {
    const { store, say } = setup();
    say(cy, { name: 'Cy', editing: '1@a' });
    say(ada, { name: 'Ada', editing: '1@a' });
    expect(store.getEditors('1@a').map((editor) => editor.name)).toEqual(['Ada', 'Cy']);
  });

  it('takes an editor away when they leave, time out or the connection is lost', () => {
    const { store, say, timers } = setup();
    say(ada, { editing: '1@a' });
    say(bob, { editing: '2@a' });
    say(cy, { editing: '3@a' });
    say(ada, null);
    expect(store.getEditors('1@a')).toEqual([]);
    timers.advance(6000);
    expect(store.getEditors('2@a')).toEqual([]);
    say(cy, { editing: '3@a' });
    store.clear();
    expect(store.getEditors('3@a')).toEqual([]);
  });

  it('tells a note when its editor times out, and the listener can then be removed', () => {
    const { store, say, timers } = setup();
    say(ada, { editing: '1@a' });
    let calls = 0;
    const stop = store.subscribeEditors('1@a', () => {
      calls += 1;
    });
    timers.advance(6000);
    expect(calls).toBe(1);
    stop();
    say(ada, { editing: '1@a' });
    expect(calls).toBe(1);
  });
});

describe('PresenceStore: against a model', () => {
  type Step =
    | { kind: 'say'; who: number; cursor: number; editing: number }
    | { kind: 'leave'; who: number }
    | { kind: 'wait'; ms: number }
    | { kind: 'clear' };

  const people = [ada, bob, cy, replicaId('di')];
  const step = fc.oneof(
    fc.record({
      kind: fc.constant('say' as const),
      who: fc.nat(3),
      cursor: fc.nat(3),
      editing: fc.nat(2),
    }),
    fc.record({ kind: fc.constant('leave' as const), who: fc.nat(3) }),
    fc.record({ kind: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 4000 }) }),
    fc.record({ kind: fc.constant('clear' as const) }),
  );

  it('shows exactly the people heard from in the last six seconds, with what they last said', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps: Step[]) => {
        const timers = new FakeTimers();
        const store = new PresenceStore({ self: me, now: () => timers.now, timers });
        const model = new Map<ReplicaId, { seen: number; state: PresenceState }>();
        for (const current of steps) {
          if (current.kind === 'say') {
            const who = people[current.who] as ReplicaId;
            const next = state({
              name: `P${current.who}`,
              cursor: current.cursor === 0 ? null : { x: current.cursor, y: 0 },
              editing: current.editing === 0 ? null : `n${current.editing}`,
            });
            store.receive({ type: 'presence', replicaId: who, state: next });
            model.set(who, { seen: timers.now, state: next });
          } else if (current.kind === 'leave') {
            const who = people[current.who] as ReplicaId;
            store.receive({ type: 'presence', replicaId: who, state: null });
            model.delete(who);
          } else if (current.kind === 'clear') {
            store.clear();
            model.clear();
          } else {
            timers.advance(current.ms);
          }
          for (const [who, { seen }] of model) {
            if (timers.now - seen >= PEER_TIMEOUT_MS) model.delete(who);
          }
          const expected = [...model.entries()]
            .map(
              ([
                id,
                {
                  state: { name, color, cursor, editing },
                },
              ]) => ({
                id,
                name,
                color,
                cursor,
                editing,
              }),
            )
            .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
          if (JSON.stringify(store.getPeers()) !== JSON.stringify(expected)) return false;
          // The notes agree with the people.
          for (const note of ['n1', 'n2']) {
            const editing = expected.filter((peer) => peer.editing === note).map((peer) => peer.id);
            const shown = store.getEditors(note).map((editor) => editor.id);
            if (JSON.stringify(shown) !== JSON.stringify(editing)) return false;
          }
          if (timers.delays.length > 0 !== model.size > 0) return false;
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });
});
