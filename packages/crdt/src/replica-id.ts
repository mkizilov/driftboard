import { compareValues, type Ordering } from './ordering';

declare const replicaIdBrand: unique symbol;

/** Identifies one replica (one device/tab). Unique per replica; never reused. */
export type ReplicaId = string & { readonly [replicaIdBrand]: true };

const REPLICA_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const GENERATED_ID_BYTES = 8;

export function isReplicaId(value: unknown): value is ReplicaId {
  return typeof value === 'string' && REPLICA_ID_PATTERN.test(value);
}

export function replicaId(value: string): ReplicaId {
  if (!isReplicaId(value)) {
    throw new RangeError(`Invalid replica id: ${JSON.stringify(value)}`);
  }
  return value;
}

export function compareReplicaIds(a: ReplicaId, b: ReplicaId): Ordering {
  return compareValues(a, b);
}

/**
 * Builds a fresh replica id (16 lowercase hex chars) from caller-supplied random bytes, e.g.
 * `crypto.getRandomValues` in the browser or `crypto.randomBytes` on the server. The library
 * itself never touches an entropy source.
 */
export function generateReplicaId(randomBytes: (length: number) => Uint8Array): ReplicaId {
  const bytes = randomBytes(GENERATED_ID_BYTES);
  if (bytes.length !== GENERATED_ID_BYTES) {
    throw new RangeError(`randomBytes must return ${GENERATED_ID_BYTES} bytes, got ${bytes.length}`);
  }
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return replicaId(hex);
}
