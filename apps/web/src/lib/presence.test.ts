import { replicaId } from '@driftboard/crdt';
import type { PresenceState } from '@driftboard/protocol';
import { describe, expect, it } from 'vitest';
import { IdentityStore } from './identity';
import { createPresence, type PresenceConnection } from './presence';
import { PresenceStore } from './presence-store';
import type { ConnectionStatus } from './sync-connection';
import { FakeTimers } from './test-network';

const me = replicaId('me');
const ada = replicaId('ada');

/** A connection that is told by the test whether it is online, and records presence it carries. */
function fakeConnection() {
  let status: ConnectionStatus = 'offline';
  const listeners = new Set<() => void>();
  const sent: (PresenceState | null)[] = [];
  const connection: PresenceConnection = {
    getStatus: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sendPresence: (state) => {
      if (status !== 'online') return false;
      sent.push(state);
      return true;
    },
  };
  return {
    connection,
    sent,
    listeners,
    set: (next: ConnectionStatus) => {
      status = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function setup(online = false) {
  const timers = new FakeTimers();
  const identity = new IdentityStore(null, () => Uint8Array.from([0, 0, 0]));
  const store = new PresenceStore({ self: me, now: () => timers.now, timers });
  const link = fakeConnection();
  if (online) link.set('online');
  const presence = createPresence({
    store,
    identity,
    connection: link.connection,
    now: () => timers.now,
    timers,
  });
  return { timers, identity, store, link, presence };
}

describe('createPresence', () => {
  it('tells the others nothing while the connection is not online', () => {
    const { link, presence, timers } = setup();
    presence.moveCursor({ x: 1, y: 1 });
    presence.startEditing('1@a');
    timers.advance(10_000);
    expect(link.sent).toEqual([]);
    link.set('connecting');
    expect(link.sent).toEqual([]);
  });

  it('sends who this is, at once, when the connection comes online', () => {
    const { link, identity } = setup();
    link.set('online');
    expect(link.sent).toEqual([
      { cursor: null, editing: null, ...identity.getIdentity() },
    ]);
  });

  it('sends at once if the connection was already online', () => {
    const { link } = setup(true);
    expect(link.sent).toHaveLength(1);
  });

  it('sends where the pointer is, throttled', () => {
    const { link, presence, timers } = setup(true);
    timers.advance(100);
    for (let x = 1; x <= 10; x += 1) presence.moveCursor({ x, y: 0 });
    expect(link.sent).toHaveLength(2);
    timers.advance(50);
    expect(link.sent).toHaveLength(3);
    expect(link.sent.at(-1)?.cursor).toEqual({ x: 10, y: 0 });
  });

  it('says which note is being edited, and when it stops', () => {
    const { link, presence, timers } = setup(true);
    timers.advance(100);
    presence.startEditing('1@a');
    timers.advance(100);
    presence.stopEditing('1@a');
    expect(link.sent.map((state) => state?.editing)).toEqual([null, '1@a', null]);
  });

  it('does not stop editing a note when asked to stop editing another one', () => {
    const { link, presence, timers } = setup(true);
    timers.advance(100);
    presence.startEditing('1@a');
    timers.advance(100);
    presence.stopEditing('2@a');
    timers.advance(100);
    expect(link.sent.at(-1)?.editing).toBe('1@a');
    presence.startEditing('2@a');
    presence.stopEditing('1@a');
    timers.advance(100);
    expect(link.sent.at(-1)?.editing).toBe('2@a');
  });

  it('says a new name as soon as it is changed', () => {
    const { link, identity, timers } = setup(true);
    timers.advance(100);
    identity.rename('Ada');
    expect(link.sent.at(-1)?.name).toBe('Ada');
  });

  it('forgets everyone when the connection is lost, and lets the server tell again when it returns', () => {
    const { link, store, timers } = setup(true);
    store.receive({
      type: 'presence',
      replicaId: ada,
      state: { cursor: null, editing: null, name: 'Ada', color: '#e03131' },
    });
    expect(store.getPeers()).toHaveLength(1);
    link.set('offline');
    expect(store.getPeers()).toEqual([]);
    expect(timers.delays).toEqual([]);

    link.set('online');
    store.receive({
      type: 'presence',
      replicaId: ada,
      state: { cursor: null, editing: null, name: 'Ada', color: '#e03131' },
    });
    expect(store.getPeers()).toHaveLength(1);
  });

  it('stops sending when the connection goes down and starts again, at once, when it is back', () => {
    const { link, presence, timers } = setup(true);
    timers.advance(100);
    link.set('offline');
    presence.moveCursor({ x: 5, y: 5 });
    timers.advance(10_000);
    expect(link.sent).toHaveLength(1);
    link.set('online');
    expect(link.sent).toHaveLength(2);
    expect(link.sent[1]?.cursor).toEqual({ x: 5, y: 5 });
  });

  it('does not react to status changes that are not about being online', () => {
    const { link, store } = setup(true);
    store.receive({
      type: 'presence',
      replicaId: ada,
      state: { cursor: null, editing: null, name: 'Ada', color: '#e03131' },
    });
    link.set('online');
    link.set('online');
    expect(store.getPeers()).toHaveLength(1);
    expect(link.sent).toHaveLength(1);
  });

  it('knows what it shows others', () => {
    const { presence, identity } = setup(true);
    presence.moveCursor({ x: 3, y: 4 });
    presence.startEditing('1@a');
    expect(presence.getState()).toEqual({
      cursor: { x: 3, y: 4 },
      editing: '1@a',
      ...identity.getIdentity(),
    });
  });

  it('lets go of everything when disposed', () => {
    const { link, presence, identity, store, timers } = setup(true);
    store.receive({
      type: 'presence',
      replicaId: ada,
      state: { cursor: null, editing: null, name: 'Ada', color: '#e03131' },
    });
    presence.dispose();
    expect(link.listeners.size).toBe(0);
    expect(timers.delays).toEqual([]);
    identity.rename('Ada');
    link.set('offline');
    link.set('online');
    presence.moveCursor({ x: 1, y: 1 });
    timers.advance(60_000);
    expect(link.sent).toHaveLength(1);
  });

  it('exposes the store and the identity it works with', () => {
    const { presence, store, identity } = setup();
    expect(presence.store).toBe(store);
    expect(presence.identity).toBe(identity);
  });
});
