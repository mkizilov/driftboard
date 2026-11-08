import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, sep } from 'node:path';

/**
 * Serves the built web app (`apps/web/dist`) from the same port as the WebSocket. Only what the
 * app needs: files under one directory, `GET` and `HEAD`, and `index.html` for the client-side
 * routes (`/b/:boardId`) so that a link to a board opens it. TLS and compression are for a reverse
 * proxy in front of it.
 */

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Sent with everything. The board id is in the page's address and is the only key to the board, so
 * nothing may leak it as a referrer. The app loads only its own files and talks only to its own
 * origin (the WebSocket is `ws:`/`wss:` to the same host); styles are set by React on elements, which
 * is why `style-src` allows inline ones.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; " +
    "style-src 'self' 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** Files whose name has a hash in it never change; the page, the worker and the manifest do. */
const cacheControl = (name: string): string =>
  name.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';

export interface StaticFiles {
  /** Answers the request. Rejects only if reading a file failed, which the caller has to survive. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

/** Thrown when the directory is not a built web app. */
export class StaticDirectoryError extends Error {
  override readonly name = 'StaticDirectoryError';
}

export async function serveStatic(directory: string): Promise<StaticFiles> {
  let root: string;
  try {
    root = await realpath(directory);
    await stat(join(root, 'index.html'));
  } catch {
    throw new StaticDirectoryError(
      `${directory} has no index.html: build the web app first (pnpm --filter @driftboard/web build:prod)`,
    );
  }
  const prefix = root.endsWith(sep) ? root : root + sep;

  /** The file for a URL path, if there is a regular one under the root; never anything outside. */
  async function find(
    pathname: string,
  ): Promise<{ file: string; size: number; mtimeMs: number } | undefined> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
    if (decoded.includes('\0')) return undefined;
    // `join` collapses `..`; the real path then has to be under the root, which also stops a
    // symlink inside it that points out.
    let real: string;
    try {
      real = await realpath(join(root, decoded));
    } catch {
      return undefined;
    }
    if (real !== root && !real.startsWith(prefix)) return undefined;
    const info = await stat(real);
    return info.isFile() ? { file: real, size: info.size, mtimeMs: info.mtimeMs } : undefined;
  }

  return {
    async handle(req, res) {
      const head = req.method === 'HEAD';
      if (req.method !== 'GET' && !head) {
        res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS }).end();
        return;
      }
      const pathname = (req.url ?? '/').split('?')[0] ?? '/';
      let name = pathname;
      let found = await find(name);
      // A path without a file name is a route of the app; one with a name that is not there is a
      // missing file, which must be a 404 and not the page (a script that is gone is not HTML).
      if (found === undefined && extname(pathname) === '') {
        name = '/index.html';
        found = await find(name);
      }
      if (found === undefined) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
        res.end(head ? undefined : 'not found');
        return;
      }
      const etag = `W/"${found.size.toString(16)}-${Math.floor(found.mtimeMs).toString(16)}"`;
      const headers = {
        'Content-Type': TYPES[extname(found.file)] ?? 'application/octet-stream',
        'Cache-Control': cacheControl(name),
        ETag: etag,
        ...SECURITY_HEADERS,
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end();
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': found.size });
      if (head) {
        res.end();
        return;
      }
      if (found.size <= 1_048_576) {
        res.end(await readFile(found.file));
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(found.file);
        stream.once('error', reject);
        res.once('close', resolve);
        stream.pipe(res);
      });
    },
  };
}
