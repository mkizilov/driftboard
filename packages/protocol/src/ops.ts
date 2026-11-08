import {
  boardOpFromJson,
  boardOpToJson,
  type BoardOp,
  type JsonObject,
  type ReplicaId,
} from '@driftboard/crdt';

/** An operation with its place in the stream of the replica that authored it. */
export interface StampedOp {
  readonly origin: ReplicaId;
  /** 1 for the first operation `origin` authored, 2 for the next, and so on. */
  readonly seq: number;
  /** Canonical JSON form of the board operation, see `canonicalizeOp`. */
  readonly op: JsonObject;
}

/**
 * Checks an untrusted operation in depth and rewrites it in canonical form (fixed key order,
 * unknown keys dropped), so stored and relayed operations are always valid and comparable as text.
 * Throws `BoardFormatError` if it is not a valid board operation.
 */
export function canonicalizeOp(raw: unknown): JsonObject {
  return boardOpToJson(boardOpFromJson(raw));
}

/** Numbers `ops` as the operations `origin` authors from `firstSeq` on. */
export function stampOps(
  origin: ReplicaId,
  firstSeq: number,
  ops: readonly BoardOp[],
): StampedOp[] {
  return ops.map((op, index) => ({ origin, seq: firstSeq + index, op: boardOpToJson(op) }));
}

/** Converts stored operations back to board operations, ready for `Board.applyRemote`. */
export function toBoardOps(ops: readonly StampedOp[]): BoardOp[] {
  return ops.map((stamped) => boardOpFromJson(stamped.op));
}
