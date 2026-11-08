// @vitest-environment jsdom
import { Profiler } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardStore } from '../lib/board-store';
import { historyOf, replica, testPresence } from '../lib/test-support';
import { INITIAL_VIEWPORT } from '../lib/viewport';
import { cleanup, flush, must, render, typeInto } from '../test-render';
import { NoteCard } from './NoteCard';

afterEach(cleanup);

function mountNotes() {
  const board = replica(1);
  const store = new BoardStore(board, () => undefined, historyOf(board));
  const ids = [must(store.createNote(0, 0)), must(store.createNote(40, 40))] as const;
  const viewportRef = { current: INITIAL_VIEWPORT };
  const people = testPresence();
  const renders = new Map<string, number>();
  const screen = render(
    <>
      {ids.map((id) => (
        <Profiler
          key={id}
          id={id}
          onRender={() => {
            renders.set(id, (renders.get(id) ?? 0) + 1);
          }}
        >
          <NoteCard store={store} id={id} presence={people.presence} viewportRef={viewportRef} />
        </Profiler>
      ))}
    </>,
  );
  const count = (id: string) => renders.get(id) ?? 0;
  const noteElement = (id: string) =>
    must(screen.container.querySelector<HTMLElement>(`[data-note-id="${id}"]`));
  return { store, ids, count, noteElement, people };
}

describe('NoteCard', () => {
  it('draws the note where the document says, in its colour and stacking order', () => {
    const { store, ids, noteElement } = mountNotes();
    const [first, second] = ids;
    expect(noteElement(first).style.transform).toBe('translate(0px, 0px)');
    expect(noteElement(second).style.transform).toBe('translate(40px, 40px)');
    expect(noteElement(first).getAttribute('data-color')).toBe('yellow');
    flush(() => {
      store.setColor(first, 'pink');
    });
    expect(noteElement(first).getAttribute('data-color')).toBe('pink');
    expect(Number(noteElement(second).style.zIndex)).toBeGreaterThan(
      Number(noteElement(first).style.zIndex),
    );
  });

  it('renders only the note that moved', () => {
    const { store, ids, count } = mountNotes();
    const [first, second] = ids;
    const firstBefore = count(first);
    const secondBefore = count(second);
    flush(() => {
      store.moveNote(first, 5, 5);
    });
    expect([count(first), count(second)]).toEqual([firstBefore + 1, secondBefore]);
  });

  it('renders only the note whose text changed, and the edit reaches the document', () => {
    const { store, ids, count, noteElement } = mountNotes();
    const [first, second] = ids;
    const firstBefore = count(first);
    const secondBefore = count(second);
    typeInto(must(noteElement(first).querySelector('textarea')), 'hello');
    expect(store.getNote(first)?.text).toBe('hello');
    expect(store.getNote(second)?.text).toBe('');
    expect([count(first), count(second)]).toEqual([firstBefore + 1, secondBefore]);
  });

  it('does not render a note again when another note changes colour or stacking', () => {
    const { store, ids, count } = mountNotes();
    const [first, second] = ids;
    const before = count(second);
    flush(() => {
      store.setColor(first, 'green');
      store.bringToFront(first);
    });
    expect(count(second)).toBe(before);
  });

  describe('with other people on the board', () => {
    it('shows who is editing it, and outlines it in their colour', () => {
      const { ids, noteElement, people } = mountNotes();
      const [first, second] = ids;
      expect(noteElement(first).querySelector('.note-editors')).toBeNull();
      expect(noteElement(first).className).not.toContain('edited');

      flush(() => {
        people.hear('Ada', { editing: first, color: '#e03131' });
        people.hear('Bob', { editing: first, color: '#2f9e44' });
      });
      const badges = [...noteElement(first).querySelectorAll('.editor')];
      expect(badges.map((badge) => badge.textContent)).toEqual([
        'Ada is editing',
        'Bob is editing',
      ]);
      expect(noteElement(first).className).toContain('edited');
      expect(noteElement(first).style.getPropertyValue('--editor')).toBe('#e03131');
      expect(noteElement(second).querySelector('.note-editors')).toBeNull();
    });

    it('stops showing someone who stops editing, leaves or goes quiet', () => {
      const { ids, noteElement, people } = mountNotes();
      const first = ids[0];
      flush(() => {
        people.hear('Ada', { editing: first });
      });
      expect(noteElement(first).querySelector('.editor')).not.toBeNull();
      flush(() => {
        people.hear('Ada', { editing: null });
      });
      expect(noteElement(first).querySelector('.editor')).toBeNull();

      flush(() => {
        people.hear('Ada', { editing: first });
      });
      flush(() => {
        people.timers.advance(6000);
      });
      expect(noteElement(first).querySelector('.editor')).toBeNull();
    });

    it('is not rendered again when someone’s pointer moves, even one who is editing it', () => {
      const { ids, count, people } = mountNotes();
      const [first, second] = ids;
      flush(() => {
        people.hear('Ada', { editing: first, cursor: { x: 0, y: 0 } });
      });
      const before = [count(first), count(second)];
      for (let step = 1; step <= 20; step += 1) {
        flush(() => {
          people.hear('Ada', { editing: first, cursor: { x: step, y: step } });
          people.hear('Bob', { cursor: { x: step, y: 0 } });
        });
      }
      expect([count(first), count(second)]).toEqual(before);
    });

    it('tells the others when its text gets the focus, and when it loses it', () => {
      const { ids, noteElement, people } = mountNotes();
      const first = ids[0];
      people.set('online');
      people.timers.advance(100);
      const textarea = must(noteElement(first).querySelector('textarea'));
      flush(() => {
        textarea.focus();
      });
      expect(people.presence.getState().editing).toBe(first);
      people.timers.advance(100);
      flush(() => {
        textarea.blur();
      });
      expect(people.presence.getState().editing).toBeNull();
      expect(people.sent.map((state) => state?.editing)).toEqual([null, first, null]);
    });

    it('is not editing any more once it is deleted while its text has the focus', () => {
      const { store, ids, noteElement, people } = mountNotes();
      const first = ids[0];
      people.set('online');
      flush(() => {
        must(noteElement(first).querySelector('textarea')).focus();
      });
      expect(people.presence.getState().editing).toBe(first);
      flush(() => {
        store.deleteNote(first);
      });
      expect(people.presence.getState().editing).toBeNull();
    });
  });

  it('changes colour from its swatches and removes itself when deleted', () => {
    const { store, ids, noteElement } = mountNotes();
    const [first] = ids;
    flush(() => {
      must(
        noteElement(first).querySelector<HTMLButtonElement>('[aria-label="Color blue"]'),
      ).click();
    });
    expect(store.getNote(first)?.color).toBe('blue');
    flush(() => {
      must(
        noteElement(first).querySelector<HTMLButtonElement>('[aria-label="Delete note"]'),
      ).click();
    });
    expect(store.getNote(first)).toBeUndefined();
    expect(document.querySelector(`[data-note-id="${first}"]`)).toBeNull();
  });
});
