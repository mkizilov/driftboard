/**
 * Access to a board is by its id alone, so the id is a capability: anyone who knows it can read and
 * write the board, and the server never lists ids. Accepted ids are 22 to 128 URL-safe characters
 * (22 characters of random base64url carry 128 bits), which rejects short or guessable names.
 */
export const BOARD_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

/** Random bytes in a generated board id: 128 bits. */
export const BOARD_ID_BYTES = 16;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function isValidBoardId(value: string): boolean {
  return BOARD_ID_PATTERN.test(value);
}

/** Unpadded base64url, the same as `Buffer.from(bytes).toString('base64url')`. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const group = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    text += ALPHABET.charAt((group >> 18) & 63) + ALPHABET.charAt((group >> 12) & 63);
    if (second !== undefined) text += ALPHABET.charAt((group >> 6) & 63);
    if (third !== undefined) text += ALPHABET.charAt(group & 63);
  }
  return text;
}

/**
 * A fresh board id from caller-supplied random bytes (`crypto.getRandomValues` in the browser,
 * `crypto.randomBytes` on the server), as 22 base64url characters.
 */
export function generateBoardId(randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(BOARD_ID_BYTES);
  if (bytes.length !== BOARD_ID_BYTES) {
    throw new RangeError(`randomBytes must return ${BOARD_ID_BYTES} bytes, got ${bytes.length}`);
  }
  return encodeBase64Url(bytes);
}
