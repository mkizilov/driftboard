/** The port the sync server listens on by default. */
export const DEFAULT_SERVER_PORT = 22100;

/**
 * The WebSocket address of the sync server: `VITE_SYNC_URL` if it is set, otherwise the same host
 * as the page, on the server's default port.
 */
export function syncUrl(
  env: { readonly VITE_SYNC_URL?: string | undefined },
  location: { readonly protocol: string; readonly hostname: string },
): string {
  if (env.VITE_SYNC_URL !== undefined && env.VITE_SYNC_URL !== '') return env.VITE_SYNC_URL;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.hostname}:${DEFAULT_SERVER_PORT}/ws`;
}
