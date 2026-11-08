import { describe, expect, it } from 'vitest';
import {
  awaitSameBoards,
  describeDifference,
  noteIn,
  parseBoard,
  parseTranslate,
  sameBoards,
  type BoardNote,
  type RawNote,
} from './board';

const raw = (id: string, change: Partial<RawNote> = {}): RawNote => ({
  id,
  transform: 'translate(10px, 20px)',
  color: 'yellow',
  zIndex: '1',
  text: '',
  ...change,
});

const note = (id: string, change: Partial<BoardNote> = {}): BoardNote => ({
  id,
  x: 10,
  y: 20,
  color: 'yellow',
  z: 1,
  text: '',
  ...change,
});

describe('parseTranslate', () => {
  it('reads whole, negative and fractional positions', () => {
    expect(parseTranslate('translate(10px, 20px)')).toEqual({ x: 10, y: 20 });
    expect(parseTranslate('translate(-5px, 0px)')).toEqual({ x: -5, y: 0 });
    expect(parseTranslate('translate(1.5px,-2.25px)')).toEqual({ x: 1.5, y: -2.25 });
    expect(parseTranslate('  translate( 3px , 4px )  ')).toEqual({ x: 3, y: 4 });
  });

  it('refuses what is not a translate of two pixel lengths', () => {
    const bad = [
      '',
      'none',
      'translate(1px)',
      'translate(1, 2)',
      'translate(1px, 2px) scale(2)',
      'scale(1)',
    ];
    for (const transform of bad) {
      expect(() => parseTranslate(transform)).toThrow('translate');
    }
  });
});

describe('parseBoard', () => {
  it('parses every note and puts them in order of id', () => {
    const board = parseBoard([
      raw('b', { transform: 'translate(1px, 2px)', zIndex: '5', text: 'two', color: 'pink' }),
      raw('a', { text: 'one' }),
    ]);
    expect(board).toEqual([
      note('a', { text: 'one' }),
      note('b', { x: 1, y: 2, z: 5, text: 'two', color: 'pink' }),
    ]);
  });

  it('gives an empty board for no notes', () => {
    expect(parseBoard([])).toEqual([]);
  });

  it('refuses a note with no id or a stacking order that is not a number', () => {
    expect(() => parseBoard([raw('')])).toThrow('Not a note');
    expect(() => parseBoard([raw('a', { zIndex: 'auto' })])).toThrow('Not a note');
    expect(() => parseBoard([raw('a', { zIndex: '' })])).toThrow('Not a note');
  });
});

describe('sameBoards', () => {
  it('is true for no boards, one board and equal boards', () => {
    expect(sameBoards([])).toBe(true);
    expect(sameBoards([[note('a')]])).toBe(true);
    expect(sameBoards([[note('a')], [note('a')], [note('a')]])).toBe(true);
    expect(sameBoards([[], []])).toBe(true);
  });

  it('is false when any field of any note differs, or a note is missing', () => {
    const base = [note('a'), note('b')];
    for (const change of [{ x: 11 }, { y: 21 }, { color: 'blue' }, { z: 2 }, { text: 'x' }]) {
      expect(sameBoards([base, [note('a', change), note('b')]])).toBe(false);
    }
    expect(sameBoards([base, [note('a')]])).toBe(false);
    expect(sameBoards([[note('a')], base, [note('a')]])).toBe(false);
    expect(sameBoards([base, [...base].reverse()])).toBe(false);
  });
});

