import type { Board, NoteInit } from './board';
import type { BoardOp, NoteColor, NoteFields } from './board-ops';
import { opIdEquals, opIdKey, type OpId } from './op-id';
import type { TextNode } from './text-sequence';

/** Typing within this many milliseconds of the last edit, at the caret, is one undo step. */
export const DEFAULT_GROUP_MS = 1000;

/** How many undo steps are kept. */
export const DEFAULT_HISTORY_LIMIT = 100;

export interface HistoryOptions {
  /** Milliseconds from any start that never goes backwards. Injected, like every clock here. */
  readonly now: () => number;
  readonly groupMs?: number;
  readonly limit?: number;
}

export interface HistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

interface Char {
  readonly id: OpId;
  readonly value: string;
}

/**
 * One undo step, described by what it *did* in terms that stay true when others edit meanwhile:
 * characters and notes are named by id, and fields by the value this replica wrote. Undoing a step
 * performs the inverse and yields the step that undoes that, which is how redo works.
 */
type Action =
  /**
   * Put in the characters `inserted` and took out `removed`, in document order. Those stood right
   * after the character `after` (`null` is the start of the text), the one that was visible just
   * before them, which is still there, or has a copy, when the removed characters are being put
   * back: steps are undone last first.
   */
  | {
      readonly kind: 'text';
      readonly noteId: string;
      readonly removed: readonly Char[];
      readonly after: OpId | null;
      readonly inserted: readonly OpId[];
    }
  | {
      readonly kind: 'move';
      readonly noteId: string;
      readonly from: { readonly x: number; readonly y: number };
      readonly to: { readonly x: number; readonly y: number };
    }
  | {
      readonly kind: 'color';
      readonly noteId: string;
      readonly from: NoteColor;
      readonly to: NoteColor;
    }
  /** Made the note. */
  | { readonly kind: 'create'; readonly noteId: string }
  /** Deleted the note, which had these fields. */
  | { readonly kind: 'remove'; readonly noteId: string; readonly fields: NoteFields };

type TextAction = Extract<Action, { kind: 'text' }>;

interface Inverted {
  readonly ops: BoardOp[];
  /** What undoes `ops` again. */
  readonly inverse: Action;
}

/**
 * Characters that were deleted and then typed again by an undo are new characters. Steps older
 * than the deletion still name the originals, so this maps each name to the copy that took its
 * place (and copies of copies). A character id is only unique within its note.
 */
type Copies = Map<string, OpId>;

const copyKey = (noteId: string, id: OpId) => `${noteId}\u0000${opIdKey(id)}`;

function current(copies: ReadonlyMap<string, OpId>, noteId: string, id: OpId): OpId {
  let latest = id;
  for (let next = copies.get(copyKey(noteId, latest)); next !== undefined; ) {
    latest = next;
    next = copies.get(copyKey(noteId, latest));
  }
  return latest;
}

/**
 * The offset of the caret that sits just after the character `id`, which may be deleted (it then
 * sits where the character was). `undefined` if `id` is unknown.
 */
function caretOffset(nodes: readonly TextNode[], id: OpId): number | undefined {
  let visible = 0;
  for (const node of nodes) {
    if (opIdEquals(node.id, id)) return visible + (node.deleted ? 0 : 1);
    if (!node.deleted) visible += 1;
  }
  return undefined;
}

function insertedIds(ops: readonly BoardOp[]): OpId[] {
  const ids: OpId[] = [];
  for (const op of ops) if (op.type === 'text' && op.op.type === 'insert') ids.push(op.op.id);
  return ids;
}

/** The visible characters `index` up to `index + count`, and the visible one before them. */
function removalOf(
  nodes: readonly TextNode[],
  index: number,
  count: number,
): { removed: Char[]; after: OpId | null } {
  const removed: Char[] = [];
  let after: OpId | null = null;
  let previous: OpId | null = null;
  let visible = 0;
  for (const node of nodes) {
    if (node.deleted) continue;
    if (visible >= index && visible < index + count) {
      if (removed.length === 0) after = previous;
      removed.push({ id: node.id, value: node.value });
    }
    previous = node.id;
    visible += 1;
  }
  return { removed, after };
}

