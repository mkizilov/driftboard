import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createManualClock } from './clock';
import {
  HlcDriftError,
  HybridLogicalClock,
  MAX_LOGICAL,
  MAX_WALL_MS,
  compareHlc,
  formatHlc,
  hlcTimestamp,
  parseHlc,
  type HlcTimestamp,
} from './hlc';
import { replicaId } from './replica-id';
import { hlcTimestampArb, must, replicaIdArb } from './test-support';

const a = replicaId('a');
const b = replicaId('b');

function setup(startMs = 1000, maxDriftMs?: number) {
  const physicalClock = createManualClock(startMs);
  const clock = new HybridLogicalClock({
    replicaId: a,
    physicalClock,
    ...(maxDriftMs === undefined ? {} : { maxDriftMs }),
  });
  return { physicalClock, clock };
}

const ts = (wallMs: number, logical: number, replica = b): HlcTimestamp =>
  hlcTimestamp(wallMs, logical, replica);

const wl = (t: HlcTimestamp) => [t.wallMs, t.logical];

describe('HybridLogicalClock.tick', () => {
  it('follows the physical clock and resets the logical counter when time advances', () => {
    const { physicalClock, clock } = setup(1000);
    expect(wl(clock.tick())).toEqual([1000, 0]);
    physicalClock.advance(5);
    expect(wl(clock.tick())).toEqual([1005, 0]);
  });

  it('bumps the logical counter when the physical clock has not moved', () => {
    const { clock } = setup(1000);
    expect(wl(clock.tick())).toEqual([1000, 0]);
    expect(wl(clock.tick())).toEqual([1000, 1]);
    expect(wl(clock.tick())).toEqual([1000, 2]);
  });

  it('stamps its own replica id and exposes the latest timestamp', () => {
    const { clock } = setup();
    const issued = clock.tick();
    expect(issued.replicaId).toBe(a);
    expect(clock.latest).toEqual(issued);
  });

  it('never goes backwards when the physical clock jumps back', () => {
    const { physicalClock, clock } = setup(1000);
    const first = clock.tick();
    physicalClock.set(400);
    const second = clock.tick();
    const third = clock.tick();
    expect(wl(second)).toEqual([1000, 1]);
    expect(wl(third)).toEqual([1000, 2]);
    expect(compareHlc(first, second)).toBe(-1);
    expect(compareHlc(second, third)).toBe(-1);
  });

  it('resumes following the physical clock once it passes the held wall time', () => {
    const { physicalClock, clock } = setup(1000);
    clock.tick();
    physicalClock.set(400);
    clock.tick();
    physicalClock.set(1000);
    expect(wl(clock.tick())).toEqual([1000, 2]);
    physicalClock.set(1001);
    expect(wl(clock.tick())).toEqual([1001, 0]);
  });

  it('does not reissue or regress after a restart from a persisted timestamp', () => {
    const { clock } = setup(1000);
    const last = clock.tick();
    const restarted = new HybridLogicalClock({
      replicaId: a,
      physicalClock: createManualClock(10),
      initial: last,
    });
    expect(compareHlc(last, restarted.tick())).toBe(-1);
  });

  it('fails without changing state if the logical counter would overflow', () => {
    const physicalClock = createManualClock(1000);
    const clock = new HybridLogicalClock({
      replicaId: a,
      physicalClock,
      initial: ts(1000, MAX_LOGICAL, a),
    });
    expect(() => clock.tick()).toThrow(RangeError);
    expect(wl(clock.latest)).toEqual([1000, MAX_LOGICAL]);
    physicalClock.advance(1);
    expect(wl(clock.tick())).toEqual([1001, 0]);
  });

  it('rejects a physical clock that returns a non-integer or out-of-range value', () => {
    for (const bad of [-1, 1.5, Number.NaN, MAX_WALL_MS + 1]) {
      const { clock } = setup(bad);
      expect(() => clock.tick()).toThrow(RangeError);
    }
  });

  it('rejects an invalid maxDriftMs', () => {
    expect(() => setup(0, -1)).toThrow(RangeError);
    expect(() => setup(0, Number.NaN)).toThrow(RangeError);
  });
});

