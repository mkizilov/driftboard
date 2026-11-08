import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Board } from './board';
import { NOTE_COLORS, UnknownNoteError, type BoardOp, type NoteColor } from './board-ops';
import { createManualClock, type ManualClock } from './clock';
import { BoardHistory, DEFAULT_GROUP_MS, DEFAULT_HISTORY_LIMIT } from './history';
import { opIdKey } from './op-id';
import { replicaId } from './replica-id';
import { must } from './test-support';

/** One person: a board, its history and a clock of their own, in milliseconds. */
class Person {
  readonly board: Board;
  readonly history: BoardHistory;
  readonly time: ManualClock = createManualClock(0);
  readonly name: string;

  constructor(name: string, options: { limit?: number } = {}) {
    this.name = name;
    this.board = new Board({ replicaId: replicaId(name), clock: createManualClock(1000) });
    this.history = new BoardHistory(this.board, { now: () => this.time.now(), ...options });
  }

  text(id: string): string | undefined {
    return this.board.getNote(id)?.text;
  }

  /** Types `text` one character at a time, 20 ms apart, as a person does. */
  type(id: string, index: number, text: string): BoardOp[] {
    const ops: BoardOp[] = [];
    [...text].forEach((char, offset) => {
      ops.push(...this.history.editText(id, index + offset, 0, char));
      this.time.advance(20);
    });
    return ops;
  }

  /** Time passes with no typing, so that what comes next is a step of its own. */
  pause(ms = 2 * DEFAULT_GROUP_MS): void {
    this.time.advance(ms);
  }
}

const state = (person: Person) => JSON.stringify(person.board.snapshot());
const views = (person: Person) => JSON.stringify(person.board.notes());

function expectConverged(first: Person, ...others: Person[]): void {
  for (const other of others) expect(state(other)).toBe(state(first));
}

/** `ops` from `from` reach `to`. */
function tell(to: Person, ops: readonly BoardOp[]): void {
  to.board.applyRemote(ops);
}

/** A and B share a note with the text "hello world", and a pause has closed any typing group. */
function shared(): { a: Person; b: Person; id: string } {
  const [a, b] = [new Person('a'), new Person('b')];
  const created = a.history.createNote({ x: 10, y: 20, color: 'blue' });
  const typed = a.type(created.id, 0, 'hello world');
  tell(b, [...created.ops, ...typed]);
  a.pause();
  b.pause();
  expect(b.text(created.id)).toBe('hello world');
  return { a, b, id: created.id };
}

