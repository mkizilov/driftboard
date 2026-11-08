import {
  VersionVector,
  compareReplicaIds,
  type JsonObject,
  type JsonValue,
  type ReplicaId,
} from '@driftboard/crdt';
import type { StampedOp } from './ops';

/**
 * What an origin's stream has used up so far. Every id an operation introduces carries a counter,
 * and an honest replica numbers them without gaps, so the next operation has to continue from here.
 */
export interface OriginCounters {
  /** Note writes so far: the next one has this dot counter plus one. */
  readonly puts: number;
  /** Per note: the counter of the last character this origin inserted into it. */
  readonly inserts: ReadonlyMap<string, number>;
}

const NO_COUNTERS: OriginCounters = { puts: 0, inserts: new Map() };

/**
 * The operations of one origin, in order. Newer versions of a store append to the same backing
 * array, and each version only reads the first `length` entries, so appending is cheap and older
 * versions stay valid. Only this file touches the array.
 */
export interface OriginLog {
  readonly items: StampedOp[];
  readonly length: number;
  /** The counters of the first `length` operations. */
  readonly counters: OriginCounters;
}

/**
 * Everything one side of the sync knows: for every origin, operations 1..n without gaps. The
 * version vector of a store is therefore just the length of each log. A store is immutable: every
 * function returns a new one.
 */
export interface OpStore {
  readonly logs: ReadonlyMap<ReplicaId, OriginLog>;
}

export const emptyStore: OpStore = { logs: new Map() };

export interface AddOptions {
  /**
   * Refuse operations of an origin that would be more than this many in the store. For the server:
   * a version vector has room for 1000 replicas, and a board with more could not be joined.
   */
  readonly maxOrigins?: number;
}

export type AddResult =
  | { readonly ok: true; readonly store: OpStore; readonly added: readonly StampedOp[] }
  | {
      readonly ok: false;
      /** `invalid`: the operation breaks the rules for the ids of its origin (see `storeAdd`). */
      readonly reason: 'gap' | 'conflict' | 'invalid';
      readonly detail: string;
    };

/** `count` operations from each origin. */
export function storeVector(store: OpStore): VersionVector {
  return VersionVector.from([...store.logs].map(([origin, log]) => [origin, log.length] as const));
}

export function storeSize(store: OpStore): number {
  let size = 0;
  for (const log of store.logs.values()) size += log.length;
  return size;
}

/**
 * The operations `vector` does not cover, i.e. exactly the ones a peer with that vector is
 * missing: per origin sorted by replica id, each origin in sequence order.
 */
export function storeMissing(store: OpStore, vector: VersionVector): StampedOp[] {
  const missing: StampedOp[] = [];
  for (const origin of [...store.logs.keys()].sort(compareReplicaIds)) {
    const log = store.logs.get(origin);
    if (log === undefined) continue;
    for (let index = vector.get(origin); index < log.length; index += 1) {
      const op = log.items[index];
      if (op !== undefined) missing.push(op);
    }
  }
  return missing;
}

function append(
  log: OriginLog | undefined,
  items: readonly StampedOp[],
  counters: OriginCounters,
): OriginLog {
  if (log === undefined) return { items: [...items], length: items.length, counters };
  if (log.items.length === log.length) {
    for (const item of items) log.items.push(item);
    return { items: log.items, length: log.length + items.length, counters };
  }
  // Another version already appended past this one: copy instead of overwriting its entries.
  return {
    items: [...log.items.slice(0, log.length), ...items],
    length: log.length + items.length,
    counters,
  };
}

// ---- The rules for the ids of an origin ---------------------------------------------------------

/** The counters while a batch is being checked: a copy of the stored ones, changed as it goes. */
interface Working {
  puts: number;
  inserts: Map<string, number>;
}

interface Ref {
  readonly counter: number;
  readonly replica: string;
}

/** Reads `counter@replica`; operations are canonical by now, so this only fails for junk. */
function refOf(value: JsonValue | undefined): Ref | undefined {
  if (typeof value !== 'string') return undefined;
  const at = value.indexOf('@');
  if (at < 1) return undefined;
  const counter = Number(value.slice(0, at));
  if (!Number.isSafeInteger(counter) || counter < 1) return undefined;
  return { counter, replica: value.slice(at + 1) };
}

/**
 * Checks one operation against the counters of its origin and, if it passes, moves them on. An
 * operation of a kind it does not know is left alone: what is stored is checked by the caller.
 *
 * The rules are about the *stream of one origin*, so they come out the same whatever order other
 * origins' operations arrive in, on the server and on every client: an id an operation introduces
 * (the character of an insert, the dot of a write) belongs to its origin and is the next one in
 * the origin's numbering, per note for characters; and an id it refers to that belongs to its
 * origin is one the origin has introduced already. Ids of other origins cannot be judged here,
 * because their operations may simply not have arrived yet.
 */
