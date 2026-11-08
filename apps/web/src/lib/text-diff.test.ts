import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyDiff, countCodePoints, diffText } from './text-diff';

describe('countCodePoints', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(countCodePoints('')).toBe(0);
    expect(countCodePoints('abc')).toBe(3);
    expect(countCodePoints('😀')).toBe(1);
    expect(countCodePoints('a😀b')).toBe(3);
  });

  it('counts a lone surrogate as one, like [...text]', () => {
    expect(countCodePoints('\ud83d')).toBe(1);
    expect(countCodePoints('\ude00')).toBe(1);
    expect(countCodePoints('\ude00\ud83d')).toBe(2);
    expect(countCodePoints('\ud83d\ud83d')).toBe(2);
  });
});

describe('diffText', () => {
  it('returns null for equal texts', () => {
    expect(diffText('', '')).toBeNull();
    expect(diffText('same', 'same')).toBeNull();
  });

  it('finds an insertion at the end, the start and the middle', () => {
    expect(diffText('hello', 'hello world')).toEqual({
      start: 5,
      deleteCount: 0,
      insert: ' world',
      unitStart: 5,
      unitDeleteCount: 0,
      unitInsertLength: 6,
    });
    expect(diffText('world', 'hello world')).toMatchObject({
      start: 0,
      deleteCount: 0,
      insert: 'hello ',
    });
    expect(diffText('ac', 'abc')).toMatchObject({ start: 1, deleteCount: 0, insert: 'b' });
  });

  it('finds a deletion', () => {
    expect(diffText('abcdef', 'abef')).toMatchObject({ start: 2, deleteCount: 2, insert: '' });
    expect(diffText('abc', '')).toMatchObject({ start: 0, deleteCount: 3, insert: '' });
  });

  it('reports a replacement, such as a paste over a selection, as one edit', () => {
    expect(diffText('one two three', 'one 2 three')).toMatchObject({
      start: 4,
      deleteCount: 3,
      insert: '2',
    });
  });

  it('trims as much as it can from the front when characters repeat', () => {
    expect(diffText('aa', 'aaa')).toMatchObject({ start: 2, deleteCount: 0, insert: 'a' });
    expect(diffText('aaa', 'aa')).toMatchObject({ start: 2, deleteCount: 1, insert: '' });
    expect(diffText('abab', 'ab')).toMatchObject({ start: 2, deleteCount: 2, insert: '' });
  });

  it('counts the start in code points and also gives UTF-16 units', () => {
    expect(diffText('x😀y', 'x😀yz')).toEqual({
      start: 3,
      deleteCount: 0,
      insert: 'z',
      unitStart: 4,
      unitDeleteCount: 0,
      unitInsertLength: 1,
    });
    expect(diffText('a😀b', 'a😀😀b')).toEqual({
      start: 2,
      deleteCount: 0,
      insert: '😀',
      unitStart: 3,
      unitDeleteCount: 0,
      unitInsertLength: 2,
    });
  });

  it('never cuts a surrogate pair in half at the front', () => {
    // Both emoji start with the same high surrogate.
    expect(diffText('a😀', 'a😁')).toEqual({
      start: 1,
      deleteCount: 1,
      insert: '😁',
      unitStart: 1,
      unitDeleteCount: 2,
      unitInsertLength: 2,
    });
  });

  it('never cuts a surrogate pair in half at the back', () => {
    // These two characters end with the same low surrogate.
    expect(diffText('\ud83d\ude00', '\ud83e\ude00')).toEqual({
      start: 0,
      deleteCount: 1,
      insert: '\ud83e\ude00',
      unitStart: 0,
      unitDeleteCount: 2,
      unitInsertLength: 2,
    });
  });

  it('turns a lone high surrogate into the full character it starts', () => {
    expect(diffText('x\ud83d', 'x😀')).toMatchObject({ start: 1, deleteCount: 1, insert: '😀' });
  });
});

describe('diffText properties', () => {
  // Includes astral characters and lone surrogates that can join into pairs when texts are edited.
  const anyText = fc
    .array(fc.constantFrom('a', 'b', ' ', '\n', 'é', '😀', '😁', '\ud83d', '\ude00'), {
      maxLength: 12,
    })
    .map((parts) => parts.join(''));
  const plainText = fc
    .array(fc.constantFrom('a', 'b', ' ', '\n', 'é'), { maxLength: 12 })
    .map((parts) => parts.join(''));

  it('applying the diff to the old text gives the new text', () => {
    fc.assert(
      fc.property(anyText, anyText, (oldText, newText) => {
        const diff = diffText(oldText, newText);
        if (diff === null) return oldText === newText;
        return applyDiff(oldText, diff) === newText;
      }),
      { numRuns: 1000 },
    );
  });

  it('is the same edit when counted in code points, as Board.editText counts', () => {
    fc.assert(
      fc.property(anyText, anyText, (oldText, newText) => {
        const diff = diffText(oldText, newText);
        if (diff === null) return true;
        const characters = [...oldText];
        characters.splice(diff.start, diff.deleteCount, ...diff.insert);
        return characters.join('') === newText;
      }),
      { numRuns: 1000 },
    );
  });

  it('leaves the text before and after the change untouched', () => {
    fc.assert(
      fc.property(anyText, anyText, (oldText, newText) => {
        const diff = diffText(oldText, newText);
        if (diff === null) return true;
        const afterOld = diff.unitStart + diff.unitDeleteCount;
        const afterNew = diff.unitStart + diff.unitInsertLength;
        return (
          diff.unitInsertLength === diff.insert.length &&
          oldText.slice(0, diff.unitStart) === newText.slice(0, diff.unitStart) &&
          oldText.slice(afterOld) === newText.slice(afterNew)
        );
      }),
      { numRuns: 1000 },
    );
  });

  it('is null exactly when the texts are equal', () => {
    fc.assert(
      fc.property(anyText, anyText, (oldText, newText) => {
        return (diffText(oldText, newText) === null) === (oldText === newText);
      }),
      { numRuns: 1000 },
    );
  });

  it('is as small as prefix and suffix trimming allows', () => {
    fc.assert(
      fc.property(plainText, plainText, (oldText, newText) => {
        const diff = diffText(oldText, newText);
        if (diff === null) return true;
        const removed = oldText.slice(diff.unitStart, diff.unitStart + diff.unitDeleteCount);
        if (removed === '' || diff.insert === '') return true;
        return removed[0] !== diff.insert[0] && removed.at(-1) !== diff.insert.at(-1);
      }),
      { numRuns: 1000 },
    );
  });

  it('turns one inserted character into an insertion of exactly that character', () => {
    fc.assert(
      fc.property(plainText, fc.constantFrom('a', 'b', 'é'), fc.nat(12), (text, char, at) => {
        const index = Math.min(at, text.length);
        const diff = diffText(text, text.slice(0, index) + char + text.slice(index));
        return diff !== null && diff.deleteCount === 0 && diff.insert === char;
      }),
      { numRuns: 1000 },
    );
  });

  it('turns one deleted character into a deletion of exactly one character', () => {
    fc.assert(
      fc.property(
        plainText.filter((text) => text.length > 0),
        fc.nat(12),
        (text, at) => {
          const index = at % text.length;
          const diff = diffText(text, text.slice(0, index) + text.slice(index + 1));
          return diff !== null && diff.deleteCount === 1 && diff.insert === '';
        },
      ),
      { numRuns: 1000 },
    );
  });
});
