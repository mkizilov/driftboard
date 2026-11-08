// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { PwaStatus } from '../lib/pwa-status';
import { cleanup, flush, must, render } from '../test-render';
import { PwaBanner } from './PwaBanner';

afterEach(cleanup);

const buttons = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].map((button) => button.textContent);

describe('PwaBanner', () => {
  it('shows nothing until the service worker has something to say', () => {
    const screen = render(<PwaBanner status={new PwaStatus()} />);
    expect(screen.container.querySelector('.pwa-banner')).toBeNull();
  });

  it('tells the user that the app now works offline, until dismissed', () => {
    const status = new PwaStatus();
    const screen = render(<PwaBanner status={status} />);
    flush(() => {
      status.markOfflineReady();
    });
    expect(must(screen.container.querySelector('.pwa-banner')).textContent).toContain(
      'works offline',
    );
    flush(() => {
      must(screen.container.querySelector('button')).click();
    });
    expect(screen.container.querySelector('.pwa-banner')).toBeNull();
  });

  it('offers a new version, and applies it only when asked', () => {
    const status = new PwaStatus();
    let reloads = 0;
    status.setReload(() => {
      reloads += 1;
    });
    const screen = render(<PwaBanner status={status} />);
    flush(() => {
      status.markNeedRefresh();
    });
    expect(screen.container.textContent).toContain('A new version is ready.');
    expect(buttons(screen.container)).toEqual(['Reload', 'Later']);
    expect(reloads).toBe(0);

    flush(() => {
      must(screen.container.querySelectorAll('button')[0]).click();
    });
    expect(reloads).toBe(1);
  });

  it('puts the update off when the user says later', () => {
    const status = new PwaStatus();
    const screen = render(<PwaBanner status={status} />);
    flush(() => {
      status.markNeedRefresh();
    });
    flush(() => {
      must(screen.container.querySelectorAll('button')[1]).click();
    });
    expect(screen.container.querySelector('.pwa-banner')).toBeNull();
  });

  it('puts an update before the offline notice when both are due', () => {
    const status = new PwaStatus();
    const screen = render(<PwaBanner status={status} />);
    flush(() => {
      status.markOfflineReady();
      status.markNeedRefresh();
    });
    expect(screen.container.textContent).toContain('A new version is ready.');
  });
});
