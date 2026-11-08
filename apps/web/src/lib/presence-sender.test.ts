import type { PresenceState } from '@driftboard/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PresenceSender } from './presence-sender';
import { HEARTBEAT_MS, MAX_UPDATES_PER_SECOND, MIN_INTERVAL_MS } from './presence-timing';
import { FakeTimers } from './test-network';
import type { Timers } from './sync-connection';

const IDENTITY = { name: 'Ada', color: '#1971c2' };

interface Sent {
  readonly at: number;
  readonly state: PresenceState;
}

/** A sender on a virtual clock that records what it sends and when. */
function setup() {
  const timers = new FakeTimers();
  const sent: Sent[] = [];
  let connected = true;
  const sender = new PresenceSender({
    send: (state) => {
      if (!connected) return false;
      sent.push({ at: timers.now, state });
      return true;
    },
    now: () => timers.now,
    timers,
    identity: IDENTITY,
  });
  return {
    timers,
    sent,
    sender,
    /** What `send` reports from now on: whether there is a connection. */
    carry: (value: boolean) => {
      connected = value;
    },
    cursors: () => sent.map((item) => item.state.cursor),
  };
}

describe('the limits', () => {
  it('are 20 updates a second, repeated every 2 seconds, in 50 ms steps', () => {
    expect(MAX_UPDATES_PER_SECOND).toBe(20);
    expect(MIN_INTERVAL_MS).toBe(50);
    expect(HEARTBEAT_MS).toBe(2000);
  });
});

describe('PresenceSender: connecting', () => {
  it('sends nothing before the connection is online, however much changes', () => {
    const { sender, sent, timers } = setup();
    sender.moveCursor({ x: 1, y: 1 });
    sender.setEditing('1@a');
    timers.advance(10_000);
    expect(sent).toEqual([]);
    expect(timers.delays).toEqual([]);
  });

  it('sends the state at once when the connection comes up', () => {
    const { sender, sent } = setup();
    sender.setConnected(true);
    expect(sent).toEqual([
      { at: 0, state: { cursor: null, editing: null, name: 'Ada', color: '#1971c2' } },
    ]);
  });

  it('sends what changed while offline, once, when it comes up', () => {
    const { sender, sent } = setup();
    sender.moveCursor({ x: 5, y: 6 });
    sender.setEditing('1@a');
    sender.setConnected(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.state).toEqual({
      cursor: { x: 5, y: 6 },
      editing: '1@a',
      name: 'Ada',
      color: '#1971c2',
    });
  });

  it('sends at once on every new connection, even right after the last message', () => {
    const { sender, sent, timers } = setup();
    sender.setConnected(true);
    timers.advance(10);
    sender.setConnected(false);
    sender.setConnected(true);
    expect(sent.map((item) => item.at)).toEqual([0, 10]);
  });

  it('stops for good when the connection is lost: no messages, no timers, nothing queued', () => {
    const { sender, sent, timers } = setup();
    sender.setConnected(true);
    sender.setConnected(false);
    expect(timers.delays).toEqual([]);
    sender.moveCursor({ x: 1, y: 1 });
    timers.advance(60_000);
    expect(sent).toHaveLength(1);
  });

  it('does not repeat itself when told twice that the connection is up or down', () => {
    const { sender, sent } = setup();
    sender.setConnected(true);
    sender.setConnected(true);
    sender.setConnected(false);
    sender.setConnected(false);
    expect(sent).toHaveLength(1);
  });

  it('treats a send that finds no connection as the connection being gone, until told otherwise', () => {
    const { sender, sent, timers, carry } = setup();
    carry(false);
    sender.setConnected(true);
    sender.moveCursor({ x: 1, y: 1 });
    expect(timers.delays).toEqual([]);
    carry(true);
    sender.setConnected(false);
    sender.setConnected(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.state.cursor).toEqual({ x: 1, y: 1 });
  });
});

