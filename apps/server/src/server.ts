import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { MAX_FRAME_BYTES } from '@driftboard/protocol';
import type Database from 'better-sqlite3';
import WebSocket, { WebSocketServer } from 'ws';
import { SyncHub, type HubOptions } from './hub';
import type { RateLimits } from './rate-limit';
import { BoardStorage } from './storage';

/** Clients connect to `ws://host:port/ws`. */
export const WS_PATH = '/ws';
export const HEALTH_PATH = '/healthz';

export interface SyncServerOptions {
  host: string;
  port: number;
  /** An open, migrated database (see `openDatabase`). The caller closes it after `close()`. */
  db: Database.Database;
  /** Largest message accepted, in bytes. Defaults to 1 MiB. */
  maxMessageBytes?: number;
  /** Fold a board's tail into its snapshot once it has this many operations. Defaults to 1000. */
  compactAfterOps?: number;
  /** Compact every board that has a tail this often, in ms; 0 disables. Defaults to 5 minutes. */
  compactIntervalMs?: number;
  /** Close connections that send no valid `hello` within this time, in ms. Defaults to 10 s. */
  helloTimeoutMs?: number;
  /** What one connection may send; see `DEFAULT_RATE_LIMITS`. */
  rateLimits?: RateLimits;
  /** Most characters one note's text may hold. Defaults to the protocol's limit. */
  maxNoteNodes?: number;
  onError?: HubOptions['onError'];
}

export interface SyncServer {
  readonly port: number;
  readonly hub: SyncHub;
  readonly storage: BoardStorage;
  /** Stops listening, closes every connection and stops the timers. Does not close the database. */
  close(): Promise<void>;
}

function toBytes(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return data;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function startSyncServer(options: SyncServerOptions): Promise<SyncServer> {
  const maxMessageBytes = options.maxMessageBytes ?? MAX_FRAME_BYTES;
  const storage = new BoardStorage(options.db);
  const hub = new SyncHub({
    storage,
    maxMessageBytes,
    ...(options.compactAfterOps === undefined ? {} : { compactAfterOps: options.compactAfterOps }),
    ...(options.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: options.helloTimeoutMs }),
    ...(options.rateLimits === undefined ? {} : { rateLimits: options.rateLimits }),
    ...(options.maxNoteNodes === undefined ? {} : { maxNoteNodes: options.maxNoteNodes }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  const onError =
    options.onError ??
    ((error: unknown, context: string) => {
      console.error(`driftboard: ${context}`, error);
    });

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== HEALTH_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    try {
      storage.ping();
      json(res, 200, { status: 'ok' });
    } catch (error) {
      onError(error, 'health check');
      json(res, 503, { status: 'unavailable' });
    }
  });

  // Compression is off: it would let a small frame expand past the size limit.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: maxMessageBytes,
    perMessageDeflate: false,
  });

  http.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const connection = hub.accept({
      send: (frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      },
      close: (code, reason) => {
        ws.close(code, reason);
      },
    });
    ws.on('message', (data, isBinary) => {
      // The hub does not let a frame throw; this is the last guard, since an exception here would
      // be uncaught and end the process for every board.
      try {
        const bytes = toBytes(data);
        connection.receive(isBinary ? bytes : bytes.toString('utf8'), isBinary);
      } catch (error) {
        onError(error, 'receiving a frame');
        ws.terminate();
      }
    });
    // `ws` reports a bad frame (for example one over `maxPayload`) here and then closes the
    // connection itself with the matching code, so the 'close' event below does the cleanup.
    ws.on('error', () => undefined);
    ws.on('close', () => {
      connection.closed();
    });
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => {
      http.off('error', reject);
      const address = http.address();
      if (address === null || typeof address === 'string') {
        reject(new Error(`Unexpected address: ${String(address)}`));
        return;
      }

      let sweep: ReturnType<typeof setInterval> | undefined;
      const intervalMs = options.compactIntervalMs ?? 300_000;
      if (intervalMs > 0) {
        sweep = setInterval(() => {
          try {
            hub.compactAll();
          } catch (error) {
            onError(error, 'periodic compaction');
          }
        }, intervalMs);
        sweep.unref();
      }

      resolve({
        port: address.port,
        hub,
        storage,
        close: () =>
          new Promise<void>((done, fail) => {
            if (sweep !== undefined) clearInterval(sweep);
            // Clients get a close frame; one that does not answer in a second is cut off.
            hub.close();
            const force = setTimeout(() => {
              for (const client of wss.clients) client.terminate();
              http.closeAllConnections();
            }, 1000);
            wss.close();
            http.close((error) => {
              clearTimeout(force);
              if (error) fail(error);
              else done();
            });
          }),
      });
    });
  });
}
