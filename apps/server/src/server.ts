import { PROTOCOL_VERSION, encodeMessage, parseClientMessage } from '@driftboard/protocol';
import { WebSocketServer } from 'ws';

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
        const parsed = parseClientMessage(data.toString());
        if (!parsed.ok) {
          socket.send(
            encodeMessage({ type: 'error', code: 'invalid_message', message: parsed.error }),
          );
          return;
        }
        socket.send(encodeMessage({ type: 'welcome', version: PROTOCOL_VERSION }));
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
