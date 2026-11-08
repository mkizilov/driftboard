/** A seeded random source (Mulberry32), so that every benchmark run builds the same workload. */
export interface Rng {
  /** A number from 0 up to, not including, 1. */
  next(): number;
  /** An integer from 0 up to, not including, `bound`. */
  int(bound: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (bound: number): number => Math.floor(next() * bound);
  return {
    next,
    int,
    chance: (probability) => next() < probability,
    pick: <T>(items: readonly T[]): T => {
      const item = items[int(items.length)];
      if (item === undefined) throw new RangeError('nothing to pick from');
      return item;
    },
  };
}
