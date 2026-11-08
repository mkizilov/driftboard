import { randomBytes } from 'node:crypto';

/**
 * Access to a board is by its id alone, so the id is a capability: anyone who knows it can read and
 * write the board, and the server never lists ids. Accepted ids are 22 to 128 URL-safe characters
 * (22 characters of random base64url carry 128 bits), which rejects short or guessable names.
 */
export const BOARD_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

export function isValidBoardId(value: string): boolean {
  return BOARD_ID_PATTERN.test(value);
}

/** A fresh random board id: 128 bits as 22 base64url characters. */
export function generateBoardId(): string {
  return randomBytes(16).toString('base64url');
}
