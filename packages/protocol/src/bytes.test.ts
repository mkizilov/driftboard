import { describe, expect, it } from 'vitest';
import { BinaryFormatError, ByteReader, ByteWriter } from './bytes';

const written = (write: (writer: ByteWriter) => void): Uint8Array => {
  const writer = new ByteWriter();
  write(writer);
  return writer.finish();
};

const BOUNDARIES = [
  0, 1, 127, 128, 255, 256, 16_383, 16_384, 2 ** 21 - 1, 2 ** 21, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1,
  2 ** 32, 2 ** 35, 2 ** 49, 2 ** 53 - 1,
];

describe('varints', () => {
  it('round-trip every size boundary', () => {
    for (const value of BOUNDARIES) {
      const bytes = written((w) => {
        w.varint(value);
      });
      expect(new ByteReader(bytes).varint()).toBe(value);
    }
  });

  it('take one byte under 128, two under 16,384, three under 2,097,152', () => {
    const size = (value: number) =>
      written((w) => {
        w.varint(value);
      }).length;
    expect([0, 127, 128, 16_383, 16_384, 2_097_151, 2_097_152].map(size)).toEqual([1, 1, 2, 2, 3, 3, 4]);
    expect(size(2 ** 53 - 1)).toBe(8);
  });

  it('refuse what is not an unsigned whole number below 2^53', () => {
    const writer = new ByteWriter();
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => {
        writer.varint(bad);
      }).toThrow(RangeError);
    }
  });

  it('are read back in sequence, and the reader says how much is left', () => {
    const bytes = written((w) => {
      w.varint(300);
      w.varint(5);
      w.varint(70_000);
    });
    const reader = new ByteReader(bytes);
    expect(reader.remaining).toBe(bytes.length);
    expect([reader.varint(), reader.varint(), reader.varint()]).toEqual([300, 5, 70_000]);
    expect(reader.remaining).toBe(0);
  });

  it('are refused when the data stops in the middle, or runs on too long, or is too big', () => {
    expect(() => new ByteReader(new Uint8Array([0x80])).varint()).toThrow(BinaryFormatError);
    expect(() => new ByteReader(new Uint8Array([])).varint()).toThrow(BinaryFormatError);
    const endless = new Uint8Array(9).fill(0x80);
    expect(() => new ByteReader(endless).varint()).toThrow('too long');
    const huge = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    expect(() => new ByteReader(huge).varint()).toThrow('too large');
  });
});

describe('zigzag numbers', () => {
  it('round-trip both signs, with small magnitudes in few bytes', () => {
    for (const value of [0, -1, 1, -2, 2, 63, -64, 64, -65, 2 ** 40, -(2 ** 40), 2 ** 51, -(2 ** 51)]) {
      const bytes = written((w) => {
        w.zigzag(value);
      });
      expect(new ByteReader(bytes).zigzag()).toBe(value);
    }
    const size = (value: number) =>
      written((w) => {
        w.zigzag(value);
      }).length;
    expect([0, -1, 63, -64, 64, -65].map(size)).toEqual([1, 1, 1, 1, 2, 2]);
  });
});

describe('float64', () => {
  it('round-trips awkward numbers exactly, whatever offset it is written at', () => {
    for (const value of [0, -0.5, 0.1, Math.PI, 1e300, -1e-300, Number.MAX_VALUE, Number.MIN_VALUE]) {
      const bytes = written((w) => {
        w.byte(7);
        w.float64(value);
        w.varint(9);
      });
      const reader = new ByteReader(bytes);
      expect(reader.byte()).toBe(7);
      expect(reader.float64()).toBe(value);
      expect(reader.varint()).toBe(9);
    }
  });

  it('is refused when fewer than eight bytes are left', () => {
    expect(() => new ByteReader(new Uint8Array(7)).float64()).toThrow(BinaryFormatError);
  });
});

describe('strings', () => {
  it('are a count and one varint per UTF-16 unit: a byte each for ASCII, lossless for the rest', () => {
    for (const text of ['', 'abc', '3@a1b2c3d4', 'é', 'naïve café', '😀 and 😀', 'lone \ud800 surrogate']) {
      const bytes = written((w) => {
        w.string(text);
      });
      expect(new ByteReader(bytes).string(200)).toBe(text);
    }
    expect(
      written((w) => {
        w.string('abc');
      }),
    ).toHaveLength(4);
  });

  it('are refused when longer than allowed, or when a unit is beyond 16 bits', () => {
    const bytes = written((w) => {
      w.string('abcdef');
    });
    expect(() => new ByteReader(bytes).string(5)).toThrow('longer than 5');
    const wide = written((w) => {
      w.varint(1);
      w.varint(0x10000);
    });
    expect(() => new ByteReader(wide).string(10)).toThrow('beyond 16 bits');
  });

  it('are refused when the data stops in the middle', () => {
    const bytes = written((w) => {
      w.string('abcdef');
    });
    expect(() => new ByteReader(bytes.slice(0, 4)).string(10)).toThrow(BinaryFormatError);
  });
});

describe('ByteWriter', () => {
  it('grows as needed and hands back exactly what was written', () => {
    const writer = new ByteWriter();
    for (let i = 0; i < 5000; i += 1) writer.varint(i);
    expect(writer.length).toBeGreaterThan(256);
    const reader = new ByteReader(writer.finish());
    for (let i = 0; i < 5000; i += 1) expect(reader.varint()).toBe(i);
    expect(reader.remaining).toBe(0);
  });

  it('finishes with a copy that later writes do not change', () => {
    const writer = new ByteWriter();
    writer.byte(1);
    const first = writer.finish();
    writer.byte(2);
    expect(Array.from(first)).toEqual([1]);
    expect(Array.from(writer.finish())).toEqual([1, 2]);
  });
});
