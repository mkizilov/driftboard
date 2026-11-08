import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  encodeMessage,
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from './messages';

const hello: ClientMessage = {
  type: 'hello',
  version: PROTOCOL_VERSION,
  boardId: 'board-1',
  clientId: 'client-1',
};

describe('client messages', () => {
  it('round-trips a hello', () => {
    expect(parseClientMessage(encodeMessage(hello))).toEqual({ ok: true, message: hello });
  });

  it('rejects invalid JSON', () => {
    expect(parseClientMessage('{nope')).toEqual({ ok: false, error: 'not valid JSON' });
  });

  it('rejects unknown types, wrong versions, empty ids and extra fields', () => {
    const bad = [
      { ...hello, type: 'goodbye' },
      { ...hello, version: PROTOCOL_VERSION + 1 },
      { ...hello, boardId: '' },
      { ...hello, extra: true },
    ];
    for (const message of bad) {
      expect(parseClientMessage(JSON.stringify(message)).ok).toBe(false);
    }
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(typeof parseClientMessage(raw).ok).toBe('boolean');
      }),
    );
    fc.assert(
      fc.property(fc.json(), (raw) => {
        expect(typeof parseClientMessage(raw).ok).toBe('boolean');
      }),
    );
  });
});

describe('server messages', () => {
  it('round-trips welcome and error', () => {
    const messages: ServerMessage[] = [
      { type: 'welcome', version: PROTOCOL_VERSION },
      { type: 'error', code: 'invalid_message', message: 'bad' },
    ];
    for (const message of messages) {
      expect(parseServerMessage(encodeMessage(message))).toEqual({ ok: true, message });
    }
  });
});
