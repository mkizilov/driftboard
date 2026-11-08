import { AwMap, type AwMapOp } from './aw-map';
import { serializeBoardOps, type JsonValue } from './board-json';
import {
  UnknownNoteError,
  assertColor,
  assertCoordinate,
  assertValidBoardOp,
  type BoardChange,
  type BoardOp,
  type NoteColor,
  type NoteFields,
  type NoteView,
  type QuarantinedOp,
} from './board-ops';
import { CausalBuffer, PendingBudget } from './causal-buffer';
import type { Clock } from './clock';
import { HybridLogicalClock, compareHlc, formatHlc, type HlcTimestamp } from './hlc';
import { MAX_NOTE_NODES, MAX_PENDING_OPS } from './limits';
import { LwwRegister } from './lww-register';
import { opId, opIdKey, type OpId } from './op-id';
import { compareValues } from './ordering';
import type { ReplicaId } from './replica-id';
import { TextSequence, type TextNode, type TextOp } from './text-sequence';

export interface BoardOptions {
  readonly replicaId: ReplicaId;
  /** Physical clock in whole milliseconds. Injected so that tests and simulations control it. */
  readonly clock: Clock;
  /** Most remote operations held back at once for missing ones. Default `MAX_PENDING_OPS`. */
  readonly maxPendingOps?: number;
  /** Most characters, deleted ones included, in one note's text. Default `MAX_NOTE_NODES`. */
  readonly maxNoteNodes?: number;
}

export interface NoteInit {
  x?: number;
  y?: number;
  color?: NoteColor;
  text?: string;
}

interface Changes {
  readonly applied: BoardOp[];
  readonly touched: Set<string>;
}

/** Joins the values of one note that were written concurrently: field by field, last writer wins. */
function joinFields(a: NoteFields, b: NoteFields): NoteFields {
  return {
    x: a.x.merge(b.x),
    y: a.y.merge(b.y),
    z: a.z.merge(b.z),
    color: a.color.merge(b.color),
  };
}

function written<T>(register: LwwRegister<T>, value: T, at: HlcTimestamp): LwwRegister<T> {
  return register.apply(register.prepareSet(value, at));
}

function filled<T>(register: LwwRegister<T>): T {
  const value = register.value;
  if (value === undefined) throw new Error('Invariant violated: note field never written');
  return value;
}

/** How many quarantined operations a board remembers; it counts all of them. */
const QUARANTINE_KEEP = 100;

function countPoints(text: string): number {
  return text === '' ? 0 : [...text].length;
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** Throws the error if there is one, or an `AggregateError` if there are several. */
function raise(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Several errors while updating the board');
  }
}

/**
 * The board document: an add-wins map from note ids to notes, where each note has `x`, `y`,
 * `color` and `z` as last-writer-wins registers and its text as a `TextSequence`.
 *
 * Every mutator applies its change locally and returns the operations to send to other replicas;
 * `applyRemote` takes operations from anywhere (other replicas, a stored log) in any order, once
 * or many times. Every operation that changes the board is appended to the op log.
 *
 * Any write to a note, including a text edit, re-asserts the note (add wins): a note that one
 * replica deletes while another concurrently edits, moves or recolours it is kept.
 */
export class Board {
  readonly replicaId: ReplicaId;
  readonly #hlc: HybridLogicalClock;
  readonly #texts = new Map<string, TextSequence>();
  readonly #notesBuffer: CausalBuffer<AwMapOp<NoteFields>>;
  readonly #log: BoardOp[] = [];
  readonly #listeners = new Set<(change: BoardChange) => void>();
  /** One limit for the operations held back in the note map and in every note's text. */
  readonly #pending: PendingBudget;
  readonly #maxNoteNodes: number;
  readonly #quarantine: QuarantinedOp[] = [];
  #quarantined = 0;
  /** Remote operations applied because of the local write in progress, to be announced after it. */
  #released: Changes | undefined;
  #notes = AwMap.empty<NoteFields>(joinFields);

