export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** The size of a note on the board: `NOTE_WIDTH` and `NOTE_HEIGHT` in `apps/web/src/lib/layout.ts`. */
export const NOTE_SIZE: Size = { width: 220, height: 180 };

/**
 * How far from the left edge of a note its header can be taken hold of for a drag: past the six
 * colour swatches (they end about 122px in) and short of the × button (it starts about 190px in).
 */
export const HEADER_GRAB_X = 155;

/** The zoom buttons in a corner of the canvas, with room to spare. */
const ZOOM_CONTROLS: Size = { width: 190, height: 70 };

const MARGIN = 12;

/**
 * Spots on the canvas for a double-click that makes a note: a note centred on each fits in a window
 * of the size the suite uses, they do not overlap, and none is near the zoom buttons.
 */
export const SPOTS = {
  left: { x: 300, y: 250 },
  right: { x: 760, y: 250 },
  below: { x: 520, y: 520 },
} as const;

/** Where a note lands when its creator double-clicks at `click`: centred on the pointer. */
export function noteAt(click: Point): Point {
  return { x: click.x - NOTE_SIZE.width / 2, y: click.y - NOTE_SIZE.height / 2 };
}

function overNote(note: Point, point: Point): boolean {
  return (
    point.x >= note.x - MARGIN &&
    point.x <= note.x + NOTE_SIZE.width + MARGIN &&
    point.y >= note.y - MARGIN &&
    point.y <= note.y + NOTE_SIZE.height + MARGIN
  );
}

/**
 * A point of the canvas where a double-click makes a note: not over a note, not over the zoom
 * buttons, and far enough from the edges for the new note to fit. It starts from the fractions
 * `fx` and `fy` of the usable area and moves on by fixed steps until it finds one, or gives up
 * (`null`) when the canvas is full.
 */
export function freeSpot(
  notes: readonly Point[],
  canvas: Size,
  start: { readonly fx: number; readonly fy: number },
  attempts = 40,
): Point | null {
  const left = NOTE_SIZE.width / 2 + MARGIN;
  const top = NOTE_SIZE.height / 2 + MARGIN;
  const width = canvas.width - 2 * left;
  const height = canvas.height - 2 * top;
  if (width <= 0 || height <= 0) return null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const fx = (start.fx + attempt * 0.381966) % 1;
    const fy = (start.fy + attempt * 0.618034) % 1;
    const point = { x: Math.round(left + fx * width), y: Math.round(top + fy * height) };
    const underControls =
      point.x >= canvas.width - ZOOM_CONTROLS.width && point.y >= canvas.height - ZOOM_CONTROLS.height;
    if (!underControls && !notes.some((note) => overNote(note, point))) return point;
  }
  return null;
}

/**
 * `delta` cut short so that a note whose corner is at `note` ends up wholly inside `canvas`: a note
 * dragged out of sight cannot be dragged again, and that is not what is being tested.
 */
export function clampMove(note: Point, delta: Point, canvas: Size): Point {
  const fit = (start: number, move: number, room: number): number =>
    Math.min(Math.max(start + move, 0), room) - start;
  return {
    x: fit(note.x, delta.x, canvas.width - NOTE_SIZE.width),
    y: fit(note.y, delta.y, canvas.height - NOTE_SIZE.height),
  };
}
