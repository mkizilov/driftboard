import { describe, expect, it } from 'vitest';
import { PwaStatus } from './pwa-status';

describe('PwaStatus', () => {
  it('starts with nothing to show', () => {
    expect(new PwaStatus().getState()).toEqual({ offlineReady: false, needRefresh: false });
  });

  it('records that the app can work offline and tells its listeners once', () => {
    const status = new PwaStatus();
    let calls = 0;
    status.subscribe(() => {
      calls += 1;
    });
    status.markOfflineReady();
    status.markOfflineReady();
    expect(status.getState()).toEqual({ offlineReady: true, needRefresh: false });
    expect(calls).toBe(1);
  });

  it('records that an update is waiting', () => {
    const status = new PwaStatus();
    status.markNeedRefresh();
    expect(status.getState()).toEqual({ offlineReady: false, needRefresh: true });
  });

  it('hands out the same state until it changes', () => {
    const status = new PwaStatus();
    const before = status.getState();
    expect(status.getState()).toBe(before);
    status.markNeedRefresh();
    expect(status.getState()).not.toBe(before);
  });

  it('hides everything when dismissed, and only tells listeners if there was something', () => {
    const status = new PwaStatus();
    let calls = 0;
    status.subscribe(() => {
      calls += 1;
    });
    status.dismiss();
    expect(calls).toBe(0);
    status.markOfflineReady();
    status.markNeedRefresh();
    status.dismiss();
    expect(status.getState()).toEqual({ offlineReady: false, needRefresh: false });
    expect(calls).toBe(3);
  });

  it('applies an update the way the page said', () => {
    const status = new PwaStatus();
    status.reload();
    let reloads = 0;
    status.setReload(() => {
      reloads += 1;
    });
    status.reload();
    expect(reloads).toBe(1);
  });

  it('stops telling a listener that unsubscribed', () => {
    const status = new PwaStatus();
    let calls = 0;
    const stop = status.subscribe(() => {
      calls += 1;
    });
    stop();
    status.markOfflineReady();
    expect(calls).toBe(0);
  });
});