describe('describeDifference', () => {
  it('is empty when the boards are the same', () => {
    expect(describeDifference([])).toBe('');
    expect(describeDifference([[note('a')], [note('a')]])).toBe('');
  });

  it('names the field and both values for a note that differs', () => {
    const text = describeDifference([[note('a', { text: 'abc' })], [note('a', { text: 'abd' })]]);
    expect(text).toContain('context 1');
    expect(text).toContain('note a text is "abd", context 0 has "abc"');
  });

  it('names notes that are missing or extra', () => {
    const text = describeDifference([
      [note('a'), note('b')],
      [note('a'), note('c')],
    ]);
    expect(text).toContain('context 1: note b is missing');
    expect(text).toContain('context 1: note c is extra');
  });

  it('says which context differs, among several', () => {
    const text = describeDifference([[note('a')], [note('a')], [note('a', { x: 99 })]]);
    expect(text).not.toContain('context 1');
    expect(text).toContain('context 2: note a x is 99, context 0 has 10');
  });

  it('lists every field that differs', () => {
    const text = describeDifference([[note('a')], [note('a', { x: 1, color: 'pink' })]]);
    expect(text.split('\n')).toHaveLength(2);
  });
});

describe('noteIn', () => {
  it('finds a note by id', () => {
    const board = [note('a'), note('b', { text: 'two' })];
    expect(noteIn(board, 'b').text).toBe('two');
  });

  it('names the notes there are when the one asked for is not there', () => {
    expect(() => noteIn([note('a'), note('b')], 'c')).toThrow('Note c is not on the board');
    expect(() => noteIn([note('a'), note('b')], 'c')).toThrow('["a","b"]');
  });
});

describe('awaitSameBoards', () => {
  const quick = { intervalMs: 1, timeoutMs: 300 };

  /** A `read` that gives the next of `reads` each time, and the last one from then on. */
  const reading = (reads: BoardNote[][][]) => {
    let at = 0;
    const read = () => Promise.resolve(reads[Math.min(at++, reads.length - 1)] ?? []);
    return { read, count: () => at };
  };

  it('returns the board once it has been the same for three reads in a row', async () => {
    const same = [[note('a')], [note('a')]];
    const source = reading([same]);
    expect(await awaitSameBoards(source.read, quick)).toEqual([note('a')]);
    expect(source.count()).toBe(3);
  });

  it('waits through reads that differ', async () => {
    const apart = [[note('a')], [note('a', { text: 'late' })]];
    const together = [[note('a', { text: 'late' })], [note('a', { text: 'late' })]];
    const source = reading([apart, apart, together]);
    expect(await awaitSameBoards(source.read, quick)).toEqual([note('a', { text: 'late' })]);
    expect(source.count()).toBe(5);
  });

  it('starts counting again when the boards come apart in between', async () => {
    const apart = [[note('a')], [note('b')]];
    const together = [[note('a')], [note('a')]];
    const source = reading([together, together, apart, together]);
    await awaitSameBoards(source.read, quick);
    expect(source.count()).toBe(6);
  });

  it('asks for as many reads in a row as it is told to', async () => {
    const source = reading([[[note('a')], [note('a')]]]);
    await awaitSameBoards(source.read, { ...quick, stableReads: 1 });
    expect(source.count()).toBe(1);
  });

  it('says how the boards differ when they never come together', async () => {
    const apart = [[note('a', { x: 1 })], [note('a', { x: 2 })]];
    await expect(
      awaitSameBoards(reading([apart]).read, { intervalMs: 1, timeoutMs: 30 }),
    ).rejects.toThrow('note a x is 2, context 0 has 1');
  });

  it('says so when the boards match but keep changing', async () => {
    let at = 0;
    const flapping = () => {
      at += 1;
      return Promise.resolve(
        at % 2 === 0 ? [[note('a')], [note('a')]] : [[note('a')], [note('b')]],
      );
    };
    await expect(awaitSameBoards(flapping, { intervalMs: 1, timeoutMs: 30 })).rejects.toThrow(
      /still differ|3 reads in a row/,
    );
  });

  it('settles at once on no boards at all', async () => {
    expect(await awaitSameBoards(() => Promise.resolve([]), quick)).toEqual([]);
  });

  it('hands back a copy, not the page-read array', async () => {
    const board = [note('a')];
    const result = await awaitSameBoards(() => Promise.resolve([board, board]), quick);
    expect(result).toEqual(board);
    expect(result).not.toBe(board);
  });
});
