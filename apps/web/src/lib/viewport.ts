/**
 * The pan-and-zoom camera over the board. A point of the board ("world" coordinates) is drawn at
 * `world * scale + (x, y)` in screen pixels measured from the canvas's top-left corner.
 */
export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 3;
export const INITIAL_VIEWPORT: Viewport = { x: 0, y: 0, scale: 1 };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function screenToWorld(viewport: Viewport, point: Point): Point {
  return { x: (point.x - viewport.x) / viewport.scale, y: (point.y - viewport.y) / viewport.scale };
}

export function worldToScreen(viewport: Viewport, point: Point): Point {
  return { x: point.x * viewport.scale + viewport.x, y: point.y * viewport.scale + viewport.y };
}

/** Moves the camera by `dx`, `dy` screen pixels, as when dragging the background. */
export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

/**
 * Multiplies the zoom by `factor` (within the limits), keeping the point under `anchor` still.
 */
export function zoomAt(viewport: Viewport, factor: number, anchor: Point): Viewport {
  const scale = clampScale(viewport.scale * factor);
  if (scale === viewport.scale) return viewport;
  const ratio = scale / viewport.scale;
  return {
    x: anchor.x - (anchor.x - viewport.x) * ratio,
    y: anchor.y - (anchor.y - viewport.y) * ratio,
    scale,
  };
}

/** The part of a wheel event the camera needs. */
export interface WheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages. */
  readonly deltaMode: number;
  /** Set for a pinch gesture on a trackpad, and when the user holds Ctrl or Cmd. */
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly clientX: number;
  readonly clientY: number;
}

const PIXELS_PER_LINE = 16;
const PIXELS_PER_PAGE = 400;
const ZOOM_SPEED = 0.01;

/** Scrolling pans; pinching or Ctrl/Cmd + scrolling zooms around the pointer. */
export function applyWheel(
  viewport: Viewport,
  wheel: WheelInput,
  canvas: { readonly left: number; readonly top: number },
): Viewport {
  const unit =
    wheel.deltaMode === 1 ? PIXELS_PER_LINE : wheel.deltaMode === 2 ? PIXELS_PER_PAGE : 1;
  const dx = wheel.deltaX * unit;
  const dy = wheel.deltaY * unit;
  if (wheel.ctrlKey || wheel.metaKey) {
    const anchor = { x: wheel.clientX - canvas.left, y: wheel.clientY - canvas.top };
    return zoomAt(viewport, Math.exp(-dy * ZOOM_SPEED), anchor);
  }
  return panBy(viewport, -dx, -dy);
}

/** How far a drag of `delta` screen pixels moves something on the board. */
export function screenDeltaToWorld(viewport: Viewport, delta: Point): Point {
  return { x: delta.x / viewport.scale, y: delta.y / viewport.scale };
}
