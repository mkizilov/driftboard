import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AwMap, CausalOrderError, type AwMapOp } from './aw-map';
import { checkConvergence, type CheckableSpec } from './convergence';
import { formatHlc } from './hlc';
import { LwwRegister } from './lww-register';
import { opId, opIdKey } from './op-id';
import { replicaId } from './replica-id';
import { must } from './test-support';

const a = replicaId('a');
const b = replicaId('b');
const c = replicaId('c');

// Numbers joined by max keep the unit tests free of register details.
const emptyMap = () => AwMap.empty<number>((x, y) => Math.max(x, y));

function snap<V>(map: AwMap<V>) {
  return {
    version: map.version.entries(),
    dots: map.dotEntries().map(({ key, dot, value }) => [key, opIdKey(dot), value]),
  };
}

describe('AwMap basics', () => {
  it('sets, reads and removes keys', () => {
    const empty = emptyMap();
    expect(empty.size).toBe(0);
    expect(empty.get('x')).toBeUndefined();

    const withX = empty.apply(empty.prepareSet(a, 'x', 1));
    expect(withX.has('x')).toBe(true);
    expect(withX.get('x')).toBe(1);
    expect(withX.size).toBe(1);

    const withXY = withX.apply(withX.prepareSet(a, 'y', 2));
    expect(withXY.keys()).toEqual(['x', 'y']);
    expect(withXY.entries()).toEqual([
      ['x', 1],
      ['y', 2],
    ]);

    const removed = withXY.apply(must(withXY.prepareRemove('x')));
    expect(removed.keys()).toEqual(['y']);
    expect(removed.has('x')).toBe(false);
  });

  it('replaces the previous value when the same replica sets a key again', () => {
    let map = emptyMap();
    map = map.apply(map.prepareSet(a, 'x', 5));
    map = map.apply(map.prepareSet(a, 'x', 2));
    expect(map.get('x')).toBe(2);
    expect(map.dotEntries()).toHaveLength(1);
  });

  it('has nothing to remove for an absent key and can re-add after a remove', () => {
    let map = emptyMap();
    expect(map.prepareRemove('x')).toBeUndefined();
    map = map.apply(map.prepareSet(a, 'x', 1));
    map = map.apply(must(map.prepareRemove('x')));
    expect(map.prepareRemove('x')).toBeUndefined();
    map = map.apply(map.prepareSet(a, 'x', 3));
    expect(map.get('x')).toBe(3);
    expect(map.version.get(a)).toBe(2);
  });

  it('does not mutate the map it applies an operation to', () => {
    const empty = emptyMap();
    const before = snap(empty);
    empty.apply(empty.prepareSet(a, 'x', 1));
    expect(snap(empty)).toEqual(before);
  });
});

describe('AwMap add-wins semantics', () => {
  // Both replicas start with x=1 written by A.
  const shared = () => {
    const origin = emptyMap();
    const put = origin.prepareSet(a, 'x', 1);
    return { atA: origin.apply(put), atB: origin.apply(put) };
  };

  it('a concurrent set beats a remove, whichever order they arrive in', () => {
    const { atA, atB } = shared();
    const remove = must(atA.prepareRemove('x'));
    const reAdd = atB.prepareSet(b, 'x', 2);

    const removerSide = atA.apply(remove).apply(reAdd);
    const adderSide = atB.apply(reAdd).apply(remove);

    for (const side of [removerSide, adderSide]) {
      expect(side.has('x')).toBe(true);
      expect(side.get('x')).toBe(2);
    }
    expect(snap(removerSide)).toEqual(snap(adderSide));
  });

  it('a remove only deletes what its issuer observed', () => {
    const { atA, atB } = shared();
    const remove = must(atA.prepareRemove('x'));
    // B has not seen A's remove, and writes to a different dot of the same key.
    const concurrentSet = atB.prepareSet(b, 'x', 7);
    // C never saw the original write at all.
    const fresh = emptyMap().prepareSet(c, 'x', 9);

    const result = atA.apply(remove).apply(concurrentSet).apply(fresh);
    expect(result.get('x')).toBe(9);
    expect(result.dotEntries().map((entry) => opIdKey(entry.dot))).toEqual(['1@b', '1@c']);
  });

  it('a remove wins over the writes it observed', () => {
    const { atA, atB } = shared();
    const remove = must(atA.prepareRemove('x'));
    expect(atB.apply(remove).has('x')).toBe(false);
    expect(atB.apply(remove).apply(remove).has('x')).toBe(false);
  });

  it('keeps concurrent writes side by side, joins them, and lets a later write replace both', () => {
    const origin = emptyMap();
    const fromA = origin.prepareSet(a, 'x', 1);
    const fromB = origin.prepareSet(b, 'x', 5);
    const merged = origin.apply(fromA).apply(fromB);
    expect(merged.dotEntries()).toHaveLength(2);
    expect(merged.get('x')).toBe(5);

    const replacement = merged.prepareSet(a, 'x', 3);
    expect(replacement.supersedes).toHaveLength(2);
    const replaced = merged.apply(replacement);
    expect(replaced.dotEntries()).toHaveLength(1);
    expect(replaced.get('x')).toBe(3);
  });
});