describe('undoing typing', () => {
  it('takes back rapid typing in one step, and puts it back in one step', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.pause();
    a.type(id, 0, 'hello');
    expect(a.text(id)).toBe('hello');
    const undone = a.history.undo();
    expect(a.text(id)).toBe('');
    const redone = a.history.redo();
    expect(a.text(id)).toBe('hello');
    // One run of characters is taken out or put back as one edit of the note.
    for (const ops of [undone, redone]) {
      expect(ops.filter((op) => op.type === 'notes')).toHaveLength(1);
      expect(ops.filter((op) => op.type === 'text')).toHaveLength(5);
    }
  });

  it('is one step as far as the history goes, and typing erased again is none', () => {
    const [a, b] = [new Person('a'), new Person('b')];
    const created = b.history.createNote();
    tell(a, created.ops);
    a.type(created.id, 0, 'abc');
    a.history.undo();
    expect(a.text(created.id)).toBe('');
    expect(a.history.getState().canUndo).toBe(false);

    a.pause();
    a.history.editText(created.id, 0, 0, 'x');
    a.history.editText(created.id, 0, 1, '');
    expect(a.history.getState()).toEqual({ canUndo: false, canRedo: false });
  });

  it('keeps typing after a pause as a step of its own', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.pause();
    a.type(id, 0, 'hello');
    a.pause();
    a.type(id, 5, ' world');
    a.history.undo();
    expect(a.text(id)).toBe('hello');
    a.history.undo();
    expect(a.text(id)).toBe('');
  });

  it('breaks the step exactly when the gap is longer than the grouping time', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.pause();
    a.history.editText(id, 0, 0, 'a');
    a.time.advance(DEFAULT_GROUP_MS);
    a.history.editText(id, 1, 0, 'b');
    a.time.advance(DEFAULT_GROUP_MS + 1);
    a.history.editText(id, 2, 0, 'c');
    a.history.undo();
    expect(a.text(id)).toBe('ab');
    a.history.undo();
    expect(a.text(id)).toBe('');
  });

  it('measures the gap from the last edit, so typing can go on for as long as it likes', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.pause();
    a.type(id, 0, 'x'.repeat(200));
    expect(a.time.now()).toBeGreaterThan(3 * DEFAULT_GROUP_MS);
    a.history.undo();
    expect(a.text(id)).toBe('');
  });

  it('starts a new step when the caret has moved elsewhere, even straight away', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.pause();
    a.type(id, 0, 'abc');
    a.history.editText(id, 0, 0, 'X');
    expect(a.text(id)).toBe('Xabc');
    a.history.undo();
    expect(a.text(id)).toBe('abc');
    a.history.undo();
    expect(a.text(id)).toBe('');
  });

  it('starts a new step in another note, and when going back to the first', () => {
    const a = new Person('a');
    const one = a.history.createNote().id;
    const two = a.history.createNote().id;
    a.pause();
    a.type(one, 0, 'ab');
    a.type(two, 0, 'cd');
    a.type(one, 2, 'ef');
    a.history.undo();
    expect([a.text(one), a.text(two)]).toEqual(['ab', 'cd']);
    a.history.undo();
    expect([a.text(one), a.text(two)]).toEqual(['ab', '']);
    a.history.undo();
    expect([a.text(one), a.text(two)]).toEqual(['', '']);
  });

  it('groups backspacing with the typing before it', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.pause();
    a.type(id, 0, 'abcd');
    a.history.editText(id, 3, 1, '');
    a.history.editText(id, 2, 1, '');
    expect(a.text(id)).toBe('ab');
    a.history.undo();
    expect(a.text(id)).toBe('');
  });

  it('groups repeated forward deletion into one step', () => {
    const { a, id } = shared();
    a.history.editText(id, 5, 1, '');
    a.history.editText(id, 5, 1, '');
    a.history.editText(id, 5, 1, '');
    expect(a.text(id)).toBe('hellorld');
    a.history.undo();
    expect(a.text(id)).toBe('hello world');
  });

  it('groups repeated backspacing into one step', () => {
    const { a, id } = shared();
    a.history.editText(id, 10, 1, '');
    a.history.editText(id, 9, 1, '');
    a.history.editText(id, 8, 1, '');
    expect(a.text(id)).toBe('hello wo');
    a.history.undo();
    expect(a.text(id)).toBe('hello world');
  });

  it('leaves nothing to undo for typing that was erased again straight away', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.pause();
    a.history.editText(id, 0, 0, 'a');
    a.history.editText(id, 0, 1, '');
    expect(a.text(id)).toBe('');
    // Only the note's creation is left.
    a.history.undo();
    expect(a.board.getNote(id)).toBeUndefined();
    expect(a.history.getState().canUndo).toBe(false);
  });

  it('closes the typing after an undo or a redo, so the next typing is a step of its own', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.pause();
    a.type(id, 0, 'abc');
    a.type(id, 3, 'de');
    a.history.undo();
    expect(a.text(id)).toBe('');
    a.history.redo();
    a.history.editText(id, 5, 0, 'f');
    a.history.undo();
    expect(a.text(id)).toBe('abcde');
  });

  it('counts code points, not UTF-16 units', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.pause();
    a.type(id, 0, 'a😀b');
    a.history.editText(id, 1, 1, '');
    expect(a.text(id)).toBe('ab');
    a.history.undo();
    expect(a.text(id)).toBe('a😀b');
    a.history.undo();
    expect(a.text(id)).toBe('');
    a.history.redo();
    a.history.redo();
    expect(a.text(id)).toBe('ab');
  });
});

describe('undoing a deletion of text', () => {
  it('types the deleted characters again where they were, and redo deletes them again', () => {
    const { a, id } = shared();
    a.history.editText(id, 5, 6, '');
    expect(a.text(id)).toBe('hello');
    a.history.undo();
    expect(a.text(id)).toBe('hello world');
    a.history.redo();
    expect(a.text(id)).toBe('hello');
    a.history.undo();
    expect(a.text(id)).toBe('hello world');
  });

  it('follows text that was typed again several times back to the original', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.pause();
    a.type(id, 0, 'xyz');
    a.pause();
    a.history.editText(id, 1, 1, '');
    a.history.undo();
    a.history.redo();
    a.history.undo();
    expect(a.text(id)).toBe('xyz');
    // The y is now a copy of a copy of the one that was typed.
    a.history.undo();
    expect(a.text(id)).toBe('');
    a.history.redo();
    expect(a.text(id)).toBe('xyz');
  });

  it('puts back the text a replacement removed, and takes out what it put in', () => {
    const { a, id } = shared();
    a.history.editText(id, 6, 5, 'there');
    expect(a.text(id)).toBe('hello there');
    a.history.undo();
    expect(a.text(id)).toBe('hello world');
    a.history.redo();
    expect(a.text(id)).toBe('hello there');
  });

  it('restores text deleted from the start and from the end', () => {
    const { a, id } = shared();
    a.history.editText(id, 0, 6, '');
    a.pause();
    a.history.editText(id, 0, 5, '');
    expect(a.text(id)).toBe('');
    a.history.undo();
    expect(a.text(id)).toBe('world');
    a.history.undo();
    expect(a.text(id)).toBe('hello world');
  });

  it('is replayed to others as ordinary operations', () => {
    const { a, b, id } = shared();
    tell(b, a.history.editText(id, 5, 6, ''));
    tell(b, a.history.undo());
    expect(b.text(id)).toBe('hello world');
    expectConverged(a, b);
  });
});

