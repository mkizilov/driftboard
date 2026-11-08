import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  INITIAL_VIEWPORT,
  MAX_SCALE,
  MIN_SCALE,
  applyWheel,
  clampScale,
  panBy,
  screenDeltaToWorld,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Viewport,
  type WheelInput,
} from './viewport';

const close = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

const coordinate = fc.integer({ min: -1000, max: 1000 });
const viewports = fc.record({
  x: coordinate,
  y: coordinate,
  scale: fc.constantFrom(0.2, 0.5, 1, 1.5, 2, 3),
});
const points = fc.record({ x: coordinate, y: coordinate });

const wheel = (overrides: Partial<WheelInput>): WheelInput => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  clientX: 0,
  clientY: 0,
  ...overrides,
});
const canvas = { left: 0, top: 0 };

describe('coordinates', () => {
  it('draws a board point at world * scale + offset', () => {
    expect(worldToScreen({ x: 10, y: -20, scale: 2 }, { x: 3, y: 4 })).toEqual({ x: 16, y: -12 });
    expect(screenToWorld({ x: 10, y: -20, scale: 2 }, { x: 16, y: -12 })).toEqual({ x: 3, y: 4 });
  });

  it('converts back and forth without loss', () => {
    fc.assert(
      fc.property(viewports, points, (viewport, point) => {
        const back = screenToWorld(viewport, worldToScreen(viewport, point));
        return close(back.x, point.x) && close(back.y, point.y);
      }),
      { numRuns: 1000 },
    );
  });

  it('scales a drag distance to board units', () => {
    expect(screenDeltaToWorld({ x: 0, y: 0, scale: 2 }, { x: 10, y: -4 })).toEqual({ x: 5, y: -2 });
    expect(screenDeltaToWorld(INITIAL_VIEWPORT, { x: 10, y: -4 })).toEqual({ x: 10, y: -4 });
  });
});

describe('panBy and clampScale', () => {
  it('moves the camera and leaves the zoom alone', () => {
    expect(panBy({ x: 1, y: 2, scale: 1.5 }, 10, -5)).toEqual({ x: 11, y: -3, scale: 1.5 });
  });

  it('keeps the scale within the limits', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(100)).toBe(MAX_SCALE);
    expect(clampScale(1.25)).toBe(1.25);
  });
});

describe('zoomAt', () => {
  it('keeps the board point under the anchor where it is', () => {
    fc.assert(
      fc.property(
        viewports,
        points,
        fc.constantFrom(0.5, 0.9, 1.1, 1.5, 2),
        (viewport, anchor, factor) => {
          const zoomed = zoomAt(viewport, factor, anchor);
          const before = screenToWorld(viewport, anchor);
          const after = screenToWorld(zoomed, anchor);
          return close(before.x, after.x) && close(before.y, after.y);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('multiplies the scale and stays within the limits', () => {
    expect(zoomAt(INITIAL_VIEWPORT, 2, { x: 0, y: 0 }).scale).toBe(2);
    expect(zoomAt(INITIAL_VIEWPORT, 100, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
    expect(zoomAt(INITIAL_VIEWPORT, 0.001, { x: 0, y: 0 }).scale).toBe(MIN_SCALE);
  });

  it('returns the very same viewport when the limit is reached', () => {
    const atMax: Viewport = { x: 5, y: 6, scale: MAX_SCALE };
    expect(zoomAt(atMax, 2, { x: 100, y: 100 })).toBe(atMax);
  });
});

describe('applyWheel', () => {
  it('pans in the direction the content should move', () => {
    expect(applyWheel(INITIAL_VIEWPORT, wheel({ deltaX: 4, deltaY: 10 }), canvas)).toEqual({
      x: -4,
      y: -10,
      scale: 1,
    });
  });

  it('reads line and page deltas in pixels', () => {
    expect(applyWheel(INITIAL_VIEWPORT, wheel({ deltaY: 2, deltaMode: 1 }), canvas).y).toBe(-32);
    expect(applyWheel(INITIAL_VIEWPORT, wheel({ deltaY: 1, deltaMode: 2 }), canvas).y).toBe(-400);
  });

  it('zooms with Ctrl (or a pinch) and with Cmd, in on scroll up and out on scroll down', () => {
    const zoomIn = applyWheel(INITIAL_VIEWPORT, wheel({ deltaY: -50, ctrlKey: true }), canvas);
    const zoomOut = applyWheel(INITIAL_VIEWPORT, wheel({ deltaY: 50, metaKey: true }), canvas);
    expect(zoomIn.scale).toBeGreaterThan(1);
    expect(zoomOut.scale).toBeLessThan(1);
  });

  it('does not pan while zooming', () => {
    const zoomed = applyWheel(
      INITIAL_VIEWPORT,
      wheel({ deltaX: 30, deltaY: -50, ctrlKey: true }),
      canvas,
    );
    const anchored = screenToWorld(zoomed, { x: 0, y: 0 });
    expect(close(anchored.x, 0) && close(anchored.y, 0)).toBe(true);
  });

  it('zooms around the pointer, measured from the canvas corner', () => {
    const rect = { left: 20, top: 10 };
    const viewport: Viewport = { x: 15, y: -5, scale: 1 };
    const input = wheel({ deltaY: -80, ctrlKey: true, clientX: 220, clientY: 110 });
    const anchor = { x: 200, y: 100 };
    const zoomed = applyWheel(viewport, input, rect);
    expect(zoomed.scale).toBeGreaterThan(1);
    const before = screenToWorld(viewport, anchor);
    const after = screenToWorld(zoomed, anchor);
    expect(close(before.x, after.x) && close(before.y, after.y)).toBe(true);
  });

  it('cannot zoom past the limits', () => {
    const far = applyWheel(INITIAL_VIEWPORT, wheel({ deltaY: -5000, ctrlKey: true }), canvas);
    expect(far.scale).toBe(MAX_SCALE);
  });
});
