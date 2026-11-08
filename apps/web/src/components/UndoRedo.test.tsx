// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { BoardStore } from '../lib/board-store';
import { historyOf, replica } from '../lib/test-support';
import { chord, cleanup, flush, must, nativeHistory, render } from '../test-render';
import { UndoRedo } from './UndoRedo';

afterEach(cleanup);

function mount() {
  const board = replica(1);
  const store = new BoardStore(board, () => undefined, historyOf(board));
  const screen = render(<UndoRedo store={store} />);
  const button = (name: 'Undo' | 'Redo') =>
    must(
      [...screen.container.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent === name,
      ),
    );
  /** A field of the page to press keys in. */
  const field = (tag: 'textarea' | 'input') =>
    document.body.appendChild(document.createElement(tag));
  return { store, screen, button, field };
}

const ctrlZ = { key: 'z', ctrlKey: true };
const cmdZ = { key: 'z', metaKey: true };
const shiftCtrlZ = { key: 'Z', ctrlKey: true, shiftKey: true };
const shiftCmdZ = { key: 'Z', metaKey: true, shiftKey: true };

describe('UndoRedo: the buttons', () => {
  it('are both off while there is nothing to undo or redo', () => {
    const { button } = mount();
    expect(button('Undo').disabled).toBe(true);
    expect(button('Redo').disabled).toBe(true);
  });

  it('turn on with the history, undo and redo when pressed, and turn off again', () => {
    const { store, button } = mount();
    const id = must(store.createNote(1, 2));
    flush(() => {
      store.moveNote(id, 30, 40);
    });
    expect(button('Undo').disabled).toBe(false);
    expect(button('Redo').disabled).toBe(true);

    flush(() => {
      button('Undo').click();
    });
    expect(store.getNote(id)).toMatchObject({ x: 1, y: 2 });
    expect(button('Redo').disabled).toBe(false);

    flush(() => {
      button('Redo').click();
    });
    expect(store.getNote(id)).toMatchObject({ x: 30, y: 40 });
    expect(button('Redo').disabled).toBe(true);

    flush(() => {
      button('Undo').click();
      button('Undo').click();
    });
    expect(store.getNote(id)).toBeUndefined();
    expect(button('Undo').disabled).toBe(true);
  });

  it('say which keys do it', () => {
    const { button } = mount();
    expect(button('Undo').title).toContain('Ctrl/Cmd+Z');
    expect(button('Redo').title).toContain('Shift+Ctrl/Cmd+Z');
  });

  it('are a labelled group', () => {
    const { screen } = mount();
    const group = must(screen.container.querySelector('.history'));
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Undo and redo');
  });
});

describe('UndoRedo: the keys', () => {
  function withHistory() {
    const context = mount();
    const id = must(context.store.createNote(1, 2));
    context.store.moveNote(id, 30, 40);
    context.store.setColor(id, 'blue');
    return { ...context, id };
  }

  it('undo on Ctrl+Z and on Cmd+Z, and keep the browser from doing it too', () => {
    const { store, id } = withHistory();
    expect(chord(document.body, ctrlZ)).toBe(true);
    expect(store.getNote(id)?.color).toBe('yellow');
    expect(chord(document.body, cmdZ)).toBe(true);
    expect(store.getNote(id)).toMatchObject({ x: 1, y: 2 });
  });

  it('redo on Shift+Ctrl+Z and Shift+Cmd+Z', () => {
    const { store, id } = withHistory();
    chord(document.body, ctrlZ);
    chord(document.body, ctrlZ);
    expect(chord(document.body, shiftCtrlZ)).toBe(true);
    expect(store.getNote(id)).toMatchObject({ x: 30, y: 40, color: 'yellow' });
    expect(chord(document.body, shiftCmdZ)).toBe(true);
    expect(store.getNote(id)?.color).toBe('blue');
  });

  it('work from inside a note’s textarea, where the browser would undo on its own', () => {
    const { store, id, field } = withHistory();
    const textarea = field('textarea');
    expect(chord(textarea, ctrlZ)).toBe(true);
    expect(store.getNote(id)?.color).toBe('yellow');
    expect(chord(textarea, shiftCtrlZ)).toBe(true);
    expect(store.getNote(id)?.color).toBe('blue');
  });

  it('leave a one-line field its own undo', () => {
    const { store, id, field } = withHistory();
    const input = field('input');
    expect(chord(input, ctrlZ)).toBe(false);
    expect(chord(input, shiftCmdZ)).toBe(false);
    expect(store.getNote(id)?.color).toBe('blue');
  });

  it('ignore other keys, other combinations and keys of an input method', () => {
    const { store, id } = withHistory();
    for (const init of [
      { key: 'z' },
      { key: 'y', ctrlKey: true },
      { key: 'z', ctrlKey: true, altKey: true },
      { key: 'Z', shiftKey: true },
      { key: 'z', ctrlKey: true, isComposing: true },
    ]) {
      expect(chord(document.body, init)).toBe(false);
    }
    expect(store.getNote(id)?.color).toBe('blue');
  });

  it('take the browser’s own undo and redo for the board’s', () => {
    const { store, id, field } = withHistory();
    const textarea = field('textarea');
    expect(nativeHistory(textarea, 'historyUndo')).toBe(true);
    expect(store.getNote(id)?.color).toBe('yellow');
    expect(nativeHistory(textarea, 'historyRedo')).toBe(true);
    expect(store.getNote(id)?.color).toBe('blue');
    expect(nativeHistory(textarea, 'insertText')).toBe(false);
    expect(nativeHistory(field('input'), 'historyUndo')).toBe(false);
  });

  it('stop being listened to when the buttons leave the page', () => {
    const { store, id } = withHistory();
    cleanup();
    expect(chord(document.body, ctrlZ)).toBe(false);
    expect(nativeHistory(document.body, 'historyUndo')).toBe(false);
    expect(store.getNote(id)?.color).toBe('blue');
  });

  it('are listened to once however often the page renders', () => {
    const { store, id, screen } = withHistory();
    screen.rerender(<UndoRedo store={store} />);
    screen.rerender(<UndoRedo store={store} />);
    chord(document.body, ctrlZ);
    // One press undid one step, not three.
    expect(store.getNote(id)?.color).toBe('yellow');
    expect(store.getNote(id)).toMatchObject({ x: 30, y: 40 });
  });
});
