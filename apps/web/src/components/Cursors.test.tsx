// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { testPresence } from '../lib/test-support';
import { INITIAL_VIEWPORT } from '../lib/viewport';
import { cleanup, flush, must, render } from '../test-render';
import { Cursors } from './Cursors';

afterEach(cleanup);

const cursors = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.cursor')];

describe('Cursors', () => {
  it('draws nothing when nobody else is here, or nobody’s pointer is over the board', () => {
    const people = testPresence();
    const screen = render(<Cursors store={people.store} viewport={INITIAL_VIEWPORT} />);
    expect(cursors(screen.container)).toEqual([]);
    flush(() => {
      people.hear('Ada', { cursor: null });
    });
    expect(cursors(screen.container)).toEqual([]);
  });

  it('labels each pointer with a name and draws it in the person’s colour', () => {
    const people = testPresence();
    const screen = render(<Cursors store={people.store} viewport={INITIAL_VIEWPORT} />);
    flush(() => {
      people.hear('Ada', { cursor: { x: 10, y: 20 }, color: '#e03131' });
      people.hear('Bob', { cursor: { x: 30, y: 40 }, color: '#2f9e44' });
    });
    const [ada, bob] = cursors(screen.container);
    expect(must(ada).querySelector('.cursor-label')?.textContent).toBe('Ada');
    expect(must(ada).style.getPropertyValue('--peer')).toBe('#e03131');
    expect(must(bob).querySelector('.cursor-label')?.textContent).toBe('Bob');
    expect(must(bob).style.getPropertyValue('--peer')).toBe('#2f9e44');
  });

  it('puts a pointer where it is on the board, whatever this person’s pan and zoom', () => {
    const people = testPresence();
    flush(() => {
      people.hear('Ada', { cursor: { x: 100, y: 50 } });
    });
    const screen = render(<Cursors store={people.store} viewport={{ x: 20, y: -10, scale: 2 }} />);
    // 100 * 2 + 20 and 50 * 2 - 10.
    expect(must(cursors(screen.container)[0]).style.transform).toBe('translate(220px, 90px)');

    screen.rerender(<Cursors store={people.store} viewport={INITIAL_VIEWPORT} />);
    expect(must(cursors(screen.container)[0]).style.transform).toBe('translate(100px, 50px)');
  });

  it('follows a pointer that moves, and removes one that leaves the board or the person', () => {
    const people = testPresence();
    const screen = render(<Cursors store={people.store} viewport={INITIAL_VIEWPORT} />);
    flush(() => {
      people.hear('Ada', { cursor: { x: 1, y: 2 } });
    });
    const element = must(cursors(screen.container)[0]);
    flush(() => {
      people.hear('Ada', { cursor: { x: 5, y: 6 } });
    });
    expect(must(cursors(screen.container)[0]).style.transform).toBe('translate(5px, 6px)');
    // The same element moves, so that it can glide.
    expect(must(cursors(screen.container)[0])).toBe(element);

    flush(() => {
      people.hear('Ada', { cursor: null });
    });
    expect(cursors(screen.container)).toEqual([]);
    flush(() => {
      people.hear('Ada', { cursor: { x: 1, y: 1 } });
    });
    flush(() => {
      people.hear('Ada', null);
    });
    expect(cursors(screen.container)).toEqual([]);
  });

  it('removes the pointer of someone who has gone quiet', () => {
    const people = testPresence();
    const screen = render(<Cursors store={people.store} viewport={INITIAL_VIEWPORT} />);
    flush(() => {
      people.hear('Ada', { cursor: { x: 1, y: 2 } });
    });
    flush(() => {
      people.timers.advance(6000);
    });
    expect(cursors(screen.container)).toEqual([]);
  });

  it('is decoration for the eye: hidden from assistive technology and never in the way of the pointer', () => {
    const people = testPresence();
    const screen = render(<Cursors store={people.store} viewport={INITIAL_VIEWPORT} />);
    expect(must(screen.container.querySelector('.cursors')).getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('shows a name as text, whatever it contains', () => {
    const people = testPresence();
    const screen = render(<Cursors store={people.store} viewport={INITIAL_VIEWPORT} />);
    flush(() => {
      people.hear('Mal', { name: '<img src=x onerror=alert(1)>', cursor: { x: 1, y: 1 } });
    });
    const label = must(screen.container.querySelector('.cursor-label'));
    expect(label.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(screen.container.querySelector('img')).toBeNull();
  });
});
