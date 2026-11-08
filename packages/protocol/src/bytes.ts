/** The bytes are not a valid binary encoding (cut short, out of range, or not what was promised). */
export class BinaryFormatError extends Error {
  override readonly name = 'BinaryFormatError';
}

/**
 * Writes unsigned integers as varints (LEB128: seven bits per byte, the high bit saying "more
 * follows"), so a number under 128 takes one byte, under 16,384 two, and so on. Whole numbers up to
 * 2^53 are handled with arithmetic rather than bit operations, which only reach 32 bits.
 */
export class ByteWriter {
  #bytes = new Uint8Array(256);
  #length = 0;

  get length(): number {
    return this.#length;
  }

  #reserve(extra: number): void {
    if (this.#length + extra <= this.#bytes.length) return;
    let size = this.#bytes.length * 2;
    while (size < this.#length + extra) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = bigger;
  }

  byte(value: number): void {
    this.#reserve(1);
    this.#bytes[this.#length] = value;
    this.#length += 1;
  }

  /** A whole number from 0 to 2^53 - 1. */
  varint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Not an unsigned whole number: ${value}`);
    }
    this.#reserve(8);
    let rest = value;
    while (rest >= 0x80) {
      this.#bytes[this.#length] = rest % 0x80 | 0x80;
      this.#length += 1;
      rest = Math.floor(rest / 0x80);
    }
    this.#bytes[this.#length] = rest;
    this.#length += 1;
  }

  /** A whole number of either sign, with small magnitudes in few bytes (zigzag: 0, -1, 1, -2, ...). */
  zigzag(value: number): void {
    this.varint(value >= 0 ? value * 2 : -value * 2 - 1);
  }

  float64(value: number): void {
    this.#reserve(8);
    new DataView(this.#bytes.buffer, this.#length, 8).setFloat64(0, value, true);
    this.#length += 8;
  }

  /** The UTF-16 units of `text`, as a count and then a varint each: one byte for ASCII. */
  string(text: string): void {
    this.varint(text.length);
    for (let i = 0; i < text.length; i += 1) this.varint(text.charCodeAt(i));
  }

  finish(): Uint8Array {
    return this.#bytes.slice(0, this.#length);
  }
}

/** Reads what `ByteWriter` wrote, and throws `BinaryFormatError` for anything that does not fit. */
export class ByteReader {
  readonly #bytes: Uint8Array;
  #at = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  /** Bytes not read yet. */
  get remaining(): number {
    return this.#bytes.length - this.#at;
  }

  byte(): number {
    const value = this.#bytes[this.#at];
    if (value === undefined) throw new BinaryFormatError('The data ends in the middle of a value');
    this.#at += 1;
    return value;
  }

  varint(): number {
    let result = 0;
    let scale = 1;
    for (let read = 0; read < 8; read += 1) {
      const byte = this.byte();
      result += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        if (!Number.isSafeInteger(result)) throw new BinaryFormatError('A number is too large');
        return result;
      }
      scale *= 0x80;
    }
    throw new BinaryFormatError('A number is too long');
  }

  zigzag(): number {
    const value = this.varint();
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }

  float64(): number {
    if (this.remaining < 8) throw new BinaryFormatError('The data ends in the middle of a value');
    const value = new DataView(this.#bytes.buffer, this.#bytes.byteOffset + this.#at, 8).getFloat64(
      0,
      true,
    );
    this.#at += 8;
    return value;
  }

  /** Inverse of `ByteWriter.string`; refuses one longer than `maxLength` units. */
  string(maxLength: number): string {
    const length = this.varint();
    if (length > maxLength) throw new BinaryFormatError(`A string is longer than ${maxLength}`);
    let text = '';
    for (let i = 0; i < length; i += 1) {
      const unit = this.varint();
      if (unit > 0xffff) throw new BinaryFormatError('A string has a unit beyond 16 bits');
      text += String.fromCharCode(unit);
    }
    return text;
  }
}
