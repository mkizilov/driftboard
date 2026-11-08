import type { BoardOp } from '@driftboard/crdt';
import { describe, expect, it } from 'vitest';
import { BoardStore } from './board-store';
import { replica } from './test-support';

function setup() {
  const board = replica(1);
  const sent: BoardOp[][] = [];
  const store = new BoardStore(board, (ops) => {
    sent.push(ops);
  });
  return { board, store, sent };
}

/** A listener that counts its calls. */
function counter() {
  const counted = {
    calls: 0,
    listener: () => {
      counted.calls += 1;
    },
  };
  return counted;
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

describe('BoardStore: reading', () => {
  it('starts with the notes the board already has, ordered by id', () => {
    const board = replica(1);
    const ids = [board.createNote({}).id, board.createNote({}).id, board.createNote({}).id];
    const store = new BoardStore(board, () => undefined);
    expect([...store.getIds()]).toEqual([...ids].sort());
    for (const id of ids) expect(store.getNote(id)?.id).toBe(id);
  });

  it('returns undefined for a note that does not exist', () => {
    expect(setup().store.getNote('nope')).toBeUndefined();
  });

  it('hands out the same snapshots until something really changes', () => {
    const { store } = setup();
    const id = must(store.createNote(10, 20));
    const ids = store.getIds();
    const view = store.getNote(id);
    expect(store.getIds()).toBe(ids);
    expect(store.getNote(id)).toBe(view);

    store.moveNote(id, 30, 40);
    expect(store.getIds()).toBe(ids);
    expect(store.getNote(id)).not.toBe(view);
    expect(store.getNote(id)).toMatchObject({ x: 30, y: 40 });
  });

  it('puts a new id list in place when a note appears or goes away', () => {
    const { store } = setup();
    const empty = store.getIds();
    const id = must(store.createNote(0, 0));
    const one = store.getIds();
    expect(one).not.toBe(empty);
    expect([...one]).toEqual([id]);
    store.deleteNote(id);
    expect([...store.getIds()]).toEqual([]);
  });
});

describe('BoardStore: local changes', () => {
  it('creates a note, passes its operations on once and tells the list', () => {
    const { store, sent } = setup();
    const list = counter();
    store.subscribeList(list.listener);
    const id = must(store.createNote(10, 20));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.length).toBeGreaterThan(0);
    expect(store.getNote(id)).toMatchObject({ x: 10, y: 20, text: '' });
    expect(list.calls).toBe(1);
  });

  it('wakes only the note that changed', () => {
    const { store } = setup();
    const a = must(store.createNote(0, 0));
    const b = must(store.createNote(0, 0));
    const forA = counter();
    const forB = counter();
    const list = counter();
    store.subscribeNote(a, forA.listener);
    store.subscribeNote(b, forB.listener);
    store.subscribeList(list.listener);

    store.moveNote(a, 5, 6);
    expect([forA.calls, forB.calls, list.calls]).toEqual([1, 0, 0]);

    store.editText(b, { start: 0, deleteCount: 0, insert: 'hi' });
    expect([forA.calls, forB.calls, list.calls]).toEqual([1, 1, 0]);

    store.setColor(a, 'pink');
    expect([forA.calls, forB.calls, list.calls]).toEqual([2, 1, 0]);
  });

  it('applies text edits counted in code points', () => {
    const { store } = setup();
    const id = must(store.createNote(0, 0));
    store.editText(id, { start: 0, deleteCount: 0, insert: 'a😀' });
    store.editText(id, { start: 2, deleteCount: 0, insert: 'b' });
    expect(store.getNote(id)?.text).toBe('a😀b');
    store.editText(id, { start: 1, deleteCount: 1, insert: '' });
    expect(store.getNote(id)?.text).toBe('ab');
  });

  it('sends nothing for a change that changes nothing', () => {
    const { store, sent } = setup();
    const id = must(store.createNote(1, 2));
    store.setColor(id, 'pink');
    const before = sent.length;
    store.moveNote(id, 1, 2);
    store.setColor(id, 'pink');
    store.bringToFront(id);
    store.editText(id, { start: 0, deleteCount: 0, insert: '' });
    expect(sent).toHaveLength(before);
  });

  it('raises a note without reordering the list', () => {
    const { store, sent } = setup();
    const a = must(store.createNote(0, 0));
    const b = must(store.createNote(0, 0));
    expect(store.isTop(b)).toBe(true);
    expect(store.isTop(a)).toBe(false);

    const ids = store.getIds();
    const forA = counter();
    const forB = counter();
    store.subscribeNote(a, forA.listener);
    store.subscribeNote(b, forB.listener);
    const before = sent.length;
    store.bringToFront(a);

    expect(sent).toHaveLength(before + 1);
    expect(store.isTop(a)).toBe(true);
    expect(store.isTop(b)).toBe(false);
    expect(store.getIds()).toBe(ids);
    expect([forA.calls, forB.calls]).toEqual([1, 0]);
  });

  it('stops calling a listener once it has unsubscribed', () => {
    const { store } = setup();
    const id = must(store.createNote(0, 0));
    const note = counter();
    const list = counter();
    const stopNote = store.subscribeNote(id, note.listener);
    const stopList = store.subscribeList(list.listener);
    stopNote();
    stopList();
    store.moveNote(id, 9, 9);
    store.createNote(0, 0);
    expect([note.calls, list.calls]).toEqual([0, 0]);
  });

  it('calls every listener even if one unsubscribes while being called', () => {
    const { store } = setup();
    const id = must(store.createNote(0, 0));
    const second = counter();
    const stopFirst = store.subscribeNote(id, () => {
      stopFirst();
    });
    store.subscribeNote(id, second.listener);
    store.moveNote(id, 9, 9);
    expect(second.calls).toBe(1);
  });

  it('shows the new state to a listener that is called', () => {
    const { store } = setup();
    const id = must(store.createNote(0, 0));
    const seen: (number | undefined)[] = [];
    store.subscribeNote(id, () => {
      seen.push(store.getNote(id)?.x);
    });
    store.moveNote(id, 77, 0);
    expect(seen).toEqual([77]);
  });
});

