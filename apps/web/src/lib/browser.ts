import { generateBoardId } from '@driftboard/protocol';
import { syncUrl } from './config';
import { createBoardSession, type BoardSession } from './session';

/** Random bytes from the browser's cryptographically secure generator. */
export function browserRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** A new, unguessable board id (128 random bits). */
export function newBoardId(): string {
  return generateBoardId(browserRandomBytes);
}

/** Opens a board against the sync server this page is configured for. */
export function createBrowserSession(boardId: string): BoardSession {
  const env = import.meta.env as { VITE_SYNC_URL?: string };
  return createBoardSession({
    boardId,
    url: syncUrl(env, window.location),
    randomBytes: browserRandomBytes,
  });
}

const NAVIGATE_EVENT = 'driftboard:navigate';

/** Goes to `path` without reloading the page. */
export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export function subscribeLocation(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}

export function getPathname(): string {
  return window.location.pathname;
}
