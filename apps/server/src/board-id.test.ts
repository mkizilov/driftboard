import { describe, expect, it } from 'vitest';
import { generateBoardId, isValidBoardId } from './board-id';

describe('board ids', () => {
  it('generates 22-character URL-safe ids that are valid and different every time', () => {
    const ids = Array.from({ length: 200 }, () => generateBoardId());
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(isValidBoardId(id)).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('accepts 22 to 128 URL-safe characters', () => {
    for (const length of [22, 64, 128]) expect(isValidBoardId('a'.repeat(length))).toBe(true);
    expect(isValidBoardId('Ab-_Cd-_Ef-_Gh-_Ij-_Kl')).toBe(true);
  });

  it('rejects short, long or unsafe ids, so a board cannot have a guessable name', () => {
    const almost = 'a'.repeat(21);
    const bad = ['', 'home', 'my-board', almost, 'a'.repeat(129)];
    for (const suffix of ['/', ' ', 'é', '\n']) bad.push(`${almost}${suffix}`);
    for (const id of bad) expect(isValidBoardId(id)).toBe(false);
  });
});
