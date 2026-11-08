import { memo, useCallback, useEffect, type CSSProperties } from 'react';
import { NOTE_COLORS } from '@driftboard/crdt';
import { useNote } from '../hooks/use-board';
import { useNoteDrag } from '../hooks/gestures';
import { useEditors } from '../hooks/use-presence';
import type { BoardStore } from '../lib/board-store';
import { NOTE_HEIGHT, NOTE_WIDTH } from '../lib/layout';
import type { LivePresence } from '../lib/presence';
import type { TextEdit } from '../lib/text-binding';
import type { Viewport } from '../lib/viewport';
import { NoteTextArea } from './NoteTextArea';

export interface NoteCardProps {
  store: BoardStore;
  id: string;
  /** Who is here; the note shows who is editing it and tells the others when its own person is. */
  presence: LivePresence;
  /** The canvas's current camera; read when a drag starts, so zooming does not re-render notes. */
  viewportRef: { readonly current: Viewport };
}

/**
 * One sticky note. It subscribes to its own note and to the people editing it, and is memoised on
 * its props, which never change while the note stays on the board: so a change to another note, a
 * pan or a zoom, or someone's pointer moving, does not render it again.
 */
export const NoteCard = memo(function NoteCard({
  store,
  id,
  presence,
  viewportRef,
}: NoteCardProps) {
  const note = useNote(store, id);
  const editors = useEditors(presence.store, id);
  const { offset, handlers } = useNoteDrag(store, id, note?.x ?? 0, note?.y ?? 0, viewportRef);
  const onEdit = useCallback(
    (edit: TextEdit) => {
      store.editText(id, edit);
    },
    [store, id],
  );
  const onFocusChange = useCallback(
    (focused: boolean) => {
      if (focused) presence.startEditing(id);
      else presence.stopEditing(id);
    },
    [presence, id],
  );
  // A note that goes away, or a page that closes, with its person in it: they stop editing it. A
  // browser does not blur a focused element that is removed, and this card can stay mounted
  // (rendering nothing) after its note is deleted.
  const gone = note === undefined;
  useEffect(() => {
    if (gone) presence.stopEditing(id);
  }, [gone, presence, id]);
  useEffect(
    () => () => {
      presence.stopEditing(id);
    },
    [presence, id],
  );
  if (note === undefined) return null;

  const x = note.x + (offset?.x ?? 0);
  const y = note.y + (offset?.y ?? 0);
  return (
    <div
      className={['note', offset === null ? '' : 'dragging', editors.length === 0 ? '' : 'edited']
        .filter(Boolean)
        .join(' ')}
      data-color={note.color}
      data-note-id={id}
      role="group"
      aria-label="Sticky note"
      style={
        {
          width: NOTE_WIDTH,
          height: NOTE_HEIGHT,
          zIndex: note.z,
          transform: `translate(${x}px, ${y}px)`,
          '--editor': editors[0]?.color,
        } as CSSProperties
      }
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
      {editors.length > 0 && (
        <div className="note-editors">
          {editors.map((editor) => (
            <span
              key={editor.id}
              className="editor"
              data-editor={editor.id}
              style={{ '--peer': editor.color } as CSSProperties}
            >
              {editor.name} is editing
            </span>
          ))}
        </div>
      )}
      <NoteTextArea value={note.text} onEdit={onEdit} onFocusChange={onFocusChange} />
    </div>
  );
});
