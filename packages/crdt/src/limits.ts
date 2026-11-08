/**
 * Limits that keep one misbehaving peer from using up a replica's memory. They are generous for
 * honest use; see "Security" in DESIGN.md for what each one protects and what it costs.
 */

/**
 * Remote operations a board holds back at once because something they depend on has not arrived.
 * Shared by the note map and every note's text. An honest replica holds back as many as the
 * operations of one author that build on another's, which is at most the size of the board.
 */
export const MAX_PENDING_OPS = 250_000;

/**
 * Characters in one note's text, deleted ones (tombstones) included, because those are what a
 * replica keeps in memory.
 */
export const MAX_NOTE_NODES = 100_000;

/**
 * Ids one operation may refer to: the dots a write replaces or a delete removes. There is at most
 * one such dot per replica that wrote the note, and a board has at most 1000 replicas.
 */
export const MAX_OP_REFS = 1000;