  constructor(options: BoardOptions) {
    this.replicaId = options.replicaId;
    this.#pending = new PendingBudget(options.maxPendingOps ?? MAX_PENDING_OPS);
    this.#maxNoteNodes = options.maxNoteNodes ?? MAX_NOTE_NODES;
    // Remote timestamps are never rejected here: a replica that dropped an operation another one
    // applied would diverge. Bounding clock drift is the server's job, before operations are shared.
    this.#hlc = new HybridLogicalClock({
      replicaId: options.replicaId,
      physicalClock: options.clock,
      maxDriftMs: Number.MAX_SAFE_INTEGER,
    });
    this.#notesBuffer = new CausalBuffer<AwMapOp<NoteFields>>({
      budget: this.#pending,
      provides: (op) => (op.type === 'put' ? op.dot : undefined),
      requires: (op) => {
        if (op.type === 'remove') return op.dots;
        // A replica's writes are applied in order, after everything they replace.
        const previous = op.dot.counter > 1 ? [opId(op.dot.counter - 1, op.dot.replicaId)] : [];
        return [...previous, ...op.supersedes];
      },
      isApplied: (id) => this.#notes.version.includes(id),
    });
  }

  // ---- Reading ----------------------------------------------------------------------------

  /** Number of notes on the board. */
  get size(): number {
    return this.#notes.size;
  }

  getNote(id: string): NoteView | undefined {
    const fields = this.#notes.get(id);
    return fields === undefined ? undefined : this.#view(id, fields);
  }

  /** All notes, bottom to top: ordered by `z`, then by id. */
  notes(): NoteView[] {
    return this.#notes
      .entries()
      .map(([id, fields]) => this.#view(id, fields))
      .sort((a, b) => compareValues(a.z, b.z) || compareValues(a.id, b.id));
  }

  /**
   * The note's text as the sequence holds it: every character in document order, deleted ones
   * (tombstones) included, each with its id. Empty for a note that never had text. This is what
   * lets a history point at characters by id instead of by index, which remote edits shift.
   */
  textNodes(noteId: string): TextNode[] {
    return this.#texts.get(noteId)?.nodes() ?? [];
  }

  /** The note's fields with the timestamps they were written at, or `undefined` if it is gone. */
  getFields(noteId: string): NoteFields | undefined {
    return this.#notes.get(noteId);
  }

  /** Every operation that changed the board, in the order it was applied. */
  get log(): readonly BoardOp[] {
    return this.#log;
  }

  /** The op log as JSON (see `board-json.ts`); feed it to `deserializeBoardOps` and `applyRemote`. */
  serializeLog(): string {
    return serializeBoardOps(this.#log);
  }

  /** Remote operations held back until the operations they depend on arrive. */
  get pendingCount(): number {
    return this.#pending.used;
  }

  /** The most recent operations `applyUntrusted` set aside, oldest first (the last 100). */
  get quarantine(): readonly QuarantinedOp[] {
    return this.#quarantine;
  }

  /** How many operations `applyUntrusted` has set aside in all. */
  get quarantinedCount(): number {
    return this.#quarantined;
  }

  /**
   * Canonical description of the whole state, including deleted notes' text and the causal
   * context. Two replicas have converged iff their snapshots serialise equally.
   */
  snapshot(): JsonValue {
    const stamped = <T extends number | string>(register: LwwRegister<T>): JsonValue => [
      register.value ?? null,
      register.timestamp === undefined ? null : formatHlc(register.timestamp),
    ];
    const texts = [...this.#texts]
      .map(([id, sequence]) => [id, sequence.nodes()] as const)
      .filter(([, nodes]) => nodes.length > 0)
      .sort(([a], [b]) => compareValues(a, b))
      .map(
        ([id, nodes]): JsonValue => [
          id,
          nodes.map((n) => [
            opIdKey(n.id),
            n.parent === null ? null : opIdKey(n.parent),
            n.side,
            n.value,
            n.deleted,
          ]),
        ],
      );
    return {
      version: this.#notes.version.entries().map(([replica, counter]) => [replica, counter]),
      dots: this.#notes
        .dotEntries()
        .map(({ key, dot, value }) => [
          key,
          opIdKey(dot),
          stamped(value.x),
          stamped(value.y),
          stamped(value.z),
          stamped(value.color),
        ]),
      texts,
      pending: this.pendingCount,
    };
  }

  // ---- Subscriptions ----------------------------------------------------------------------

  /**
   * Calls `listener` once after each local call and each `applyRemote` that changed the board.
   * Returns the function that unsubscribes. If listeners throw, all of them still run and the
   * error reaches the caller afterwards; the changes stay applied and in the op log.
   */
  subscribe(listener: (change: BoardChange) => void): () => void {
    const entry = (change: BoardChange): void => {
      listener(change);
    };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  // ---- Local changes: each applies the change and returns the operations to send ------------

  /** Creates a note on top of the others. Returns its id and the operations. */
  createNote(init: NoteInit = {}): { id: string; ops: BoardOp[] } {
    const { x = 0, y = 0, color = 'yellow', text = '' } = init;
    assertCoordinate(x, 'x');
    assertCoordinate(y, 'y');
    assertColor(color);
    // The id is the note's first write: the creating replica's next map counter.
    const id = opIdKey(opId(this.#notes.version.get(this.replicaId) + 1, this.replicaId));
    this.#sequence(id).assertRoom(countPoints(text)); // before anything changes
    const at = this.#hlc.tick();
    const fields: NoteFields = {
      x: written(LwwRegister.empty<number>(), x, at),
      y: written(LwwRegister.empty<number>(), y, at),
      z: written(LwwRegister.empty<number>(), this.#topZ() + 1, at),
      color: written(LwwRegister.empty<NoteColor>(), color, at),
    };
    const changes = this.#newChanges();
    this.#applyNotesOp(this.#notes.prepareSet(this.replicaId, id, fields), changes, true);
    this.#recordText(id, this.#sequence(id).insert(0, text), changes);
    return { id, ops: this.#finishLocal(changes) };
  }

  /** Moves the note. `x` and `y` are written with one timestamp, so concurrent moves never tear. */
  moveNote(noteId: string, x: number, y: number): BoardOp[] {
    assertCoordinate(x, 'x');
    assertCoordinate(y, 'y');
    const fields = this.#require(noteId);
    const at = this.#hlc.tick();
    const moved = { ...fields, x: written(fields.x, x, at), y: written(fields.y, y, at) };
    return this.#write(noteId, moved);
  }

  setColor(noteId: string, color: NoteColor): BoardOp[] {
    assertColor(color);
    const fields = this.#require(noteId);
    const recoloured = { ...fields, color: written(fields.color, color, this.#hlc.tick()) };
    return this.#write(noteId, recoloured);
  }

  /** Puts the note above all others. */
  bringToFront(noteId: string): BoardOp[] {
    const fields = this.#require(noteId);
    const raised = { ...fields, z: written(fields.z, this.#topZ() + 1, this.#hlc.tick()) };
    return this.#write(noteId, raised);
  }

  /**
   * Replaces `deleteCount` characters at `index` with `insert`, like `Array.prototype.splice`.
   * Indices count code points. Returns no operations if nothing changes.
   */
  editText(noteId: string, index: number, deleteCount: number, insert: string): BoardOp[] {
    const fields = this.#require(noteId);
    const sequence = this.#sequence(noteId);
    sequence.assertRoom(countPoints(insert)); // before the deletions are applied
    const changes = this.#newChanges();
    this.#recordText(noteId, sequence.delete(index, deleteCount), changes);
    this.#recordText(noteId, sequence.insert(index, insert), changes);
    if (changes.applied.length === 0) return [];
    // Re-assert the note, so that a concurrent delete of it does not hide this edit.
    this.#applyNotesOp(this.#notes.prepareSet(this.replicaId, noteId, fields), changes, true);
    return this.#finishLocal(changes);
  }

  /**
   * Types `text` directly after the character `after` (`null` for the start), which may be one
   * that was deleted: the text lands where that character stands, whatever has happened around it
   * (see `TextSequence.insertAfter`). Returns no operations if `text` is empty.
   */
  insertTextAfter(noteId: string, after: OpId | null, text: string): BoardOp[] {
    const fields = this.#require(noteId);
    const changes = this.#newChanges();
    this.#recordText(noteId, this.#sequence(noteId).insertAfter(after, text), changes);
    if (changes.applied.length === 0) return [];
    this.#applyNotesOp(this.#notes.prepareSet(this.replicaId, noteId, fields), changes, true);
    return this.#finishLocal(changes);
  }

  /**
   * Deletes the note. Its text is kept, so a concurrent edit that survives the delete (add wins)
   * finds the note's text intact.
   */
  deleteNote(noteId: string): BoardOp[] {
    const remove = this.#notes.prepareRemove(noteId);
    if (remove === undefined) throw new UnknownNoteError(`No note ${JSON.stringify(noteId)}`);
    const changes = this.#newChanges();
    this.#applyNotesOp(remove, changes);
    return this.#finishLocal(changes);
  }

  /**
   * Puts a deleted note back with the fields it had (see `getFields`), text included: a deleted
   * note's text is kept. The fields keep their old timestamps, so anything another replica wrote
   * since still wins. Does nothing if the note exists, for example because a concurrent edit by
   * someone else kept it (add wins).
   */
  restoreNote(noteId: string, fields: NoteFields): BoardOp[] {
    if (this.#notes.get(noteId) !== undefined) return [];
    const changes = this.#newChanges();
    this.#applyNotesOp(this.#notes.prepareSet(this.replicaId, noteId, fields), changes, true);
    return this.#finishLocal(changes);
  }

  // ---- Remote changes ---------------------------------------------------------------------

  /**
   * Applies operations created elsewhere (or read from a log). They may arrive in any order and
   * more than once: an operation whose predecessors are missing is held until they arrive, and
   * one that is already applied is ignored. Malformed operations are rejected before anything
   * is applied.
   */
  applyRemote(ops: readonly BoardOp[]): void {
    for (const op of ops) assertValidBoardOp(op);
    const changes = this.#newChanges();
    const errors: unknown[] = [];
    try {
      for (const op of ops) this.#integrate(op, changes);
    } catch (error) {
      errors.push(error);
    }
    errors.push(...this.#publish('remote', changes));
    raise(errors);
  }

  /**
   * Like `applyRemote`, for operations that may come from a misbehaving peer: nothing an operation
   * contains makes this throw. An operation that is malformed, that cannot be applied (an id used
   * twice for different characters), that would make a text too long, or that arrives when too many
   * others are already waiting for missing ones, is set aside (see `quarantine`) and the rest go
   * through. Returns the operations set aside by this call. Only errors thrown by subscribers
   * still surface, after the change has been applied.
   */
  applyUntrusted(ops: readonly unknown[]): QuarantinedOp[] {
    const changes = this.#newChanges();
    const rejected: QuarantinedOp[] = [];
    const reject = (op: unknown, error: unknown): void => {
      rejected.push({ op, reason: reasonOf(error) });
    };
    for (const op of ops) {
      try {
        assertValidBoardOp(op as BoardOp);
        this.#integrate(op as BoardOp, changes, reject);
      } catch (error) {
        reject(op, error);
      }
    }
    for (const entry of rejected) this.#quarantine.push(entry);
    this.#quarantined += rejected.length;
    this.#quarantine.splice(0, Math.max(0, this.#quarantine.length - QUARANTINE_KEEP));
    raise(this.#publish('remote', changes));
    return rejected;
  }

  // ---- Internals --------------------------------------------------------------------------

  #view(id: string, fields: NoteFields): NoteView {
    return {
      id,
      x: filled(fields.x),
      y: filled(fields.y),
      color: filled(fields.color),
      z: filled(fields.z),
      text: this.#texts.get(id)?.toString() ?? '',
    };
  }

  #topZ(): number {
    let top = 0;
    for (const [, fields] of this.#notes.entries()) top = Math.max(top, filled(fields.z));
    return top;
  }

  #require(noteId: string): NoteFields {
    const fields = this.#notes.get(noteId);
    if (fields === undefined) throw new UnknownNoteError(`No note ${JSON.stringify(noteId)}`);
    return fields;
  }

  #sequence(noteId: string): TextSequence {
    let sequence = this.#texts.get(noteId);
    if (sequence === undefined) {
      sequence = new TextSequence(this.replicaId, {
        maxNodes: this.#maxNoteNodes,
        pending: this.#pending,
      });
      this.#texts.set(noteId, sequence);
    }
    return sequence;
  }

  #newChanges(): Changes {
    return { applied: [], touched: new Set() };
  }

  /** Writes the note's new value as a map write that replaces the dots this replica has seen. */
  #write(noteId: string, fields: NoteFields): BoardOp[] {
    const changes = this.#newChanges();
    this.#applyNotesOp(this.#notes.prepareSet(this.replicaId, noteId, fields), changes, true);
    return this.#finishLocal(changes);
  }

  #record(changes: Changes, op: BoardOp): void {
    this.#log.push(op);
    changes.applied.push(op);
    changes.touched.add(op.type === 'notes' ? op.op.key : op.noteId);
  }

  /** Records text operations that `TextSequence.insert` or `delete` already applied locally. */
  #recordText(noteId: string, ops: readonly TextOp[], changes: Changes): void {
    for (const op of ops) this.#record(changes, { type: 'text', noteId, op });
    // Text that other replicas wrote for characters this replica has only now made (see
    // `CausalBuffer.supplied`) is applied now, and is theirs, not part of this edit.
    for (const op of this.#sequence(noteId).takeReleased()) {
      this.#record(this.#releasedChanges(), { type: 'text', noteId, op });
    }
  }

  /** `local`: the operation was just made here, so what was waiting for its dot can go ahead. */
  #applyNotesOp(op: AwMapOp<NoteFields>, changes: Changes, local = false): void {
    const next = this.#notes.apply(op);
    if (next === this.#notes) return; // already applied, or removes nothing
    this.#notes = next;
    this.#record(changes, { type: 'notes', op });
    if (op.type !== 'put') return;
    this.#observe(op.value);
    if (local) {
      this.#notesBuffer.supplied(
        op.dot,
        (ready) => {
          this.#applyNotesOp(ready, this.#releasedChanges());
        },
        () => undefined,
      );
    }
  }

  /** What other replicas wrote that was applied only because of a local write. */
  #releasedChanges(): Changes {
    return (this.#released ??= this.#newChanges());
  }

  /** With `reject`, an operation that fails goes there instead of throwing. */
  #integrate(op: BoardOp, changes: Changes, reject?: (op: unknown, error: unknown) => void): void {
    if (op.type === 'notes') {
      this.#notesBuffer.receive(
        op.op,
        (ready) => {
          this.#applyNotesOp(ready, changes);
        },
        reject && ((failed, error) => reject({ type: 'notes', op: failed }, error)),
      );
    } else {
      this.#sequence(op.noteId).apply(
        op.op,
        (applied) => {
          this.#record(changes, { type: 'text', noteId: op.noteId, op: applied });
        },
        reject &&
          ((failed, error) => reject({ type: 'text', noteId: op.noteId, op: failed }, error)),
      );
    }
  }

  /** Moves this replica's clock past the newest timestamp in a note value written elsewhere. */
  #observe(fields: NoteFields): void {
    let latest: HlcTimestamp | undefined;
    for (const register of [fields.x, fields.y, fields.z, fields.color]) {
      const at = register.timestamp;
      if (at !== undefined && (latest === undefined || compareHlc(at, latest) > 0)) latest = at;
    }
    if (latest !== undefined && compareHlc(latest, this.#hlc.latest) > 0) {
      this.#hlc.receive(latest);
    }
  }

  #finishLocal(changes: Changes): BoardOp[] {
    const errors = this.#publish('local', changes);
    const released = this.#released;
    this.#released = undefined;
    if (released !== undefined) errors.push(...this.#publish('remote', released));
    raise(errors);
    return changes.applied;
  }

  /** Tells every subscriber; returns the errors they threw instead of throwing them. */
  #publish(source: BoardChange['source'], changes: Changes): unknown[] {
    if (changes.applied.length === 0) return [];
    const change: BoardChange = {
      source,
      noteIds: [...changes.touched].sort(compareValues),
      ops: changes.applied,
    };
    const errors: unknown[] = [];
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }
}