describe('undo after concurrent remote edits to the same note', () => {
  it('takes out only what this person typed, wherever it has ended up', () => {
    const { a, b, id } = shared();
    const mine = a.type(id, 11, '!');
    const theirs = b.type(id, 0, '>> ');
    tell(b, mine);
    tell(a, theirs);
    expect(a.text(id)).toBe('>> hello world!');

    tell(b, a.history.undo());
    expect(a.text(id)).toBe('>> hello world');
    expectConverged(a, b);
  });

  it('finds its characters by id after the indices have all moved', () => {
    const { a, b, id } = shared();
    const mine = a.type(id, 5, 'XYZ');
    const theirs = [...b.type(id, 0, '1234'), ...b.type(id, 4, '5678')];
    tell(b, mine);
    tell(a, theirs);
    expect(a.text(id)).toBe('12345678helloXYZ world');

    tell(b, a.history.undo());
    expect(a.text(id)).toBe('12345678hello world');
    expectConverged(a, b);
  });

  it('leaves characters another person typed inside its own typing', () => {
    const { a, b, id } = shared();
    const mine = a.type(id, 11, 'abc');
    tell(b, mine);
    tell(a, b.type(id, 12, 'X'));
    expect(a.text(id)).toBe('hello worldaXbc');

    tell(b, a.history.undo());
    expect(a.text(id)).toBe('hello worldX');
    expectConverged(a, b);
  });

  it('does not bring back what another person deleted from its typing, even on redo', () => {
    const { a, b, id } = shared();
    const mine = a.type(id, 11, 'abcdef');
    tell(b, mine);
    tell(a, b.history.editText(id, 13, 2, ''));
    expect(a.text(id)).toBe('hello worldabef');

    tell(b, a.history.undo());
    expect(a.text(id)).toBe('hello world');
    tell(b, a.history.redo());
    expect(a.text(id)).toBe('hello worldabef');
    expectConverged(a, b);
  });

  it('puts back deleted text before what another person added after it', () => {
    const { a, b, id } = shared();
    const deleted = a.history.editText(id, 6, 5, '');
    const appended = b.type(id, 11, '!');
    tell(b, deleted);
    tell(a, appended);
    expect(a.text(id)).toBe('hello !');

    tell(b, a.history.undo());
    expect(a.text(id)).toBe('hello world!');
    expectConverged(a, b);
  });

  it('puts back deleted text as one block, keeping what another person typed in the middle of it', () => {
    const { a, b, id } = shared();
    const deleted = a.history.editText(id, 6, 5, '');
    const inserted = b.type(id, 8, 'X');
    tell(b, deleted);
    tell(a, inserted);
    expect(a.text(id)).toBe('hello X');

    tell(b, a.history.undo());
    expect(a.text(id)).toBe('hello worldX');
    expectConverged(a, b);
  });

  it('does not touch text another person deleted before the deletion that is undone', () => {
    const { a, b, id } = shared();
    tell(a, b.history.editText(id, 0, 6, ''));
    expect(a.text(id)).toBe('world');
    a.pause();
    a.history.editText(id, 0, 5, '');
    a.history.undo();
    expect(a.text(id)).toBe('world');
  });

  it('skips a typing step whose characters another person has deleted, and undoes the step before', () => {
    const [a, b] = [new Person('a'), new Person('b')];
    const created = b.history.createNote({ x: 0, y: 0 });
    tell(a, created.ops);
    const moved = a.history.moveNote(created.id, 5, 5);
    a.pause();
    const typed = a.type(created.id, 0, 'abc');
    tell(b, [...moved, ...typed]);
    tell(a, b.history.editText(created.id, 0, 3, ''));
    expect(a.text(created.id)).toBe('');

    expect(a.history.undo().length).toBeGreaterThan(0);
    expect(a.board.getNote(created.id)).toMatchObject({ x: 0, y: 0 });
  });

  it('undoes an earlier step after later remote edits to the note', () => {
    const { a, b, id } = shared();
    const one = a.type(id, 11, ' one');
    a.pause();
    const two = a.type(id, 15, ' two');
    tell(b, [...one, ...two]);
    tell(a, b.type(id, 0, 'B:'));
    expect(a.text(id)).toBe('B:hello world one two');
    a.history.undo();
    expect(a.text(id)).toBe('B:hello world one');
    a.history.undo();
    expect(a.text(id)).toBe('B:hello world');
  });

  it('never deletes a character another person wrote, through any number of undos and redos', () => {
    const { a, b, id } = shared();
    const mine = [...a.type(id, 0, 'AB'), ...a.type(id, 13, 'CD')];
    const theirs = b.type(id, 5, '--');
    tell(b, mine);
    tell(a, theirs);
    const sent: BoardOp[] = [];
    for (let round = 0; round < 3; round += 1) {
      sent.push(...a.history.undo(), ...a.history.undo(), ...a.history.redo(), ...a.history.redo());
    }
    for (const op of sent) {
      if (op.type === 'text' && op.op.type === 'delete') {
        expect(op.op.target.replicaId).toBe('a');
      }
    }
    tell(b, sent);
    expectConverged(a, b);
  });
});

