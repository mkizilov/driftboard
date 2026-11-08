import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LamportClock } from './lamport';
import { compareOpIds, opId, type OpId } from './op-id';
import { replicaId } from './replica-id';
import { must } from './test-support';

const a = replicaId('a');
const b = replicaId('b');

describe('LamportClock', () => {
  it('issues consecutive counters starting at 1', () => {
    const clock = new LamportClock(a);
    expect(clock.tick()).toEqual({ counter: 1, replicaId: 'a' });
    expect(clock.tick()).toEqual({ counter: 2, replicaId: 'a' });
    expect(clock.counter).toBe(2);
  });

  it('resumes from a restored counter', () => {
    expect(new LamportClock(a, 41).tick().counter).toBe(42);
  });

  it('rejects an invalid initial counter', () => {
    expect(() => new LamportClock(a, -1)).toThrow(RangeError);
    expect(() => new LamportClock(a, 1.5)).toThrow(RangeError);
  });

  it('observe jumps ahead of a remote id but never goes backwards', () => {
    const clock = new LamportClock(a);
    clock.observe(opId(10, b));
    expect(clock.tick().counter).toBe(11);
    clock.observe(opId(3, b));
    expect(clock.tick().counter).toBe(12);
  });

  it('refuses to overflow', () => {
    const clock = new LamportClock(a, Number.MAX_SAFE_INTEGER);
    expect(() => clock.tick()).toThrow(RangeError);
  });

  it('keeps ids unique and respects happened-before across replicas', () => {
    const step = fc.record({
      from: fc.constantFrom(0, 1, 2),
      to: fc.constantFrom(0, 1, 2),
      deliver: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        const clocks = [a, b, replicaId('c')].map((id) => new LamportClock(id));
        const seen = new Set<string>();
        const known: OpId[][] = [[], [], []];
        for (const { from, to, deliver } of steps) {
          const sender = must(clocks[from]);
          const issued = sender.tick();
          // Everything the sender knew about so far precedes the new op.
          for (const earlier of must(known[from])) {
            expect(compareOpIds(earlier, issued)).toBe(-1);
          }
          must(known[from]).push(issued);
          const key = `${issued.counter}@${issued.replicaId}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
          if (deliver) {
            must(clocks[to]).observe(issued);
            must(known[to]).push(...must(known[from]));
          }
        }
      }),
    );
  });
});
