import {
  NOTE_COLORS,
  formatHlc,
  hlcTimestamp,
  isReplicaId,
  parseHlc,
  type HlcTimestamp,
  type JsonObject,
  type ReplicaId,
} from '@driftboard/crdt';
import { BinaryFormatError, ByteReader, ByteWriter } from './bytes';
import { MAX_NOTE_ID_LENGTH } from './constants';
import type { StampedOp } from './ops';

export { BinaryFormatError } from './bytes';

/**
 * Compact binary form of a batch of operations, for the wire and for snapshots. The operations are
 * the canonical JSON ones of `board-json.ts` and come back exactly as they went in (same values,
 * same key order), so everything built on them, such as comparing stored operations as text, is
 * unchanged. Format version 1:
 *
 *   batch    = 0xDB 0x01 groupCount group*
 *   group    = origin firstSeq opCount item*      one origin's operations firstSeq, firstSeq+1, ...
 *   item     = 0x01 insertRun | 0x02 deleteRun | 0x03 put | 0x04 remove | 0x05 reassert
 *
 * Numbers are varints (seven bits per byte, so most take one or two). Replica ids and note ids are
 * written once per batch, where first used (`name` below is an index into those seen so far, or
 * the next free index followed by the string itself), and are an index after that. Then:
 *
 *   insertRun = note replica counter flags [parentDelta | parentReplica parentCounter] count char*
 *               A run of text inserts by one replica into one note, each hanging to the right of
 *               the one before it (what typing a word makes): only the first is written whole.
 *               The characters are code points, one varint each. flags: bits 0-1 say where the
 *               parent is (0 the start of the text, 1 the same replica, that much before this
 *               counter, 2 another replica), bit 2 says the side (1 left), bit 3 says that every
 *               insert is followed by a re-assertion of its note (see below), which makes the run
 *               cover twice `count` operations: that is what typing a key at a time makes.
 *   deleteRun = note replica counter (count << 2 | paired << 1 | descending)
 *               Deletes of consecutive counters by one replica: a selection removed (ascending)
 *               or backspacing over a word (descending), alone or each followed by a re-assertion.
 *   put       = note replica counter supersedes mask field*
 *               supersedes = count (0 delta | 1 replica counter)*; mask: bit i set when field i
 *               (x, y, z, color) is as in the previous put of this note in the batch; the other
 *               fields follow as a number (colour: index) and a timestamp (wall time as a
 *               difference from the previous timestamp in the batch, logical counter, replica)
 *   remove    = note count (replica counter)*
 *   reassert  = note
 *               Every text edit also writes its note again, unchanged, as the next write of its
 *               replica replacing the latest one of that note. When that is what a put is, given
 *               the puts earlier in the batch, only the note is written.
 *   number    = varint(zigzag(n) * 2) for a whole number, or 1 and a float64
 */

const MAGIC = 0xdb;
const VERSION = 1;

const TAG_INSERT = 1;
const TAG_DELETE = 2;
const TAG_PUT = 3;
const TAG_REMOVE = 4;
const TAG_REASSERT = 5;

const FIELDS = ['x', 'y', 'z', 'color'] as const;
const ALL_SAME = 0b1111;
/** The most operations one run covers; longer ones are written as several. */
const MAX_RUN = 1 << 20;
/** Whole numbers up to this size are written as varints; beyond it a number is a float64. */
const MAX_VARINT_NUMBER = 2 ** 50;

interface FieldValue {
  readonly value: number | string;
  readonly at: string;
}

interface Id {
  readonly replica: string;
  readonly counter: number;
}

/** The dot counter and the superseded dot of a re-assertion that is about to be written. */
interface Next {
  readonly counter: number;
  readonly supersedes: string;
}

const keyOf = (id: Id): string => `${id.counter}@${id.replica}`;

/** An operation body as the encoder sees it: not yet known to be in canonical form. */
type Body = { readonly [key: string]: unknown };

/** An operation with its place in the stream of its origin; `StampedOp` and the wire's ops fit. */
export interface EncodableOp {
  readonly origin: string;
  readonly seq: number;
  readonly op: Body;
}

// ---- Small checks on the JSON side -----------------------------------------------------------

