import {
  UnknownNoteError,
  type Board,
  type BoardChange,
  type BoardHistory,
  type BoardOp,
  type HistoryState,
  type NoteColor,
  type NoteView,
} from '@driftboard/crdt';
import type { TextEdit } from './text-binding';

type Listener = () => void;

function sameView(a: NoteView, b: NoteView): boolean {
  return (
    a.x === b.x && a.y === b.y && a.z === b.z && a.color === b.color && a.text === b.text
  );
}

function sortedIds(views: ReadonlyMap<string, NoteView>): readonly string[] {
  return [...views.keys()].sort();
}

/**
 * The board document as React wants to read it. It follows the `Board` through its change events
 * and keeps one immutable `NoteView` per note, replaced only when that note's fields or text really
 * changed, plus the list of note ids, replaced only when a note appears or disappears. Both are
 * what `useSyncExternalStore` needs: stable snapshots, and a subscription per note so that a change
 * to one note wakes only the component showing it.
 *
 * Ids are in a fixed order (by id) and stacking is left to each note's `z`, so raising a note never
 * reorders the list, and never makes React move a focused textarea in the DOM.
 *
 * The mutators change the board, through its `BoardHistory` so that they can be undone, and pass
 * the resulting operations to `submit`, which sends them. `undo` and `redo` do the same with the
 * operations that reverse or repeat this user's last step. A note that another user deleted in the
 * meantime is ignored quietly.
 */
export class BoardStore {
  readonly #board: Board;
  readonly #history: BoardHistory;
  readonly #submit: (ops: BoardOp[]) => void;
  readonly #views = new Map<string, NoteView>();
  readonly #noteListeners = new Map<string, Set<Listener>>();
  readonly #listListeners = new Set<Listener>();
  #ids: readonly string[] = [];

  constructor(board: Board, submit: (ops: BoardOp[]) => void, history: BoardHistory) {
    this.#board = board;
    this.#submit = submit;
    this.#history = history;
    for (const note of board.notes()) this.#views.set(note.id, note);
    this.#ids = sortedIds(this.#views);
    board.subscribe((change) => {
      this.#onChange(change);
    });
  }

  // ---- Reading, shaped for useSyncExternalStore --------------------------------------------

  /** The ids of all notes, in a fixed order. The same array until a note is added or removed. */
  readonly getIds = (): readonly string[] => this.#ids;

  readonly subscribeList = (listener: Listener): (() => void) => {
    this.#listListeners.add(listener);
    return () => {
      this.#listListeners.delete(listener);
    };
  };

  /** A note's current state. The same object until that note changes; `undefined` if it is gone. */
  getNote(id: string): NoteView | undefined {
    return this.#views.get(id);
  }

  /** Calls `listener` when the note with `id` changes (or is created or deleted). */
  subscribeNote(id: string, listener: Listener): () => void {
    let listeners = this.#noteListeners.get(id);
    if (listeners === undefined) {
      listeners = new Set();
      this.#noteListeners.set(id, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.#noteListeners.get(id);
      current?.delete(listener);
      if (current?.size === 0) this.#noteListeners.delete(id);
    };
  }

  /** Whether the note is drawn above every other note. */
  isTop(id: string): boolean {
    const note = this.#views.get(id);
    if (note === undefined) return false;
    for (const other of this.#views.values()) {
      if (other.id !== id && other.z >= note.z) return false;
    }
    return true;
  }

  // ---- Changing the board -----------------------------------------------------------------

  /** Creates an empty note with its top-left corner at `x`, `y`. Returns its id. */
  createNote(x: number, y: number): string | undefined {
    return this.#local(() => {
      const { id, ops } = this.#history.createNote({ x, y });
      return { ops, result: id };
    });
  }

  moveNote(id: string, x: number, y: number): void {
    const note = this.#views.get(id);
    if (note === undefined || (note.x === x && note.y === y)) return;
    this.#local(() => ({ ops: this.#history.moveNote(id, x, y), result: undefined }));
  }

  setColor(id: string, color: NoteColor): void {
    if (this.#views.get(id)?.color === color) return;
    this.#local(() => ({ ops: this.#history.setColor(id, color), result: undefined }));
  }

  /** Raises the note above all others, unless it already is. Not an undo step. */
  bringToFront(id: string): void {
    if (this.#views.has(id) && !this.isTop(id)) {
      this.#local(() => ({ ops: this.#history.bringToFront(id), result: undefined }));
    }
  }

  /** Applies one text edit, in code points, as found by `diffText`. */
  editText(id: string, edit: TextEdit): void {
    this.#local(() => ({
      ops: this.#history.editText(id, edit.start, edit.deleteCount, edit.insert),
      result: undefined,
    }));
  }

  deleteNote(id: string): void {
    this.#local(() => ({ ops: this.#history.deleteNote(id), result: undefined }));
  }

  // ---- Undo and redo ----------------------------------------------------------------------

  /** Reverses this user's last change that is still theirs to reverse. */
  undo(): void {
    this.#local(() => ({ ops: this.#history.undo(), result: undefined }));
  }

  redo(): void {
    this.#local(() => ({ ops: this.#history.redo(), result: undefined }));
  }

  /** Whether there is anything to undo or redo. The same object until that changes. */
  readonly getHistoryState = (): HistoryState => this.#history.getState();

  readonly subscribeHistory = (listener: Listener): (() => void) =>
    this.#history.subscribe(listener);

  // ---- Internals --------------------------------------------------------------------------

  #local<T>(action: () => { ops: BoardOp[]; result: T }): T | undefined {
    try {
      const { ops, result } = action();
      if (ops.length > 0) this.#submit(ops);
      return result;
    } catch (error) {
      if (error instanceof UnknownNoteError) return undefined;
      throw error;
    }
  }

  /** Brings the cached views in line with the board, then wakes exactly what changed. */
  #onChange(change: BoardChange): void {
    const changed: string[] = [];
    let membership = false;
    for (const id of change.noteIds) {
      const next = this.#board.getNote(id);
      const previous = this.#views.get(id);
      if (next === undefined) {
        if (previous === undefined) continue;
        this.#views.delete(id);
        membership = true;
        changed.push(id);
      } else if (previous === undefined) {
        this.#views.set(id, next);
        membership = true;
        changed.push(id);
      } else if (!sameView(previous, next)) {
        this.#views.set(id, next);
        changed.push(id);
      }
    }
    if (membership) this.#ids = sortedIds(this.#views);
    for (const id of changed) {
      for (const listener of [...(this.#noteListeners.get(id) ?? [])]) listener();
    }
    if (membership) for (const listener of [...this.#listListeners]) listener();
  }
}