describe('PresenceSender: throttling', () => {
  it('sends a change at once when nothing was sent for a while', () => {
    const { sender, sent, timers } = setup();
    sender.setConnected(true);
    timers.advance(100);
    sender.moveCursor({ x: 3, y: 4 });
    expect(sent.map((item) => item.at)).toEqual([0, 100]);
    expect(sent[1]?.state.cursor).toEqual({ x: 3, y: 4 });
  });

  it('merges changes that come within the interval and sends the latest when it is over', () => {
    const { sender, sent, timers, cursors } = setup();
    sender.setConnected(true);
    timers.advance(10);
    sender.moveCursor({ x: 1, y: 1 });
    timers.advance(10);
    sender.moveCursor({ x: 2, y: 2 });
    timers.advance(10);
    sender.moveCursor({ x: 3, y: 3 });
    expect(sent).toHaveLength(1);

    timers.advance(19);
    expect(sent).toHaveLength(1);
    timers.advance(1);
    expect(sent.map((item) => item.at)).toEqual([0, 50]);
    expect(cursors()).toEqual([null, { x: 3, y: 3 }]);
  });

  it('merges different kinds of change into one message', () => {
    const { sender, sent, timers } = setup();
    sender.setConnected(true);
    timers.advance(1);
    sender.moveCursor({ x: 9, y: 9 });
    sender.setEditing('2@b');
    sender.setIdentity({ name: 'Grace', color: '#c2255c' });
    timers.advance(49);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.state).toEqual({
      cursor: { x: 9, y: 9 },
      editing: '2@b',
      name: 'Grace',
      color: '#c2255c',
    });
  });

  it('keeps 50 ms between messages however fast changes come', () => {
    const { sender, sent, timers } = setup();
    sender.setConnected(true);
    for (let step = 1; step <= 2000; step += 1) {
      timers.advance(1);
      sender.moveCursor({ x: step, y: 0 });
    }
    const times = sent.map((item) => item.at);
    for (let index = 1; index < times.length; index += 1) {
      expect((times[index] ?? 0) - (times[index - 1] ?? 0)).toBeGreaterThanOrEqual(50);
    }
  });

  it('sends at most 20 a second under a flood, and the end of the movement is not lost', () => {
    const { sender, sent, timers } = setup();
    sender.setConnected(true);
    for (let step = 1; step <= 3000; step += 1) {
      timers.advance(1);
      sender.moveCursor({ x: step, y: step });
    }
    for (const first of sent) {
      const inSecond = sent.filter((item) => item.at >= first.at && item.at < first.at + 1000);
      expect(inSecond.length).toBeLessThanOrEqual(20);
    }
    // 3 seconds at the limit, give or take the first and last.
    expect(sent.length).toBeGreaterThanOrEqual(58);
    expect(sent.length).toBeLessThanOrEqual(61);

    timers.advance(100);
    expect(sent.at(-1)?.state.cursor).toEqual({ x: 3000, y: 3000 });
  });

  it('has one timer at most pending, which is the next moment something is due', () => {
    const { sender, timers } = setup();
    sender.setConnected(true);
    expect(timers.delays).toEqual([HEARTBEAT_MS]);
    timers.advance(10);
    for (let step = 0; step < 50; step += 1) sender.moveCursor({ x: step, y: 0 });
    expect(timers.delays).toEqual([40]);
  });

  it('honours the interval it is given', () => {
    const timers = new FakeTimers();
    const at: number[] = [];
    const sender = new PresenceSender({
      send: () => {
        at.push(timers.now);
        return true;
      },
      now: () => timers.now,
      timers,
      identity: IDENTITY,
      minIntervalMs: 200,
      heartbeatMs: 1000,
    });
    sender.setConnected(true);
    for (let step = 1; step <= 100; step += 1) {
      timers.advance(10);
      sender.moveCursor({ x: step, y: 0 });
    }
    expect(at.slice(0, 4)).toEqual([0, 200, 400, 600]);
  });

  it('does not send early when a timer fires early', () => {
    let fire: () => void = () => undefined;
    let clock = 0;
    const timers: Timers = {
      setTimeout: (callback) => {
        fire = callback;
        return 1;
      },
      clearTimeout: () => undefined,
    };
    const sent: number[] = [];
    const sender = new PresenceSender({
      send: () => {
        sent.push(clock);
        return true;
      },
      now: () => clock,
      timers,
      identity: IDENTITY,
    });
    sender.setConnected(true);
    clock = 10;
    sender.moveCursor({ x: 1, y: 1 });
    // The browser runs the timer 5 ms before it was due.
    clock = 45;
    fire();
    expect(sent).toEqual([0]);
    clock = 50;
    fire();
    expect(sent).toEqual([0, 50]);
  });
});

