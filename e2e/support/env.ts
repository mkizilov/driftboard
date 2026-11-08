import { fileURLToPath } from 'node:url';

/**
 * Where the suite runs. Ports are loopback ones from the project's range and are not the ones the
 * dev servers use (22100 to 22102), so a suite can run while the app is being developed.
 */
export const SYNC_PORT = 22110;
export const WEB_PORT = 22111;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
/** Where the web app under test is told to find the sync server (`VITE_SYNC_URL`). */
export const SYNC_URL = `ws://127.0.0.1:${SYNC_PORT}/ws`;

/** The window of every person: wide enough for three notes in a row. */
export const VIEWPORT = { width: 1280, height: 720 } as const;

/** How long a person may take to be connected and caught up after a server or network outage. */
export const SYNC_TIMEOUT_MS = 30_000;

/** The repository root (this file is `e2e/support/env.ts`). */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