/** Folds the edit `next` into the step `prev` made just before it: their net effect as one step. */
function mergeText(prev: TextAction, next: TextAction, nodes: readonly TextNode[]): TextAction {
  // Characters the step typed and the edit then erased never existed as far as the step goes.
  const typed = new Set(prev.inserted.map(opIdKey));
  const erased = new Set(next.removed.map((char) => opIdKey(char.id)));
  const position = new Map(nodes.map((node, index) => [opIdKey(node.id), index]));
  const at = (char: Char) => position.get(opIdKey(char.id)) ?? 0;
  const removed = [
    ...prev.removed,
    ...next.removed.filter((char) => !typed.has(opIdKey(char.id))),
  ].sort((a, b) => at(a) - at(b));
  // Whichever edit removed the first of them knows what stood before it.
  const first = removed[0];
  const fromPrev =
    first !== undefined && prev.removed.some((char) => opIdEquals(char.id, first.id));
  return {
    kind: 'text',
    noteId: prev.noteId,
    removed,
    after: fromPrev ? prev.after : next.after,
    inserted: [...prev.inserted.filter((id) => !erased.has(opIdKey(id))), ...next.inserted],
  };
}

function invertText(board: Board, action: TextAction, copies: Copies): Inverted | undefined {
  const { noteId } = action;
  // A note someone else deleted is theirs to have deleted: an edit would bring it back.
  if (board.getNote(noteId) === undefined) return undefined;
  const ops: BoardOp[] = [];

  // Take out what the step put in: those characters, wherever they are now, unless already gone.
  const mine = new Set(action.inserted.map((id) => opIdKey(current(copies, noteId, id))));
  const taken: Char[] = [];
  let after: OpId | null = null;
  const runs: { start: number; length: number }[] = [];
  let previous: OpId | null = null;
  let visible = 0;
  for (const node of board.textNodes(noteId)) {
    if (node.deleted) continue;
    if (mine.has(opIdKey(node.id))) {
      if (taken.length === 0) after = previous;
      taken.push({ id: node.id, value: node.value });
      const last = runs.at(-1);
      if (last !== undefined && last.start + last.length === visible) last.length += 1;
      else runs.push({ start: visible, length: 1 });
    }
    previous = node.id;
    visible += 1;
  }
  // Last run first, so that the indices of the others stay right.
  for (const run of runs.reverse()) ops.push(...board.editText(noteId, run.start, run.length, ''));

  // Put back what the step took out, as one block where it stood: after what was before it,
  // or after the copy of that if it was taken out and typed again meanwhile.
  let put: OpId[] = [];
  if (action.removed.length > 0) {
    const anchor = action.after === null ? null : current(copies, noteId, action.after);
    const text = action.removed.map((char) => char.value).join('');
    const added = board.insertTextAfter(noteId, anchor, text);
    put = insertedIds(added);
    ops.push(...added);
    action.removed.forEach((char, index) => {
      const copy = put[index];
      if (copy !== undefined) copies.set(copyKey(noteId, char.id), copy);
    });
  }

  if (ops.length === 0) return undefined;
  return { ops, inverse: { kind: 'text', noteId, removed: taken, after, inserted: put } };
}

/**
 * Performs the inverse of one action. `undefined` if it would change nothing, or would change
 * something that is no longer this replica's: a field someone else has overwritten since keeps
 * their value, a note someone else deleted stays deleted.
 */