function fail(what: string): never {
  throw new BinaryFormatError(`Not a canonical operation: ${what}`);
}

function stringOf(object: Body, key: string): string {
  const value = object[key];
  if (typeof value !== 'string') return fail(`${key} must be a string`);
  return value;
}

function objectOf(value: unknown, what: string): Body {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(`${what} must be an object`);
  }
  return value as Body;
}

function listOf(object: Body, key: string): readonly unknown[] {
  const value = object[key];
  if (!Array.isArray(value)) return fail(`${key} must be an array`);
  return value as readonly unknown[];
}

/** Reads `counter@replica`, refusing anything that would not be written back the same. */
function idOf(key: string): Id {
  const at = key.indexOf('@');
  const counter = Number(key.slice(0, at));
  if (at < 1 || at === key.length - 1 || !Number.isSafeInteger(counter) || counter < 1) {
    return fail(`operation id ${JSON.stringify(key)}`);
  }
  if (String(counter) !== key.slice(0, at)) return fail(`operation id ${JSON.stringify(key)}`);
  return { replica: key.slice(at + 1), counter };
}

function codePointOf(value: string): number {
  const point = value.codePointAt(0);
  if (point === undefined || value.length !== (point > 0xffff ? 2 : 1)) {
    return fail(`a text insert carries ${JSON.stringify(value)}, not one code point`);
  }
  return point;
}

// ---- Names ------------------------------------------------------------------------------------

/** The strings of one kind (replica ids, note ids) seen so far in a batch. */
class Names {
  readonly #index = new Map<string, number>();
  readonly #list: string[] = [];
  readonly #maxLength: number;
  readonly #valid: (name: string) => boolean;

  constructor(maxLength: number, valid: (name: string) => boolean) {
    this.#maxLength = maxLength;
    this.#valid = valid;
  }

