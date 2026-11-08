import { PROTOCOL_VERSION, encodeMessage, parseMessage } from '@driftboard/protocol';
import { replicaId } from '@driftboard/crdt';
import { WebSocketServer } from 'ws';

const SERVER_REPLICA_ID = replicaId('server');

export interface SyncServer {
  port: number;
  close(): Promise<void>;
}

export interface SyncServerOptions {
  host: string;
  port: number;
}

export function startSyncServer({ host, port }: SyncServerOptions): Promise<SyncServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host, port });

    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        const parsed = parseMessage(data.toString());
        if (!parsed.ok) {
          socket.send(
            encodeMessage({ type: 'error', code: 'invalid_message', message: parsed.error }),
          );
          return;
        }
        // Handshake only: the server is not yet wired to the sync room, so it holds no operations.
        if (parsed.message.type === 'hello') {
          socket.send(
            encodeMessage({
              type: 'hello',
              version: PROTOCOL_VERSION,
              replicaId: SERVER_REPLICA_ID,
              boardId: parsed.message.boardId,
              versionVector: [],
            }),
          );
        }
      });
    });

    wss.once('error', reject);
    wss.once('listening', () => {
      wss.off('error', reject);
      const address = wss.address();
      if (typeof address === 'string') {
        reject(new Error(`Unexpected address: ${address}`));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done, fail) => {
            for (const client of wss.clients) client.terminate();
            wss.close((error) => {
              if (error) fail(error);
              else done();
            });
          }),
      });
    });
  });
}
