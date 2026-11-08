import { applyRemoteText, type TextControl } from './caret';
import { countCodePoints, diffText, type TextDiff } from './text-diff';

/**
 * One replacement in code points, the shape of `Board.editText`: `deleteCount` characters at
 * `start` become `insert`.
 */
export type TextEdit = Pick<TextDiff, 'start' | 'deleteCount' | 'insert'>;

/**
 * `edit` was made to a text; meanwhile `over` was applied to that same text by someone else.
 * Returns the edit for the text as it is now. An edit before or after `over` stays or moves along.
 * One that overlaps `over` cannot keep its deletion without removing text its author never saw, so
 * only the text it inserted is kept, placed after what `over` inserted.
 */
export function rebaseEdit(edit: TextEdit, over: TextEdit): TextEdit {
  const editEnd = edit.start + edit.deleteCount;
  if (editEnd <= over.start) return edit;
  const inserted = countCodePoints(over.insert);
  if (edit.start >= over.start + over.deleteCount) {
    return { ...edit, start: edit.start + inserted - over.deleteCount };
  }
  return { start: over.start + inserted, deleteCount: 0, insert: edit.insert };
}

/**
 * Keeps one text control and one text in the document in step, without a framework:
 *
 * - `input` reports what the user changed, once, as the edit between the last text the control
 *   and the document agreed on and the control's new value;
 * - `documentChanged` brings the control up to date after the document changed (a remote edit, or
 *   the echo of the user's own) and keeps the caret, selection and scroll position in place;
 * - while an input method composition is in progress nothing is reported or overwritten. Document
 *   changes are only remembered, and when the composition ends its result is reported moved over
 *   each of them, so it lands where the user typed and not at an offset that others' edits shifted.
 *
 * The control is passed to each call because it only exists once the component is mounted.
 */
export interface TextBinding {
  documentChanged(control: TextControl, text: string, hasFocus: boolean): void;
  input(control: TextControl): void;
  compositionStart(): void;
  compositionEnd(control: TextControl, hasFocus: boolean): void;
}

export function createTextBinding(initial: string, onEdit: (edit: TextEdit) => void): TextBinding {
  /** The text the control and the document last agreed on. */
  let known = initial;
  /** The document's text. */
  let latest = initial;
  let composing = false;
  /** Changes to the document during a composition, each relative to the text before it. */
  let missed: TextEdit[] = [];

  /** Reports what the user changed since `known`. Returns whether there was anything to report. */
  const report = (control: TextControl): boolean => {
    const typed = diffText(known, control.value);
    if (typed === null) return false;
    known = control.value;
    const edit = missed.reduce<TextEdit>(rebaseEdit, {
      start: typed.start,
      deleteCount: typed.deleteCount,
      insert: typed.insert,
    });
    missed = [];
    // Others may already have made the same change. The document then stays as it is and nothing
    // would bring the control in line with it, so the caller has to.
    if (edit.deleteCount === 0 && edit.insert === '') return false;
    onEdit(edit);
    return true;
  };

  return {
    documentChanged(control, text, hasFocus) {
      if (composing) {
        const change = diffText(latest, text);
        if (change !== null) missed.push(change);
        latest = text;
        return;
      }
      latest = text;
      applyRemoteText(control, text, hasFocus);
      known = text;
    },
    input(control) {
      if (!composing) report(control);
    },
    compositionStart() {
      composing = true;
    },
    compositionEnd(control, hasFocus) {
      composing = false;
      if (report(control)) return;
      // Nothing is left to report. The control still has to catch up with what arrived meanwhile.
      missed = [];
      applyRemoteText(control, latest, hasFocus);
      known = latest;
    },
  };
}
