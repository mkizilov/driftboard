import { describe, expect, it } from 'vitest';
import { Board } from './board';
import {
  boardOpFromJson,
  boardOpToJson,
  deserializeBoardOps,
  serializeBoardOps,
} from './board-json';
import { BoardFormatError, type BoardOp, type NoteFields } from './board-ops';
import { createManualClock } from './clock';
import { LwwRegister } from './lww-register';
import { opId } from './op-id';
import { replicaId } from './replica-id';
import { must } from './test-support';

const AT = '0000000003e8-0000-a'; // wall time 1000, counter 0, replica "a"

/** A small history: create, edit (delete + insert + re-assert), delete. */
function sample(): BoardOp[] {
  const board = new Board({ replicaId: replicaId('a'), clock: createManualClock(1000) });
  const { id, ops } = board.createNote({ x: 3, y: 4, color: 'orange', text: 'é' });
  return [...ops, ...board.editText(id, 0, 1, 'x'), ...board.deleteNote(id)];
}

type Json = Record<string, unknown>;

/** The sample log as JSON text, with the operation at `index` changed by `change`. */
function corrupted(index: number, change: (op: Json) => void): string {
  const envelope = JSON.parse(serializeBoardOps(sample())) as { ops: Json[] };
  change(must(envelope.ops[index]));
  return JSON.stringify(envelope);
}

const PUT = 0;
const INSERT = 1;
const DELETE = 2;
const REMOVE = 5;

describe('board JSON format', () => {
  it('writes operations as documented', () => {
    const ops = sample().map(boardOpToJson);
    const field = (value: unknown) => ({ value, at: AT });
    expect(ops).toEqual([
      {
        type: 'note-put',
        noteId: '1@a',
        dot: '1@a',
        supersedes: [],
        fields: { x: field(3), y: field(4), z: field(1), color: field('orange') },
      },
      { type: 'text-insert', noteId: '1@a', id: '1@a', parent: null, side: 'right', value: 'é' },
      { type: 'text-delete', noteId: '1@a', target: '1@a' },
      { type: 'text-insert', noteId: '1@a', id: '2@a', parent: '1@a', side: 'left', value: 'x' },
      {
        type: 'note-put',
        noteId: '1@a',
        dot: '2@a',
        supersedes: ['1@a'],
        fields: { x: field(3), y: field(4), z: field(1), color: field('orange') },
      },
      { type: 'note-remove', noteId: '1@a', dots: ['2@a'] },
    ]);
  });

  it('wraps a log in a versioned envelope', () => {
    const ops = sample();
    expect(JSON.parse(serializeBoardOps(ops))).toEqual({
      format: 'driftboard-ops',
      version: 1,
      ops: ops.map(boardOpToJson),
    });
    expect(JSON.parse(serializeBoardOps([]))).toEqual({
      format: 'driftboard-ops',
      version: 1,
      ops: [],
    });
  });

  it('round-trips every kind of operation', () => {
    const ops = sample();
    for (const op of ops) {
      expect(boardOpToJson(boardOpFromJson(boardOpToJson(op)))).toEqual(boardOpToJson(op));
    }
    const restored = deserializeBoardOps(serializeBoardOps(ops));
    expect(restored).toHaveLength(ops.length);
    expect(serializeBoardOps(restored)).toBe(serializeBoardOps(ops));
  });

  it('ignores keys it does not know, so newer writers can add fields', () => {
    const text = corrupted(PUT, (op) => {
      op['extra'] = { anything: true };
    });
    expect(deserializeBoardOps(text)).toHaveLength(6);
  });

  it('refuses to write a note value that was never written', () => {
    const empty = LwwRegister.empty<number>();
    const fields: NoteFields = {
      x: empty,
      y: empty,
      z: empty,
      color: LwwRegister.empty(),
    };
    const op: BoardOp = {
      type: 'notes',
      op: { type: 'put', key: 'n', dot: opId(1, replicaId('a')), supersedes: [], value: fields },
    };
    expect(() => boardOpToJson(op)).toThrow(BoardFormatError);
  });
});

