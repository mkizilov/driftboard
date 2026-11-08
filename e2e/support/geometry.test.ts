import { describe, expect, it } from 'vitest';
import {
  HEADER_GRAB_X,
  NOTE_SIZE,
  SPOTS,
  clampMove,
  freeSpot,
  noteAt,
  type Point,
} from './geometry';

const canvas = { width: 1280, height: 660 };

const overlaps = (note: Point, point: Point) =>
  point.x >= note.x &&
  point.x <= note.x + NOTE_SIZE.width &&
  point.y >= note.y &&
  point.y <= note.y + NOTE_SIZE.height;

describe('noteAt', () => {
  it('centres the note on the pointer', () => {
    expect(noteAt({ x: 300, y: 200 })).toEqual({ x: 190, y: 110 });
  });
});

describe('freeSpot', () => {
  it('uses the spot asked for when it is free', () => {
    const spot = freeSpot([], canvas, { fx: 0, fy: 0 });
    expect(spot).toEqual({ x: 122, y: 102 });
    const far = freeSpot([], canvas, { fx: 0.999, fy: 0.999 });
    expect(far?.x).toBeLessThanOrEqual(canvas.width - 122);
    expect(far?.y).toBeLessThanOrEqual(canvas.height - 102);
  });

  it('keeps the whole new note on the canvas, wherever it starts from', () => {
    for (let a = 0; a < 20; a += 1) {
      for (let b = 0; b < 20; b += 1) {
        const spot = freeSpot([], canvas, { fx: a / 20, fy: b / 20 });
        if (spot === null) throw new Error('an empty canvas always has a free spot');
        const note = noteAt(spot);
        expect(note.x).toBeGreaterThanOrEqual(0);
        expect(note.y).toBeGreaterThanOrEqual(0);
        expect(note.x + NOTE_SIZE.width).toBeLessThanOrEqual(canvas.width);
        expect(note.y + NOTE_SIZE.height).toBeLessThanOrEqual(canvas.height);
      }
    }
  });

  it('moves on from a spot that is over a note', () => {
    const first = must(freeSpot([], canvas, { fx: 0.5, fy: 0.5 }));
    const taken = noteAt(first);
    const second = must(freeSpot([taken], canvas, { fx: 0.5, fy: 0.5 }));
    expect(overlaps(taken, second)).toBe(false);
    expect(second).not.toEqual(first);
  });

  it('never returns a spot over a note, however many there are, or over the zoom buttons', () => {
    const notes: Point[] = [];
    for (let index = 0; index < 40; index += 1) {
      const spot = freeSpot(notes, canvas, { fx: (index * 0.137) % 1, fy: (index * 0.291) % 1 });
      if (spot === null) break;
      for (const note of notes) expect(overlaps(note, spot)).toBe(false);
      expect(spot.x >= canvas.width - 190 && spot.y >= canvas.height - 70).toBe(false);
      notes.push(noteAt(spot));
    }
    expect(notes.length).toBeGreaterThan(4);
  });

  it('gives up with null when the canvas is full, or too small for a note', () => {
    const everywhere: Point[] = [];
    for (let x = -200; x < canvas.width; x += 100) {
      for (let y = -200; y < canvas.height; y += 100) everywhere.push({ x, y });
    }
    expect(freeSpot(everywhere, canvas, { fx: 0.3, fy: 0.3 })).toBeNull();
    expect(freeSpot([], { width: 200, height: 100 }, { fx: 0, fy: 0 })).toBeNull();
  });

  it('stays out of the zoom buttons in the corner', () => {
    const spot = freeSpot([], canvas, { fx: 1 - 1e-9, fy: 1 - 1e-9 });
    expect(spot === null || !(spot.x >= canvas.width - 190 && spot.y >= canvas.height - 70)).toBe(true);
  });
});

