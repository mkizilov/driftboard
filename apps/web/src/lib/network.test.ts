import { describe, expect, it } from 'vitest';
import { watchNetwork } from './network';

function connection() {
  const calls: string[] = [];
  return {
    calls,
    retryNow: () => {
      calls.push('retryNow');
    },
    networkLost: () => {
      calls.push('networkLost');
    },
  };
}

describe('watchNetwork', () => {
  it('connects at once when the browser says the network is back', () => {
    const events = new EventTarget();
    const aware = connection();
    watchNetwork(events, aware);
    events.dispatchEvent(new Event('online'));
    expect(aware.calls).toEqual(['retryNow']);
  });

  it('gives up the connection when the browser says the network is gone', () => {
    const events = new EventTarget();
    const aware = connection();
    watchNetwork(events, aware);
    events.dispatchEvent(new Event('offline'));
    expect(aware.calls).toEqual(['networkLost']);
  });

  it('follows every change', () => {
    const events = new EventTarget();
    const aware = connection();
    watchNetwork(events, aware);
    for (const type of ['offline', 'online', 'offline', 'online']) {
      events.dispatchEvent(new Event(type));
    }
    expect(aware.calls).toEqual(['networkLost', 'retryNow', 'networkLost', 'retryNow']);
  });

  it('stops listening when told to', () => {
    const events = new EventTarget();
    const aware = connection();
    const stop = watchNetwork(events, aware);
    stop();
    events.dispatchEvent(new Event('online'));
    events.dispatchEvent(new Event('offline'));
    expect(aware.calls).toEqual([]);
  });

  it('ignores other events', () => {
    const events = new EventTarget();
    const aware = connection();
    watchNetwork(events, aware);
    events.dispatchEvent(new Event('focus'));
    expect(aware.calls).toEqual([]);
  });
});
