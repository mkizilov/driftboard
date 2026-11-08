import type { Clock } from './clock';
import { compareValues, type Ordering } from './ordering';
import { compareReplicaIds, isReplicaId, replicaId, type ReplicaId } from './replica-id';

/** Wall time is stored in 48 bits (about the year 10889), which keeps the string form fixed-width. */
export const MAX_WALL_MS = 2 ** 48 - 1;
/** The logical counter is stored in 16 bits. */
export const MAX_LOGICAL = 0xffff;
export const DEFAULT_MAX_DRIFT_MS = 60_000;

/** Hybrid logical timestamp, totally ordered by `(wallMs, logical, replicaId)`. */
export interface HlcTimestamp {
  readonly wallMs: number;
  readonly logical: number;
  readonly replicaId: ReplicaId;
}

export class HlcDriftError extends Error {
  override readonly name = 'HlcDriftError';
}

function assertWallMs(wallMs: number): void {
  if (!Number.isSafeInteger(wallMs) || wallMs < 0 || wallMs > MAX_WALL_MS) {
    throw new RangeError(`wallMs must be an integer in [0, ${MAX_WALL_MS}], got ${wallMs}`);
  }
}

function assertLogical(logical: number): void {
  if (!Number.isSafeInteger(logical) || logical < 0 || logical > MAX_LOGICAL) {
    throw new RangeError(`logical must be an integer in [0, ${MAX_LOGICAL}], got ${logical}`);
  }
}

export function hlcTimestamp(wallMs: number, logical: number, replica: ReplicaId): HlcTimestamp {
  assertWallMs(wallMs);
  assertLogical(logical);
  return Object.freeze({ wallMs, logical, replicaId: replica });
}

export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): Ordering {
  return (
    compareValues(a.wallMs, b.wallMs) ||
    compareValues(a.logical, b.logical) ||
    compareReplicaIds(a.replicaId, b.replicaId)
  );
}

/**
 * Fixed-width encoding `<wall:12 hex>-<logical:4 hex>-<replicaId>` whose plain string order
 * equals `compareHlc`, so timestamps can be sorted by SQLite or `Array.sort()` directly.
 */
export function formatHlc(timestamp: HlcTimestamp): string {
  const wall = timestamp.wallMs.toString(16).padStart(12, '0');
  const logical = timestamp.logical.toString(16).padStart(4, '0');
  return `${wall}-${logical}-${timestamp.replicaId}`;
}

const HLC_PATTERN = /^([0-9a-f]{12})-([0-9a-f]{4})-(.+)$/;

export function parseHlc(text: string): HlcTimestamp {
  const match = HLC_PATTERN.exec(text);
  const [, wall, logical, replica] = match ?? [];
  if (wall === undefined || logical === undefined || !isReplicaId(replica)) {
    throw new RangeError(`Invalid HLC timestamp: ${JSON.stringify(text)}`);
  }
  return hlcTimestamp(parseInt(wall, 16), parseInt(logical, 16), replicaId(replica));
}

export interface HybridLogicalClockOptions {
  replicaId: ReplicaId;
  /** Injected physical clock; must return integer milliseconds. It may jump backwards. */
  physicalClock: Clock;
  /** Remote timestamps further ahead of the physical clock than this are rejected. */
  maxDriftMs?: number;
  /** Last persisted timestamp, so a restarted replica never reissues or regresses. */
  initial?: HlcTimestamp;
}

/**
 * Hybrid logical clock (Kulkarni et al.). Timestamps issued by `tick` and `receive` are strictly
 * increasing for this replica no matter what the physical clock does, and `receive` returns a
 * timestamp greater than the remote one, so causality is preserved.
 */
export class HybridLogicalClock {
  readonly replicaId: ReplicaId;
  readonly #physicalClock: Clock;
  readonly #maxDriftMs: number;
  #wallMs: number;
  #logical: number;

  constructor(options: HybridLogicalClockOptions) {
    const maxDriftMs = options.maxDriftMs ?? DEFAULT_MAX_DRIFT_MS;
    if (!Number.isFinite(maxDriftMs) || maxDriftMs < 0) {
      throw new RangeError(`maxDriftMs must be a non-negative number, got ${maxDriftMs}`);
    }
    this.replicaId = options.replicaId;
    this.#physicalClock = options.physicalClock;
    this.#maxDriftMs = maxDriftMs;
    this.#wallMs = options.initial?.wallMs ?? 0;
    this.#logical = options.initial?.logical ?? 0;
  }

  /** The most recently issued timestamp (or the initial state before the first tick). */
  get latest(): HlcTimestamp {
    return hlcTimestamp(this.#wallMs, this.#logical, this.replicaId);
  }

  /** Timestamp for a local event or an outgoing message. */
  tick(): HlcTimestamp {
    const physical = this.#readPhysical();
    if (physical > this.#wallMs) return this.#commit(physical, 0);
    return this.#commit(this.#wallMs, this.#logical + 1);
  }

  /** Merges a remote timestamp; returns a timestamp greater than both it and everything issued so far. */
  receive(remote: HlcTimestamp): HlcTimestamp {
    const physical = this.#readPhysical();
    if (remote.wallMs - physical > this.#maxDriftMs) {
      throw new HlcDriftError(
        `Remote timestamp is ${remote.wallMs - physical}ms ahead of the local clock (limit ${this.#maxDriftMs}ms)`,
      );
    }
    const wallMs = Math.max(this.#wallMs, remote.wallMs, physical);
    const fromLocal = wallMs === this.#wallMs;
    const fromRemote = wallMs === remote.wallMs;
    let logical = 0;
    if (fromLocal && fromRemote) logical = Math.max(this.#logical, remote.logical) + 1;
    else if (fromLocal) logical = this.#logical + 1;
    else if (fromRemote) logical = remote.logical + 1;
    return this.#commit(wallMs, logical);
  }

  #readPhysical(): number {
    const physical = this.#physicalClock.now();
    assertWallMs(physical);
    return physical;
  }

  // Validates before assigning so a failure (e.g. logical overflow) leaves the clock untouched.
  #commit(wallMs: number, logical: number): HlcTimestamp {
    const timestamp = hlcTimestamp(wallMs, logical, this.replicaId);
    this.#wallMs = wallMs;
    this.#logical = logical;
    return timestamp;
  }
}