describe('HybridLogicalClock.receive', () => {
  it('adopts the remote wall time when it is ahead (within the drift limit)', () => {
    const { clock } = setup(1000);
    expect(wl(clock.receive(ts(1020, 4)))).toEqual([1020, 5]);
    expect(wl(clock.tick())).toEqual([1020, 6]);
  });

  it('bumps the local counter when the local wall time wins', () => {
    const { clock } = setup(1000);
    clock.tick();
    clock.tick();
    expect(wl(clock.receive(ts(900, 7)))).toEqual([1000, 2]);
  });

  it('takes the larger counter when local and remote wall times tie', () => {
    const { clock } = setup(1000);
    clock.tick();
    expect(wl(clock.receive(ts(1000, 9)))).toEqual([1000, 10]);
    expect(wl(clock.receive(ts(1000, 3)))).toEqual([1000, 11]);
  });

  it('resets the counter when the physical clock is ahead of both', () => {
    const { physicalClock, clock } = setup(1000);
    clock.tick();
    physicalClock.set(2000);
    expect(wl(clock.receive(ts(1500, 3)))).toEqual([2000, 0]);
  });

  it('rejects a remote timestamp beyond the drift limit and leaves state untouched', () => {
    const { clock } = setup(1000, 100);
    const before = clock.tick();
    expect(() => clock.receive(ts(1101, 0))).toThrow(HlcDriftError);
    expect(clock.latest).toEqual(before);
    expect(wl(clock.receive(ts(1100, 0)))).toEqual([1100, 1]);
  });

  it('measures drift against the physical clock, not the held wall time', () => {
    const { physicalClock, clock } = setup(1000, 100);
    clock.receive(ts(1100, 0));
    physicalClock.set(0);
    expect(() => clock.receive(ts(101, 0))).toThrow(HlcDriftError);
  });

  it('stays monotonic when the physical clock jumps back between receives', () => {
    const { physicalClock, clock } = setup(5000);
    const first = clock.receive(ts(5050, 1));
    physicalClock.set(10);
    const second = clock.receive(ts(20, 0));
    expect(compareHlc(first, second)).toBe(-1);
    expect(second.wallMs).toBe(5050);
  });
});

describe('HLC timestamp format', () => {
  it('encodes fixed-width hex fields', () => {
    expect(formatHlc(ts(255, 16, a))).toBe('0000000000ff-0010-a');
    expect(formatHlc(ts(MAX_WALL_MS, MAX_LOGICAL, a))).toBe('ffffffffffff-ffff-a');
  });

  it('round-trips through parseHlc', () => {
    fc.assert(
      fc.property(hlcTimestampArb, (t) => {
        expect(parseHlc(formatHlc(t))).toEqual(t);
      }),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_WALL_MS }),
        fc.integer({ min: 0, max: MAX_LOGICAL }),
        replicaIdArb,
        (wall, logical, replica) => {
          const t = hlcTimestamp(wall, logical, replica);
          expect(parseHlc(formatHlc(t))).toEqual(t);
        },
      ),
    );
  });

  it('sorts as strings exactly like compareHlc', () => {
    fc.assert(
      fc.property(hlcTimestampArb, hlcTimestampArb, (x, y) => {
        const sx = formatHlc(x);
        const sy = formatHlc(y);
        expect(sx < sy ? -1 : sx > sy ? 1 : 0).toBe(compareHlc(x, y));
      }),
    );
  });

  it('rejects malformed text and out-of-range fields', () => {
    for (const bad of ['', 'x', '0-0-a', '000000000000-0000-', '000000000000-0000-a b', 'ZZ']) {
      expect(() => parseHlc(bad)).toThrow(RangeError);
    }
    expect(() => hlcTimestamp(-1, 0, a)).toThrow(RangeError);
    expect(() => hlcTimestamp(0, MAX_LOGICAL + 1, a)).toThrow(RangeError);
    expect(() => hlcTimestamp(0.5, 0, a)).toThrow(RangeError);
  });
});

