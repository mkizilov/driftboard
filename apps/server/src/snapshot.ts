import { gunzipSync, gzipSync } from 'node:zlib';
import { compareReplicaIds, isReplicaId, type JsonObject, type ReplicaId } from '@driftboard/crdt';
import type { StampedOp } from '@driftboard/protocol';

/**
 * A snapshot is a board's operation log in compact form: for each origin its operations 1..n
 * without the repeated origin and sequence number, as gzipped JSON
 * (`{ "v": 1, "origins": [[origin, [op, ...]], ...] }`). One such blob loads far faster than
 * hundreds of thousands of rows, and it still holds every operation, so any peer can be caught up
 * from it by version vector.
 */

const FORMAT_VERSION = 1;

export class SnapshotError extends Error {
  override readonly name = 'SnapshotError';
}

/** Encodes operations that are numbered 1, 2, 3, ... per origin. */
export function encodeSnapshot(ops: readonly StampedOp[]): Buffer {
  const groups = new Map<ReplicaId, JsonObject[]>();
  for (const { origin, seq, op } of ops) {
    const group = groups.get(origin) ?? [];
    if (seq !== group.length + 1) {
      throw new SnapshotError(`operations of ${origin} are not numbered 1, 2, 3 (got ${seq})`);
    }
    group.push(op);
    groups.set(origin, group);
  }
  const origins = [...groups].sort(([a], [b]) => compareReplicaIds(a, b));
  return gzipSync(JSON.stringify({ v: FORMAT_VERSION, origins }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Inverse of `encodeSnapshot`; throws `SnapshotError` for anything that is not a snapshot. */
export function decodeSnapshot(data: Uint8Array): StampedOp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(data).toString('utf8'));
  } catch (error) {
    throw new SnapshotError('snapshot is not gzipped JSON', { cause: error });
  }
  if (!isObject(parsed) || parsed['v'] !== FORMAT_VERSION || !Array.isArray(parsed['origins'])) {
    throw new SnapshotError('unsupported snapshot format');
  }
  const ops: StampedOp[] = [];
  for (const entry of parsed['origins'] as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new SnapshotError('bad origin entry');
    const [origin, bodies] = entry as [unknown, unknown];
    if (!isReplicaId(origin) || !Array.isArray(bodies)) throw new SnapshotError('bad origin entry');
    (bodies as unknown[]).forEach((body, index) => {
      if (!isObject(body)) throw new SnapshotError(`bad operation ${index + 1} of ${origin}`);
      ops.push({ origin, seq: index + 1, op: body as JsonObject });
    });
  }
  return ops;
}
