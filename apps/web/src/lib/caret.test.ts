import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyRemoteText, mapIndex } from './caret';
import { FakeTextarea } from './test-support';
import { diffText, type TextDiff } from './text-diff';

function change(from: string, to: string): TextDiff {
  const diff = diffText(from, to);
  if (diff === null) throw new Error('the texts are equal');
  return diff;
}

describe('mapIndex', () => {
  const insertion = change('hello world', 'hello big world'); // "big " goes in at 6
  const deletion = change('hello big world', 'hello world'); // "big " goes away at 6
  const replacement = change('hello world', 'hello there'); // "world" becomes "there" at 6

  it('keeps a caret in front of the change', () => {
    expect(mapIndex(0, insertion)).toBe(0);
    expect(mapIndex(5, deletion)).toBe(5);
    expect(mapIndex(3, replacement)).toBe(3);
  });

  it('keeps a caret at the start of an insertion in front of it', () => {
    expect(mapIndex(6, insertion)).toBe(6);
    expect(mapIndex(1, change('ab', 'aXb'))).toBe(1);
  });

  it('moves a caret behind the change along with the text', () => {
    expect(mapIndex(7, insertion)).toBe(11);
    expect(mapIndex(11, insertion)).toBe(15);
    expect(mapIndex(10, deletion)).toBe(6);
    expect(mapIndex(12, deletion)).toBe(8);
    expect(mapIndex(11, replacement)).toBe(11);
  });

  it('puts a caret inside replaced text at the end of what replaced it', () => {
    expect(mapIndex(8, replacement)).toBe(11);
    expect(mapIndex(8, deletion)).toBe(6);
  });

  it('counts in UTF-16 units', () => {
    // "😀" is two units wide.
    const emoji = change('ab', 'a😀b');
    expect(mapIndex(2, emoji)).toBe(4);
    expect(mapIndex(1, emoji)).toBe(1);
  });

  const anyText = fc
    .array(fc.constantFrom('a', 'b', ' ', 'é', '😀', '😁'), { maxLength: 10 })
    .map((parts) => parts.join(''));

  it('never leaves the new text and never reorders two carets', () => {
    fc.assert(
      fc.property(anyText, anyText, fc.nat(30), fc.nat(30), (oldText, newText, a, b) => {
        const diff = diffText(oldText, newText);
        if (diff === null) return true;
        const first = Math.min(a % (oldText.length + 1), b % (oldText.length + 1));
        const second = Math.max(a % (oldText.length + 1), b % (oldText.length + 1));
        const mappedFirst = mapIndex(first, diff);
        const mappedSecond = mapIndex(second, diff);
        return mappedFirst >= 0 && mappedFirst <= mappedSecond && mappedSecond <= newText.length;
      }),
      { numRuns: 1000 },
    );
  });

  it('leaves what comes before the change alone and shifts what comes after by its size', () => {
    fc.assert(
      fc.property(anyText, anyText, fc.nat(30), (oldText, newText, at) => {
        const diff = diffText(oldText, newText);
        if (diff === null) return true;
        const index = at % (oldText.length + 1);
        const end = diff.unitStart + diff.unitDeleteCount;
        const mapped = mapIndex(index, diff);
        if (index <= diff.unitStart) return mapped === index;
        if (index >= end) return mapped === index - diff.unitDeleteCount + diff.unitInsertLength;
        return mapped === diff.unitStart + diff.unitInsertLength;
      }),
      { numRuns: 1000 },
    );
  });
});

describe('applyRemoteText', () => {
  it('shows why it exists: assigning a value throws the caret to the end', () => {
    const control = new FakeTextarea('hello world');
    control.select(2, 2);
    control.value = '>> hello world';
    expect(control.selectionStart).toBe(control.value.length);
  });

  it('does nothing when the text is the same', () => {
    const control = new FakeTextarea('hello');
    control.select(2, 2);
    applyRemoteText(control, 'hello', true);
    expect(control.selectionStart).toBe(2);
    expect(control.selectionCalls).toBe(0);
  });

  it('moves the caret along with the text around it', () => {
    const control = new FakeTextarea('hello world');
    control.select(8, 8);
    applyRemoteText(control, '>> hello world', true);
    expect(control.value).toBe('>> hello world');
    expect([control.selectionStart, control.selectionEnd]).toEqual([11, 11]);
  });

  it('keeps the caret still when the change is behind it', () => {
    const control = new FakeTextarea('hello world');
    control.select(2, 2);
    applyRemoteText(control, 'hello big world', true);
    expect([control.selectionStart, control.selectionEnd]).toEqual([2, 2]);
  });

  it('moves both ends of a selection and keeps its direction', () => {
    const control = new FakeTextarea('hello world');
    control.select(6, 11, 'backward');
    applyRemoteText(control, 'XYhello world', true);
    expect([control.selectionStart, control.selectionEnd]).toEqual([8, 13]);
    expect(control.selectionDirection).toBe('backward');
  });

  it('keeps the scroll position', () => {
    const control = new FakeTextarea('hello world');
    control.scrollTop = 40;
    applyRemoteText(control, 'hello big world', true);
    expect(control.scrollTop).toBe(40);
  });

  it('only updates the value when the control has no focus', () => {
    const control = new FakeTextarea('hello world');
    control.scrollTop = 40;
    applyRemoteText(control, 'hello big world', false);
    expect(control.value).toBe('hello big world');
    expect(control.selectionCalls).toBe(0);
    expect(control.scrollTop).toBe(40);
  });
});
