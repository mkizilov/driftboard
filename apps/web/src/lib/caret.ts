import { diffText, type TextDiff } from './text-diff';

/** The part of a textarea (or input) that carries a value and a selection. */
export interface TextControl {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: 'forward' | 'backward' | 'none' | null;
  scrollTop: number;
  setSelectionRange(start: number, end: number, direction?: 'forward' | 'backward' | 'none'): void;
}

/**
 * Where a caret at `index` (in UTF-16 units) ends up when the text around it changes as `change`
 * says. A caret before the change stays; one after it moves with the text; one inside the replaced
 * part goes to the end of what replaced it. A caret exactly at the start of an insertion stays in
 * front of it, so text someone else types at your caret does not push the caret along.
 */
export function mapIndex(index: number, change: TextDiff): number {
  if (index <= change.unitStart) return index;
  const end = change.unitStart + change.unitDeleteCount;
  if (index >= end) return index - change.unitDeleteCount + change.unitInsertLength;
  return change.unitStart + change.unitInsertLength;
}

/**
 * Puts `next` into `control`, which holds a text that someone else has changed, and keeps the
 * reader's place: the selection is moved along with the text around it and the scroll position is
 * kept. Setting `value` on a textarea would otherwise throw the caret to the end. When the control
 * does not have focus there is no caret to keep.
 */
export function applyRemoteText(control: TextControl, next: string, hasFocus: boolean): void {
  const change = diffText(control.value, next);
  if (change === null) return;
  const { selectionStart, selectionEnd, selectionDirection, scrollTop } = control;
  control.value = next;
  control.scrollTop = scrollTop;
  if (!hasFocus) return;
  control.setSelectionRange(
    mapIndex(selectionStart, change),
    mapIndex(selectionEnd, change),
    selectionDirection ?? undefined,
  );
}
