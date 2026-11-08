import { PROTOCOL_VERSION, encodeMessage, parseServerMessage } from '@driftboard/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startSyncServer, type SyncServer } from './server';

const TEST_PORT = 22110;

let server: SyncServer;

beforeEach(async () => {
  server = await startSyncServer({ host: '127.0.0.1', port: TEST_PORT });
});

afterEach(async () => {
  await server.close();
});

function exchange(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
    socket.once('error', reject);
    socket.once('open', () => socket.send(payload));
    socket.once('message', (data) => {
      socket.close();
      resolve(data.toString());
    });
  });
}

describe('sync server', () => {
  it('answers a valid hello with welcome', async () => {
    const reply = await exchange(
      encodeMessage({ type: 'hello', version: PROTOCOL_VERSION, boardId: 'b', clientId: 'c' }),
    );
    expect(parseServerMessage(reply)).toEqual({
      ok: true,
      message: { type: 'welcome', version: PROTOCOL_VERSION },
    });
  });

  it('answers garbage with an error message', async () => {
    const reply = await exchange('not json');
    const parsed = parseServerMessage(reply);
    expect(parsed.ok && parsed.message.type).toBe('error');
  });
});