describe('undoing a note deletion', () => {
  function decorated() {
    const [a, b] = [new Person('a'), new Person('b')];
    const created = a.history.createNote({ x: 10, y: 20, color: 'green' });
    const id = created.id;
    const ops = [...created.ops, ...a.type(id, 0, 'keep me')];
    a.pause();
    ops.push(...a.history.moveNote(id, 30, 40), ...a.history.setColor(id, 'purple'));
    tell(b, ops);
    a.pause();
    return { a, b, id };
  }

  it('puts the note back with its position, colour, stacking and text', () => {
    const { a, id } = decorated();
    const before = JSON.stringify(a.board.getNote(id));
    a.history.deleteNote(id);
    expect(a.board.getNote(id)).toBeUndefined();
    expect(a.history.undo().length).toBeGreaterThan(0);
    expect(JSON.stringify(a.board.getNote(id))).toBe(before);
    expect(a.board.getNote(id)).toMatchObject({ x: 30, y: 40, color: 'purple', text: 'keep me' });
  });

  it('puts the note back for everyone else, and deletes it again on redo', () => {
    const { a, b, id } = decorated();
    tell(b, a.history.deleteNote(id));
    expect(b.board.getNote(id)).toBeUndefined();
    tell(b, a.history.undo());
    expect(b.board.getNote(id)).toMatchObject({ x: 30, y: 40, color: 'purple', text: 'keep me' });
    expectConverged(a, b);
    tell(b, a.history.redo());
    expect(b.board.getNote(id)).toBeUndefined();
    expectConverged(a, b);
  });

  it('can be undone after another person has done things to other notes and to this one before it', () => {
    const { a, b, id } = decorated();
    const other = b.history.createNote({ x: 1, y: 1 });
    tell(a, [...other.ops, ...b.type(other.id, 0, 'theirs')]);
    tell(b, a.history.deleteNote(id));
    tell(b, a.history.undo());
    expect(
      a.board
        .notes()
        .map((note) => note.text)
        .sort(),
    ).toEqual(['keep me', 'theirs']);
    expectConverged(a, b);
  });

  it('keeps the note the other person edited meanwhile, which makes the undo a no-op', () => {
    const { a, b, id } = decorated();
    const deleted = a.history.deleteNote(id);
    const edited = b.type(id, 7, '!');
    tell(b, deleted);
    tell(a, edited);
    // Add wins: the edit kept the note.
    expect(a.text(id)).toBe('keep me!');
    // Undo skips the deletion, which changes nothing now, and goes on to the colour before it.
    tell(b, a.history.undo());
    expect(a.board.getNote(id)).toMatchObject({ color: 'green', text: 'keep me!' });
    expectConverged(a, b);
  });

  it('does not bring back a note that another person deleted', () => {
    const { a, b, id } = decorated();
    tell(a, b.history.deleteNote(id));
    expect(a.board.getNote(id)).toBeUndefined();
    // Their deletion stands: every step of mine on that note is skipped.
    expect(a.history.undo()).toEqual([]);
    expect(a.board.getNote(id)).toBeUndefined();
  });

  it('restores several deleted notes, the one deleted last first, and redo deletes them in order', () => {
    const a = new Person('a');
    const first = a.history.createNote({ x: 1 }).id;
    const second = a.history.createNote({ x: 2 }).id;
    a.history.deleteNote(first);
    a.history.deleteNote(second);
    a.history.undo();
    expect(a.board.notes().map((note) => note.id)).toEqual([second]);
    a.history.undo();
    expect(
      a.board
        .notes()
        .map((note) => note.id)
        .sort(),
    ).toEqual([first, second].sort());
    expect(a.history.redo().length).toBeGreaterThan(0);
    expect(a.board.notes().map((note) => note.id)).toEqual([second]);
  });

  it('restores a note whose text changed before it was deleted, text and all', () => {
    const { a, id } = decorated();
    a.history.editText(id, 0, 7, 'rewritten');
    a.pause();
    a.history.deleteNote(id);
    a.history.undo();
    expect(a.text(id)).toBe('rewritten');
    a.history.undo();
    expect(a.text(id)).toBe('keep me');
  });
});

