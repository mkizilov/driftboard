// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { IdentityStore } from '../lib/identity';
import { openBoardSession, type BoardSession } from '../lib/session';
import { MemoryDisk } from '../lib/storage';
import { FakeNetwork, FakeTimers } from '../lib/test-network';
import { cleanup, flush, must, render, settle, typeInto } from '../test-render';
import { BoardPage } from './BoardPage';

afterEach(cleanup);

const NAMES = ['', 'Ann', 'Bea', 'Cal'];

function session(net: FakeNetwork, timers: FakeTimers, seed: number, disk = new MemoryDisk()) {
  const randomBytes = (length: number) =>
    Uint8Array.from({ length }, (_, index) => (seed * 53 + index * 7) % 256);
  const identity = new IdentityStore(null, randomBytes);
  identity.rename(NAMES[seed] ?? `Person ${seed}`);
  return openBoardSession({
    boardId: net.boardId,
    url: 'ws://test.invalid/ws',
    storage: disk.open(net.boardId),
    randomBytes,
    identity,
    createSocket: net.createSocket,
    timers,
    elapsed: () => timers.now,
    random: () => 0,
  });
}

/** The board page on one session, and a second user on the same board outside React. */
async function open({ connect = true, disk = new MemoryDisk() } = {}) {
  const net = new FakeNetwork();
  const timers = net.timers;
  const mine = await session(net, timers, 1, disk);
  const theirs = await session(net, timers, 2);
  const createSession = () => Promise.resolve(mine);
  const screen = render(<BoardPage boardId={net.boardId} createSession={createSession} />);
  await settle();
  const mySocket = must(net.sockets[0]);

  theirs.start();
  flush(() => {
    if (connect) net.open(mySocket);
    net.open(must(net.sockets[1]));
  });
  const canvas = () => must(screen.container.querySelector<HTMLElement>('[data-testid="canvas"]'));
  const notes = () => [...screen.container.querySelectorAll<HTMLElement>('[data-note-id]')];
  const doubleClick = (clientX: number, clientY: number) => {
    flush(() => {
      canvas().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX, clientY }));
    });
  };
  const badge = () => must(screen.container.querySelector('.sync')).textContent;
  /** The pointer moves over the canvas. */
  const movePointer = (clientX: number, clientY: number) => {
    flush(() => {
      canvas().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX, clientY }));
    });
  };
  const cursors = () => [...screen.container.querySelectorAll<HTMLElement>('.cursor')];
  return {
    net,
    timers,
    mine,
    theirs,
    screen,
    canvas,
    notes,
    doubleClick,
    mySocket,
    badge,
    movePointer,
    cursors,
  };
}

