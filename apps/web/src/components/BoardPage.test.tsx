// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createBoardSession } from '../lib/session';
import { FakeNetwork, FakeTimers } from '../lib/test-network';
import { cleanup, flush, must, render, typeInto } from '../test-render';
import { BoardPage } from './BoardPage';

afterEach(cleanup);

function session(net: FakeNetwork, timers: FakeTimers, seed: number) {
  return createBoardSession({
    boardId: net.boardId,
    url: 'ws://test.invalid/ws',
    randomBytes: (length) =>
      Uint8Array.from({ length }, (_, index) => (seed * 53 + index * 7) % 256),
    createSocket: net.createSocket,
    timers,
    random: () => 0,
  });
}

/** The board page on one session, and a second user on the same board outside React. */
function open() {
  const net = new FakeNetwork();
  const timers = new FakeTimers();
  const mine = session(net, timers, 1);
  const theirs = session(net, timers, 2);
  const createSession = () => mine;
  const screen = render(<BoardPage boardId={net.boardId} createSession={createSession} />);
  const mySocket = must(net.sockets[0]);

  theirs.start();
  flush(() => {
    net.open(mySocket);
    net.open(must(net.sockets[1]));
  });
  const canvas = () => must(screen.container.querySelector<HTMLElement>('[data-testid="canvas"]'));
  const notes = () => [...screen.container.querySelectorAll<HTMLElement>('[data-note-id]')];
  const doubleClick = (clientX: number, clientY: number) => {
    flush(() => {
      canvas().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX, clientY }));
    });
  };
  return { net, timers, mine, theirs, screen, canvas, notes, doubleClick, mySocket };
}

describe('BoardPage', () => {
  it('shows the connection status as it changes', () => {
    const { net, timers, mySocket, screen } = open();
    const badge = () => must(screen.container.querySelector('[role="status"]')).textContent;
    expect(badge()).toBe('Connected');

    flush(() => {
      mySocket.drop();
    });
    expect(badge()).toBe('Offline, retrying…');

    flush(() => {
      timers.fire();
    });
    expect(badge()).toBe('Connecting…');

    flush(() => {
      net.open(must(net.sockets.at(-1)));
    });
    expect(badge()).toBe('Connected');
  });

  it('adds a note under the pointer on a double-click, and the other user sees it', () => {
    const { theirs, notes, doubleClick } = open();
    expect(notes()).toHaveLength(0);
    doubleClick(300, 200);
    expect(notes()).toHaveLength(1);
    // Centred on the pointer: a note is 220 by 180.
    expect(must(notes()[0]).style.transform).toBe('translate(190px, 110px)');
    const id = must(theirs.store.getIds()[0]);
    expect(theirs.store.getNote(id)).toMatchObject({ x: 190, y: 110 });
  });

  it('sends what is typed into a note to the other user', () => {
    const { theirs, notes, doubleClick } = open();
    doubleClick(300, 200);
    const textarea = must(must(notes()[0]).querySelector('textarea'));
    typeInto(textarea, 'hello');
    const id = must(theirs.store.getIds()[0]);
    expect(theirs.store.getNote(id)?.text).toBe('hello');
  });

  it('shows another user’s typing without moving the caret', () => {
    const { theirs, notes, doubleClick } = open();
    doubleClick(300, 200);
    const id = must(theirs.store.getIds()[0]);
    flush(() => {
      theirs.store.editText(id, { start: 0, deleteCount: 0, insert: 'hello world' });
    });
    const textarea = must(must(notes()[0]).querySelector('textarea'));
    expect(textarea.value).toBe('hello world');

    textarea.focus();
    textarea.setSelectionRange(8, 8);
    flush(() => {
      theirs.store.editText(id, { start: 0, deleteCount: 0, insert: '>> ' });
    });
    expect(textarea.value).toBe('>> hello world');
    expect(textarea.selectionStart).toBe(11);
    expect(document.activeElement).toBe(textarea);
  });

  it('removes a note that the other user deletes', () => {
    const { theirs, notes, doubleClick } = open();
    doubleClick(300, 200);
    const id = must(theirs.store.getIds()[0]);
    flush(() => {
      theirs.store.deleteNote(id);
    });
    expect(notes()).toHaveLength(0);
  });

  it('deletes a note from its button, for everyone', () => {
    const { theirs, notes, doubleClick } = open();
    doubleClick(300, 200);
    flush(() => {
      must(must(notes()[0]).querySelector<HTMLButtonElement>('[aria-label="Delete note"]')).click();
    });
    expect(notes()).toHaveLength(0);
    expect(theirs.store.getIds()).toHaveLength(0);
  });

  it('only adds a note when the background itself is double-clicked', () => {
    const { notes, doubleClick } = open();
    doubleClick(300, 200);
    flush(() => {
      must(must(notes()[0]).querySelector('textarea')).dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      );
    });
    expect(notes()).toHaveLength(1);
  });

  it('closes the connection when the page goes away', () => {
    const { mySocket } = open();
    cleanup();
    expect(mySocket.closed).toBe(true);
  });
});