function invert(board: Board, action: Action, copies: Copies): Inverted | undefined {
  switch (action.kind) {
    case 'text':
      return invertText(board, action, copies);
    case 'move': {
      const note = board.getNote(action.noteId);
      if (note === undefined || note.x !== action.to.x || note.y !== action.to.y) return undefined;
      const ops = board.moveNote(action.noteId, action.from.x, action.from.y);
      return { ops, inverse: { ...action, from: action.to, to: action.from } };
    }
    case 'color': {
      const note = board.getNote(action.noteId);
      if (note === undefined || note.color !== action.to) return undefined;
      const ops = board.setColor(action.noteId, action.from);
      return { ops, inverse: { ...action, from: action.to, to: action.from } };
    }
    case 'create': {
      const fields = board.getFields(action.noteId);
      if (fields === undefined) return undefined;
      const ops = board.deleteNote(action.noteId);
      return { ops, inverse: { kind: 'remove', noteId: action.noteId, fields } };
    }
    case 'remove': {
      const ops = board.restoreNote(action.noteId, action.fields);
      if (ops.length === 0) return undefined;
      return { ops, inverse: { kind: 'create', noteId: action.noteId } };
    }
  }
}

/**
 * Undo and redo for one replica's own changes to a board. Local edits go through this object
 * (it forwards them to the `Board`, which returns the operations to send); `undo` and `redo` give
 * back the operations that reverse or repeat the last step, to be sent like any other.
 *
 * Undo is a new edit, never a rewind: it generates inverse operations, so it converges like any
 * edit and cannot touch what others did. Each step names what it changed in terms that survive
 * their edits (see `Action`):
 *
 * - *Text* is undone by id. Characters this replica typed are deleted wherever they have ended up,
 *   and characters it deleted are typed again as a block right after the character that was before
 *   them, so edits others made before, after or even inside stay. Typed again means new
 *   characters; `Copies` lets the steps before name them as the originals.
 * - *Fields* (position, colour) are restored only while they still hold what this replica wrote;
 *   once someone else has written them, that is theirs and the step is skipped.
 * - A *deleted note* is put back with its fields, unless it exists again already; a *created
 *   note* is deleted.
 *
 * A step that changes nothing is skipped: undo carries on to the step before it, so a key press
 * always does something while anything can be undone.
 *
 * Rapid typing in one note is one step: an edit within `groupMs` of the last one, right where its
 * caret was left (typing on, or deleting backwards or forwards), joins it. Raising a note is not
 * recorded; it happens on every click. History is kept in memory and is gone with the page.
 */
export class BoardHistory {
  readonly #board: Board;
  readonly #now: () => number;
  readonly #groupMs: number;
  readonly #limit: number;
  readonly #listeners = new Set<() => void>();
  readonly #copies: Copies = new Map();
  #undo: Action[] = [];
  #redo: Action[] = [];
  /** The typing that the next edit may join; its step is the top of the undo stack. */
  #open: { readonly noteId: string; readonly at: number; readonly caret: OpId } | undefined;
  #state: HistoryState = { canUndo: false, canRedo: false };

