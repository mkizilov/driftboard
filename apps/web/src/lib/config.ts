/** The port the sync server listens on by default. */
export const DEFAULT_SERVER_PORT = 22100;

/**
 * The WebSocket address of the sync server.
 *
 * - `VITE_SYNC_URL` as a full address (`wss://sync.example.test/ws`) is used as it is.
 * - `VITE_SYNC_URL` as a path (`/ws`) is that path on the origin that served the page, with `ws` or
 *   `wss` to match. The production build uses it, since the Node server serves the page and the
 *   socket from one port, whatever that port is made visible as (a published container port).
 * - Without it, the same host as the page on the server's default port: for the Vite dev server and
 *   `vite preview`, which are on other ports than the sync server.
 */
export function syncUrl(
  env: { readonly VITE_SYNC_URL?: string | undefined },
  location: { readonly protocol: string; readonly hostname: string; readonly host: string },
): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const configured = env.VITE_SYNC_URL;
  if (configured !== undefined && configured.startsWith('/')) {
    return `${scheme}://${location.host}${configured}`;
  }
  if (configured !== undefined && configured !== '') return configured;
  return `${scheme}://${location.hostname}:${DEFAULT_SERVER_PORT}/ws`;
}
