import { describe, expect, it } from 'vitest';
import { createRng, seedFrom } from './rng';

describe('createRng', () => {
  it('gives the same numbers for the same seed, and others for another seed', () => {
    const run = (seed: number) => {
      const rng = createRng(seed);
      return Array.from({ length: 20 }, () => rng.next());
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });

  it('gives numbers from 0 up to, not including, 1', () => {
    const rng = createRng(1);
    for (let index = 0; index < 5000; index += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('gives integers below the bound, and every one of them', () => {
    const rng = createRng(2);
    const seen = new Set<number>();
    for (let index = 0; index < 2000; index += 1) {
      const value = rng.int(6);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(6);
      seen.add(value);
    }
    expect(seen.size).toBe(6);
  });

  it('refuses a bound that is not a positive integer', () => {
    const rng = createRng(3);
    for (const bound of [0, -1, 1.5, Number.NaN]) {
      expect(() => rng.int(bound)).toThrow(RangeError);
    }
    expect(rng.int(1)).toBe(0);
  });

  it('picks from a list, every item of it, and refuses an empty one', () => {
    const rng = createRng(4);
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) seen.add(rng.pick(['a', 'b', 'c']));
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it('chooses with probability in proportion to the weights', () => {
    const rng = createRng(5);
    const counts = { often: 0, rarely: 0, never: 0 };
    for (let index = 0; index < 10_000; index += 1) {
      counts[rng.weighted([['often', 9], ['rarely', 1], ['never', 0]] as const)] += 1;
    }
    expect(counts.never).toBe(0);
    expect(counts.often).toBeGreaterThan(8700);
    expect(counts.often).toBeLessThan(9300);
    expect(counts.rarely).toBeGreaterThan(700);
  });

  it('refuses weights that cannot be chosen from', () => {
    const rng = createRng(6);
    expect(() => rng.weighted([])).toThrow(RangeError);
    expect(() => rng.weighted([['a', 0]])).toThrow(RangeError);
    expect(() => rng.weighted([['a', -1], ['b', 3]])).toThrow(RangeError);
  });
});

describe('seedFrom', () => {
  it('reads an integer seed, and uses the fallback when there is none', () => {
    expect(seedFrom('12345', 9)).toBe(12345);
    expect(seedFrom('0', 9)).toBe(0);
    expect(seedFrom('4294967295', 9)).toBe(4294967295);
    expect(seedFrom(undefined, 9)).toBe(9);
    expect(seedFrom('', 9)).toBe(9);
    expect(seedFrom('  ', 9)).toBe(9);
  });

  it('refuses anything that is not an integer in range, saying what it was', () => {
    for (const raw of ['abc', '1.5', '-1', '4294967296', 'NaN']) {
      expect(() => seedFrom(raw, 9)).toThrow('E2E_SEED');
    }
    expect(() => seedFrom('abc', 9)).toThrow('"abc"');
  });
});
