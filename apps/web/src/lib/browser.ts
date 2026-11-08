import { generateBoardId } from '@driftboard/protocol';
import { syncUrl } from './config';
import { openIdbStorage } from './idb-storage';
import { watchNetwork } from './network';
import { openBoardSession, type BoardSession } from './session';
import { MemoryDisk, type BoardStorage } from './storage';

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

/**
 * The board's storage in IndexedDB. Where IndexedDB cannot be used (some private modes, blocked
 * storage) the board still works, but only for as long as the page lives.
 */
export async function openBrowserStorage(boardId: string): Promise<BoardStorage> {
  try {
    return await openIdbStorage(boardId);
  } catch (error) {
    console.warn('IndexedDB is not available; this board will not be kept on this device.', error);
    return new MemoryDisk({ durable: false }).open(boardId);
  }
}

/** Opens a board against the sync server this page is configured for. */
export async function createBrowserSession(boardId: string): Promise<BoardSession> {
  const env = import.meta.env as { VITE_SYNC_URL?: string };
  const storage = await openBrowserStorage(boardId);
  let session: BoardSession;
  try {
    session = await openBoardSession({
      boardId,
      url: syncUrl(env, window.location),
      storage,
      randomBytes: browserRandomBytes,
    });
  } catch (error) {
    await storage.close();
    throw error;
  }
  if (session.droppedOps > 0) {
    console.warn(`${session.droppedOps} stored operations were unusable and left out.`);
  }
  const stopWatching = watchNetwork(window, session.connection);
  return {
    ...session,
    dispose: () => {
      stopWatching();
      return session.dispose();
    },
  };
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
