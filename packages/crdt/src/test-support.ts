import fc from 'fast-check';
import { hlcTimestamp, type HlcTimestamp } from './hlc';
import { opId, type OpId } from './op-id';
import { replicaId, type ReplicaId } from './replica-id';
import { VersionVector } from './version-vector';

/** Unwraps a value that a test knows exists (noUncheckedIndexedAccess helper). */
export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

// Few, mixed-case ids so that collisions and tie-breaks occur often.
export const replicaIdArb: fc.Arbitrary<ReplicaId> = fc
  .constantFrom('a', 'b', 'ab', 'B', 'a-1', '0')
  .map((id) => replicaId(id));

export const opIdArb: fc.Arbitrary<OpId> = fc
  .tuple(fc.integer({ min: 1, max: 6 }), replicaIdArb)
  .map(([counter, replica]) => opId(counter, replica));

export const versionVectorArb: fc.Arbitrary<VersionVector> = fc
  .array(fc.tuple(replicaIdArb, fc.integer({ min: 0, max: 6 })), { maxLength: 6 })
  .map((entries) => VersionVector.from(entries));

export const hlcTimestampArb: fc.Arbitrary<HlcTimestamp> = fc
  .tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }), replicaIdArb)
  .map(([wallMs, logical, replica]) => hlcTimestamp(wallMs, logical, replica));
