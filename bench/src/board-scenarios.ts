import { Board, NOTE_COLORS, createManualClock, replicaId, type BoardOp } from '@driftboard/crdt';
import { createRng, type Rng } from './rng';
import { editScript } from './text-scenarios';

export interface BoardSize {
  readonly notes: number;
  /** Characters typed into each note (deleted ones included, so the text ends up a little shorter). */
  readonly charsPerNote: number;
}

const WORD_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Words of 2 to 9 letters, `length` characters in all. */
export function sentence(rng: Rng, length: number): string {
  let text = '';
  while (text.length < length) {
    const word = Array.from({ length: 2 + rng.int(8) }, () => WORD_LETTERS[rng.int(26)]).join('');
    text += `${word} `;
  }
  return text.slice(0, length);
}

/**
 * The operation log of a board of `size.notes` notes with long texts, as one author made it: every
 * note is created, typed into in sessions of 10 to 80 characters at random places, now and then
 * with a few characters deleted, and moved. This is what a server stores and a client loads.
 */
export function buildBoardOps(seed: number, size: BoardSize): BoardOp[] {
  const rng = createRng(seed);
  const clock = createManualClock(1_700_000_000_000);
  const board = new Board({ replicaId: replicaId('author'), clock });
  for (let n = 0; n < size.notes; n += 1) {
    clock.advance(1000);
    const { id } = board.createNote({
      x: rng.int(5000),
      y: rng.int(5000),
      color: rng.pick(NOTE_COLORS),
    });
    let typed = 0;
    let length = 0;
    while (typed < size.charsPerNote) {
      const run = Math.min(size.charsPerNote - typed, 10 + rng.int(70));
      board.editText(id, rng.int(length + 1), 0, sentence(rng, run));
      length += run;
      typed += run;
      if (length > 5 && rng.chance(0.3)) {
        const count = 1 + rng.int(5);
        board.editText(id, rng.int(length - count + 1), count, '');
        length -= count;
      }
    }
    if (rng.chance(0.5)) board.moveNote(id, rng.int(5000), rng.int(5000));
  }
  return [...board.log];
}

/**
 * The operations of one person typing into one note a key at a time, as the app writes them: every
 * key is a character inserted or erased and the note put again. `keystrokes` keys, from the same
 * script as the text benchmarks.
 */
export function typingOps(seed: number, keystrokes: number): BoardOp[] {
  const clock = createManualClock(1_700_000_000_000);
  const board = new Board({ replicaId: replicaId('typist'), clock });
  const { id, ops } = board.createNote({ x: 120, y: 80, color: 'yellow' });
  const log = [...ops];
  for (const { index, deleteCount, insert } of editScript(seed, keystrokes)) {
    clock.advance(40);
    log.push(...board.editText(id, index, deleteCount, insert));
  }
  return log;
}

/** A client that opens the board from its operation log. */
export function loadBoard(ops: readonly BoardOp[]): Board {
  const board = new Board({ replicaId: replicaId('viewer'), clock: createManualClock() });
  board.applyRemote(ops);
  return board;
}

/** Reads every note the way the screen does; returns the number of characters shown. */
export function readEverything(board: Board): number {
  let shown = 0;
  for (const note of board.notes()) shown += note.text.length;
  return shown;
}
