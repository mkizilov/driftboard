// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { pwaStatus } from './lib/pwa-status';
import { cleanup, flush, render } from './test-render';

afterEach(() => {
  cleanup();
  pwaStatus.dismiss();
});

function renderAt(path: string) {
  window.history.pushState(null, '', path);
  return render(<App />);
}

describe('App', () => {
  it('shows the start page at the root', () => {
    const screen = renderAt('/');
    expect(screen.container.querySelector('h1')?.textContent).toBe('driftboard');
    expect(screen.container.querySelector('button.create-board')).not.toBeNull();
  });

  it('says so when there is nothing at an address', () => {
    expect(renderAt('/elsewhere').container.querySelector('h1')?.textContent).toBe('Not found');
  });

  it('does not open a board for an id that cannot be one', () => {
    const screen = renderAt('/b/short');
    expect(screen.container.querySelector('h1')?.textContent).toBe('Not found');
    expect(screen.container.querySelector('[data-testid="canvas"]')).toBeNull();
  });

  it('offers an update on every page when the service worker has one', () => {
    const screen = renderAt('/');
    expect(screen.container.querySelector('.pwa-banner')).toBeNull();
    flush(() => {
      pwaStatus.markNeedRefresh();
    });
    expect(screen.container.querySelector('.pwa-banner')?.textContent).toContain('new version');
  });

  it('follows the address when it changes', () => {
    const screen = renderAt('/');
    flush(() => {
      window.history.pushState(null, '', '/elsewhere');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.container.querySelector('h1')?.textContent).toBe('Not found');
  });
});
