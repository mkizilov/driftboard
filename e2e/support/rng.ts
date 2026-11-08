/** A seeded random source, so that a failing random run can be repeated from its seed. */
export interface Rng {
  /** A number from 0 up to, not including, 1. */
  next(): number;
  /** An integer from 0 up to, not including, `bound`. */
  int(bound: number): number;
  pick<T>(items: readonly T[]): T;
  /** One of the options, chosen with probability in proportion to its weight. */
  weighted<T>(options: readonly (readonly [T, number])[]): T;
}

/** Mulberry32: small, fast and good enough for choosing test actions. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (bound: number): number => {
    if (!Number.isInteger(bound) || bound < 1)
      throw new RangeError(`bound must be at least 1, got ${bound}`);
    return Math.floor(next() * bound);
  };
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => {
      const item = items[int(items.length)];
      if (item === undefined) throw new RangeError('nothing to pick from');
      return item;
    },
    weighted: <T>(options: readonly (readonly [T, number])[]): T => {
      const total = options.reduce((sum, [, weight]) => sum + weight, 0);
      if (options.length === 0 || !(total > 0) || options.some(([, weight]) => weight < 0)) {
        throw new RangeError('weights must be non-negative and not all zero');
      }
      let at = next() * total;
      for (const [value, weight] of options) {
        at -= weight;
        if (at < 0) return value;
      }
      const last = options.at(-1);
      if (last === undefined) throw new RangeError('nothing to pick from');
      return last[0];
    },
  };
}

/** The seed from `E2E_SEED` (an integer from 0 to 4294967295), or `fallback` if it is not set. */
export function seedFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`E2E_SEED must be an integer from 0 to 4294967295, got ${JSON.stringify(raw)}`);
  }
  return value;
}