  write(writer: ByteWriter, name: string): void {
    const known = this.#index.get(name);
    if (known !== undefined) {
      writer.varint(known);
      return;
    }
    writer.varint(this.#list.length);
    writer.string(name);
    this.#index.set(name, this.#list.length);
    this.#list.push(name);
  }

  read(reader: ByteReader): string {
    const index = reader.varint();
    const known = this.#list[index];
    if (known !== undefined) return known;
    if (index !== this.#list.length) throw new BinaryFormatError('A name is out of range');
    const name = reader.string(this.#maxLength);
    if (!this.#valid(name)) throw new BinaryFormatError(`Invalid name ${JSON.stringify(name)}`);
    this.#list.push(name);
    return name;
  }
}

const replicaNames = () => new Names(64, isReplicaId);
const noteNames = () => new Names(MAX_NOTE_ID_LENGTH, (name) => name.length > 0);

/**
 * What the puts so far in a batch say, which later puts can lean on: each note's latest fields and
 * the key of its latest dot, and each replica's latest dot counter. The encoder and the decoder
 * keep the same one, so that a put which only repeats the latest can be left out.
 */
class Memory {
  readonly fields = new Map<string, readonly FieldValue[]>();
  readonly dots = new Map<string, string>();
  readonly counters = new Map<string, number>();

  remember(note: string, dot: Id, fields: readonly FieldValue[]): void {
    this.fields.set(note, fields);
    this.dots.set(note, keyOf(dot));
    this.counters.set(dot.replica, dot.counter);
  }

  /** `origin` writes `note` again, unchanged: the next dot of the replica, replacing the latest. */
  reassert(origin: string, note: string): { dot: string; supersedes: string } | undefined {
    const supersedes = this.dots.get(note);
    const last = this.counters.get(origin);
    if (supersedes === undefined || last === undefined) return undefined;
    const dot = `${last + 1}@${origin}`;
    this.counters.set(origin, last + 1);
    this.dots.set(note, dot);
    return { dot, supersedes };
  }
}

function putOp(
  note: string,
  dot: string,
  supersedes: string[],
  fields: readonly FieldValue[],
): JsonObject {
  const [x, y, z, color] = fields;
  if (x === undefined || y === undefined || z === undefined || color === undefined) {
    throw new BinaryFormatError('A put is missing a field');
  }
  return {
    type: 'note-put',
    noteId: note,
    dot,
    supersedes,
    fields: {
      x: { value: x.value, at: x.at },
      y: { value: y.value, at: y.at },
      z: { value: z.value, at: z.at },
      color: { value: color.value, at: color.at },
    },
  };
}

// ---- Numbers ----------------------------------------------------------------------------------

function writeNumber(writer: ByteWriter, value: number): void {
  if (Number.isInteger(value) && Math.abs(value) <= MAX_VARINT_NUMBER) {
    writer.varint((value >= 0 ? value * 2 : -value * 2 - 1) * 2);
  } else {
    writer.varint(1);
    writer.float64(value);
  }
}

function readNumber(reader: ByteReader): number {
  const head = reader.varint();
  if (head === 1) return reader.float64();
  if (head % 2 !== 0) throw new BinaryFormatError('Unknown kind of number');
  const zigzag = head / 2;
  return zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2;
}

// ---- Encoding ---------------------------------------------------------------------------------

class Encoder {
  readonly #writer = new ByteWriter();
  readonly #replicas = replicaNames();
  readonly #notes = noteNames();
  readonly #memory = new Memory();
  #wall = 0;

  encode(ops: readonly EncodableOp[]): Uint8Array {
    const writer = this.#writer;
    writer.byte(MAGIC);
    writer.byte(VERSION);
    const groups: [number, number][] = [];
    for (let start = 0; start < ops.length; ) {
      const first = ops[start];
      if (first === undefined) break;
      if (!Number.isSafeInteger(first.seq) || first.seq < 1) fail(`sequence number ${first.seq}`);
      let end = start + 1;
      for (
        let next = ops[end];
        next?.origin === first.origin && next.seq === first.seq + (end - start);
        next = ops[end]
      ) {
        end += 1;
      }
      groups.push([start, end]);
      start = end;
    }
    writer.varint(groups.length);
    for (const [start, end] of groups) {
      const first = ops[start];
      if (first === undefined) break;
      this.#replicas.write(writer, first.origin);
      writer.varint(first.seq);
      writer.varint(end - start);
      for (let at = start; at < end; ) at += this.#item(first.origin, ops, at, end);
    }
    return writer.finish();
  }

  /** Writes the item that starts at `at` and returns how many operations it covers. */
  #item(origin: string, ops: readonly EncodableOp[], at: number, end: number): number {
    const op = ops[at]?.op;
    if (op === undefined) return fail('missing operation');
    switch (op['type']) {
      case 'text-insert':
        return this.#insertRun(origin, ops, at, end);
      case 'text-delete':
        return this.#deleteRun(origin, ops, at, end);
      case 'note-put': {
        const note = stringOf(op, 'noteId');
        if (this.#isReassert(op, origin, note, this.#next(origin, note))) {
          this.#writer.byte(TAG_REASSERT);
          this.#notes.write(this.#writer, note);
          this.#memory.reassert(origin, note);
        } else {
          this.#put(op);
        }
        return 1;
      }
      case 'note-remove':
        this.#remove(op);
        return 1;
      default:
        return fail(`operation type ${JSON.stringify(op['type'])}`);
    }
  }

  /** What the next re-assertion of `note` by `origin` would be, if the batch has one to repeat. */
  #next(origin: string, note: string): Next | undefined {
    const supersedes = this.#memory.dots.get(note);
    const last = this.#memory.counters.get(origin);
    if (supersedes === undefined || last === undefined) return undefined;
    return { counter: last + 1, supersedes };
  }

  /** Whether `op` is exactly the put that `expected` describes, with the note's fields unchanged. */
  #isReassert(
    op: Body | undefined,
    origin: string,
    note: string,
    expected: Next | undefined,
  ): boolean {
    if (op === undefined || expected === undefined) return false;
    if (op['type'] !== 'note-put' || op['noteId'] !== note) return false;
    if (op['dot'] !== `${expected.counter}@${origin}`) return false;
    const supersedes = op['supersedes'];
    if (!Array.isArray(supersedes) || supersedes.length !== 1) return false;
    if (supersedes[0] !== expected.supersedes) return false;
    const before = this.#memory.fields.get(note);
    const fields = op['fields'];
    if (before === undefined || typeof fields !== 'object' || fields === null) return false;
    if (Array.isArray(fields)) return false;
    return FIELDS.every((name, index) => {
      const field = (fields as Body)[name];
      const old = before[index];
      if (
        typeof field !== 'object' ||
        field === null ||
        Array.isArray(field) ||
        old === undefined
      ) {
        return false;
      }
      const register = field as Body;
      return register['value'] === old.value && register['at'] === old.at;
    });
  }

  #id(id: Id): void {
    this.#replicas.write(this.#writer, id.replica);
    this.#writer.varint(id.counter);
  }