describe('PresenceSender: what counts as a change', () => {
  it('sends nothing for a change that changes nothing', () => {
    const { sender, sent, timers } = setup();
    sender.setConnected(true);
    sender.moveCursor(null);
    sender.setEditing(null);
    sender.setIdentity(IDENTITY);
    timers.advance(1000);
    expect(sent).toHaveLength(1);
  });

  it('rounds the cursor to whole board units, so tiny movements send nothing', () => {
    const { sender, sent, timers, cursors } = setup();
    sender.setConnected(true);
    timers.advance(100);
    sender.moveCursor({ x: 10.2, y: 5.4 });
    timers.advance(100);
    sender.moveCursor({ x: 10.4, y: 5.1 });
    timers.advance(100);
    expect(cursors()).toEqual([null, { x: 10, y: 5 }]);
    sender.moveCursor({ x: 10.6, y: 5.1 });
    expect(sent).toHaveLength(3);
    expect(sent[2]?.state.cursor).toEqual({ x: 11, y: 5 });
  });

  it('sends when the cursor leaves the board, and not again for leaving twice', () => {
    const { sender, sent, timers, cursors } = setup();
    sender.setConnected(true);
    timers.advance(100);
    sender.moveCursor({ x: 1, y: 1 });
    timers.advance(100);
    sender.moveCursor(null);
    timers.advance(100);
    sender.moveCursor(null);
    expect(cursors()).toEqual([null, { x: 1, y: 1 }, null]);
    expect(sent).toHaveLength(3);
  });

  it('sends when the note being edited changes, and when it stops', () => {
    const { sender, sent, timers } = setup();
    sender.setConnected(true);
    timers.advance(100);
    sender.setEditing('1@a');
    timers.advance(100);
    sender.setEditing('2@a');
    timers.advance(100);
    sender.setEditing(null);
    expect(sent.map((item) => item.state.editing)).toEqual([null, '1@a', '2@a', null]);
  });

  it('sends a new name or colour', () => {
    const { sender, sent, timers } = setup();
    sender.setConnected(true);
    timers.advance(100);
    sender.setIdentity({ name: 'Grace', color: '#1971c2' });
    timers.advance(100);
    sender.setIdentity({ name: 'Grace', color: '#e03131' });
    expect(sent.map((item) => [item.state.name, item.state.color])).toEqual([
      ['Ada', '#1971c2'],
      ['Grace', '#1971c2'],
      ['Grace', '#e03131'],
    ]);
  });

  it('knows what it would send', () => {
    const { sender } = setup();
    sender.moveCursor({ x: 1, y: 2 });
    expect(sender.getState()).toEqual({
      cursor: { x: 1, y: 2 },
      editing: null,
      name: 'Ada',
      color: '#1971c2',
    });
  });
});

describe('PresenceSender: the heartbeat', () => {
  it('repeats the state every two seconds while nothing changes, and not before', () => {
    const { sender, sent, timers } = setup();
    sender.setConnected(true);
    timers.advance(1999);
    expect(sent).toHaveLength(1);
    timers.advance(1);
    expect(sent.map((item) => item.at)).toEqual([0, 2000]);
    timers.advance(4000);
    expect(sent.map((item) => item.at)).toEqual([0, 2000, 4000, 6000]);
    expect(new Set(sent.map((item) => JSON.stringify(item.state))).size).toBe(1);
  });

  it('counts from the last message, whatever it was', () => {
    const { sender, sent, timers } = setup();
    sender.setConnected(true);
    timers.advance(1500);
    sender.moveCursor({ x: 1, y: 1 });
    timers.advance(1999);
    expect(sent.map((item) => item.at)).toEqual([0, 1500]);
    timers.advance(1);
    expect(sent.map((item) => item.at)).toEqual([0, 1500, 3500]);
  });

  it('repeats the latest state, not the one from the first message', () => {
    const { sender, timers, cursors } = setup();
    sender.setConnected(true);
    timers.advance(100);
    sender.moveCursor({ x: 7, y: 8 });
    timers.advance(2000);
    expect(cursors()).toEqual([null, { x: 7, y: 8 }, { x: 7, y: 8 }]);
  });

  it('is fast enough that a few missed heartbeats still fit inside the peers’ timeout', async () => {
    const { PEER_TIMEOUT_MS } = await import('./presence-timing');
    expect(PEER_TIMEOUT_MS / HEARTBEAT_MS).toBeGreaterThanOrEqual(3);
  });
});

