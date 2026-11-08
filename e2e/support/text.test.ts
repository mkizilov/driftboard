import { describe, expect, it } from 'vitest';
import { only } from './text';

describe('only', () => {
  it('keeps the characters of the alphabet, in the order they come', () => {
    expect(only('a1b2c3', 'abc')).toBe('abc');
    expect(only('a1b2c3', '123')).toBe('123');
    expect(only('cba', 'abc')).toBe('cba');
  });

  it('keeps repeats and drops everything else', () => {
    expect(only('aXaYa', 'a')).toBe('aaa');
    expect(only('xyz', 'abc')).toBe('');
    expect(only('', 'abc')).toBe('');
    expect(only('abc', '')).toBe('');
  });

  it('counts a character outside the basic plane as one character', () => {
    expect(only('a😀b😀', '😀')).toBe('😀😀');
    expect(only('a😀b', 'ab')).toBe('ab');
  });

  it('is case sensitive and takes spaces and punctuation like any other character', () => {
    expect(only('Hello, World', 'lo')).toBe('llool');
    expect(only('a b  c', ' ')).toBe('   ');
    expect(only('a!b?', '!?')).toBe('!?');
  });
});
