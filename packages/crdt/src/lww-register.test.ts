import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createManualClock } from './clock';
import { checkConvergence, type CheckableSpec } from './convergence';
import { HybridLogicalClock, formatHlc, hlcTimestamp } from './hlc';
import { LwwRegister, type LwwSetOp } from './lww-register';
import { replicaId } from './replica-id';
import { hlcTimestampArb } from './test-support';

const a = replicaId('a');
const b = replicaId('b');

const write = (value: string, wallMs: number, logical = 0, replica = a) =>
  LwwRegister.empty<string>().prepareSet(value, hlcTimestamp(wallMs, logical, replica));

// A register whose value is derived from its timestamp, so equal timestamps always carry equal values.
const registerArb = fc
  .array(hlcTimestampArb, { maxLength: 4 })
  .map((timestamps) =>
    timestamps.reduce(
      (register, timestamp) =>
        register.apply(register.prepareSet(formatHlc(timestamp), timestamp)),
      LwwRegister.empty<string>(),
    ),
  );

const view = (register: LwwRegister<string>) => [
  register.value ?? null,
  register.timestamp === undefined ? null : formatHlc(register.timestamp),
];

describe('LwwRegister', () => {
  it('starts empty', () => {
    const register = LwwRegister.empty<string>();
    expect(register.value).toBeUndefined();
    expect(register.timestamp).toBeUndefined();
  });

  it('keeps the write with the greater timestamp regardless of arrival order', () => {
    const old = write('old', 10);
    const recent = write('new', 11);
    const empty = LwwRegister.empty<string>();
    expect(empty.apply(old).apply(recent).value).toBe('new');
    expect(empty.apply(recent).apply(old).value).toBe('new');
  });

  it('breaks wall-time ties by logical counter, then by replica id', () => {
    const empty = LwwRegister.empty<string>();
    expect(empty.apply(write('x', 10, 1)).apply(write('y', 10, 2)).value).toBe('y');
    expect(empty.apply(write('y', 10, 2)).apply(write('x', 10, 1)).value).toBe('y');
    expect(empty.apply(write('from-a', 10, 0, a)).apply(write('from-b', 10, 0, b)).value).toBe(
      'from-b',
    );
    expect(empty.apply(write('from-b', 10, 0, b)).apply(write('from-a', 10, 0, a)).value).toBe(
      'from-b',
    );
  });

  it('returns the same instance when the op loses or repeats, and never mutates', () => {
    const op = write('v', 10);
    const register = LwwRegister.empty<string>().apply(op);
    expect(register.apply(op)).toBe(register);
    expect(register.apply(write('older', 9))).toBe(register);
    const empty = LwwRegister.empty<string>();
    empty.apply(op);
    expect(empty.value).toBeUndefined();
  });

  it('lets a write that observed another win even if its physical clock is behind', () => {
    const clockA = createManualClock(5000);
    const clockB = createManualClock(1000);
    const hlcA = new HybridLogicalClock({ replicaId: a, physicalClock: clockA });
    const hlcB = new HybridLogicalClock({ replicaId: b, physicalClock: clockB });
    const empty = LwwRegister.empty<string>();

    const first = empty.prepareSet('from-a', hlcA.tick());
    hlcB.receive(first.timestamp); // B has seen A's write...
    const second = empty.prepareSet('from-b', hlcB.tick()); // ...so B's later write must win.

    expect(empty.apply(first).apply(second).value).toBe('from-b');
    expect(empty.apply(second).apply(first).value).toBe('from-b');
  });

  it('survives the physical clock jumping backwards between two local writes', () => {
    const physicalClock = createManualClock(5000);
    const hlc = new HybridLogicalClock({ replicaId: a, physicalClock });
    const empty = LwwRegister.empty<string>();
    const first = empty.prepareSet('first', hlc.tick());
    physicalClock.set(100);
    const second = empty.prepareSet('second', hlc.tick());
    expect(empty.apply(second).apply(first).value).toBe('second');
  });
});

describe('LwwRegister.merge', () => {
  it('picks the write with the greater timestamp and ignores empty registers', () => {
    const x = LwwRegister.empty<string>().apply(write('x', 1));
    const y = LwwRegister.empty<string>().apply(write('y', 2));
    expect(x.merge(y).value).toBe('y');
    expect(y.merge(x).value).toBe('y');
    expect(x.merge(LwwRegister.empty<string>())).toBe(x);
    expect(LwwRegister.empty<string>().merge(x)).toBe(x);
  });

  it('is commutative, associative and idempotent', () => {
    fc.assert(
      fc.property(registerArb, registerArb, registerArb, (x, y, z) => {
        expect(view(x.merge(y))).toEqual(view(y.merge(x)));
        expect(view(x.merge(y).merge(z))).toEqual(view(x.merge(y.merge(z))));
        expect(view(x.merge(x))).toEqual(view(x));
      }),
    );
  });

  it('agrees with applying the other side\'s write', () => {
    fc.assert(
      fc.property(registerArb, hlcTimestampArb, (x, timestamp) => {
        const op = x.prepareSet(formatHlc(timestamp), timestamp);
        const other = LwwRegister.empty<string>().apply(op);
        expect(view(x.apply(op))).toEqual(view(x.merge(other)));
      }),
    );
  });
});

describe('LwwRegister convergence harness', () => {
  const spec: CheckableSpec<LwwRegister<number>, LwwSetOp<number>, number> = {
    name: 'LwwRegister',
    intentArb: fc.integer({ min: 0, max: 9 }),
    idempotentApply: true,
    create: () => LwwRegister.empty<number>(),
    prepare: (state, value, ctx) => [state.prepareSet(value, ctx.clock.tick())],
    apply: (state, op) => state.apply(op),
    merge: (x, y) => x.merge(y),
    observe: (ctx, op) => {
      ctx.clock.receive(op.timestamp);
    },
    snapshot: (state) =>
      state.timestamp === undefined ? null : [state.value ?? null, formatHlc(state.timestamp)],
  };

  it('converges over 1000 random scenarios on 3 replicas', { timeout: 120_000 }, () => {
    const summary = checkConvergence(spec, { numRuns: 1000 });
    expect(summary.runs).toBe(1000);
    expect(summary.ops).toBeGreaterThan(0);
    expect(summary.concurrentPairs).toBeGreaterThan(0);
    expect(summary.redeliveries).toBeGreaterThan(0);
    expect(summary.mergeChecks).toBeGreaterThan(0);
  });
});
