import { describe, expect, it } from 'vitest';
import { MONKEY_WEIGHTS, NOTE_COLOR_NAMES, planMonkey, type MonkeyKind } from './monkey-plan';

const kinds = MONKEY_WEIGHTS.map(([kind]) => kind);

describe('planMonkey', () => {
  it('makes the number of actions asked for', () => {
    expect(planMonkey(1, 200, 3)).toHaveLength(200);
    expect(planMonkey(1, 0, 3)).toEqual([]);
    expect(planMonkey(1, 1, 1)).toHaveLength(1);
  });

  it('makes the same plan from the same seed, and another from another seed', () => {
    expect(planMonkey(42, 200, 3)).toEqual(planMonkey(42, 200, 3));
    expect(planMonkey(42, 200, 3)).not.toEqual(planMonkey(43, 200, 3));
  });

  it('does not change the start of a plan when it is made longer', () => {
    expect(planMonkey(9, 300, 3).slice(0, 200)).toEqual(planMonkey(9, 200, 3));
  });

  it('has every kind of action in 200, whichever seed is tried', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const seen = new Set<MonkeyKind>(planMonkey(seed, 200, 3).map((step) => step.kind));
      expect([...seen].sort()).toEqual([...kinds].sort());
    }
  });

  it('is mostly typing, and typing is the most common thing', () => {
    const counts = new Map<MonkeyKind, number>();
    for (const step of planMonkey(5, 5000, 3))
      counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1);
    const typing = counts.get('type') ?? 0;
    expect(typing).toBeGreaterThan(5000 * 0.2);
    for (const [kind, count] of counts) if (kind !== 'type') expect(count).toBeLessThan(typing);
  });

  it('only involves the people there are', () => {
    for (const contexts of [1, 2, 3]) {
      const who = new Set<number>();
      for (const step of planMonkey(7, 400, contexts)) {
        if ('who' in step) {
          expect(step.who).toBeGreaterThanOrEqual(0);
          expect(step.who).toBeLessThan(contexts);
          who.add(step.who);
        }
      }
      expect(who.size).toBe(contexts);
    }
  });

  it('keeps every number in its range', () => {
    for (const step of planMonkey(11, 3000, 3)) {
      switch (step.kind) {
        case 'create':
          expect(step.fx).toBeGreaterThanOrEqual(0);
          expect(step.fx).toBeLessThan(1);
          expect(step.fy).toBeGreaterThanOrEqual(0);
          expect(step.fy).toBeLessThan(1);
          break;
        case 'type':
          expect(step.text.length).toBeGreaterThan(0);
          expect(step.caret).toBeGreaterThanOrEqual(0);
          expect(step.caret).toBeLessThan(1);
          expect(Number.isInteger(step.pick)).toBe(true);
          expect(step.pick).toBeGreaterThanOrEqual(0);
          break;
        case 'erase':
          expect(step.count).toBeGreaterThanOrEqual(1);
          expect(step.count).toBeLessThanOrEqual(4);
          expect(step.caret).toBeLessThan(1);
          break;
        case 'move':
          expect(Math.abs(step.dx)).toBeLessThanOrEqual(200);
          expect(Math.abs(step.dy)).toBeLessThanOrEqual(200);
          break;
        case 'color':
          expect(NOTE_COLOR_NAMES).toContain(step.color);
          break;
        case 'pause':
          expect(step.ms).toBeGreaterThanOrEqual(50);
          expect(step.ms).toBeLessThanOrEqual(600);
          break;
        default:
          break;
      }
    }
  });

  it('types text that includes characters outside ASCII, and outside the basic plane', () => {
    const typed = planMonkey(3, 3000, 3).flatMap((step) =>
      step.kind === 'type' ? [step.text] : [],
    );
    expect(typed.some((text) => text.includes('é'))).toBe(true);
    expect(typed.some((text) => text.includes('😀'))).toBe(true);
    expect(typed.some((text) => text.includes(' '))).toBe(true);
  });

  it('refuses a count or a number of people that makes no sense', () => {
    expect(() => planMonkey(1, -1, 3)).toThrow(RangeError);
    expect(() => planMonkey(1, 1.5, 3)).toThrow(RangeError);
    expect(() => planMonkey(1, 10, 0)).toThrow(RangeError);
    expect(() => planMonkey(1, 10, 2.5)).toThrow(RangeError);
  });

  it('plans going offline and coming back, and reloads, so that they are tried', () => {
    const plan = planMonkey(1, 200, 3).map((step) => step.kind);
    for (const kind of ['offline', 'online', 'reload', 'undo', 'redo', 'delete'] as const) {
      expect(plan).toContain(kind);
    }
  });
});
