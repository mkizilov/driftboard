import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { BoardStore } from '../lib/board-store';
import {
  applyWheel,
  panBy,
  screenDeltaToWorld,
  type Point,
  type Viewport,
} from '../lib/viewport';

/** Scrolling pans the canvas; pinching or Ctrl/Cmd + scrolling zooms around the pointer. */
export function useWheelZoom(
  surface: RefObject<HTMLElement | null>,
  setViewport: Dispatch<SetStateAction<Viewport>>,
): void {
  useEffect(() => {
    const element = surface.current;
    if (element === null) return undefined;
    // By hand because React's wheel listeners are passive and cannot stop page scrolling.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      setViewport((current) => applyWheel(current, event, rect));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
    };
  }, [surface, setViewport]);
}

interface PointerStart {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

/** Dragging the empty canvas pans it. Returns the handlers for the canvas element. */
export function usePanDrag(setViewport: Dispatch<SetStateAction<Viewport>>) {
  const drag = useRef<PointerStart | null>(null);
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget || event.button !== 0) return;
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const start = drag.current;
      if (start === null || start.pointerId !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      drag.current = { pointerId: start.pointerId, x: event.clientX, y: event.clientY };
      setViewport((current) => panBy(current, dx, dy));
    },
    onPointerUp: end,
    onPointerCancel: end,
  };
}

/**
 * Dragging a note by its header. While dragging the note follows the pointer locally; the move is
 * written to the board once, when the pointer is released. `viewportRef` gives the zoom, so that a
 * drag moves the note by the same distance as the pointer whatever the zoom.
 */
export function useNoteDrag(
  store: BoardStore,
  id: string,
  x: number,
  y: number,
  viewportRef: { readonly current: Viewport },
) {
  const [offset, setOffset] = useState<Point | null>(null);
  const start = useRef<PointerStart | null>(null);

  const delta = (event: ReactPointerEvent<HTMLElement>, from: PointerStart): Point =>
    screenDeltaToWorld(viewportRef.current, {
      x: event.clientX - from.x,
      y: event.clientY - from.y,
    });

  return {
    offset,
    handlers: {
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        const target = event.target as HTMLElement;
        if (event.button !== 0 || target.closest('button') !== null) return;
        start.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const from = start.current;
        if (from === null || from.pointerId !== event.pointerId) return;
        setOffset(delta(event, from));
      },
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
        const from = start.current;
        if (from === null || from.pointerId !== event.pointerId) return;
        start.current = null;
        const moved = delta(event, from);
        setOffset(null);
        store.moveNote(id, Math.round(x + moved.x), Math.round(y + moved.y));
      },
      onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => {
        if (start.current?.pointerId === event.pointerId) {
          start.current = null;
          setOffset(null);
        }
      },
    },
  };
}
