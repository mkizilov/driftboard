// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { parseRoute } from '../lib/route';
import { cleanup, flush, must, render } from '../test-render';
import { HomePage } from './HomePage';

afterEach(cleanup);

describe('HomePage', () => {
  it('creates a board with a new random id and goes to it', () => {
    window.history.pushState(null, '', '/');
    const screen = render(<HomePage />);
    const button = must(screen.container.querySelector<HTMLButtonElement>('button.create-board'));

    flush(() => {
      button.click();
    });
    const first = parseRoute(window.location.pathname);
    expect(first.name).toBe('board');

    window.history.pushState(null, '', '/');
    flush(() => {
      button.click();
    });
    const second = parseRoute(window.location.pathname);
    expect(second.name).toBe('board');
    expect(second).not.toEqual(first);
  });
});