describe('undoing the creation of a note', () => {
  it('deletes the note, and redo makes it again with its text', () => {
    const a = new Person('a');
    const { id } = a.history.createNote({ x: 5, y: 6, color: 'pink' });
    a.pause();
    a.type(id, 0, 'draft');
    a.pause();
    a.history.undo();
    expect(a.text(id)).toBe('');
    a.history.undo();
    expect(a.board.getNote(id)).toBeUndefined();
    a.history.redo();
    expect(a.board.getNote(id)).toMatchObject({ x: 5, y: 6, color: 'pink', text: '' });
    a.history.redo();
    expect(a.text(id)).toBe('draft');
  });

  it('is sent to others, who see the note go and come back', () => {
    const [a, b] = [new Person('a'), new Person('b')];
    const created = a.history.createNote({ x: 1 });
    tell(b, created.ops);
    a.pause();
    tell(b, a.history.undo());
    expect(b.board.size).toBe(0);
    tell(b, a.history.redo());
    expect(b.board.size).toBe(1);
    expectConverged(a, b);
  });

  it('does nothing if the note is already gone', () => {
    const [a, b] = [new Person('a'), new Person('b')];
    const created = a.history.createNote();
    tell(b, created.ops);
    tell(a, b.history.deleteNote(created.id));
    expect(a.history.undo()).toEqual([]);
  });

  it('skips a creation whose note another person deleted, and undoes the one before it', () => {
    const [a, b] = [new Person('a'), new Person('b')];
    const first = a.history.createNote({ x: 1 });
    const second = a.history.createNote({ x: 2 });
    tell(b, [...first.ops, ...second.ops]);
    tell(a, b.history.deleteNote(second.id));
    expect(a.history.undo().length).toBeGreaterThan(0);
    expect(a.board.getNote(first.id)).toBeUndefined();
  });
});

