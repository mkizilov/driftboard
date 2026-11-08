import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { IN_MEMORY, openDatabase } from './db';
import { startSyncServer, type SyncServer } from './server';
import { StaticDirectoryError } from './static';

// Loopback ports 22141-22149 are reserved for this file (server.test.ts has 22110-22139, the fuzz
// test 22140).
let portCounter = 0;
const nextPort = () => 22141 + (portCounter++ % 9);

let workdir: string;
let root: string;
let db: Database.Database;
const stops: (() => Promise<void>)[] = [];

const INDEX =
  '<!doctype html><title>driftboard</title><script type="module" src="/assets/app-1a2b3c.js"></script>';
const BIG = 'x'.repeat(1_200_000);

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'driftboard-static-'));
  root = join(workdir, 'dist');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), INDEX);
  writeFileSync(join(root, 'assets', 'app-1a2b3c.js'), 'console.log("app");');
  writeFileSync(join(root, 'assets', 'style-4d5e6f.css'), 'body{margin:0}');
  writeFileSync(join(root, 'assets', 'big-000000.js'), BIG);
  writeFileSync(join(root, 'sw.js'), 'self.skipWaiting();');
  writeFileSync(join(root, 'manifest.webmanifest'), '{"name":"driftboard"}');
  writeFileSync(join(workdir, 'secret.txt'), 'the secret');
  symlinkSync(join(workdir, 'secret.txt'), join(root, 'leak.txt'));
  db = openDatabase(IN_MEMORY);
});

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

/** `null` for a server without a directory (an omitted argument means the built app in `root`). */
async function start(
  staticDir: string | null = root,
): Promise<{ server: SyncServer; port: number }> {
  const port = nextPort();
  const server = await startSyncServer({
    host: '127.0.0.1',
    port,
    db,
    helloTimeoutMs: 0,
    compactIntervalMs: 0,
    ...(staticDir === null ? {} : { staticDir }),
  });
  stops.push(() => server.close());
  return { server, port };
}

/** One request with the path exactly as given (`fetch` would tidy `..` away before sending). */
function raw(
  port: number,
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serving the built web app', () => {
  it('serves the page at / with headers that keep the board id to itself', async () => {
    const { port } = await start();
    const res = await raw(port, '/');
    expect(res.status).toBe(200);
    expect(res.body).toBe(INDEX);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('serves files by type, and lets only the hashed ones be cached for good', async () => {
    const { port } = await start();
    const script = await raw(port, '/assets/app-1a2b3c.js');
    expect(script.status).toBe(200);
    expect(script.body).toBe('console.log("app");');
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await raw(port, '/assets/style-4d5e6f.css')).headers['content-type']).toBe(
      'text/css; charset=utf-8',
    );
    expect((await raw(port, '/manifest.webmanifest')).headers['content-type']).toBe(
      'application/manifest+json; charset=utf-8',
    );
    // The worker must be fetched again each time or the app could never be updated.
    expect((await raw(port, '/sw.js')).headers['cache-control']).toBe('no-cache');
  });

  it('gives the page for the routes of the app, so that a link to a board opens it', async () => {
    const { port } = await start();
    for (const path of [
      '/b/abcdefghijklmnopqrstuv',
      '/b/x/y',
      '/anything',
      '/assets',
      '/?board=1',
    ]) {
      const res = await raw(port, path);
      expect(res.status).toBe(200);
      expect(res.body).toBe(INDEX);
    }
  });

  it('answers 404, not the page, for a file with a name that is not there', async () => {
    const { port } = await start();
    for (const path of ['/assets/gone-123456.js', '/favicon.ico', '/robots.txt', '/a/b.css']) {
      const res = await raw(port, path);
      expect(res.status).toBe(404);
      expect(res.body).not.toContain('<!doctype');
    }
  });

  it('answers a repeat request with 304, and HEAD without a body', async () => {
    const { port } = await start();
    const first = await raw(port, '/');
    const etag = String(first.headers['etag']);
    expect(etag).toMatch(/^W\//);
    const again = await raw(port, '/', 'GET', { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(again.body).toBe('');
    const head = await raw(port, '/', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String(INDEX.length));
  });

  it('sends a big file whole', async () => {
    const { port } = await start();
    const res = await raw(port, '/assets/big-000000.js');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(BIG.length);
  });

  it('allows only GET and HEAD', async () => {
    const { port } = await start();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await raw(port, '/', method);
      expect(res.status).toBe(405);
      expect(res.headers['allow']).toBe('GET, HEAD');
    }
  });
});

describe('what it will not serve', () => {
  it('nothing outside the directory, however the path is written', async () => {
    const { port } = await start();
    const attempts = [
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E%2Fsecret.txt',
      '/..%2fsecret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '//../secret.txt',
      '/%252e%252e/secret.txt',
      '/leak.txt', // a symlink inside the directory that points out of it
      '/%00',
      '/index.html%00.png',
      '/%',
      '/%ZZ',
    ];
    for (const path of attempts) {
      const res = await raw(port, path);
      expect(res.body, path).not.toContain('the secret');
      expect([200, 404], path).toContain(res.status);
      // A 200 can only be the page, never the file.
      if (res.status === 200) expect(res.body, path).toBe(INDEX);
    }
  });

  it('refuses a directory that is not a build, when the server starts', async () => {
    const empty = join(workdir, 'empty');
    mkdirSync(empty);
    await expect(start(empty)).rejects.toBeInstanceOf(StaticDirectoryError);
    await expect(start(join(workdir, 'missing'))).rejects.toThrow(/build the web app first/);
  });
});

describe('next to the sync server', () => {
  it('still answers /healthz and takes WebSocket connections on the same port', async () => {
    const { port } = await start();
    const health = await raw(port, '/healthz');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: 'ok' });

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    socket.close();
  });

  it('serves no files at all without a directory', async () => {
    const { port } = await start(null);
    expect((await raw(port, '/')).status).toBe(404);
    expect((await raw(port, '/assets/app-1a2b3c.js')).status).toBe(404);
    expect((await raw(port, '/healthz')).status).toBe(200);
  });
});