describe('BoardPage: who is here', () => {
  it('lists this person first, then the others on the board', async () => {
    const { screen } = await open();
    const group = must(screen.container.querySelector('.people'));
    expect(must(group.querySelector<HTMLInputElement>('.my-name')).value).toBe('Ann');
    expect([...group.querySelectorAll('.others .person')].map((item) => item.textContent)).toEqual([
      'Bea',
    ]);
  });

  it('shows the other person’s pointer, labelled with their name', async () => {
    const { theirs, timers, cursors } = await open();
    timers.advance(100);
    flush(() => {
      theirs.presence.moveCursor({ x: 120, y: 80 });
    });
    const [cursor] = cursors();
    expect(must(cursor).querySelector('.cursor-label')?.textContent).toBe('Bea');
    expect(must(cursor).style.transform).toBe('translate(120px, 80px)');
  });

  it('sends where this person’s pointer is, in board units, and the other person sees it', async () => {
    const { theirs, timers, movePointer } = await open();
    timers.advance(100);
    movePointer(300, 200);
    const [ann] = theirs.presence.store.getPeers();
    expect(ann).toMatchObject({ name: 'Ann', cursor: { x: 300, y: 200 } });
  });

  it('says the pointer is gone when it leaves the canvas', async () => {
    const { theirs, timers, movePointer, canvas } = await open();
    timers.advance(100);
    movePointer(300, 200);
    timers.advance(100);
    flush(() => {
      canvas().dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }));
    });
    expect(theirs.presence.store.getPeers()[0]?.cursor).toBeNull();
  });

  it('shows which note someone else is editing, on that note, and no longer when they stop', async () => {
    const { theirs, timers, notes, doubleClick } = await open();
    doubleClick(300, 200);
    const id = must(theirs.store.getIds()[0]);
    timers.advance(100);
    flush(() => {
      theirs.presence.startEditing(id);
    });
    const badge = () => must(notes()[0]).querySelector('.editor')?.textContent;
    expect(badge()).toBe('Bea is editing');
    timers.advance(100);
    flush(() => {
      theirs.presence.stopEditing(id);
    });
    expect(badge()).toBeUndefined();
  });

  it('tells the other person which note this one is editing', async () => {
    const { theirs, timers, notes, doubleClick } = await open();
    doubleClick(300, 200);
    const id = must(theirs.store.getIds()[0]);
    timers.advance(100);
    flush(() => {
      must(must(notes()[0]).querySelector('textarea')).focus();
    });
    expect(theirs.presence.store.getEditors(id).map((editor) => editor.name)).toEqual(['Ann']);
  });

  it('drops the other person from the page when they go quiet for six seconds', async () => {
    const { theirs, timers, screen } = await open();
    theirs.presence.dispose();
    flush(() => {
      timers.advance(6000);
    });
    expect(screen.container.querySelectorAll('.others .person')).toHaveLength(0);
  });

  it('forgets everyone when the connection is lost', async () => {
    const { theirs, mySocket, screen, cursors } = await open();
    flush(() => {
      theirs.presence.moveCursor({ x: 1, y: 1 });
    });
    flush(() => {
      mySocket.drop();
    });
    expect(screen.container.querySelectorAll('.others .person')).toHaveLength(0);
    expect(cursors()).toEqual([]);
  });
});