describe('undoing position and colour', () => {
  it('restores the earlier value, and redo the later one', () => {
    const a = new Person('a');
    const { id } = a.history.createNote({ x: 1, y: 2 });
    a.history.moveNote(id, 10, 20);
    a.history.setColor(id, 'orange');
    a.history.undo();
    expect(a.board.getNote(id)).toMatchObject({ x: 10, y: 20, color: 'yellow' });
    a.history.undo();
    expect(a.board.getNote(id)).toMatchObject({ x: 1, y: 2 });
    a.history.redo();
    a.history.redo();
    expect(a.board.getNote(id)).toMatchObject({ x: 10, y: 20, color: 'orange' });
  });

  it('walks back through several moves one at a time', () => {
    const a = new Person('a');
    const { id } = a.history.createNote({ x: 0, y: 0 });
    for (const x of [10, 20, 30]) a.history.moveNote(id, x, x);
    const seen: number[] = [];
    for (let step = 0; step < 3; step += 1) {
      a.history.undo();
      seen.push(must(a.board.getNote(id)).x);
    }
    expect(seen).toEqual([20, 10, 0]);
    for (let step = 0; step < 3; step += 1) a.history.redo();
    expect(must(a.board.getNote(id)).x).toBe(30);
  });

  it('is sent to others', () => {
    const [a, b] = [new Person('a'), new Person('b')];
    const created = a.history.createNote({ x: 1 });
    tell(b, created.ops);
    tell(b, a.history.moveNote(created.id, 50, 60));
    tell(b, a.history.undo());
    expect(b.board.getNote(created.id)).toMatchObject({ x: 1, y: 0 });
    expectConverged(a, b);
  });

  it('leaves a move that another person has moved on from, which is theirs', () => {
    const [a, b] = [new Person('a'), new Person('b')];
    const created = b.history.createNote({ x: 1, y: 1 });
    tell(a, created.ops);
    tell(b, a.history.moveNote(created.id, 10, 10));
    tell(a, b.history.moveNote(created.id, 99, 99));
    expect(a.history.undo()).toEqual([]);
    expect(b.board.getNote(created.id)).toMatchObject({ x: 99, y: 99 });
    expect(a.board.getNote(created.id)).toMatchObject({ x: 99, y: 99 });
  });

  it('leaves a move whose x the other person kept but whose y they changed', () => {
    const [a, b] = [new Person('a'), new Person('b')];
    const created = b.history.createNote({ x: 1, y: 1 });
    tell(a, created.ops);
    tell(b, a.history.moveNote(created.id, 10, 10));
    tell(a, b.history.moveNote(created.id, 10, 99));
    expect(a.history.undo()).toEqual([]);
    expect(a.board.getNote(created.id)).toMatchObject({ x: 10, y: 99 });
  });

  it('leaves a colour that another person has changed since', () => {
    const [a, b] = [new Person('a'), new Person('b')];
    const created = b.history.createNote();
    tell(a, created.ops);
    tell(b, a.history.setColor(created.id, 'pink'));
    tell(a, b.history.setColor(created.id, 'blue'));
    expect(a.history.undo()).toEqual([]);
    expect(a.board.getNote(created.id)?.color).toBe('blue');
  });

  it('undoes the move of a note whose colour another person changed, since they are separate', () => {
    const [a, b] = [new Person('a'), new Person('b')];
    const created = b.history.createNote({ x: 1, y: 1 });
    tell(a, created.ops);
    tell(b, a.history.moveNote(created.id, 10, 10));
    tell(a, b.history.setColor(created.id, 'blue'));
    tell(b, a.history.undo());
    expect(a.board.getNote(created.id)).toMatchObject({ x: 1, y: 1, color: 'blue' });
    expectConverged(a, b);
  });

  it('does not record a move that changes nothing, and does not record raising a note', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.history.moveNote(id, 0, 0);
    a.history.setColor(id, 'yellow');
    a.history.bringToFront(id);
    // The creation is the only step.
    a.history.undo();
    expect(a.board.getNote(id)).toBeUndefined();
    expect(a.history.getState().canUndo).toBe(false);
  });
});

describe('skipping steps that would change nothing', () => {
  it('goes on to the step before when a step has been superseded', () => {
    const [a, b] = [new Person('a'), new Person('b')];
    const created = a.history.createNote({ x: 0, y: 0 });
    a.pause();
    const typed = a.type(created.id, 0, 'abc');
    a.pause();
    const moved = a.history.moveNote(created.id, 5, 5);
    tell(b, [...created.ops, ...typed, ...moved]);
    tell(a, b.history.moveNote(created.id, 7, 7));

    const ops = a.history.undo();
    expect(ops.length).toBeGreaterThan(0);
    expect(a.text(created.id)).toBe('');
    expect(a.board.getNote(created.id)).toMatchObject({ x: 7, y: 7 });
  });

  it('gives back nothing when no step is left that can be undone', () => {
    const a = new Person('a');
    expect(a.history.undo()).toEqual([]);
    expect(a.history.redo()).toEqual([]);
  });

  it('drops the skipped steps, so they do not come back as redo', () => {
    const [a, b] = [new Person('a'), new Person('b')];
    const created = a.history.createNote({ x: 0 });
    tell(b, [...created.ops, ...a.history.moveNote(created.id, 5, 5)]);
    tell(a, b.history.moveNote(created.id, 9, 9));
    a.history.undo();
    a.history.undo();
    expect(a.history.getState()).toEqual({ canUndo: false, canRedo: true });
    a.history.redo();
    expect(a.history.getState().canRedo).toBe(false);
  });
});