describe('compareHlc', () => {
  it('orders by wall time, then counter, then replica id', () => {
    expect(compareHlc(ts(1, 9), ts(2, 0))).toBe(-1);
    expect(compareHlc(ts(2, 1), ts(2, 2))).toBe(-1);
    expect(compareHlc(ts(2, 2, a), ts(2, 2, b))).toBe(-1);
    expect(compareHlc(ts(2, 2, b), ts(2, 2, b))).toBe(0);
  });

  it('is a total order', () => {
    fc.assert(
      fc.property(hlcTimestampArb, hlcTimestampArb, hlcTimestampArb, (x, y, z) => {
        expect(compareHlc(x, x)).toBe(0);
        expect(compareHlc(x, y)).toBe(-compareHlc(y, x) || 0);
        if (compareHlc(x, y) <= 0 && compareHlc(y, z) <= 0) {
          expect(compareHlc(x, z)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });
});

describe('HybridLogicalClock properties', () => {
  type Step =
    | { kind: 'tick' }
    | { kind: 'set'; ms: number }
    | { kind: 'advance'; ms: number }
    | { kind: 'receive'; remote: HlcTimestamp };

  const stepArb: fc.Arbitrary<Step> = fc.oneof(
    fc.constant<Step>({ kind: 'tick' }),
    fc.integer({ min: 0, max: 3000 }).map<Step>((ms) => ({ kind: 'set', ms })),
    fc.integer({ min: 0, max: 50 }).map<Step>((ms) => ({ kind: 'advance', ms })),
    fc
      .tuple(fc.integer({ min: 0, max: 3500 }), fc.integer({ min: 0, max: 20 }), replicaIdArb)
      .map<Step>(([wall, logical, replica]) => ({
        kind: 'receive',
        remote: hlcTimestamp(wall, logical, replica),
      })),
  );

  it('issues strictly increasing timestamps whatever the physical clock does', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3000 }),
        fc.array(stepArb, { maxLength: 60 }),
        (start, steps) => {
          const physicalClock = createManualClock(start);
          const clock = new HybridLogicalClock({
            replicaId: a,
            physicalClock,
            maxDriftMs: 500,
          });
          let previous = clock.latest;
          let highestWall = start;
          for (const step of steps) {
            let issued: HlcTimestamp | undefined;
            if (step.kind === 'set') physicalClock.set(step.ms);
            else if (step.kind === 'advance') physicalClock.advance(step.ms);
            else if (step.kind === 'tick') issued = clock.tick();
            else {
              try {
                issued = clock.receive(step.remote);
                highestWall = Math.max(highestWall, step.remote.wallMs);
                expect(compareHlc(issued, step.remote)).toBe(1);
              } catch (error) {
                if (!(error instanceof HlcDriftError)) throw error;
                expect(clock.latest).toEqual(previous);
                continue;
              }
            }
            highestWall = Math.max(highestWall, physicalClock.now());
            if (issued !== undefined) {
              expect(compareHlc(previous, issued)).toBe(-1);
              expect(issued.wallMs).toBeLessThanOrEqual(highestWall);
              expect(issued.wallMs).toBeGreaterThanOrEqual(physicalClock.now());
              previous = issued;
            }
          }
        },
      ),
    );
  });

  it('keeps timestamps unique across replicas and orders effects after causes', () => {
    const messageArb = fc.record({
      from: fc.constantFrom(0, 1, 2),
      to: fc.constantFrom(0, 1, 2),
      jump: fc.integer({ min: -2000, max: 2000 }),
    });
    fc.assert(
      fc.property(fc.array(messageArb, { maxLength: 40 }), (messages) => {
        const physical = [0, 1, 2].map(() => createManualClock(5000));
        const clocks = ['a', 'b', 'c'].map(
          (id, i) =>
            new HybridLogicalClock({
              replicaId: replicaId(id),
              physicalClock: must(physical[i]),
              maxDriftMs: 100_000,
            }),
        );
        const seen = new Set<string>();
        for (const { from, to, jump } of messages) {
          must(physical[from]).set(Math.max(0, must(physical[from]).now() + jump));
          const sent = must(clocks[from]).tick();
          expect(seen.has(formatHlc(sent))).toBe(false);
          seen.add(formatHlc(sent));
          const received = must(clocks[to]).receive(sent);
          expect(compareHlc(sent, received)).toBe(-1);
          expect(seen.has(formatHlc(received))).toBe(false);
          seen.add(formatHlc(received));
        }
      }),
    );
  });
});