  constructor(board: Board, options: HistoryOptions) {
    this.#board = board;
    this.#now = options.now;
    this.#groupMs = options.groupMs ?? DEFAULT_GROUP_MS;
    this.#limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  }

  /** The same object until `canUndo` or `canRedo` changes. */
  readonly getState = (): HistoryState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // ---- Local changes: the `Board`'s, remembered ----------------------------------------------

  createNote(init?: NoteInit): { id: string; ops: BoardOp[] } {
    const created = this.#board.createNote(init);
    this.#push({ kind: 'create', noteId: created.id });
    return created;
  }

  moveNote(noteId: string, x: number, y: number): BoardOp[] {
    const before = this.#board.getNote(noteId);
    const ops = this.#board.moveNote(noteId, x, y);
    if (before !== undefined && (before.x !== x || before.y !== y)) {
      this.#push({ kind: 'move', noteId, from: { x: before.x, y: before.y }, to: { x, y } });
    }
    return ops;
  }

  setColor(noteId: string, color: NoteColor): BoardOp[] {
    const before = this.#board.getNote(noteId);
    const ops = this.#board.setColor(noteId, color);
    if (before !== undefined && before.color !== color) {
      this.#push({ kind: 'color', noteId, from: before.color, to: color });
    }
    return ops;
  }

  /** Not an undo step: it happens on every click on a note. */
  bringToFront(noteId: string): BoardOp[] {
    return this.#board.bringToFront(noteId);
  }

  deleteNote(noteId: string): BoardOp[] {
    const fields = this.#board.getFields(noteId);
    const ops = this.#board.deleteNote(noteId);
    if (fields !== undefined) this.#push({ kind: 'remove', noteId, fields });
    return ops;
  }

  editText(noteId: string, index: number, deleteCount: number, insert: string): BoardOp[] {
    const at = this.#now();
    const before = this.#board.textNodes(noteId);
    const { removed, after } = removalOf(before, index, deleteCount);
    const joins = this.#joins(noteId, before, index, deleteCount, at);

    const ops = this.#board.editText(noteId, index, deleteCount, insert);
    if (ops.length === 0) return ops;
    const typed = insertedIds(ops);
    const edit: TextAction = { kind: 'text', noteId, removed, after, inserted: typed };
    // The caret is left after the last character typed, or where the first one was removed.
    const caret = typed.at(-1) ?? removed[0]?.id;
    if (caret === undefined) throw new Error('Invariant violated: an edit that changed nothing');

    const top = this.#undo.at(-1);
    if (joins && top?.kind === 'text') {
      const merged = mergeText(top, edit, this.#board.textNodes(noteId));
      this.#undo.pop();
      // Typed and erased again: nothing is left to undo.
      if (merged.removed.length === 0 && merged.inserted.length === 0) {
        this.#open = undefined;
        this.#publish();
        return ops;
      }
      this.#undo.push(merged);
      this.#publish();
    } else {
      this.#push(edit);
    }
    this.#open = { noteId, at, caret };
    return ops;
  }

  // ---- Undo and redo -------------------------------------------------------------------------

  /** Reverses the last step that can still be reversed. Empty if there is none. */
  undo(): BoardOp[] {
    return this.#travel(this.#undo, this.#redo);
  }

  /** Repeats the step that was last undone, unless something else was done since. */
  redo(): BoardOp[] {
    return this.#travel(this.#redo, this.#undo);
  }

  // ---- Internals -----------------------------------------------------------------------------

  /** Whether an edit at `index` replacing `deleteCount` characters continues the open typing. */
  #joins(
    noteId: string,
    nodes: readonly TextNode[],
    index: number,
    deleteCount: number,
    at: number,
  ): boolean {
    const open = this.#open;
    if (open === undefined || open.noteId !== noteId || at - open.at > this.#groupMs) return false;
    const caret = caretOffset(nodes, open.caret);
    return caret !== undefined && (index === caret || index + deleteCount === caret);
  }

  #push(action: Action): void {
    this.#open = undefined;
    this.#undo.push(action);
    this.#redo = [];
    if (this.#undo.length > this.#limit) this.#undo.splice(0, this.#undo.length - this.#limit);
    this.#publish();
  }

  /** Takes steps off `from` until one does something; that one's inverse goes on `to`. */
  #travel(from: Action[], to: Action[]): BoardOp[] {
    this.#open = undefined;
    try {
      for (let action = from.pop(); action !== undefined; action = from.pop()) {
        const done = invert(this.#board, action, this.#copies);
        if (done === undefined) continue;
        to.push(done.inverse);
        return done.ops;
      }
      return [];
    } finally {
      this.#publish();
    }
  }

  #publish(): void {
    const canUndo = this.#undo.length > 0;
    const canRedo = this.#redo.length > 0;
    // With nothing left to undo or redo, no step can name an original any more.
    if (!canUndo && !canRedo) this.#copies.clear();
    if (canUndo === this.#state.canUndo && canRedo === this.#state.canRedo) return;
    this.#state = { canUndo, canRedo };
    for (const listener of [...this.#listeners]) listener();
  }
}