describe('the stacks', () => {
  it('clears redo when something new is done', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.pause();
    a.type(id, 0, 'abc');
    a.history.undo();
    expect(a.history.getState().canRedo).toBe(true);
    a.history.moveNote(id, 4, 4);
    expect(a.history.getState().canRedo).toBe(false);
    expect(a.history.redo()).toEqual([]);
  });

  it('clears redo when typing joins an earlier step, too', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.pause();
    a.type(id, 0, 'ab');
    a.history.undo();
    a.history.redo();
    a.history.undo();
    a.history.moveNote(id, 1, 1);
    a.history.undo();
    a.history.redo();
    expect(a.history.getState().canRedo).toBe(false);
  });

  it('keeps remote edits from clearing either stack', () => {
    const { a, b, id } = shared();
    a.history.moveNote(id, 1, 1);
    a.history.undo();
    tell(a, b.type(id, 0, 'x'));
    expect(a.history.getState()).toEqual({ canUndo: true, canRedo: true });
  });

  it('forgets the oldest steps beyond its limit', () => {
    const a = new Person('a', { limit: 3 });
    const { id } = a.history.createNote({ x: 0 });
    for (const x of [1, 2, 3, 4]) a.history.moveNote(id, x, 0);
    for (let step = 0; step < 10; step += 1) a.history.undo();
    expect(must(a.board.getNote(id)).x).toBe(1);
    expect(a.history.getState().canUndo).toBe(false);
  });

  it('keeps a hundred steps by default', () => {
    expect(DEFAULT_HISTORY_LIMIT).toBe(100);
    const a = new Person('a');
    const { id } = a.history.createNote({ x: 0 });
    for (let x = 1; x <= 150; x += 1) a.history.moveNote(id, x, 0);
    let undone = 0;
    while (a.history.undo().length > 0) undone += 1;
    expect(undone).toBe(100);
    expect(must(a.board.getNote(id)).x).toBe(50);
  });

  it('tells its listeners when undo or redo become possible or impossible, and only then', () => {
    const a = new Person('a');
    const states: string[] = [];
    const stop = a.history.subscribe(() => {
      const { canUndo, canRedo } = a.history.getState();
      states.push(`${canUndo ? 'U' : '-'}${canRedo ? 'R' : '-'}`);
    });
    const first = a.history.getState();
    expect(a.history.getState()).toBe(first);
    const { id } = a.history.createNote();
    a.history.moveNote(id, 1, 1);
    a.history.moveNote(id, 2, 2);
    a.history.undo();
    a.history.undo();
    a.history.undo();
    a.history.redo();
    stop();
    a.history.undo();
    expect(states).toEqual(['U-', 'UR', '-R', 'UR']);
  });

  it('works with the default grouping time of one second', () => {
    expect(DEFAULT_GROUP_MS).toBe(1000);
  });

  it('does not record an edit that was rejected', () => {
    const a = new Person('a');
    const { id } = a.history.createNote();
    a.pause();
    expect(() => a.history.editText(id, 5, 0, 'x')).toThrow();
    expect(() => a.history.moveNote('nope', 1, 1)).toThrow(UnknownNoteError);
    expect(() => a.history.deleteNote('nope')).toThrow(UnknownNoteError);
    a.history.undo();
    expect(a.board.getNote(id)).toBeUndefined();
    expect(a.history.getState().canUndo).toBe(false);
  });
});

// ---- Random histories -------------------------------------------------------------------------

type Intent =
  | { kind: 'create'; x: number; y: number }
  | { kind: 'move'; pick: number; x: number; y: number }
  | { kind: 'color'; pick: number; color: NoteColor }
  | { kind: 'type'; pick: number; at: number; text: string }
  | { kind: 'erase'; pick: number; at: number; count: number }
  | { kind: 'delete'; pick: number }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'wait'; ms: number };

const coordinate = fc.integer({ min: -50, max: 50 });
const word = fc
  .array(fc.constantFrom('a', 'b', 'c', '😀', 'é', ' '), { minLength: 1, maxLength: 3 })
  .map((chars) => chars.join(''));

const intents: fc.Arbitrary<Intent> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('create' as const), x: coordinate, y: coordinate }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('move' as const),
      pick: fc.nat(),
      x: coordinate,
      y: coordinate,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('color' as const),
      pick: fc.nat(),
      color: fc.constantFrom(...NOTE_COLORS),
    }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant('type' as const),
      pick: fc.nat(),
      at: fc.nat(),
      text: word,
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('erase' as const),
      pick: fc.nat(),
      at: fc.nat(),
      count: fc.integer({ min: 1, max: 3 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), pick: fc.nat() }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('undo' as const) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('redo' as const) }) },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('wait' as const),
      ms: fc.integer({ min: 0, max: 2500 }),
    }),
  },
);

