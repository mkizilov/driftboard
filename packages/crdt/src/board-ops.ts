import type { AwMapOp } from './aw-map';
import type { LwwRegister } from './lww-register';
import { MAX_OP_REFS } from './limits';
import { isOpId } from './op-id';
import { assertValidTextOp, type TextOp } from './text-sequence';

/** The fixed palette a note can be coloured from. */
export const NOTE_COLORS = ['yellow', 'pink', 'green', 'blue', 'purple', 'orange'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export const MAX_NOTE_ID_LENGTH = 200;

export function isNoteColor(value: unknown): value is NoteColor {
  return typeof value === 'string' && (NOTE_COLORS as readonly string[]).includes(value);
}

/** The value stored for each note in the board's add-wins map: four last-writer-wins registers. */
export interface NoteFields {
  readonly x: LwwRegister<number>;
  readonly y: LwwRegister<number>;
  readonly color: LwwRegister<NoteColor>;
  readonly z: LwwRegister<number>;
}

/**
 * One board operation: an operation on the add-wins map of notes (create, change or delete a
 * note), or on the text sequence of one note. Operations are immutable data.
 */
export type BoardOp =
  | { readonly type: 'notes'; readonly op: AwMapOp<NoteFields> }
  | { readonly type: 'text'; readonly noteId: string; readonly op: TextOp };

/** What a reader sees of a note. */
export interface NoteView {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly color: NoteColor;
  /** Stacking order: a larger `z` is drawn above a smaller one. */
  readonly z: number;
  readonly text: string;
}

/** Sent to subscribers once per local call or `applyRemote` that changed the board. */
export interface BoardChange {
  readonly source: 'local' | 'remote';
  /** Ids of the notes whose fields, text or presence may have changed, sorted. */
  readonly noteIds: readonly string[];
  /** The operations that were applied, in order. */
  readonly ops: readonly BoardOp[];
}

/** An operation from another replica that was set aside instead of applied, and why. */
export interface QuarantinedOp {
  /** What was received. Not necessarily a well-formed operation. */
  readonly op: unknown;
  readonly reason: string;
}

/** The note does not exist (never created, or deleted). */
export class UnknownNoteError extends Error {
  override readonly name = 'UnknownNoteError';
}

/** Serialised operations are malformed. */
export class BoardFormatError extends Error {
  override readonly name = 'BoardFormatError';
}

export function assertCoordinate(value: unknown, what: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${what} must be a finite number, got ${String(value)}`);
  }
}

export function assertColor(value: unknown): asserts value is NoteColor {
  if (!isNoteColor(value)) {
    throw new RangeError(`color must be one of ${NOTE_COLORS.join(', ')}, got ${String(value)}`);
  }
}

function assertNoteId(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NOTE_ID_LENGTH) {
    throw new RangeError(`Invalid note id: ${JSON.stringify(value)}`);
  }
}

function assertOpIds(ids: readonly unknown[], what: string): void {
  if (ids.length > MAX_OP_REFS) throw new RangeError(`Too many operation ids in ${what}`);
  for (const id of ids) {
    if (!isOpId(id)) throw new RangeError(`Invalid operation id in ${what}`);
  }
}

function assertFilled<T>(register: LwwRegister<T>, what: string): T {
  if (register.value === undefined || register.timestamp === undefined) {
    throw new RangeError(`Note field ${what} has never been written`);
  }
  return register.value;
}

/** Throws `RangeError` if a note value is not complete and valid. */
export function assertValidFields(fields: NoteFields): void {
  assertCoordinate(assertFilled(fields.x, 'x'), 'x');
  assertCoordinate(assertFilled(fields.y, 'y'), 'y');
  assertCoordinate(assertFilled(fields.z, 'z'), 'z');
  assertColor(assertFilled(fields.color, 'color'));
}

/**
 * Throws `RangeError` if `op` is malformed. Applying remote operations validates everything first,
 * so a bad operation cannot leave a batch half applied.
 */
export function assertValidBoardOp(op: BoardOp): void {
  if (op.type === 'notes') {
    const inner = op.op;
    assertNoteId(inner.key);
    if (inner.type === 'put') {
      assertOpIds([inner.dot], 'put');
      assertOpIds(inner.supersedes, 'put');
      assertValidFields(inner.value);
    } else if (inner.type === 'remove') {
      assertOpIds(inner.dots, 'remove');
    } else {
      throw new RangeError('Unknown note operation type');
    }
  } else if (op.type === 'text') {
    assertNoteId(op.noteId);
    assertValidTextOp(op.op);
  } else {
    throw new RangeError('Unknown board operation type');
  }
}