describe('PresenceSender: disposing', () => {
  it('stops sending and leaves no timer behind', () => {
    const { sender, sent, timers } = setup();
    sender.setConnected(true);
    timers.advance(100);
    sender.moveCursor({ x: 1, y: 1 });
    timers.advance(10);
    // This one is waiting for the interval to be over when the sender is disposed.
    sender.moveCursor({ x: 2, y: 2 });
    expect(timers.delays).toHaveLength(1);
    sender.dispose();
    expect(timers.delays).toEqual([]);
    timers.advance(60_000);
    sender.moveCursor({ x: 3, y: 3 });
    sender.setConnected(false);
    sender.setConnected(true);
    expect(sent).toHaveLength(2);
    expect(timers.delays).toEqual([]);
  });
});

describe('PresenceSender: properties', () => {
  type Step =
    | { kind: 'move'; x: number; y: number }
    | { kind: 'edit'; note: number }
    | { kind: 'rename'; name: number }
    | { kind: 'wait'; ms: number }
    | { kind: 'up' }
    | { kind: 'down' };

  const step = fc.oneof(
    fc.record({
      kind: fc.constant('move' as const),
      x: fc.integer({ min: 0, max: 50 }),
      y: fc.integer({ min: 0, max: 50 }),
    }),
    fc.record({ kind: fc.constant('edit' as const), note: fc.nat(3) }),
    fc.record({ kind: fc.constant('rename' as const), name: fc.nat(3) }),
    fc.record({ kind: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 3000 }) }),
    fc.record({ kind: fc.constant('up' as const) }),
    fc.record({ kind: fc.constant('down' as const) }),
  );

  it('never sends twice within 50 ms on one connection, never while down, and ends up saying the latest', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps: Step[]) => {
        const timers = new FakeTimers();
        const sent: { at: number; connection: number; state: PresenceState }[] = [];
        let connection = 0;
        let up = false;
        const sender = new PresenceSender({
          send: (state) => {
            if (!up) throw new Error('sent while the connection was down');
            sent.push({ at: timers.now, connection, state });
            return true;
          },
          now: () => timers.now,
          timers,
          identity: IDENTITY,
        });
        for (const current of steps) {
          switch (current.kind) {
            case 'move':
              sender.moveCursor({ x: current.x, y: current.y });
              break;
            case 'edit':
              sender.setEditing(current.note === 0 ? null : `${current.note}@a`);
              break;
            case 'rename':
              sender.setIdentity({ name: `Name ${current.name}`, color: IDENTITY.color });
              break;
            case 'wait':
              timers.advance(current.ms);
              break;
            case 'up':
              if (!up) connection += 1;
              up = true;
              sender.setConnected(true);
              break;
            case 'down':
              up = false;
              sender.setConnected(false);
              break;
          }
          if (timers.delays.length > 1) return false;
        }
        // Consecutive messages on one connection are at least 50 ms apart.
        for (let index = 1; index < sent.length; index += 1) {
          const [before, after] = [sent[index - 1], sent[index]];
          if (before === undefined || after === undefined) return false;
          if (before.connection === after.connection && after.at - before.at < 50) return false;
        }
        // Given a moment, a connection that is up has been told the latest state.
        if (up) {
          timers.advance(50);
          const last = JSON.stringify(sent.at(-1)?.state);
          if (last !== JSON.stringify(sender.getState())) return false;
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });
});
