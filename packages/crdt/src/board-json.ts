import type { AwMapOp } from './aw-map';
import {
  BoardFormatError,
  assertValidBoardOp,
  type BoardOp,
  type NoteColor,
  type NoteFields,
} from './board-ops';
import { formatHlc, parseHlc } from './hlc';
import { LwwRegister } from './lww-register';
import { opIdKey, parseOpIdKey, type OpId } from './op-id';
import type { TextSide } from './text-sequence';

/**
 * JSON form of board operations, for the op log, files and the wire. Identifiers are strings
 * (`counter@replica` for operation ids, the fixed-width form for hybrid timestamps), so the data
 * is compact and every field is checked on the way back in. Format version 1:
 *
 *   { "format": "driftboard-ops", "version": 1, "ops": [ <op>, ... ] }
 *
 *   note-put     { type, noteId, dot, supersedes: [id], fields: { x, y, z, color } }
 *                 each field is { value, at: <hybrid timestamp> }
 *   note-remove  { type, noteId, dots: [id] }
 *   text-insert  { type, noteId, id, parent: id | null, side: "left" | "right", value }
 *   text-delete  { type, noteId, target: id }
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

const FORMAT = 'driftboard-ops';
const VERSION = 1;

function registerToJson<T extends number | string>(register: LwwRegister<T>): JsonValue {
  const { value, timestamp } = register;
  if (value === undefined || timestamp === undefined) {
    throw new BoardFormatError('Cannot serialise a note field that was never written');
  }
  return { value, at: formatHlc(timestamp) };
}

/** Converts one operation to plain JSON data. */
export function boardOpToJson(op: BoardOp): JsonObject {
  if (op.type === 'text') {
    const { noteId, op: textOp } = op;
    return textOp.type === 'insert'
      ? {
          type: 'text-insert',
          noteId,
          id: opIdKey(textOp.id),
          parent: textOp.parent === null ? null : opIdKey(textOp.parent),
          side: textOp.side,
          value: textOp.value,
        }
      : { type: 'text-delete', noteId, target: opIdKey(textOp.target) };
  }
  const noteOp = op.op;
  if (noteOp.type === 'remove') {
    return { type: 'note-remove', noteId: noteOp.key, dots: noteOp.dots.map(opIdKey) };
  }
  return {
    type: 'note-put',
    noteId: noteOp.key,
    dot: opIdKey(noteOp.dot),
    supersedes: noteOp.supersedes.map(opIdKey),
    fields: {
      x: registerToJson(noteOp.value.x),
      y: registerToJson(noteOp.value.y),
      z: registerToJson(noteOp.value.z),
      color: registerToJson(noteOp.value.color),
    },
  };
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BoardFormatError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new BoardFormatError(`${what} must be a string`);
  return value;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new BoardFormatError(`${what} must be an array`);
  return value as unknown[];
}

function opIdFrom(value: unknown, what: string): OpId {
  return parseOpIdKey(asString(value, what));
}

function registerFrom<T extends number | string>(value: unknown, what: string): LwwRegister<T> {
  const entry = asObject(value, what);
  const register = LwwRegister.empty<T>();
  return register.apply({
    type: 'set',
    value: entry['value'] as T,
    timestamp: parseHlc(asString(entry['at'], `${what}.at`)),
  });
}

function fieldsFrom(value: unknown): NoteFields {
  const fields = asObject(value, 'fields');
  return {
    x: registerFrom<number>(fields['x'], 'fields.x'),
    y: registerFrom<number>(fields['y'], 'fields.y'),
    z: registerFrom<number>(fields['z'], 'fields.z'),
    color: registerFrom<NoteColor>(fields['color'], 'fields.color'),
  };
}

function opFromObject(json: Record<string, unknown>): BoardOp {
  const type = asString(json['type'], 'type');
  const noteId = asString(json['noteId'], 'noteId');
  switch (type) {
    case 'note-put': {
      const op: AwMapOp<NoteFields> = {
        type: 'put',
        key: noteId,
        dot: opIdFrom(json['dot'], 'dot'),
        supersedes: asArray(json['supersedes'], 'supersedes').map((id) =>
          opIdFrom(id, 'supersedes'),
        ),
        value: fieldsFrom(json['fields']),
      };
      return { type: 'notes', op };
    }
    case 'note-remove': {
      const dots = asArray(json['dots'], 'dots').map((id) => opIdFrom(id, 'dots'));
      return { type: 'notes', op: { type: 'remove', key: noteId, dots } };
    }
    case 'text-insert': {
      const parent = json['parent'];
      return {
        type: 'text',
        noteId,
        op: {
          type: 'insert',
          id: opIdFrom(json['id'], 'id'),
          parent: parent === null ? null : opIdFrom(parent, 'parent'),
          side: asString(json['side'], 'side') as TextSide,
          value: asString(json['value'], 'value'),
        },
      };
    }
    case 'text-delete':
      return {
        type: 'text',
        noteId,
        op: { type: 'delete', target: opIdFrom(json['target'], 'target') },
      };
    default:
      throw new BoardFormatError(`Unknown operation type ${JSON.stringify(type)}`);
  }
}

/** Converts untyped JSON data back to an operation, throwing `BoardFormatError` if it is malformed. */
export function boardOpFromJson(value: unknown): BoardOp {
  try {
    const op = opFromObject(asObject(value, 'operation'));
    assertValidBoardOp(op);
    return op;
  } catch (error) {
    if (error instanceof RangeError) throw new BoardFormatError(error.message);
    throw error;
  }
}

export function serializeBoardOps(ops: readonly BoardOp[]): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, ops: ops.map(boardOpToJson) });
}

/** Inverse of `serializeBoardOps`. Throws `BoardFormatError` for anything that is not valid. */
export function deserializeBoardOps(text: string): BoardOp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BoardFormatError('Not valid JSON');
  }
  const envelope = asObject(parsed, 'envelope');
  if (envelope['format'] !== FORMAT) {
    throw new BoardFormatError(`format must be ${JSON.stringify(FORMAT)}`);
  }
  if (envelope['version'] !== VERSION) {
    throw new BoardFormatError(`Unsupported version ${String(envelope['version'])}`);
  }
  return asArray(envelope['ops'], 'ops').map(boardOpFromJson);
}
