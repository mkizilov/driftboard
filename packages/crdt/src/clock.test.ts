import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createManualClock } from './clock';

describe('createManualClock', () => {
  it('starts at the given time and defaults to zero', () => {
    expect(createManualClock().now()).toBe(0);
    expect(createManualClock(42).now()).toBe(42);
  });

  it('set replaces the current time', () => {
    const clock = createManualClock(10);
    clock.set(5);
    expect(clock.now()).toBe(5);
  });

  it('advance accumulates the sum of all steps', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 1_000_000 })), (steps) => {
        const clock = createManualClock();
        for (const step of steps) clock.advance(step);
        expect(clock.now()).toBe(steps.reduce((a, b) => a + b, 0));
      }),
    );
  });
});