  #insertRun(origin: string, ops: readonly EncodableOp[], at: number, end: number): number {
    const first = ops[at]?.op;
    if (first === undefined) return fail('missing operation');
    const note = stringOf(first, 'noteId');
    const idKey = stringOf(first, 'id');
    const id = idOf(idKey);
    const side = stringOf(first, 'side');
    if (side !== 'left' && side !== 'right') fail(`side ${JSON.stringify(side)}`);
    const parent = first['parent'];
    const characters = [codePointOf(stringOf(first, 'value'))];

    // A key at a time: every insert is followed by the note being written again.
    let expected = this.#next(origin, note);
    const paired = at + 1 < end && this.#isReassert(ops[at + 1]?.op, origin, note, expected);
    let used = paired ? 2 : 1;
    let lastKey = idKey;
    for (;;) {
      const next = at + used;
      const op = ops[next]?.op;
      if (next >= end || op === undefined || characters.length >= MAX_RUN) break;
      if (op['type'] !== 'text-insert' || op['noteId'] !== note || op['side'] !== 'right') break;
      if (op['parent'] !== lastKey) break;
      const key = stringOf(op, 'id');
      if (key !== `${id.counter + characters.length}@${id.replica}`) break;
      if (paired) {
        expected = expected && {
          counter: expected.counter + 1,
          supersedes: `${expected.counter}@${origin}`,
        };
        if (next + 1 >= end || !this.#isReassert(ops[next + 1]?.op, origin, note, expected)) break;
      }
      characters.push(codePointOf(stringOf(op, 'value')));
      lastKey = key;
      used += paired ? 2 : 1;
    }

    const writer = this.#writer;
    writer.byte(TAG_INSERT);
    this.#notes.write(writer, note);
    this.#id(id);
    const flags = (side === 'left' ? 4 : 0) | (paired ? 8 : 0);
    if (parent === null) {
      if (side === 'left') fail('the start of the text only has right children');
      writer.byte(flags);
    } else if (typeof parent === 'string') {
      const before = idOf(parent);
      if (before.replica === id.replica && before.counter < id.counter) {
        writer.byte(1 | flags);
        writer.varint(id.counter - before.counter);
      } else {
        writer.byte(2 | flags);
        this.#id(before);
      }
    } else {
      fail('parent must be an id or null');
    }
    writer.varint(characters.length);
    for (const character of characters) writer.varint(character);
    if (paired) for (let n = 0; n < characters.length; n += 1) this.#memory.reassert(origin, note);
    return used;
  }

  #deleteRun(origin: string, ops: readonly EncodableOp[], at: number, end: number): number {
    const first = ops[at]?.op;
    if (first === undefined) return fail('missing operation');
    const note = stringOf(first, 'noteId');
    const target = idOf(stringOf(first, 'target'));
    let expected = this.#next(origin, note);
    const paired = at + 1 < end && this.#isReassert(ops[at + 1]?.op, origin, note, expected);
    let used = paired ? 2 : 1;
    let count = 1;
    let step = 0;
    for (;;) {
      const next = at + used;
      const op = ops[next]?.op;
      if (next >= end || op === undefined || count >= MAX_RUN) break;
      if (op['type'] !== 'text-delete' || op['noteId'] !== note) break;
      const following = idOf(stringOf(op, 'target'));
      const difference = following.counter - (target.counter + step * (count - 1));
      if (following.replica !== target.replica || (difference !== 1 && difference !== -1)) break;
      if (step !== 0 && difference !== step) break;
      if (paired) {
        expected = expected && {
          counter: expected.counter + 1,
          supersedes: `${expected.counter}@${origin}`,
        };
        if (next + 1 >= end || !this.#isReassert(ops[next + 1]?.op, origin, note, expected)) break;
      }
      if (step === 0) step = difference;
      count += 1;
      used += paired ? 2 : 1;
    }
    const writer = this.#writer;
    writer.byte(TAG_DELETE);
    this.#notes.write(writer, note);
    this.#id(target);
    writer.varint(count * 4 + (paired ? 2 : 0) + (step === -1 ? 1 : 0));
    if (paired) for (let n = 0; n < count; n += 1) this.#memory.reassert(origin, note);
    return used;
  }

