import { replicaId } from '@driftboard/crdt';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_FRAME_BYTES,
  MAX_NAME_LENGTH,
  MAX_NOTE_ID_LENGTH,
  MAX_OPS_PER_MESSAGE,
  PROTOCOL_VERSION,
  encodeFrame,
  encodeMessage,
  encodeOps,
  parseFrame,
  parseMessage,
  type Message,
} from './index';
import { stamped } from './test-support';

const a = replicaId('a');
const b = replicaId('b');

const hello: Message = {
  type: 'hello',
  version: PROTOCOL_VERSION,
  replicaId: a,
  boardId: 'board-1',
  versionVector: [
    [a, 3],
    [b, 1],
  ],
};

const messages: Message[] = [
  hello,
  { type: 'hello', version: PROTOCOL_VERSION, replicaId: b, boardId: 'x', versionVector: [] },
  { type: 'ops', ops: stamped(a, 1, 3) },
  { type: 'ack', versionVector: [[a, 3]] },
  {
    type: 'presence',
    replicaId: a,
    state: { cursor: { x: 1.5, y: -2 }, editing: '1@a', name: 'Ada', color: '#1971c2' },
  },
  {
    type: 'presence',
    replicaId: a,
    state: { cursor: null, editing: null, name: 'Grace Hopper', color: '#c2255c' },
  },
  { type: 'presence', replicaId: a, state: null },
  { type: 'error', code: 'out_of_order', message: 'expected operation 4 from a' },
];

/** `message` as the JSON object a peer would send, changed by `change`. */
function altered(message: Message, change: (json: Record<string, unknown>) => void): string {
  const json = JSON.parse(encodeMessage(message)) as Record<string, unknown>;
  change(json);
  return JSON.stringify(json);
}

describe('message parsing', () => {
  it('round-trips every kind of message', () => {
    for (const message of messages) {
      expect(parseMessage(encodeMessage(message))).toEqual({ ok: true, message });
    }
  });

  it('rejects text that is not a message', () => {
    for (const raw of ['', '{', 'null', '[]', '"hello"', '42', '{}', '{"type":"bogus"}']) {
      expect(parseMessage(raw).ok).toBe(false);
    }
    expect(parseMessage('{'.repeat(10))).toEqual({ ok: false, error: 'not valid JSON' });
    expect(parseMessage('x'.repeat(MAX_FRAME_BYTES + 1))).toEqual({
      ok: false,
      error: 'frame too large',
    });
  });

  it('never throws, whatever it is given', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(typeof parseMessage(raw).ok).toBe('boolean');
      }),
    );
  });

  it('rejects unknown fields on every message', () => {
    for (const message of messages) {
      const text = altered(message, (json) => {
        json['extra'] = 1;
      });
      expect(parseMessage(text).ok).toBe(false);
    }
  });

  it('accepts any positive hello version, so a mismatch can be answered with an error', () => {
    const future = altered(hello, (json) => {
      json['version'] = PROTOCOL_VERSION + 41;
    });
    expect(parseMessage(future).ok).toBe(true);
    for (const version of [0, -1, 1.5, '1', null]) {
      const bad = altered(hello, (json) => {
        json['version'] = version;
      });
      expect(parseMessage(bad).ok).toBe(false);
    }
  });

  describe('rejects', () => {
    const cases: [string, Message, (json: Record<string, unknown>) => void][] = [
      ['an empty board id', hello, (j) => (j['boardId'] = '')],
      ['a board id that is too long', hello, (j) => (j['boardId'] = 'b'.repeat(201))],
      ['an invalid replica id', hello, (j) => (j['replicaId'] = 'not valid')],
      ['a version vector that is not a list', hello, (j) => (j['versionVector'] = {})],
      ['a vector entry with a zero count', hello, (j) => (j['versionVector'] = [['a', 0]])],
      ['a vector entry with a fractional count', hello, (j) => (j['versionVector'] = [['a', 1.5]])],
      ['a replica twice in the vector', hello, (j) => (j['versionVector'] = [['a', 1], ['a', 2]])],
      ['a vector entry with a bad replica id', hello, (j) => (j['versionVector'] = [['a b', 1]])],
      ['a missing version vector', hello, (j) => delete j['versionVector']],
    ];
    for (const [name, message, change] of cases) {
      it(name, () => {
        expect(parseMessage(altered(message, change)).ok).toBe(false);
      });
    }
  });

  describe('rejects bad operations', () => {
    const ops: Message = { type: 'ops', ops: stamped(a, 1, 2) };
    const first = (json: Record<string, unknown>) => (json['ops'] as Record<string, unknown>[])[0];
    const cases: [string, (json: Record<string, unknown>) => void][] = [
      ['an empty batch', (j) => (j['ops'] = [])],
      [
        'a batch that is too large',
        (j) => (j['ops'] = Array.from({ length: MAX_OPS_PER_MESSAGE + 1 }, () => first(j))),
      ],
      ['a sequence number of 0', (j) => (first(j)!['seq'] = 0)],
      ['a fractional sequence number', (j) => (first(j)!['seq'] = 1.5)],
      ['an origin that is not a replica id', (j) => (first(j)!['origin'] = 'x y')],
      ['a payload that is not an object', (j) => (first(j)!['op'] = 'text')],
      ['a missing payload', (j) => delete first(j)!['op']],
      ['an unknown field on an operation', (j) => (first(j)!['extra'] = true)],
    ];
    for (const [name, change] of cases) {
      it(name, () => {
        expect(parseMessage(altered(ops, change)).ok).toBe(false);
      });
    }
  });

  describe('rejects bad presence and errors', () => {
    const presence = messages[4] as Message;
    const state = (json: Record<string, unknown>) => json['state'] as Record<string, unknown>;
    it('a cursor without coordinates, or with text coordinates', () => {
      for (const cursor of [{}, { x: 1 }, { x: '1', y: 2 }, { x: 1, y: 2, z: 3 }, 5]) {
        const text = altered(presence, (j) => {
          state(j)['cursor'] = cursor;
        });
        expect(parseMessage(text).ok).toBe(false);
      }
    });
    it('a cursor that is not finite', () => {
      // JSON cannot carry Infinity or NaN, but a huge number is read back as Infinity.
      const text = encodeMessage(presence).replace('1.5', '1e999');
      expect(parseMessage(text).ok).toBe(false);
    });
    it('a note id that is empty, too long or not text', () => {
      for (const editing of ['', 'n'.repeat(MAX_NOTE_ID_LENGTH + 1), 5, ['1@a']]) {
        const text = altered(presence, (j) => (state(j)['editing'] = editing));
        expect(parseMessage(text).ok).toBe(false);
      }
    });
    it('a name that is missing, empty, too long or not text', () => {
      for (const name of ['', 'n'.repeat(MAX_NAME_LENGTH + 1), 5, null]) {
        const text = altered(presence, (j) => (state(j)['name'] = name));
        expect(parseMessage(text).ok).toBe(false);
      }
      expect(parseMessage(altered(presence, (j) => delete state(j)['name'])).ok).toBe(false);
    });
    it('a colour that is not six lower-case hex digits after a #', () => {
      const bad = ['', 'red', '#12345', '#1234567', '#1971C2', '1971c2', '#1971c2ff', '#19 1c2', 5];
      for (const color of bad) {
        const text = altered(presence, (j) => (state(j)['color'] = color));
        expect(parseMessage(text).ok).toBe(false);
      }
      expect(parseMessage(altered(presence, (j) => delete state(j)['color'])).ok).toBe(false);
    });
    it('a missing note id, and the old selection list', () => {
      expect(parseMessage(altered(presence, (j) => delete state(j)['editing'])).ok).toBe(false);
      const old = altered(presence, (j) => (state(j)['selection'] = []));
      expect(parseMessage(old).ok).toBe(false);
    });
    it('a state that is not an object', () => {
      for (const value of [5, 'x', [], true]) {
        expect(parseMessage(altered(presence, (j) => (j['state'] = value))).ok).toBe(false);
      }
    });
    it('presence about no replica or a bad one', () => {
      expect(parseMessage(altered(presence, (j) => delete j['replicaId'])).ok).toBe(false);
      expect(parseMessage(altered(presence, (j) => (j['replicaId'] = 'x y'))).ok).toBe(false);
    });
    it('an unknown error code', () => {
      const error = messages[7] as Message;
      expect(parseMessage(altered(error, (j) => (j['code'] = 'whoops'))).ok).toBe(false);
    });
  });
});