function advance(work: Working, origin: string, op: JsonObject): string | undefined {
  const note = op['noteId'];
  switch (op['type']) {
    case 'note-put': {
      const dot = refOf(op['dot']);
      if (dot === undefined) return 'its dot is not an id';
      if (dot.replica !== origin) return `its dot belongs to ${dot.replica}`;
      if (dot.counter !== work.puts + 1) {
        return `its dot is ${dot.counter}, the next one is ${work.puts + 1}`;
      }
      const problem = checkRefs(op['supersedes'], origin, work.puts);
      if (problem !== undefined) return problem;
      work.puts += 1;
      return undefined;
    }
    case 'note-remove':
      return checkRefs(op['dots'], origin, work.puts);
    case 'text-insert': {
      if (typeof note !== 'string') return 'it has no note';
      const id = refOf(op['id']);
      if (id === undefined) return 'its id is not an id';
      if (id.replica !== origin) return `its id belongs to ${id.replica}`;
      const last = work.inserts.get(note) ?? 0;
      if (id.counter !== last + 1) return `its id is ${id.counter}, the next one is ${last + 1}`;
      if (op['parent'] !== null) {
        const problem = checkChar(refOf(op['parent']), origin, last);
        if (problem !== undefined) return problem;
      }
      work.inserts.set(note, id.counter);
      return undefined;
    }
    case 'text-delete':
      if (typeof note !== 'string') return 'it has no note';
      return checkChar(refOf(op['target']), origin, work.inserts.get(note) ?? 0);
    default:
      return undefined;
  }
}

/** A character of its own that an operation refers to must have been inserted already. */
function checkChar(ref: Ref | undefined, origin: string, lastOwn: number): string | undefined {
  if (ref === undefined) return 'it refers to something that is not an id';
  if (ref.replica !== origin || ref.counter <= lastOwn) return undefined;
  return `it refers to ${ref.counter}@${origin} too early`;
}

/** The write dots of its own that an operation refers to must have been introduced already. */
function checkRefs(
  list: JsonValue | undefined,
  origin: string,
  ownPuts: number,
): string | undefined {
  if (!Array.isArray(list)) return 'it has no list of ids';
  for (const value of list as JsonValue[]) {
    const ref = refOf(value);
    if (ref === undefined) return 'it refers to something that is not an id';
    if (ref.replica === origin && ref.counter > ownPuts) {
      return `it refers to ${ref.counter}@${origin} too early`;
    }
  }
  return undefined;
}

/**
 * Adds operations that must arrive in order per origin. An operation the store already holds is
 * skipped if it is identical, so repeated delivery is harmless. The whole batch is rejected, and
 * the store left as it was, if an operation skips ahead of its origin's stream (`gap`), differs
 * from the one already stored under the same origin and number (`conflict`), or breaks the rules
 * for the ids of its origin (`invalid`; see `advance`).
 */
export function storeAdd(
  store: OpStore,
  ops: readonly StampedOp[],
  options: AddOptions = {},
): AddResult {
  const fresh = new Map<ReplicaId, StampedOp[]>();
  const working = new Map<ReplicaId, Working>();
  const added: StampedOp[] = [];
  let newOrigins = 0;

  for (const op of ops) {
    const log = store.logs.get(op.origin);
    const stored = log?.length ?? 0;
    const pending = fresh.get(op.origin) ?? [];
    const length = stored + pending.length;
    if (op.seq > length + 1) {
      const detail = `expected operation ${length + 1} from ${op.origin}, got ${op.seq}`;
      return { ok: false, reason: 'gap', detail };
    }
    if (op.seq <= length) {
      const existing = op.seq <= stored ? log?.items[op.seq - 1] : pending[op.seq - stored - 1];
      if (existing === undefined) throw new Error('Invariant violated: stored operation missing');
      if (JSON.stringify(existing.op) !== JSON.stringify(op.op)) {
        const detail = `operation ${op.seq} from ${op.origin} differs from the one already stored`;
        return { ok: false, reason: 'conflict', detail };
      }
      continue;
    }
    let work = working.get(op.origin);
    if (work === undefined) {
      if (log === undefined) newOrigins += 1;
      const limit = options.maxOrigins;
      if (limit !== undefined && store.logs.size + newOrigins > limit) {
        const detail = `the board has operations from ${limit} replicas already`;
        return { ok: false, reason: 'invalid', detail };
      }
      const start = log?.counters ?? NO_COUNTERS;
      work = { puts: start.puts, inserts: new Map(start.inserts) };
      working.set(op.origin, work);
    }
    const problem = advance(work, op.origin, op.op);
    if (problem !== undefined) {
      const detail = `operation ${op.seq} from ${op.origin} is not valid: ${problem}`;
      return { ok: false, reason: 'invalid', detail };
    }
    pending.push(op);
    fresh.set(op.origin, pending);
    added.push(op);
  }
  if (added.length === 0) return { ok: true, store, added };
  const logs = new Map(store.logs);
  for (const [origin, pending] of fresh) {
    const work = working.get(origin);
    if (work === undefined) throw new Error('Invariant violated: counters of a changed origin');
    logs.set(origin, append(store.logs.get(origin), pending, work));
  }
  return { ok: true, store: { logs }, added };
}
