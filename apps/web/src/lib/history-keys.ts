export type HistoryCommand = 'undo' | 'redo';

/** The part of a keyboard event that decides it. */
export interface KeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** An input method is composing text: its keys belong to it. */
  readonly isComposing?: boolean;
  readonly target?: object | null;
}

/** The part of an `input` event that decides it. */
export interface InputLike {
  readonly inputType: string;
  readonly target?: object | null;
}

/**
 * A one-line field keeps the browser's own undo (the name field): its edits are not the board's.
 * The notes' textareas do not, because their text is the board's and is changed from outside the
 * textarea, which the browser's own undo knows nothing about.
 */
function keepsNativeUndo(target: object | null | undefined): boolean {
  if (target === null || target === undefined || !('tagName' in target)) return false;
  return target.tagName === 'INPUT';
}

/**
 * Ctrl/Cmd+Z undoes, and Shift+Ctrl/Cmd+Z redoes. Anything else, including a key press that an
 * input method is composing with or that a one-line field should handle itself, is `null`.
 */
export function historyShortcut(event: KeyLike): HistoryCommand | null {
  if (event.isComposing === true || keepsNativeUndo(event.target)) return null;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (event.key.toLowerCase() !== 'z') return null;
  return event.shiftKey ? 'redo' : 'undo';
}

/**
 * The browser's own undo and redo reach a textarea by other roads than the keys (the Edit menu on
 * a Mac, a shake on a phone) as a `beforeinput` event; those are the board's too.
 */
export function historyInput(event: InputLike): HistoryCommand | null {
  if (keepsNativeUndo(event.target)) return null;
  if (event.inputType === 'historyUndo') return 'undo';
  if (event.inputType === 'historyRedo') return 'redo';
  return null;
}
