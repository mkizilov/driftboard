import { isReplicaId, type ReplicaId } from '@driftboard/crdt';
import { z } from 'zod';
import { BinaryFormatError, decodeOps, encodeOps } from './binary';
import {
  ERROR_CODES,
  MAX_BOARD_ID_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_FRAME_BYTES,
  MAX_NAME_LENGTH,
  MAX_NOTE_ID_LENGTH,
  MAX_OPS_PER_MESSAGE,
  MAX_VECTOR_ENTRIES,
} from './constants';

const replicaIdSchema = z.custom<ReplicaId>((value) => isReplicaId(value), 'Invalid replica id');
const boardIdSchema = z.string().min(1).max(MAX_BOARD_ID_LENGTH);
const noteIdSchema = z.string().min(1).max(MAX_NOTE_ID_LENGTH);
const counterSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** A version vector on the wire: `[replicaId, count]` pairs, each replica at most once, no zeros. */
export const versionVectorSchema = z
  .array(z.tuple([replicaIdSchema, counterSchema]))
  .max(MAX_VECTOR_ENTRIES)
  .refine(
    (entries) => new Set(entries.map(([replica]) => replica)).size === entries.length,
    'A replica appears twice in the version vector',
  );

/**
 * One operation as it travels: the replica that authored it, that replica's sequence number for it
 * (1, 2, 3, ... without gaps) and the board operation in its JSON form (see `board-json.ts` in
 * `@driftboard/crdt`). Only the envelope is checked here; the sync logic checks the payload in
 * depth and stores it in canonical form.
 */
export const stampedOpSchema = z
  .object({
    origin: replicaIdSchema,
    seq: counterSchema,
    op: z.record(z.string(), z.unknown()),
  })
  .strict();

export const helloSchema = z
  .object({
    type: z.literal('hello'),
    /** Not restricted here, so that a mismatch can be answered with `unsupported_version`. */
    version: z.number().int().min(1),
    replicaId: replicaIdSchema,
    boardId: boardIdSchema,
    versionVector: versionVectorSchema,
  })
  .strict();

export const opsSchema = z
  .object({
    type: z.literal('ops'),
    ops: z.array(stampedOpSchema).min(1).max(MAX_OPS_PER_MESSAGE),
  })
  .strict();

/** "I hold every operation this vector covers." */
export const ackSchema = z
  .object({ type: z.literal('ack'), versionVector: versionVectorSchema })
  .strict();

/** Who someone is and what they are doing on the board right now. It is never stored. */
export const presenceStateSchema = z
  .object({
    /** The pointer in board coordinates, or `null` when it is not over the board. */
    cursor: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .strict()
      .nullable(),
    /** The note whose text this person is editing, if any. */
    editing: noteIdSchema.nullable(),
    name: z.string().min(1).max(MAX_NAME_LENGTH),
    /** `#rrggbb`, lower case. */
    color: z.string().regex(/^#[0-9a-f]{6}$/),
  })
  .strict();

/** `state: null` means the replica has left (or cleared its presence). */
export const presenceSchema = z
  .object({
    type: z.literal('presence'),
    replicaId: replicaIdSchema,
    state: presenceStateSchema.nullable(),
  })
  .strict();

export const errorSchema = z
  .object({
    type: z.literal('error'),
    code: z.enum(ERROR_CODES),
    message: z.string().max(MAX_ERROR_MESSAGE_LENGTH),
  })
  .strict();

/** Every message either side can send. */
export const messageSchema = z.discriminatedUnion('type', [
  helloSchema,
  opsSchema,
  ackSchema,
  presenceSchema,
  errorSchema,
]);

export type WireOp = z.infer<typeof stampedOpSchema>;
export type Hello = z.infer<typeof helloSchema>;
export type Ops = z.infer<typeof opsSchema>;
export type Ack = z.infer<typeof ackSchema>;
export type PresenceState = z.infer<typeof presenceStateSchema>;
export type Presence = z.infer<typeof presenceSchema>;
export type ErrorMessage = z.infer<typeof errorSchema>;
export type ErrorCode = ErrorMessage['code'];
export type Message = z.infer<typeof messageSchema>;

export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };

/** Parses one text frame. Never throws. */
export function parseMessage(raw: string): ParseResult<Message> {
  if (raw.length > MAX_FRAME_BYTES) return { ok: false, error: 'frame too large' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  const result = messageSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    return { ok: false, error: issues.join('; ').slice(0, MAX_ERROR_MESSAGE_LENGTH) };
  }
  return { ok: true, message: result.data };
}

export function encodeMessage(message: Message): string {
  return JSON.stringify(message);
}

/**
 * What goes over a WebSocket: a text frame of JSON, or a binary frame. Operations are the bulk of
 * the traffic and are sent as a binary frame (see `binary.ts`); everything else is JSON text.
 */
export type Frame = string | Uint8Array;

export function encodeFrame(message: Message): Frame {
  return message.type === 'ops' ? encodeOps(message.ops) : encodeMessage(message);
}

/**
 * Parses one frame, text or binary, as the transports hand it over (a string, a `Uint8Array` or
 * `Buffer`, or an `ArrayBuffer`). A text frame is any message in its JSON form, `ops` included; a
 * binary frame is a batch of operations. Never throws.
 */
export function parseFrame(frame: string | Uint8Array | ArrayBuffer): ParseResult<Message> {
  if (typeof frame === 'string') return parseMessage(frame);
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.length > MAX_FRAME_BYTES) return { ok: false, error: 'frame too large' };
  try {
    const ops = decodeOps(bytes, MAX_OPS_PER_MESSAGE);
    if (ops.length === 0) return { ok: false, error: 'ops: no operations' };
    return { ok: true, message: { type: 'ops', ops } };
  } catch (error) {
    if (!(error instanceof BinaryFormatError)) throw error;
    return { ok: false, error: error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH) };
  }
}
