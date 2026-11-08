import { sleep } from './wait';

/** One note as the page shows it. */
export interface BoardNote {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly color: string;
  /** Stacking order: a larger value is drawn above a smaller one. */
  readonly z: number;
  readonly text: string;
}

/** What is read from the page for a note, before it is parsed. */
export interface RawNote {
  readonly id: string;
  /** The inline `transform` style, `translate(Xpx, Ypx)`. */
  readonly transform: string;
  readonly color: string;
  readonly zIndex: string;
  readonly text: string;
}

/** The position in a `translate(10px, -3.5px)` style. */
export function parseTranslate(transform: string): { x: number; y: number } {
  const match = /^translate\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px\s*\)$/.exec(
    transform.trim(),
  );
  if (match === null) {
    throw new Error(`Not a translate(Xpx, Ypx) transform: ${JSON.stringify(transform)}`);
  }
  return { x: Number(match[1]), y: Number(match[2]) };
}

const byId = (a: BoardNote, b: BoardNote): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The notes in a fixed order (by id), so that boards can be compared. */
export function parseBoard(raw: readonly RawNote[]): BoardNote[] {
  return raw
    .map((note): BoardNote => {
      const z = Number(note.zIndex);
      if (note.id === '' || note.zIndex.trim() === '' || !Number.isFinite(z)) {
        throw new Error(`Not a note: ${JSON.stringify(note)}`);
      }
      return { id: note.id, ...parseTranslate(note.transform), color: note.color, z, text: note.text };
    })
    .sort(byId);
}

/** The note with this id; an error, naming the notes there are, if it is not on the board. */
export function noteIn(board: readonly BoardNote[], id: string): BoardNote {
  const found = board.find((note) => note.id === id);
  if (found === undefined) {
    throw new Error(`Note ${id} is not on the board; it has ${JSON.stringify(board.map((n) => n.id))}`);
  }
  return found;
}

const FIELDS = ['x', 'y', 'color', 'z', 'text'] as const;

/** True if every board in the list shows exactly the same notes. */
export function sameBoards(boards: readonly (readonly BoardNote[])[]): boolean {
  const [first, ...others] = boards;
  if (first === undefined) return true;
  const expected = JSON.stringify(first);
  return others.every((board) => JSON.stringify(board) === expected);
}

/** Says how the other boards differ from the first one; an empty string if they do not. */
export function describeDifference(boards: readonly (readonly BoardNote[])[]): string {
  const [first, ...others] = boards;
  if (first === undefined) return '';
  const lines: string[] = [];
  others.forEach((board, offset) => {
    const who = `context ${offset + 1}`;
    const mine = new Map(first.map((note) => [note.id, note]));
    const theirs = new Map(board.map((note) => [note.id, note]));
    for (const id of mine.keys()) {
      if (!theirs.has(id)) lines.push(`${who}: note ${id} is missing`);
    }
    for (const id of theirs.keys()) {
      if (!mine.has(id)) lines.push(`${who}: note ${id} is extra`);
    }
    for (const [id, note] of mine) {
      const other = theirs.get(id);
      if (other === undefined) continue;
      for (const field of FIELDS) {
        if (note[field] !== other[field]) {
          lines.push(
            `${who}: note ${id} ${field} is ${JSON.stringify(other[field])}, context 0 has ${JSON.stringify(note[field])}`,
          );
        }
      }
    }
  });
  return lines.join('\n');
}

export interface SettleOptions {
  /** How long the boards have to become the same. */
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  /** How many reads in a row must show the same boards before they count as settled. */
  readonly stableReads?: number;
}

/**
 * Reads the boards until they are all the same, and the same for `stableReads` reads in a row (so
 * that two boards that agree by chance on the way to somewhere else do not count), and returns the
 * board. Throws, saying how they differ, if that does not happen in time.
 */
export async function awaitSameBoards(
  read: () => Promise<readonly (readonly BoardNote[])[]>,
  { timeoutMs = 30_000, intervalMs = 200, stableReads = 3 }: SettleOptions = {},
): Promise<BoardNote[]> {
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  for (;;) {
    const boards = await read();
    streak = sameBoards(boards) ? streak + 1 : 0;
    if (streak >= stableReads) return [...(boards[0] ?? [])];
    if (Date.now() >= deadline) {
      const difference = describeDifference(boards);
      throw new Error(
        difference === ''
          ? `The boards matched, but not ${stableReads} reads in a row, within ${timeoutMs} ms`
          : `The boards still differ after ${timeoutMs} ms:\n${difference}`,
      );
    }
    await sleep(intervalMs);
  }
}
