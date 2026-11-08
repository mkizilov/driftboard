/**
 * The version both sides must speak. 2: presence carries the person's name, colour and the note
 * they are editing (it used to carry a list of selected notes). 3: operations travel in binary
 * frames (`encodeFrame`, see `binary.ts`) instead of JSON text; the other messages are still text.
 */
export const PROTOCOL_VERSION = 3;

/** Largest number of operations in one `ops` message; larger batches are split. */
export const MAX_OPS_PER_MESSAGE = 500;

/** Largest number of replicas in a version vector. */
export const MAX_VECTOR_ENTRIES = 1000;

export const MAX_BOARD_ID_LENGTH = 200;
export const MAX_NOTE_ID_LENGTH = 200;
export const MAX_NAME_LENGTH = 80;
export const MAX_TOKEN_LENGTH = 64;

export const MAX_ERROR_MESSAGE_LENGTH = 500;

/** Largest frame a peer may send. Transports should enforce this too (`ws` `maxPayload`). */
export const MAX_FRAME_BYTES = 1_048_576;

export const ERROR_CODES = [
  'invalid_message',
  'unsupported_version',
  'wrong_board',
  'unexpected_message',
  'out_of_order',
  'conflicting_op',
  'internal_error',
  /** The connection sent more than it is allowed to; it is closed. */
  'rate_limited',
] as const;