describe('clampMove', () => {
  // Room for a note to sit anywhere from 0 to 780 across and from 0 to 420 down.
  const bounds = { width: NOTE_SIZE.width + 780, height: NOTE_SIZE.height + 420 };

  it('leaves a move that stays inside alone', () => {
    expect(clampMove({ x: 300, y: 200 }, { x: 100, y: -50 }, bounds)).toEqual({ x: 100, y: -50 });
    expect(clampMove({ x: 300, y: 200 }, { x: 0, y: 0 }, bounds)).toEqual({ x: 0, y: 0 });
  });

  it('lets a note go right up to every edge, and no further', () => {
    expect(clampMove({ x: 700, y: 200 }, { x: 80, y: 0 }, bounds)).toEqual({ x: 80, y: 0 });
    expect(clampMove({ x: 700, y: 200 }, { x: 81, y: 0 }, bounds)).toEqual({ x: 80, y: 0 });
    expect(clampMove({ x: 50, y: 200 }, { x: -50, y: 0 }, bounds)).toEqual({ x: -50, y: 0 });
    expect(clampMove({ x: 50, y: 200 }, { x: -500, y: 0 }, bounds)).toEqual({ x: -50, y: 0 });
    expect(clampMove({ x: 300, y: 400 }, { x: 0, y: 500 }, bounds)).toEqual({ x: 0, y: 20 });
    expect(clampMove({ x: 300, y: 30 }, { x: 0, y: -500 }, bounds)).toEqual({ x: 0, y: -30 });
  });

  it('pulls a note that is already partly outside back in', () => {
    expect(clampMove({ x: -40, y: 200 }, { x: 0, y: 0 }, bounds)).toEqual({ x: 40, y: 0 });
    expect(clampMove({ x: 300, y: 500 }, { x: 0, y: 10 }, bounds)).toEqual({ x: 0, y: -80 });
  });

  it('keeps the whole note on the canvas whatever the move', () => {
    for (let dx = -2000; dx <= 2000; dx += 250) {
      for (let dy = -2000; dy <= 2000; dy += 250) {
        const note = { x: 400, y: 150 };
        const moved = clampMove(note, { x: dx, y: dy }, bounds);
        expect(note.x + moved.x).toBeGreaterThanOrEqual(0);
        expect(note.x + moved.x + NOTE_SIZE.width).toBeLessThanOrEqual(bounds.width);
        expect(note.y + moved.y).toBeGreaterThanOrEqual(0);
        expect(note.y + moved.y + NOTE_SIZE.height).toBeLessThanOrEqual(bounds.height);
      }
    }
  });
});

describe('SPOTS', () => {
  // A window of the suite's size is 1280 by 720, less the bar above the canvas.
  const window = { width: 1280, height: 650 };
  const notes = Object.values(SPOTS).map(noteAt);

  it('puts the whole note on the canvas', () => {
    for (const note of notes) {
      expect(note.x).toBeGreaterThanOrEqual(0);
      expect(note.y).toBeGreaterThanOrEqual(0);
      expect(note.x + NOTE_SIZE.width).toBeLessThanOrEqual(window.width);
      expect(note.y + NOTE_SIZE.height).toBeLessThanOrEqual(window.height);
    }
  });

  it('keeps the notes from overlapping, with room to spare for grabbing a header', () => {
    for (const [index, a] of notes.entries()) {
      for (const b of notes.slice(index + 1)) {
        const apart =
          a.x + NOTE_SIZE.width < b.x ||
          b.x + NOTE_SIZE.width < a.x ||
          a.y + NOTE_SIZE.height < b.y ||
          b.y + NOTE_SIZE.height < a.y;
        expect(apart).toBe(true);
      }
    }
  });

  it('leaves the corner with the zoom buttons alone', () => {
    for (const spot of Object.values(SPOTS)) {
      expect(spot.x >= window.width - 190 && spot.y >= window.height - 70).toBe(false);
    }
  });

  it('has three spots', () => {
    expect(notes).toHaveLength(3);
  });
});

describe('HEADER_GRAB_X', () => {
  it('is inside the note, clear of the swatches at the left and the × button at the right', () => {
    expect(HEADER_GRAB_X).toBeGreaterThan(125);
    expect(HEADER_GRAB_X).toBeLessThan(NOTE_SIZE.width - 30);
  });
});

function must<T>(value: T | null): T {
  if (value === null) throw new Error('expected a value');
  return value;
}
