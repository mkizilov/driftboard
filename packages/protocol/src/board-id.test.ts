import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BOARD_ID_BYTES,
  encodeBase64Url,
  generateBoardId,
  isValidBoardId,
} from './board-id';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** An independent way to encode: write out the bits and read them six at a time. */
function reference(bytes: Uint8Array): string {
  const bits = [...bytes].map((byte) => byte.toString(2).padStart(8, '0')).join('');
  let text = '';
  for (let index = 0; index < bits.length; index += 6) {
    text += ALPHABET.charAt(parseInt(bits.slice(index, index + 6).padEnd(6, '0'), 2));
  }
  return text;
}

describe('encodeBase64Url', () => {
  it('encodes the standard test vectors without padding', () => {
    const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
    expect(encodeBase64Url(bytes(''))).toBe('');
    expect(encodeBase64Url(bytes('f'))).toBe('Zg');
    expect(encodeBase64Url(bytes('fo'))).toBe('Zm8');
    expect(encodeBase64Url(bytes('foo'))).toBe('Zm9v');
    expect(encodeBase64Url(bytes('foob'))).toBe('Zm9vYg');
    expect(encodeBase64Url(bytes('foobar'))).toBe('Zm9vYmFy');
  });

  it('uses the URL-safe alphabet', () => {
    expect(encodeBase64Url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_');
  });

  it('matches the bit-by-bit reference for any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 40 }), (bytes) => {
        expect(encodeBase64Url(bytes)).toBe(reference(bytes));
      }),
    );
  });
});

describe('board ids', () => {
  it('are 22 valid characters built from the injected random bytes', () => {
    let requested = 0;
    const id = generateBoardId((length) => {
      requested = length;
      return new Uint8Array(length).fill(255);
    });
    expect(requested).toBe(BOARD_ID_BYTES);
    expect(id).toBe('_'.repeat(21) + 'w');
    expect(isValidBoardId(id)).toBe(true);
  });

  it('are always valid and as distinct as the bytes are', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: BOARD_ID_BYTES, maxLength: BOARD_ID_BYTES }),
        fc.uint8Array({ minLength: BOARD_ID_BYTES, maxLength: BOARD_ID_BYTES }),
        (a, b) => {
          const idA = generateBoardId(() => a);
          const idB = generateBoardId(() => b);
          expect(idA).toMatch(/^[A-Za-z0-9_-]{22}$/);
          expect(idA === idB).toBe(a.every((byte, i) => byte === b[i]));
        },
      ),
    );
  });

  it('refuses a random source that returns the wrong number of bytes', () => {
    expect(() => generateBoardId(() => new Uint8Array(8))).toThrow(RangeError);
  });

  it('accept 22 to 128 URL-safe characters and nothing else', () => {
    for (const length of [22, 64, 128]) expect(isValidBoardId('a'.repeat(length))).toBe(true);
    const almost = 'a'.repeat(21);
    const bad = ['', 'home', almost, 'a'.repeat(129)];
    for (const suffix of ['/', ' ', '\u00e9', '\n']) bad.push(`${almost}${suffix}`);
    for (const id of bad) expect(isValidBoardId(id)).toBe(false);
  });
});