describe('BoardPage', () => {
  it('shows the connection as online, syncing or offline, with the changes waiting', async () => {
    const { net, mySocket, mine, badge } = await open();
    expect(badge()).toBe('Online');

    flush(() => {
      mySocket.drop();
    });
    expect(badge()).toBe('Offline');

    flush(() => {
      mine.store.createNote(1, 1);
    });
    expect(badge()).toMatch(/^Offline · \d+ pending changes?$/);

    flush(() => {
      mine.connection.retryNow();
    });
    expect(badge()).toMatch(/^Syncing…/);

    flush(() => {
      net.open(must(net.sockets.at(-1)));
    });
    expect(badge()).toBe('Online');
  });

  it('marks the state of the indicator for styling', async () => {
    const { screen, mySocket } = await open();
    const indicator = () =>
      must(screen.container.querySelector('.sync')).getAttribute('data-state');
    expect(indicator()).toBe('online');
    flush(() => {
      mySocket.drop();
    });
    expect(indicator()).toBe('offline');
  });

  it('opens a board from this device with no network, showing the notes and what is waiting', async () => {
    const disk = new MemoryDisk();
    const net = new FakeNetwork();
    const earlier = await session(net, new FakeTimers(), 5, disk);
    const id = must(earlier.store.createNote(30, 40));
    earlier.store.editText(id, { start: 0, deleteCount: 0, insert: 'from before' });
    await earlier.dispose();

    const timers = new FakeTimers();
    const later = await session(net, timers, 6, disk);
    const screen = render(
      <BoardPage boardId={net.boardId} createSession={() => Promise.resolve(later)} />,
    );
    await settle();
    flush(() => {
      must(net.sockets.at(-1)).drop();
    });

    const textarea = must(screen.container.querySelector('textarea'));
    expect(textarea.value).toBe('from before');
    const badge = must(screen.container.querySelector('.sync')).textContent;
    expect(badge).toMatch(/^Offline · \d+ pending changes$/);
  });

  it('says so when the board cannot be opened', async () => {
    const screen = render(
      <BoardPage
        boardId="x"
        createSession={() => Promise.reject(new Error('the saved data is damaged'))}
      />,
    );
    await settle();
    expect(must(screen.container.querySelector('[role="alert"]')).textContent).toContain(
      'the saved data is damaged',
    );
  });

  it('warns when changes are not being kept on this device', async () => {
    const net = new FakeNetwork();
    const timers = new FakeTimers();
    const volatile = await session(net, timers, 1, new MemoryDisk({ durable: false }));
    const screen = render(
      <BoardPage boardId={net.boardId} createSession={() => Promise.resolve(volatile)} />,
    );
    await settle();
    expect(must(screen.container.querySelector('.save-warning')).textContent).toBe(
      'Not saved on this device',
    );
  });

  it('warns when a write to this device fails, and stops warning when it works again', async () => {
    const disk = new MemoryDisk();
    const { mine, screen } = await open({ disk });
    expect(screen.container.querySelector('.save-warning')).toBeNull();

    disk.failNextWrites(1);
    flush(() => {
      mine.store.createNote(1, 1);
    });
    await settle();
    expect(screen.container.querySelector('.save-warning')).not.toBeNull();

    flush(() => {
      mine.store.createNote(2, 2);
    });
    await settle();
    expect(screen.container.querySelector('.save-warning')).toBeNull();
  });

  it('adds a note under the pointer on a double-click, and the other user sees it', async () => {
    const { theirs, notes, doubleClick } = await open();
    expect(notes()).toHaveLength(0);
    doubleClick(300, 200);
    expect(notes()).toHaveLength(1);
    // Centred on the pointer: a note is 220 by 180.
    expect(must(notes()[0]).style.transform).toBe('translate(190px, 110px)');
    const id = must(theirs.store.getIds()[0]);
    expect(theirs.store.getNote(id)).toMatchObject({ x: 190, y: 110 });
  });

  it('sends what is typed into a note to the other user', async () => {
    const { theirs, notes, doubleClick } = await open();
    doubleClick(300, 200);
    const textarea = must(must(notes()[0]).querySelector('textarea'));
    typeInto(textarea, 'hello');
    const id = must(theirs.store.getIds()[0]);
    expect(theirs.store.getNote(id)?.text).toBe('hello');
  });

  it('shows another user’s typing without moving the caret', async () => {
    const { theirs, notes, doubleClick } = await open();
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

  it('removes a note that the other user deletes', async () => {
    const { theirs, notes, doubleClick } = await open();
    doubleClick(300, 200);
    const id = must(theirs.store.getIds()[0]);
    flush(() => {
      theirs.store.deleteNote(id);
    });
    expect(notes()).toHaveLength(0);
  });

  it('deletes a note from its button, for everyone', async () => {
    const { theirs, notes, doubleClick } = await open();
    doubleClick(300, 200);
    flush(() => {
      must(must(notes()[0]).querySelector<HTMLButtonElement>('[aria-label="Delete note"]')).click();
    });
    expect(notes()).toHaveLength(0);
    expect(theirs.store.getIds()).toHaveLength(0);
  });

  it('only adds a note when the background itself is double-clicked', async () => {
    const { notes, doubleClick } = await open();
    doubleClick(300, 200);
    flush(() => {
      must(must(notes()[0]).querySelector('textarea')).dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      );
    });
    expect(notes()).toHaveLength(1);
  });

  it('closes the connection when the page goes away', async () => {
    const { mySocket } = await open();
    cleanup();
    expect(mySocket.closed).toBe(true);
  });

  it('closes a board that finished opening after the page had gone', async () => {
    const net = new FakeNetwork();
    const opened = await session(net, new FakeTimers(), 1);
    let disposed = 0;
    const late: BoardSession = {
      ...opened,
      dispose: () => {
        disposed += 1;
        return opened.dispose();
      },
    };
    let finish: (value: BoardSession) => void = () => {};
    const slow = new Promise<BoardSession>((resolve) => {
      finish = resolve;
    });
    render(<BoardPage boardId={net.boardId} createSession={() => slow} />);
    cleanup();
    finish(late);
    await settle();
    expect(disposed).toBe(1);
    expect(net.sockets).toHaveLength(0);
  });
});
