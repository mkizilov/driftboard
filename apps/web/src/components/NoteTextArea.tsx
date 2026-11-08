import { useLayoutEffect, useRef, useState } from 'react';
import { createTextBinding, type TextEdit } from '../lib/text-binding';

export interface NoteTextAreaProps {
  /** The note's text in the document. */
  value: string;
  /** Called with what the user changed: the text between the common prefix and suffix. */
  onEdit: (edit: TextEdit) => void;
  /** The textarea gained or lost the focus: its person started or stopped editing. */
  onFocusChange?: (focused: boolean) => void;
  label?: string;
}

/**
 * The text of a note. The textarea is uncontrolled so that React never overwrites it behind the
 * browser's back; `createTextBinding` compares what the textarea shows with the document. It turns
 * the user's changes into single edits, and brings the textarea up to date when the document text
 * changes by other means (a remote edit) without moving the caret, selection or scroll position.
 *
 * There is deliberately no `defaultValue`. React applies it to the DOM node whenever it changes,
 * which for a textarea that was never given a value (an empty new note) can replace its text
 * behind the binding's back and put the caret at the end. The layout effect below sets the first
 * text instead, before the browser paints.
 */
export function NoteTextArea({
  value,
  onEdit,
  onFocusChange,
  label = 'Note text',
}: NoteTextAreaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const onEditRef = useRef(onEdit);
  const [binding] = useState(() =>
    createTextBinding(value, (edit) => {
      onEditRef.current(edit);
    }),
  );

  useLayoutEffect(() => {
    onEditRef.current = onEdit;
  });

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    binding.documentChanged(element, value, document.activeElement === element);
  }, [binding, value]);

  return (
    <textarea
      ref={ref}
      className="note-text"
      aria-label={label}
      onFocus={() => {
        onFocusChange?.(true);
      }}
      onBlur={() => {
        onFocusChange?.(false);
      }}
      onChange={(event) => {
        binding.input(event.currentTarget);
      }}
      onCompositionStart={() => {
        binding.compositionStart();
      }}
      onCompositionEnd={(event) => {
        const element = event.currentTarget;
        binding.compositionEnd(element, document.activeElement === element);
      }}
    />
  );
}
