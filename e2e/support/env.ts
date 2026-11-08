import { fileURLToPath } from 'node:url';

/**
 * A port of the project's loopback range (22100 to 22199): `name` in the environment if it is set,
 * else `fallback`. Anything else is refused, so a typo cannot send the suite outside the range.
 */
export function portFromEnv(
  name: string,
  fallback: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const text = env[name];
  if (text === undefined || text === '') return fallback;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 22100 || port > 22199) {
    throw new Error(`${name} must be a port from 22100 to 22199, got "${text}"`);
  }
  return port;
}

export const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserName = (typeof BROWSERS)[number];

const isBrowser = (name: string): name is BrowserName =>
  (BROWSERS as readonly string[]).includes(name);

/**
 * The engines to run, from a comma-separated `E2E_BROWSERS` (default: chromium). Only Chromium is
 * installed by `pnpm e2e:install`; install the others with `playwright install` first.
 */
export function browsersFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BrowserName[] {
  const text = env['E2E_BROWSERS'];
  if (text === undefined || text.trim() === '') return ['chromium'];
  const names = text.split(',').map((name) => name.trim());
  const unknown = names.filter((name) => !isBrowser(name));
  if (unknown.length > 0) {
    throw new Error(
      `E2E_BROWSERS lists unknown browsers: ${unknown.map((name) => `"${name}"`).join(', ')} (choose from ${BROWSERS.join(', ')})`,
    );
  }
  return [...new Set(names.filter(isBrowser))];
}

/**
 * Where the suite runs. Ports are loopback ones from the project's range and are not the ones the
 * dev servers use (22100 to 22102), so a suite can run while the app is being developed. When a
 * process of an earlier run still holds one, `E2E_SYNC_PORT` and `E2E_WEB_PORT` move the suite.
 */
export const SYNC_PORT = portFromEnv('E2E_SYNC_PORT', 22150);
export const WEB_PORT = portFromEnv('E2E_WEB_PORT', 22151);
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
/** Where the web app under test is told to find the sync server (`VITE_SYNC_URL`). */
export const SYNC_URL = `ws://127.0.0.1:${SYNC_PORT}/ws`;

/** The window of every person: wide enough for three notes in a row. */
export const VIEWPORT = { width: 1280, height: 720 } as const;

/** How long a person may take to be connected and caught up after a server or network outage. */
export const SYNC_TIMEOUT_MS = 30_000;

/** The repository root (this file is `e2e/support/env.ts`). */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
