import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { usePanDrag, useWheelZoom } from '../hooks/gestures';
import { useNoteIds } from '../hooks/use-board';
import type { BoardStore } from '../lib/board-store';
import { NOTE_HEIGHT, NOTE_WIDTH } from '../lib/layout';
import type { LivePresence } from '../lib/presence';
import {
  INITIAL_VIEWPORT,
  screenToWorld,
  zoomAt,
  type Point,
  type Viewport,
} from '../lib/viewport';
import { Cursors } from './Cursors';
import { NoteCard } from './NoteCard';

const GRID = 24;
const ZOOM_STEP = 1.25;

/**
 * The board: an infinite canvas you pan by dragging the background or scrolling and zoom with a
 * pinch, Ctrl/Cmd + scroll or the buttons. Double-click the background to add a note there.
 * Where the pointer is over the board is shown to the others, and theirs is shown here.
 */
export function Canvas({ store, presence }: { store: BoardStore; presence: LivePresence }) {
  const ids = useNoteIds(store);
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT);
  const viewportRef = useRef(viewport);
  const surface = useRef<HTMLDivElement>(null);
  /** The pointer's last position over the canvas, in pixels from its corner. */
  const pointer = useRef<Point | null>(null);

  useLayoutEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);
  // A view that moves under a still pointer puts the pointer over another part of the board.
  useEffect(() => {
    if (pointer.current !== null) presence.moveCursor(screenToWorld(viewport, pointer.current));
  }, [viewport, presence]);
  useWheelZoom(surface, setViewport);
  const pan = usePanDrag(setViewport);

  const trackPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    pointer.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    presence.moveCursor(screenToWorld(viewport, pointer.current));
  };

  const addNote = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const at = screenToWorld(viewport, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    store.createNote(Math.round(at.x - NOTE_WIDTH / 2), Math.round(at.y - NOTE_HEIGHT / 2));
  };

  const zoomFromCenter = (factor: number) => {
    const rect = surface.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setViewport((current) => zoomAt(current, factor, { x: rect.width / 2, y: rect.height / 2 }));
  };

  return (
    <div
      ref={surface}
      className="canvas"
      data-testid="canvas"
      onDoubleClick={addNote}
      onPointerDown={pan.onPointerDown}
      onPointerMove={(event) => {
        pan.onPointerMove(event);
        trackPointer(event);
      }}
      onPointerLeave={() => {
        pointer.current = null;
        presence.moveCursor(null);
      }}
      onPointerUp={pan.onPointerUp}
      onPointerCancel={pan.onPointerCancel}
      style={{
        backgroundSize: `${GRID * viewport.scale}px ${GRID * viewport.scale}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
    >
      <div
        className="world"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
        }}
      >
        {ids.map((id) => (
          <NoteCard key={id} store={store} id={id} presence={presence} viewportRef={viewportRef} />
        ))}
      </div>
      <Cursors store={presence.store} viewport={viewport} />
      {ids.length === 0 && <p className="empty-hint">Double-click anywhere to add a note</p>}
      <div className="zoom-controls" role="group" aria-label="Zoom">
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => {
            zoomFromCenter(1 / ZOOM_STEP);
          }}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Reset zoom"
          onClick={() => {
            setViewport(INITIAL_VIEWPORT);
          }}
        >
          {Math.round(viewport.scale * 100)}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => {
            zoomFromCenter(ZOOM_STEP);
          }}
        >
          +
        </button>
      </div>
    </div>
  );
}
