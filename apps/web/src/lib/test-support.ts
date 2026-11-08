import { Board, generateReplicaId } from '@driftboard/crdt';
import type { TextControl } from './caret';
import type { TextEdit } from './text-binding';

type Direction = 'forward' | 'backward' | 'none';

/**
 * A textarea as far as the code under test can tell. It follows the HTML rule that matters here:
 * giving `value` a different string puts the caret at the end and clears the selection direction
 * (and, as some browsers do, resets the scroll position). What the user types goes in directly.
 * Offsets are UTF-16 units, as in the DOM.
 */
export class FakeTextarea implements TextControl {
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: Direction | null = 'none';
  scrollTop = 0;
  /** How many times the code under test asked for a selection. */
  selectionCalls = 0;
  #value: string;

  constructor(value = '') {
    this.#value = value;
    this.selectionStart = value.length;
    this.selectionEnd = value.length;
  }

  get value(): string {
    return this.#value;
  }

  set value(next: string) {
    if (next === this.#value) return;
    this.#value = next;
    this.selectionStart = next.length;
    this.selectionEnd = next.length;
    this.selectionDirection = 'none';
    this.scrollTop = 0;
  }

  setSelectionRange(start: number, end: number, direction: Direction = 'none'): void {
    this.selectionCalls += 1;
    this.select(start, end, direction);
  }

  /** The user selects text. */
  select(start: number, end: number, direction: Direction = 'none'): void {
    const clamp = (index: number) => Math.min(Math.max(index, 0), this.#value.length);
    this.selectionStart = clamp(Math.min(start, end));
    this.selectionEnd = clamp(Math.max(start, end));
    this.selectionDirection = direction;
  }

  /** The user types, pastes or drops `text`, replacing the selection. */
  replaceSelection(text: string): void {
    const { selectionStart: start, selectionEnd: end } = this;
    this.#value = this.#value.slice(0, start) + text + this.#value.slice(end);
    this.select(start + text.length, start + text.length);
  }

  /** The user presses Backspace. */
  deleteBackward(): void {
    if (this.selectionStart === this.selectionEnd && this.selectionStart > 0) {
      this.select(this.selectionStart - 1, this.selectionStart);
    }
    this.replaceSelection('');
  }
}

/**
 * A replica with its own id (derived from `seed`) and a physical clock that moves a millisecond
 * per reading.
 */
export function replica(seed: number): Board {
  let time = 1_000;
  return new Board({
    replicaId: generateReplicaId((length) =>
      Uint8Array.from({ length }, (_, index) => (seed * 37 + index * 11) % 256),
    ),
    clock: {
      now: () => {
        time += 1;
        return time;
      },
    },
  });
}

/** Applies an edit in code points to a text, as `Board.editText` does. */
export function applyEdit(text: string, edit: TextEdit): string {
  const characters = [...text];
  characters.splice(edit.start, edit.deleteCount, ...edit.insert);
  return characters.join('');
}
