import { describe, expect, it } from 'vitest';
import { placeCaretIn } from './caret';

/** Enough of a textarea to see where the caret was put and whether it was given the focus. */
function textarea(value: string) {
  const calls: string[] = [];
  const area = {
    value,
    focus: (options?: { preventScroll?: boolean }) => {
      calls.push(`focus${options?.preventScroll === true ? ' without scrolling' : ''}`);
    },
    setSelectionRange: (start: number, end: number) => {
      calls.push(`select ${start}-${end}`);
    },
  };
  return { area: area as unknown as HTMLTextAreaElement, calls };
}

const caretAt = (value: string, fraction: number): string | undefined => {
  const { area, calls } = textarea(value);
  placeCaretIn(area, fraction);
  return calls.find((call) => call.startsWith('select'));
};

describe('placeCaretIn', () => {
  it('puts the caret at the start, the end and a fraction of the way along', () => {
    expect(caretAt('abcdefghij', 0)).toBe('select 0-0');
    expect(caretAt('abcdefghij', 1)).toBe('select 10-10');
    expect(caretAt('abcdefghij', 0.5)).toBe('select 5-5');
    expect(caretAt('abcdefghij', 0.25)).toBe('select 3-3');
  });

  it('puts the caret at 0 in an empty text', () => {
    expect(caretAt('', 0)).toBe('select 0-0');
    expect(caretAt('', 1)).toBe('select 0-0');
  });

  it('gives the textarea the focus, without scrolling, before the caret is put', () => {
    const { area, calls } = textarea('abc');
    placeCaretIn(area, 1);
    expect(calls).toEqual(['focus without scrolling', 'select 3-3']);
  });

  it('never puts the caret between the two halves of a character outside the basic plane', () => {
    // "a😀b" is four units long: a, the two halves of the emoji, b.
    expect('a😀b'.length).toBe(4);
    expect(caretAt('a😀b', 0.5)).toBe('select 1-1');
    expect(caretAt('a😀b', 0.25)).toBe('select 1-1');
    expect(caretAt('a😀b', 0.75)).toBe('select 3-3');
    expect(caretAt('a😀b', 1)).toBe('select 4-4');
    expect(caretAt('a😀b', 0)).toBe('select 0-0');
  });

  it('keeps the caret off the middle of every emoji in a row of them', () => {
    const text = '😀😀😀😀';
    for (let step = 0; step <= 20; step += 1) {
      const call = caretAt(text, step / 20);
      const index = Number(/select (\d+)-/.exec(call ?? '')?.[1]);
      expect(index % 2).toBe(0);
    }
  });

  it('leaves a caret between two characters of the basic plane, such as é, alone', () => {
    expect(caretAt('éé', 0.5)).toBe('select 1-1');
  });
});
