import { Board, boardOpToJson, createManualClock, type ReplicaId } from '@driftboard/crdt';
import type { StampedOp } from '@driftboard/protocol';

/** Unwraps a value a test knows exists (noUncheckedIndexedAccess helper). */
export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

/** `count` valid operations of `origin`, numbered from `firstSeq`, each creating a note. */
export function stamped(origin: ReplicaId, firstSeq: number, count: number): StampedOp[] {
  const board = new Board({ replicaId: origin, clock: createManualClock(1000) });
  // A note without text is exactly one operation; its x makes each one different.
  const bodies = Array.from({ length: firstSeq + count - 1 }, (_, i) =>
    board.createNote({ x: i }).ops.map(boardOpToJson),
  ).flat();
  return bodies.slice(firstSeq - 1).map((op, index) => ({ origin, seq: firstSeq + index, op }));
}

/** Resolves once `condition` holds, or rejects after `timeoutMs`. */
export async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