describe('BoardStore: changes from other replicas', () => {
  /** A store on one replica and a second replica that has seen the same note. */
  function shared() {
    const { board, store, sent } = setup();
    const id = must(store.createNote(0, 0));
    const other = replica(2);
    other.applyRemote(must(sent[0]));
    return { board, store, sent, other, id };
  }

  it('wakes the note that was edited, and only it', () => {
    const { store, other, board, id } = shared();
    const second = must(store.createNote(0, 0));
    const forId = counter();
    const forSecond = counter();
    const list = counter();
    store.subscribeNote(id, forId.listener);
    store.subscribeNote(second, forSecond.listener);
    store.subscribeList(list.listener);

    board.applyRemote(other.editText(id, 0, 0, 'hello'));

    expect(store.getNote(id)?.text).toBe('hello');
    expect([forId.calls, forSecond.calls, list.calls]).toEqual([1, 0, 0]);
  });

  it('removes a note that another replica deleted', () => {
    const { store, other, board, id } = shared();
    const forId = counter();
    const list = counter();
    store.subscribeNote(id, forId.listener);
    store.subscribeList(list.listener);
    const ids = store.getIds();

    board.applyRemote(other.deleteNote(id));

    expect(store.getNote(id)).toBeUndefined();
    expect(store.getIds()).not.toBe(ids);
    expect([...store.getIds()]).toEqual([]);
    expect([forId.calls, list.calls]).toEqual([1, 1]);
  });

  it('adds a note that another replica created', () => {
    const { store, other, board } = shared();
    const list = counter();
    store.subscribeList(list.listener);
    const created = other.createNote({ x: 3, y: 4 });
    board.applyRemote(created.ops);
    expect(store.getNote(created.id)).toMatchObject({ x: 3, y: 4 });
    expect(store.getIds()).toContain(created.id);
    expect(list.calls).toBe(1);
  });

  it('wakes nobody when operations arrive that it already has', () => {
    const { store, other, board, id } = shared();
    const ops = other.editText(id, 0, 0, 'hello');
    board.applyRemote(ops);
    const forId = counter();
    const list = counter();
    store.subscribeNote(id, forId.listener);
    store.subscribeList(list.listener);
    board.applyRemote(ops);
    expect([forId.calls, list.calls]).toEqual([0, 0]);
  });

  it('lets a click settle notes that tie for the top after being created at the same time', () => {
    const { board, store } = setup();
    const other = replica(2);
    const mine = must(store.createNote(0, 0));
    const theirs = other.createNote({});
    board.applyRemote(theirs.ops);
    expect(store.getNote(mine)?.z).toBe(store.getNote(theirs.id)?.z);
    expect(store.isTop(mine)).toBe(false);
    expect(store.isTop(theirs.id)).toBe(false);
    store.bringToFront(mine);
    expect(store.isTop(mine)).toBe(true);
    expect(store.isTop(theirs.id)).toBe(false);
  });

  it('quietly ignores local changes to a note someone else deleted', () => {
    const { store, sent, other, board, id } = shared();
    board.applyRemote(other.deleteNote(id));
    const before = sent.length;
    store.editText(id, { start: 0, deleteCount: 0, insert: 'late' });
    store.moveNote(id, 1, 1);
    store.setColor(id, 'blue');
    store.bringToFront(id);
    store.deleteNote(id);
    expect(sent).toHaveLength(before);
  });
});
