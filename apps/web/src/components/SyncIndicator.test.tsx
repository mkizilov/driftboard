// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { openBoardSession } from '../lib/session';
import { MemoryDisk } from '../lib/storage';
import { FakeNetwork, FakeTimers } from '../lib/test-network';
import { cleanup, flush, must, render } from '../test-render';
import { SyncIndicator } from './SyncIndicator';

afterEach(cleanup);

async function setup(disk = new MemoryDisk()) {
  const net = new FakeNetwork();
  const timers = new FakeTimers();
  const session = await openBoardSession({
    boardId: net.boardId,
    url: 'ws://test.invalid/ws',
    storage: disk.open(net.boardId),
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    createSocket: net.createSocket,
    timers,
    random: () => 0,
  });
  const screen = render(<SyncIndicator session={session} />);
  const text = () => must(screen.container.querySelector('.sync')).textContent;
  const state = () => must(screen.container.querySelector('.sync')).getAttribute('data-state');
  return { net, timers, session, screen, text, state };
}

describe('SyncIndicator', () => {
  it('is offline before anything has connected, with no changes waiting', async () => {
    const { text, state } = await setup();
    expect(text()).toBe('Offline');
    expect(state()).toBe('offline');
  });

  it('is syncing while the first connection is being made', async () => {
    const { session, text, state } = await setup();
    flush(() => {
      session.start();
    });
    expect(text()).toBe('Syncing…');
    expect(state()).toBe('syncing');
  });

  it('is online once connected, and says how many changes were waiting while offline', async () => {
    const { net, session, text, state } = await setup();
    flush(() => {
      session.store.createNote(1, 1);
    });
    expect(text()).toMatch(/^Offline · \d+ pending change/);

    flush(() => {
      session.start();
      net.open(must(net.sockets.at(-1)));
    });
    expect(text()).toBe('Online');
    expect(state()).toBe('online');
  });

  it('is offline again, with the count, when the connection drops', async () => {
    const { net, session, text } = await setup();
    flush(() => {
      session.start();
      net.open(must(net.sockets.at(-1)));
    });
    flush(() => {
      must(net.sockets.at(-1)).drop();
    });
    flush(() => {
      session.store.createNote(1, 1);
    });
    expect(text()).toMatch(/^Offline · \d+ pending changes?$/);
  });

  it('warns that nothing is kept when the storage is not durable', async () => {
    const { screen } = await setup(new MemoryDisk({ durable: false }));
    expect(must(screen.container.querySelector('.save-warning')).textContent).toBe(
      'Not saved on this device',
    );
  });

  it('shows no warning when the changes are being kept', async () => {
    const { screen } = await setup();
    expect(screen.container.querySelector('.save-warning')).toBeNull();
  });
});