  #put(op: Body): void {
    const writer = this.#writer;
    const note = stringOf(op, 'noteId');
    const dot = idOf(stringOf(op, 'dot'));
    writer.byte(TAG_PUT);
    this.#notes.write(writer, note);
    this.#id(dot);
    const supersedes = listOf(op, 'supersedes');
    writer.varint(supersedes.length);
    for (const entry of supersedes) {
      if (typeof entry !== 'string') fail('supersedes must hold ids');
      const id = idOf(entry);
      if (id.replica === dot.replica && id.counter < dot.counter) {
        writer.byte(0);
        writer.varint(dot.counter - id.counter);
      } else {
        writer.byte(1);
        this.#id(id);
      }
    }

    const fields = objectOf(op['fields'], 'fields');
    const current = FIELDS.map((name): FieldValue => {
      const field = objectOf(fields[name], name);
      const value = field['value'];
      const at = field['at'];
      if (typeof at !== 'string') return fail(`${name}.at must be a string`);
      if (name === 'color') {
        if (typeof value !== 'string') return fail('color must be a string');
        return { value, at };
      }
      if (typeof value !== 'number') return fail(`${name} must be a number`);
      return { value, at };
    });
    const before = this.#memory.fields.get(note);
    let same = 0;
    current.forEach((field, index) => {
      const old = before?.[index];
      if (old !== undefined && old.value === field.value && old.at === field.at) same |= 1 << index;
    });
    writer.byte(same);
    current.forEach((field, index) => {
      if ((same & (1 << index)) !== 0) return;
      if (index === 3) {
        const color = NOTE_COLORS.indexOf(field.value as (typeof NOTE_COLORS)[number]);
        if (color < 0) fail(`color ${JSON.stringify(field.value)}`);
        writer.varint(color);
      } else {
        writeNumber(writer, field.value as number);
      }
      this.#timestamp(field.at);
    });
    this.#memory.remember(note, dot, current);
  }

  #timestamp(text: string): void {
    let stamp: HlcTimestamp;
    try {
      stamp = parseHlc(text);
    } catch {
      return fail(`timestamp ${JSON.stringify(text)}`);
    }
    if (formatHlc(stamp) !== text) fail(`timestamp ${JSON.stringify(text)}`);
    this.#writer.zigzag(stamp.wallMs - this.#wall);
    this.#writer.varint(stamp.logical);
    this.#replicas.write(this.#writer, stamp.replicaId);
    this.#wall = stamp.wallMs;
  }

  #remove(op: Body): void {
    const writer = this.#writer;
    writer.byte(TAG_REMOVE);
    this.#notes.write(writer, stringOf(op, 'noteId'));
    const dots = listOf(op, 'dots');
    writer.varint(dots.length);
    for (const dot of dots) {
      if (typeof dot !== 'string') fail('dots must hold ids');
      this.#id(idOf(dot));
    }
  }
}

/** The operations as one compact binary batch. They must be in canonical form. */
export function encodeOps(ops: readonly EncodableOp[]): Uint8Array {
  return new Encoder().encode(ops);
}

// ---- Decoding ---------------------------------------------------------------------------------

class Decoder {
  readonly #reader: ByteReader;
  readonly #replicas = replicaNames();
  readonly #notes = noteNames();
  readonly #memory = new Memory();
  readonly #maxOps: number;
  #wall = 0;

  constructor(bytes: Uint8Array, maxOps: number) {
    this.#reader = new ByteReader(bytes);
    this.#maxOps = maxOps;
  }

