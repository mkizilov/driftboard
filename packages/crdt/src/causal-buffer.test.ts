import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CausalBuffer } from './causal-buffer';
import { opId, opIdKey, type OpId } from './op-id';
import { replicaId } from './replica-id';

const r = replicaId('a');
const id = (n: number): OpId => opId(n, r);

interface TestOp {
  readonly id: OpId;
  readonly needs: readonly OpId[];
}

const op = (n: number, ...needs: number[]): TestOp => ({ id: id(n), needs: needs.map(id) });

/** A buffer plus the host state it drives: which ops were applied, and in what order. */
function setup(alreadyApplied: readonly number[] = []) {
  const applied = new Set(alreadyApplied.map((n) => opIdKey(id(n))));
  const order: number[] = [];
  const buffer = new CausalBuffer<TestOp>({
    provides: (o) => o.id,
    requires: (o) => o.needs,
    isApplied: (dep) => applied.has(opIdKey(dep)),
  });
  const receive = (o: TestOp, fail: (o: TestOp) => boolean = () => false): number =>
    buffer.receive(o, (ready) => {
      if (fail(ready)) throw new Error(`cannot apply ${ready.id.counter}`);
      applied.add(opIdKey(ready.id));
      order.push(ready.id.counter);
    });
  return { buffer, receive, order };
}

describe('CausalBuffer', () => {
  it('applies an operation immediately when nothing is missing', () => {
    const { buffer, receive, order } = setup();
    expect(receive(op(1))).toBe(1);
    expect(order).toEqual([1]);
    expect(buffer.size).toBe(0);
  });

  it('holds an operation until its dependency arrives, then applies both in order', () => {
    const { buffer, receive, order } = setup();
    expect(receive(op(2, 1))).toBe(0);
    expect(buffer.size).toBe(1);
    expect(buffer.pending()).toEqual([op(2, 1)]);
    expect(receive(op(1))).toBe(2);
    expect(order).toEqual([1, 2]);
    expect(buffer.size).toBe(0);
  });

  it('releases a whole chain delivered in reverse', () => {
    const { buffer, receive, order } = setup();
    expect([receive(op(4, 3)), receive(op(3, 2)), receive(op(2, 1))]).toEqual([0, 0, 0]);
    expect(buffer.size).toBe(3);
    expect(receive(op(1))).toBe(4);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(buffer.size).toBe(0);
  });

  it('waits for every dependency of an operation', () => {
    const { buffer, receive, order } = setup();
    receive(op(3, 1, 2));
    receive(op(1));
    expect(order).toEqual([1]);
    expect(buffer.size).toBe(1);
    receive(op(2));
    expect(order).toEqual([1, 2, 3]);
    expect(buffer.size).toBe(0);
  });

  it('releases every operation waiting on the same dependency', () => {
    const { receive, order } = setup();
    receive(op(2, 1));
    receive(op(3, 1));
    receive(op(1));
    expect(order).toEqual([1, 2, 3]);
  });

  it('treats ids applied outside the buffer as satisfied', () => {
    const { buffer, receive, order } = setup([1]);
    expect(receive(op(2, 1))).toBe(1);
    expect(order).toEqual([2]);
    expect(buffer.size).toBe(0);
  });

  it('retries operations that a failing apply left unprocessed on the next receive', () => {
    const { buffer, receive, order } = setup();
    receive(op(2, 1));
    receive(op(3, 1));
    // Applying 2 throws: it is dropped, 3 (released at the same time) is kept for a retry.
    expect(() => receive(op(1), (o) => o.id.counter === 2)).toThrow('cannot apply 2');
    expect(order).toEqual([1]);
    expect(buffer.size).toBe(1);
    expect(buffer.pending()).toEqual([op(3, 1)]);
    expect(receive(op(4))).toBe(2);
    expect(order).toEqual([1, 3, 4]);
    expect(buffer.size).toBe(0);
  });

  it('applies each operation once and only after its dependencies, in any arrival order', () => {
    const opsArb = fc
      .array(fc.array(fc.nat(), { maxLength: 3 }), { minLength: 1, maxLength: 12 })
      .map((deps) =>
        deps.map((picks, i) => {
          // Operation i + 1 may depend on any earlier operation 1..i.
          const needs = i === 0 ? [] : picks.map((pick) => (pick % i) + 1);
          return op(i + 1, ...new Set(needs));
        }),
      );
    fc.assert(
      fc.property(
        opsArb.chain((ops) =>
          fc.tuple(
            fc.constant(ops),
            fc.shuffledSubarray(ops, { minLength: ops.length, maxLength: ops.length }),
          ),
        ),
        ([ops, arrival]) => {
          const { buffer, receive, order } = setup();
          for (const o of arrival) receive(o);
          expect(buffer.size).toBe(0);
          expect([...order].sort((x, y) => x - y)).toEqual(ops.map((o) => o.id.counter));
          for (const o of ops) {
            const position = order.indexOf(o.id.counter);
            for (const need of o.needs) {
              expect(order.indexOf(need.counter)).toBeLessThan(position);
            }
          }
        },
      ),
    );
  });
});
