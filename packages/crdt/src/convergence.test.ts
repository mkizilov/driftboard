import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Clock } from './clock';
import { checkConvergence, type CheckableSpec } from './convergence';
import { runScenario } from './convergence-scenario';

// These tests check the harness itself: it must accept correct CRDTs and reject broken ones.

// Grow-only set of integers: add is commutative and idempotent, merge is union.
const unionOf = (x: readonly number[], y: readonly number[]): number[] =>
  [...new Set([...x, ...y])].sort((p, q) => p - q);

const setSpec: CheckableSpec<readonly number[], number, number> = {
  name: 'grow-only set',
  intentArb: fc.integer({ min: 0, max: 6 }),
  idempotentApply: true,
  create: () => [],
  prepare: (_state, value) => [value],
  apply: (state, value) => unionOf(state, [value]),
  merge: unionOf,
  snapshot: (state) => state,
};

// Counter: increments commute but are not idempotent, so it must not claim idempotentApply.
const counterSpec: CheckableSpec<number, number, number> = {
  name: 'counter',
  intentArb: fc.integer({ min: 1, max: 5 }),
  create: () => 0,
  prepare: (_state, amount) => [amount],
  apply: (state, amount) => state + amount,
  snapshot: (state) => state,
};

describe('checkConvergence', () => {
  it('accepts correct CRDTs and reports non-vacuous totals', () => {
    const summary = checkConvergence(setSpec, { numRuns: 200 });
    expect(summary.runs).toBe(200);
    expect(summary.ops).toBeGreaterThan(200);
    expect(summary.concurrentPairs).toBeGreaterThan(0);
    expect(summary.redeliveries).toBeGreaterThan(0);
    expect(summary.mergeChecks).toBeGreaterThan(0);
    expect(checkConvergence(counterSpec, { numRuns: 200 }).redeliveries).toBe(0);
  });

  it('is reproducible for a given seed', () => {
    expect(checkConvergence(setSpec, { numRuns: 50, seed: 7 })).toEqual(
      checkConvergence(setSpec, { numRuns: 50, seed: 7 }),
    );
  });

  it('rejects a register that lets the last delivered write win', () => {
    const arrivalOrder: CheckableSpec<number | null, number, number> = {
      name: 'arrival-order register',
      intentArb: fc.integer({ min: 0, max: 9 }),
      create: () => null,
      prepare: (_state, value) => [value],
      apply: (_state, value) => value,
      snapshot: (state) => state,
    };
    expect(() => checkConvergence(arrivalOrder, { numRuns: 300 })).toThrow(
      /arrival-order register/,
    );
  });

  it('rejects an operation that claims to be idempotent but is not', () => {
    const lying: CheckableSpec<number, number, number> = { ...counterSpec, idempotentApply: true };
    expect(() => checkConvergence(lying, { numRuns: 300 })).toThrow(/redelivering/);
  });

  it('rejects a state merge that is not the join of the operations', () => {
    const keepsLeft: CheckableSpec<readonly number[], number, number> = {
      ...setSpec,
      merge: (x) => x,
    };
    expect(() => checkConvergence(keepsLeft, { numRuns: 300 })).toThrow(/merge/);
  });

  it('only delivers an operation after the operations its origin had applied', () => {
    interface Op {
      id: string;
      deps: readonly string[];
    }
    // Every op names everything its origin had applied (and each prepare yields two ops, the
    // second naming the first); applying one early is a harness bug.
    const probe: CheckableSpec<readonly string[], Op, null> = {
      name: 'causal order probe',
      intentArb: fc.constant(null),
      idempotentApply: true,
      create: () => [],
      prepare: (state, _intent, ctx) => {
        const own = state.filter((id) => id.startsWith(`${ctx.replicaId}:`)).length;
        const first = { id: `${ctx.replicaId}:${own}`, deps: state };
        const second = { id: `${ctx.replicaId}:${own + 1}`, deps: [...state, first.id] };
        return [first, second];
      },
      apply: (state, op) => {
        if (state.includes(op.id)) return state;
        const missing = op.deps.filter((dep) => !state.includes(dep));
        if (missing.length > 0) throw new Error(`delivered ${op.id} before ${missing.join(',')}`);
        return [...state, op.id];
      },
      snapshot: (state) => [...state].sort(),
    };
    expect(checkConvergence(probe, { numRuns: 300 }).concurrentPairs).toBeGreaterThan(0);
  });

  it('uses 3 to 5 replicas when asked to and rejects other ranges', () => {
    const wide = checkConvergence(setSpec, { numRuns: 100, replicas: { min: 3, max: 5 } });
    expect(wide.maxReplicas).toBe(5);
    expect(checkConvergence(setSpec, { numRuns: 20 }).maxReplicas).toBe(3);
    expect(() => checkConvergence(setSpec, { replicas: { min: 2, max: 4 } })).toThrow(RangeError);
    expect(() => checkConvergence(setSpec, { replicas: { min: 3, max: 6 } })).toThrow(RangeError);
    const tooFew = { replicas: 2, steps: [], flushPicks: [], mergePicks: [] };
    expect(() => runScenario(setSpec, tooFew)).toThrow(RangeError);
  });

  it('gives create the replica clock, which the harness moves, even backwards', () => {
    let backwards = 0;
    let created = 0;
    const clockProbe: CheckableSpec<{ clock: Clock; last: number }, number, number> = {
      name: 'clock probe',
      intentArb: fc.constant(0),
      create: (_replica, ctx) => {
        created += 1;
        return { clock: ctx.physicalClock, last: -1 };
      },
      prepare: (state) => {
        const now = state.clock.now();
        if (now < state.last) backwards += 1;
        state.last = now;
        return [now];
      },
      apply: (state) => state,
      snapshot: () => 0,
    };
    checkConvergence(clockProbe, { numRuns: 100 });
    expect(created).toBeGreaterThanOrEqual(100 * 4); // 3 replicas and the reference, per run
    expect(backwards).toBeGreaterThan(0);
  });

  it('supports states that apply operations in place', () => {
    const inPlaceSet: CheckableSpec<Set<number>, number, number> = {
      name: 'in-place set',
      intentArb: fc.integer({ min: 0, max: 6 }),
      idempotentApply: true,
      create: () => new Set<number>(),
      prepare: (_state, value) => [value],
      apply: (state, value) => state.add(value),
      snapshot: (state) => [...state].sort((p, q) => p - q),
    };
    expect(checkConvergence(inPlaceSet, { numRuns: 200 }).redeliveries).toBeGreaterThan(0);

    // A mutable state must not fool the redelivery check by being compared with itself.
    const inPlaceCounter: CheckableSpec<{ total: number }, number, number> = {
      name: 'in-place counter',
      intentArb: fc.integer({ min: 1, max: 5 }),
      idempotentApply: true,
      create: () => ({ total: 0 }),
      prepare: (_state, amount) => [amount],
      apply: (state, amount) => {
        state.total += amount;
        return state;
      },
      snapshot: (state) => state.total,
    };
    expect(() => checkConvergence(inPlaceCounter, { numRuns: 300 })).toThrow(/redelivering/);
  });

  it('runScenario handles an empty scenario', () => {
    const stats = runScenario(setSpec, {
      replicas: 3,
      steps: [],
      flushPicks: [],
      mergePicks: [[0, 0, 0]],
    });
    expect(stats).toEqual({ ops: 0, concurrentPairs: 0, redeliveries: 0, mergeChecks: 1 });
  });
});