describe('frames', () => {
  it('send operations as a binary frame and every other message as JSON text', () => {
    for (const message of messages) {
      const frame = encodeFrame(message);
      expect(typeof frame).toBe(message.type === 'ops' ? 'object' : 'string');
      if (typeof frame === 'string') expect(frame).toBe(encodeMessage(message));
    }
  });

  it('round-trip every kind of message', () => {
    for (const message of messages) {
      expect(parseFrame(encodeFrame(message))).toEqual({ ok: true, message });
    }
  });

  it('read binary frames however the transport hands them over: bytes, a Buffer view or an ArrayBuffer', () => {
    const ops = { type: 'ops', ops: stamped(a, 1, 5) } as const;
    const bytes = encodeOps(ops.ops);
    expect(parseFrame(bytes)).toEqual({ ok: true, message: ops });
    expect(parseFrame(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))).toEqual({
      ok: true,
      message: ops,
    });
    // A view into a larger buffer, as `ws` gives for a message that is part of a bigger read.
    const padded = new Uint8Array(bytes.length + 7);
    padded.set(bytes, 4);
    expect(parseFrame(padded.subarray(4, 4 + bytes.length))).toEqual({ ok: true, message: ops });
  });

  it('still read operations sent as JSON text, which is what the other kinds of message are', () => {
    const ops: Message = { type: 'ops', ops: stamped(a, 1, 2) };
    expect(parseFrame(encodeMessage(ops))).toEqual({ ok: true, message: ops });
  });

  it('reject a binary frame that is damaged, empty, too big or too long a batch, without throwing', () => {
    const bytes = encodeOps(stamped(a, 1, 3));
    for (let length = 0; length < bytes.length; length += 1) {
      expect(parseFrame(bytes.slice(0, length)).ok).toBe(false);
    }
    expect(parseFrame(encodeOps([]))).toEqual({ ok: false, error: 'ops: no operations' });
    expect(parseFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).toEqual({
      ok: false,
      error: 'frame too large',
    });
    expect(parseFrame(encodeOps(stamped(a, 1, MAX_OPS_PER_MESSAGE)))).toMatchObject({ ok: true });
    expect(parseFrame(encodeOps(stamped(a, 1, MAX_OPS_PER_MESSAGE + 1))).ok).toBe(false);
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 60 }), (junk) => {
        expect(typeof parseFrame(junk).ok).toBe('boolean');
      }),
      { numRuns: 300 },
    );
  });
});
