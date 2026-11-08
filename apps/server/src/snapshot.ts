import { gunzipSync, gzipSync } from 'node:zlib';
import { compareReplicaIds, isReplicaId, type JsonObject, type ReplicaId } from '@driftboard/crdt';
import {
  BinaryFormatError,
  decodeOps,
  encodeOps,
  isBinaryBatch,
  type StampedOp,
} from '@driftboard/protocol';

/**
 * A snapshot is a board's operation log in compact form: for each origin its operations 1..n
 * without the repeated origin and sequence number, gzipped. One such blob loads far faster than
 * hundreds of thousands of rows, and it still holds every operation, so any peer can be caught up
 * from it by version vector.
 *
 * Two formats are read, and the second is written. Version 1 is gzipped JSON
 * (`{ "v": 1, "origins": [[origin, [op, ...]], ...] }`), what earlier servers stored. Version 2 is
 * the gzip of the binary batch of `@driftboard/protocol` (`encodeOps`), which starts with a byte no
 * JSON starts with, so the two are told apart by looking.
 */

export class SnapshotError extends Error {
  override readonly name = 'SnapshotError';
}

/** Encodes operations that are numbered 1, 2, 3, ... per origin. */
export function encodeSnapshot(ops: readonly StampedOp[]): Buffer {
  const counts = new Map<ReplicaId, number>();
  for (const { origin, seq } of ops) {
    const count = counts.get(origin) ?? 0;
    if (seq !== count + 1) {
      throw new SnapshotError(`operations of ${origin} are not numbered 1, 2, 3 (got ${seq})`);
    }
    counts.set(origin, seq);
  }
  // Each origin's operations together, origins in order of id, so that they are runs in the batch.
  const byOrigin = new Map<ReplicaId, StampedOp[]>();
  for (const op of ops) {
    const group = byOrigin.get(op.origin);
    if (group === undefined) byOrigin.set(op.origin, [op]);
    else group.push(op);
  }
  const ordered = [...byOrigin]
    .sort(([a], [b]) => compareReplicaIds(a, b))
    .flatMap(([, group]) => group);
  return gzipSync(encodeOps(ordered));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeJsonSnapshot(raw: Buffer): StampedOp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new SnapshotError('snapshot is not gzipped JSON or a binary batch', { cause: error });
  }
  if (!isObject(parsed) || parsed['v'] !== 1 || !Array.isArray(parsed['origins'])) {
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

function decodeBinarySnapshot(raw: Buffer): StampedOp[] {
  let ops: StampedOp[];
  try {
    ops = decodeOps(raw);
  } catch (error) {
    if (!(error instanceof BinaryFormatError)) throw error;
    throw new SnapshotError(`snapshot is damaged: ${error.message}`, { cause: error });
  }
  const counts = new Map<ReplicaId, number>();
  for (const { origin, seq } of ops) {
    const count = counts.get(origin) ?? 0;
    if (seq !== count + 1) {
      throw new SnapshotError(`operations of ${origin} are not numbered 1, 2, 3 (got ${seq})`);
    }
    counts.set(origin, seq);
  }
  return ops;
}

/** Inverse of `encodeSnapshot`; throws `SnapshotError` for anything that is not a snapshot. */
export function decodeSnapshot(data: Uint8Array): StampedOp[] {
  let raw: Buffer;
  try {
    raw = gunzipSync(data);
  } catch (error) {
    throw new SnapshotError('snapshot is not gzipped', { cause: error });
  }
  return isBinaryBatch(raw) ? decodeBinarySnapshot(raw) : decodeJsonSnapshot(raw);
}