describe('AwMap delivery checks', () => {
  it('ignores a write it has already applied, even after it was removed', () => {
    const empty = emptyMap();
    const put = empty.prepareSet(a, 'x', 1);
    const withX = empty.apply(put);
    expect(withX.apply(put)).toBe(withX);
    const removed = withX.apply(must(withX.prepareRemove('x')));
    expect(removed.apply(put)).toBe(removed);
    expect(removed.has('x')).toBe(false);
  });

  it('rejects a write that skips an earlier write from the same replica', () => {
    const origin = emptyMap();
    const first = origin.prepareSet(a, 'x', 1);
    const second = origin.apply(first).prepareSet(a, 'y', 2);
    expect(() => origin.apply(second)).toThrow(CausalOrderError);
  });

  it('rejects operations that refer to writes it has not seen', () => {
    const origin = emptyMap();
    const put = origin.prepareSet(a, 'x', 1);
    const withX = origin.apply(put);
    const remove = must(withX.prepareRemove('x'));
    const overwrite = withX.prepareSet(b, 'x', 2);
    expect(() => origin.apply(remove)).toThrow(CausalOrderError);
    expect(() => origin.apply(overwrite)).toThrow(CausalOrderError);
  });
});

describe('AwMap.merge', () => {
  it('does not resurrect a key that the other side removed after observing it', () => {
    const origin = emptyMap();
    const put = origin.prepareSet(a, 'x', 1);
    const atA = origin.apply(put);
    const atB = origin.apply(put);
    const removedAtB = atB.apply(must(atB.prepareRemove('x')));
    expect(atA.merge(removedAtB).has('x')).toBe(false);
    expect(removedAtB.merge(atA).has('x')).toBe(false);
  });

  it('keeps a write the other side has not seen, even if it also removed the key', () => {
    const origin = emptyMap();
    const put = origin.prepareSet(a, 'x', 1);
    const atA = origin.apply(put);
    const atB = origin.apply(put);
    const removedAtB = atB.apply(must(atB.prepareRemove('x')));
    const rewrittenAtA = atA.apply(atA.prepareSet(a, 'x', 4));
    for (const merged of [removedAtB.merge(rewrittenAtA), rewrittenAtA.merge(removedAtB)]) {
      expect(merged.get('x')).toBe(4);
      expect(merged.dotEntries()).toHaveLength(1);
    }
  });

  it('unions disjoint keys and combines versions', () => {
    const left = emptyMap();
    const right = emptyMap();
    const l = left.apply(left.prepareSet(a, 'x', 1));
    const r = right.apply(right.prepareSet(b, 'y', 2));
    const merged = l.merge(r);
    expect(merged.entries()).toEqual([
      ['x', 1],
      ['y', 2],
    ]);
    expect(merged.version.includes(opId(1, a))).toBe(true);
    expect(merged.version.includes(opId(1, b))).toBe(true);
    expect(snap(l.merge(r))).toEqual(snap(r.merge(l)));
  });

  it('continues in order after absorbing a snapshot, and drops duplicates it already covers', () => {
    const origin = emptyMap();
    const first = origin.prepareSet(a, 'x', 1);
    const atA = origin.apply(first);
    const second = atA.prepareSet(a, 'x', 2);
    const snapshot = atA.apply(second);
    const absorbed = origin.merge(snapshot);
    expect(absorbed.apply(first)).toBe(absorbed);
    expect(absorbed.apply(second)).toBe(absorbed);
    const third = absorbed.prepareSet(a, 'x', 3);
    expect(absorbed.apply(third).get('x')).toBe(3);
  });
});

describe('AwMap convergence harness', () => {
  type Value = LwwRegister<number>;
  type Intent = { kind: 'set'; key: string; value: number } | { kind: 'remove'; key: string };

  // Few keys so that sets and removes of the same key collide often.
  const keyArb = fc.constantFrom('k1', 'k2', 'k3');
  const setIntent = fc.record({
    kind: fc.constant('set' as const),
    key: keyArb,
    value: fc.integer({ min: 0, max: 9 }),
  });
  const removeIntent = fc.record({ kind: fc.constant('remove' as const), key: keyArb });
  const intentArb: fc.Arbitrary<Intent> = fc.oneof(
    { weight: 3, arbitrary: setIntent },
    { weight: 2, arbitrary: removeIntent },
  );

  const spec: CheckableSpec<AwMap<Value>, AwMapOp<Value>, Intent> = {
    name: 'AwMap<LwwRegister>',
    intentArb,
    idempotentApply: true,
    create: () => AwMap.empty<Value>((x, y) => x.merge(y)),
    prepare: (state, intent, ctx) => {
      if (intent.kind === 'remove') return state.prepareRemove(intent.key);
      // Read-modify-write: the new value builds on what this replica currently sees for the key.
      const current = state.get(intent.key) ?? LwwRegister.empty<number>();
      const next = current.apply(current.prepareSet(intent.value, ctx.clock.tick()));
      return state.prepareSet(ctx.replicaId, intent.key, next);
    },
    apply: (state, op) => state.apply(op),
    merge: (x, y) => x.merge(y),
    observe: (ctx, op) => {
      if (op.type === 'put' && op.value.timestamp !== undefined) {
        ctx.clock.receive(op.value.timestamp);
      }
    },
    snapshot: (state) => ({
      version: state.version.entries(),
      dots: state.dotEntries().map(({ key, dot, value }) => [
        key,
        opIdKey(dot),
        value.value ?? null,
        value.timestamp === undefined ? null : formatHlc(value.timestamp),
      ]),
    }),
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