/** The characters, in any note, that are visible and that `person` did not type. */
function visibleCharsNotBy(person: Person): string[] {
  const notes = new Set(person.board.log.flatMap((op) => (op.type === 'text' ? [op.noteId] : [])));
  return [...notes].flatMap((noteId) =>
    person.board
      .textNodes(noteId)
      .filter((node) => !node.deleted && node.id.replicaId !== person.name)
      .map((node) => `${noteId}/${opIdKey(node.id)}`),
  );
}

/** Carries out `intent` for `person`, returning the operations to send. */
function perform(person: Person, intent: Intent): BoardOp[] {
  const notes = person.board.notes();
  const pick = (value: number) => (notes.length === 0 ? undefined : notes[value % notes.length]);
  switch (intent.kind) {
    case 'create':
      return person.history.createNote({ x: intent.x, y: intent.y }).ops;
    case 'undo':
      return person.history.undo();
    case 'redo':
      return person.history.redo();
    case 'wait':
      person.time.advance(intent.ms);
      return [];
    case 'move': {
      const target = pick(intent.pick);
      return target === undefined ? [] : person.history.moveNote(target.id, intent.x, intent.y);
    }
    case 'color': {
      const target = pick(intent.pick);
      return target === undefined ? [] : person.history.setColor(target.id, intent.color);
    }
    case 'type': {
      const target = pick(intent.pick);
      if (target === undefined) return [];
      const at = intent.at % ([...target.text].length + 1);
      return person.history.editText(target.id, at, 0, intent.text);
    }
    case 'erase': {
      const target = pick(intent.pick);
      if (target === undefined) return [];
      const length = [...target.text].length;
      if (length === 0) return [];
      const at = intent.at % length;
      return person.history.editText(target.id, at, Math.min(intent.count, length - at), '');
    }
    case 'delete': {
      const target = pick(intent.pick);
      return target === undefined ? [] : person.history.deleteNote(target.id);
    }
  }
}

describe('random histories', () => {
  it('on their own: undoing everything empties the board and redoing everything brings it back', () => {
    fc.assert(
      fc.property(fc.array(intents, { maxLength: 40 }), (actions) => {
        const a = new Person('a');
        for (const intent of actions) perform(a, intent);
        // Whatever is on the redo stack now belongs to the state before the last undo.
        while (a.history.getState().canRedo) a.history.redo();
        const after = views(a);

        let guard = 0;
        while (a.history.getState().canUndo && guard < 500) {
          a.history.undo();
          guard += 1;
        }
        if (a.board.size !== 0) return false;
        while (a.history.getState().canRedo && guard < 1000) {
          a.history.redo();
          guard += 1;
        }
        return views(a) === after;
      }),
      { numRuns: 400 },
    );
  });

  it('three people at once: everyone converges, undo and redo only delete the undoer’s own characters, and undoing everything keeps everyone else’s', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ who: fc.integer({ min: 0, max: 2 }), intent: intents }), {
          maxLength: 60,
        }),
        fc.array(fc.nat(), { maxLength: 80 }),
        (actions, deliveries) => {
          const people = [new Person('a'), new Person('b'), new Person('c')];
          const inbox: { to: Person; ops: BoardOp[] }[] = [];
          const send = (from: Person, ops: BoardOp[]) => {
            if (ops.length === 0) return;
            for (const to of people) if (to !== from) inbox.push({ to, ops });
          };
          const deliverOne = (pick: number) => {
            if (inbox.length === 0) return;
            const [message] = inbox.splice(pick % inbox.length, 1);
            if (message !== undefined) message.to.board.applyRemote(message.ops);
          };
          let ok = true;
          let step = 0;
          for (const { who, intent } of actions) {
            const person = must(people[who]);
            const ops = perform(person, intent);
            if (intent.kind === 'undo' || intent.kind === 'redo') {
              for (const op of ops) {
                if (op.type !== 'text' || op.op.type !== 'delete') continue;
                if (op.op.target.replicaId !== person.name) ok = false;
              }
            }
            send(person, ops);
            deliverOne(deliveries[step % Math.max(1, deliveries.length)] ?? 0);
            step += 1;
          }
          while (inbox.length > 0) deliverOne(0);
          const [first, ...others] = people;
          const converged =
            others.every((other) => state(other) === state(must(first))) &&
            people.every((person) => person.board.pendingCount === 0);

          // Undoing every step of the first person leaves every character the others wrote.
          const theirs = visibleCharsNotBy(must(first));
          while (must(first).history.getState().canUndo) must(first).history.undo();
          const kept = new Set(visibleCharsNotBy(must(first)));
          return ok && converged && theirs.every((char) => kept.has(char));
        },
      ),
      { numRuns: 400 },
    );
  });
});