describe('reading board JSON', () => {
  it('rejects text that is not a valid document', () => {
    const wrong = [
      '',
      '{',
      'null',
      '[]',
      '"text"',
      '{}',
      '{"format":"other","version":1,"ops":[]}',
      '{"format":"driftboard-ops","version":2,"ops":[]}',
      '{"format":"driftboard-ops","version":1}',
      '{"format":"driftboard-ops","version":1,"ops":{}}',
      '{"format":"driftboard-ops","version":1,"ops":[null]}',
      '{"format":"driftboard-ops","version":1,"ops":[[]]}',
      '{"format":"driftboard-ops","version":1,"ops":["x"]}',
    ];
    for (const text of wrong) expect(() => deserializeBoardOps(text)).toThrow(BoardFormatError);
  });

  const cases: [string, number, (op: Json) => void][] = [
    ['an unknown type', PUT, (op) => (op['type'] = 'bogus')],
    ['a missing type', PUT, (op) => delete op['type']],
    ['an empty note id', PUT, (op) => (op['noteId'] = '')],
    ['a note id that is too long', PUT, (op) => (op['noteId'] = 'n'.repeat(201))],
    ['a note id that is not a string', PUT, (op) => (op['noteId'] = 7)],
    ['a dot with counter 0', PUT, (op) => (op['dot'] = '0@a')],
    ['a dot without a replica', PUT, (op) => (op['dot'] = 'x')],
    ['a dot that is not a string', PUT, (op) => (op['dot'] = 5)],
    ['supersedes that is not a list', PUT, (op) => (op['supersedes'] = '1@a')],
    ['supersedes with a bad id', PUT, (op) => (op['supersedes'] = [3])],
    ['missing fields', PUT, (op) => delete op['fields']],
    ['a missing field', PUT, (op) => delete (op['fields'] as Json)['x']],
    [
      'a field timestamp that is not a timestamp',
      PUT,
      (op) => ((op['fields'] as Json)['x'] = { value: 1, at: 'nope' }),
    ],
    ['a field without a timestamp', PUT, (op) => ((op['fields'] as Json)['z'] = { value: 1 })],
    ['a string coordinate', PUT, (op) => ((op['fields'] as Json)['x'] = { value: '3', at: AT })],
    ['a null coordinate', PUT, (op) => ((op['fields'] as Json)['y'] = { value: null, at: AT })],
    [
      'a colour outside the palette',
      PUT,
      (op) => ((op['fields'] as Json)['color'] = { value: 'red', at: AT }),
    ],
    ['an empty text value', INSERT, (op) => (op['value'] = '')],
    ['two characters in one insert', INSERT, (op) => (op['value'] = 'ab')],
    ['an unknown side', INSERT, (op) => (op['side'] = 'up')],
    ['a side that is not a string', INSERT, (op) => (op['side'] = 5)],
    ['a parent that is not an id', INSERT, (op) => (op['parent'] = 5)],
    ['a malformed parent id', INSERT, (op) => (op['parent'] = '1@bad id')],
    ['a left child of the document start', INSERT, (op) => (op['side'] = 'left')],
    ['a missing delete target', DELETE, (op) => delete op['target']],
    ['a malformed delete target', DELETE, (op) => (op['target'] = 'x')],
    ['dots that are not a list', REMOVE, (op) => (op['dots'] = 'x')],
    ['dots with a null', REMOVE, (op) => (op['dots'] = [null])],
  ];

  for (const [name, index, change] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => deserializeBoardOps(corrupted(index, change))).toThrow(BoardFormatError);
    });
  }

  it('accepts the unmodified sample', () => {
    expect(deserializeBoardOps(corrupted(PUT, () => undefined))).toHaveLength(6);
  });
});
