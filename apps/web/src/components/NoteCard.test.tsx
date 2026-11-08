// @vitest-environment jsdom
import { Profiler } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardStore } from '../lib/board-store';
import { replica } from '../lib/test-support';
import { INITIAL_VIEWPORT } from '../lib/viewport';
import { cleanup, flush, must, render, typeInto } from '../test-render';
import { NoteCard } from './NoteCard';

afterEach(cleanup);

function mountNotes() {
  const store = new BoardStore(replica(1), () => undefined);
  const ids = [must(store.createNote(0, 0)), must(store.createNote(40, 40))] as const;
  const viewportRef = { current: INITIAL_VIEWPORT };
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
          <NoteCard store={store} id={id} viewportRef={viewportRef} />
        </Profiler>
      ))}
    </>,
  );
  const count = (id: string) => renders.get(id) ?? 0;
  const noteElement = (id: string) =>
    must(screen.container.querySelector<HTMLElement>(`[data-note-id="${id}"]`));
  return { store, ids, count, noteElement };
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