  decode(): StampedOp[] {
    const reader = this.#reader;
    if (reader.byte() !== MAGIC) throw new BinaryFormatError('Not a binary batch of operations');
    if (reader.byte() !== VERSION) throw new BinaryFormatError('Unsupported version of the format');
    const ops: StampedOp[] = [];
    const groups = reader.varint();
    for (let group = 0; group < groups; group += 1) {
      const origin = this.#replicas.read(reader) as ReplicaId;
      const firstSeq = reader.varint();
      const count = reader.varint();
      if (firstSeq < 1) throw new BinaryFormatError('A sequence number is below 1');
      if (ops.length + count > this.#maxOps) throw new BinaryFormatError('Too many operations');
      const decoded: JsonObject[] = [];
      while (decoded.length < count) this.#item(origin, decoded, count - decoded.length);
      decoded.forEach((op, index) => ops.push({ origin, seq: firstSeq + index, op }));
    }
    if (reader.remaining !== 0) throw new BinaryFormatError('Extra bytes after the last group');
    return ops;
  }

  /** Reads one item into `into`; `room` is how many operations the group has left for it. */
  #item(origin: string, into: JsonObject[], room: number): void {
    const tag = this.#reader.byte();
    switch (tag) {
      case TAG_INSERT:
        this.#insertRun(origin, into, room);
        return;
      case TAG_DELETE:
        this.#deleteRun(origin, into, room);
        return;
      case TAG_PUT:
        into.push(this.#put());
        return;
      case TAG_REMOVE:
        into.push(this.#remove());
        return;
      case TAG_REASSERT:
        into.push(this.#reassert(origin, this.#notes.read(this.#reader)));
        return;
      default:
        throw new BinaryFormatError(`Unknown item ${tag}`);
    }
  }

  #id(): Id {
    const replica = this.#replicas.read(this.#reader);
    const counter = this.#reader.varint();
    if (counter < 1) throw new BinaryFormatError('An operation counter is below 1');
    return { replica, counter };
  }

  /** The put that writes `note` again unchanged, as `origin`'s next write. */
  #reassert(origin: string, note: string): JsonObject {
    const fields = this.#memory.fields.get(note);
    const next = this.#memory.reassert(origin, note);
    if (fields === undefined || next === undefined) {
      throw new BinaryFormatError('A re-assertion has no put to repeat');
    }
    return putOp(note, next.dot, [next.supersedes], fields);
  }

  #insertRun(origin: string, into: JsonObject[], room: number): void {
    const reader = this.#reader;
    const note = this.#notes.read(reader);
    const id = this.#id();
    const flags = reader.byte();
    if (flags > 15) throw new BinaryFormatError('Unknown flags');
    const side = (flags & 4) === 0 ? 'right' : 'left';
    const paired = (flags & 8) !== 0;
    let parent: string | null;
    switch (flags & 3) {
      case 0:
        if (side === 'left')
          throw new BinaryFormatError('The start of the text has no left children');
        parent = null;
        break;
      case 1: {
        const delta = reader.varint();
        if (delta < 1 || delta >= id.counter)
          throw new BinaryFormatError('A parent is out of range');
        parent = `${id.counter - delta}@${id.replica}`;
        break;
      }
      case 2:
        parent = keyOf(this.#id());
        break;
      default:
        throw new BinaryFormatError('Unknown kind of parent');
    }
    const count = reader.varint();
    const operations = paired ? count * 2 : count;
    if (count < 1 || count > reader.remaining || operations > Math.min(room, MAX_RUN * 2)) {
      throw new BinaryFormatError('A run has a bad length');
    }
    let previous = keyOf(id);
    for (let n = 0; n < count; n += 1) {
      const point = reader.varint();
      if (point > 0x10ffff) throw new BinaryFormatError('A character is beyond Unicode');
      const key = `${id.counter + n}@${id.replica}`;
      into.push({
        type: 'text-insert',
        noteId: note,
        id: key,
        parent: n === 0 ? parent : previous,
        side: n === 0 ? side : 'right',
        value: String.fromCodePoint(point),
      });
      if (paired) into.push(this.#reassert(origin, note));
      previous = key;
    }
  }

  #deleteRun(origin: string, into: JsonObject[], room: number): void {
    const reader = this.#reader;
    const note = this.#notes.read(reader);
    const first = this.#id();
    const head = reader.varint();
    const count = Math.floor(head / 4);
    const paired = Math.floor(head / 2) % 2 === 1;
    const step = head % 2 === 1 ? -1 : 1;
    if (count < 1 || (paired ? count * 2 : count) > Math.min(room, MAX_RUN * 2)) {
      throw new BinaryFormatError('A run has a bad length');
    }
    if (first.counter + step * (count - 1) < 1) throw new BinaryFormatError('A target is below 1');
    for (let n = 0; n < count; n += 1) {
      into.push({
        type: 'text-delete',
        noteId: note,
        target: `${first.counter + step * n}@${first.replica}`,
      });
      if (paired) into.push(this.#reassert(origin, note));
    }
  }

  #put(): JsonObject {
    const reader = this.#reader;
    const note = this.#notes.read(reader);
    const dot = this.#id();
    const count = reader.varint();
    if (count > reader.remaining) throw new BinaryFormatError('A list is longer than the data');
    const supersedes: string[] = [];
    for (let n = 0; n < count; n += 1) {
      const kind = reader.byte();
      if (kind === 0) {
        const delta = reader.varint();
        if (delta < 1 || delta >= dot.counter) throw new BinaryFormatError('A dot is out of range');
        supersedes.push(`${dot.counter - delta}@${dot.replica}`);
      } else if (kind === 1) {
        supersedes.push(keyOf(this.#id()));
      } else {
        throw new BinaryFormatError('Unknown kind of dot');
      }
    }

    const same = reader.byte();
    if (same > ALL_SAME) throw new BinaryFormatError('Unknown field flags');
    const before = this.#memory.fields.get(note);
    const fields: FieldValue[] = [];
    FIELDS.forEach((name, index) => {
      if ((same & (1 << index)) !== 0) {
        const old = before?.[index];
        if (old === undefined)
          throw new BinaryFormatError(`Field ${name} repeats a put that is not there`);
        fields.push(old);
        return;
      }
      let value: number | string;
      if (index === 3) {
        const color = NOTE_COLORS[reader.varint()];
        if (color === undefined) throw new BinaryFormatError('Unknown colour');
        value = color;
      } else {
        value = readNumber(reader);
      }
      fields.push({ value, at: this.#timestamp() });
    });
    this.#memory.remember(note, dot, fields);
    return putOp(note, keyOf(dot), supersedes, fields);
  }

  #timestamp(): string {
    const reader = this.#reader;
    const wallMs = this.#wall + reader.zigzag();
    const logical = reader.varint();
    const replica = this.#replicas.read(reader) as ReplicaId;
    try {
      const stamp = hlcTimestamp(wallMs, logical, replica);
      this.#wall = wallMs;
      return formatHlc(stamp);
    } catch (error) {
      throw new BinaryFormatError(error instanceof Error ? error.message : 'Invalid timestamp');
    }
  }

  #remove(): JsonObject {
    const reader = this.#reader;
    const note = this.#notes.read(reader);
    const count = reader.varint();
    if (count > reader.remaining) throw new BinaryFormatError('A list is longer than the data');
    const dots: string[] = [];
    for (let n = 0; n < count; n += 1) dots.push(keyOf(this.#id()));
    return { type: 'note-remove', noteId: note, dots };
  }
}

/**
 * Inverse of `encodeOps`. Throws `BinaryFormatError` for bytes that are not a batch, and for a
 * batch of more than `maxOps` operations (stopping early, so a lying header costs nothing). What
 * comes out has the shape of canonical operations, not yet checked in depth: run it through
 * `canonicalizeOp` like anything that arrives from outside.
 */
export function decodeOps(bytes: Uint8Array, maxOps = Number.MAX_SAFE_INTEGER): StampedOp[] {
  return new Decoder(bytes, maxOps).decode();
}

/** Whether `bytes` start like a binary batch (a JSON snapshot starts with `{`). */
export function isBinaryBatch(bytes: Uint8Array): boolean {
  return bytes[0] === MAGIC;
}
