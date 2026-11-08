import { memo, useCallback } from 'react';
import { NOTE_COLORS } from '@driftboard/crdt';
import { useNote } from '../hooks/use-board';
import { useNoteDrag } from '../hooks/gestures';
import type { BoardStore } from '../lib/board-store';
import { NOTE_HEIGHT, NOTE_WIDTH } from '../lib/layout';
import type { TextEdit } from '../lib/text-binding';
import type { Viewport } from '../lib/viewport';
import { NoteTextArea } from './NoteTextArea';

export interface NoteCardProps {
  store: BoardStore;
  id: string;
  /** The canvas's current camera; read when a drag starts, so zooming does not re-render notes. */
  viewportRef: { readonly current: Viewport };
}

/**
 * One sticky note. It subscribes to its own note only, and is memoised on its props, which never
 * change while the note stays on the board: so a change to another note, a pan or a zoom does not
 * render it again.
 */
export const NoteCard = memo(function NoteCard({ store, id, viewportRef }: NoteCardProps) {
  const note = useNote(store, id);
  const { offset, handlers } = useNoteDrag(store, id, note?.x ?? 0, note?.y ?? 0, viewportRef);
  const onEdit = useCallback(
    (edit: TextEdit) => {
      store.editText(id, edit);
    },
    [store, id],
  );
  if (note === undefined) return null;

  const x = note.x + (offset?.x ?? 0);
  const y = note.y + (offset?.y ?? 0);
  return (
    <div
      className={offset === null ? 'note' : 'note dragging'}
      data-color={note.color}
      data-note-id={id}
      role="group"
      aria-label="Sticky note"
      style={{
        width: NOTE_WIDTH,
        height: NOTE_HEIGHT,
        zIndex: note.z,
        transform: `translate(${x}px, ${y}px)`,
      }}
      onPointerDown={() => {
        store.bringToFront(id);
      }}
    >
      <div className="note-header" {...handlers}>
        <div className="note-colors" role="group" aria-label="Note color">
          {NOTE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className="swatch"
              data-color={color}
              aria-label={`Color ${color}`}
              aria-pressed={color === note.color}
              onClick={() => {
                store.setColor(id, color);
              }}
            />
          ))}
        </div>
        <button
          type="button"
          className="note-delete"
          aria-label="Delete note"
          onClick={() => {
            store.deleteNote(id);
          }}
        >
          ×
        </button>
      </div>
      <NoteTextArea value={note.text} onEdit={onEdit} />
    </div>
  );
});
