import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { NoteView } from '@driftboard/crdt';
import type { BoardStore } from '../lib/board-store';
import { createBrowserSession, getPathname, subscribeLocation } from '../lib/browser';
import { parseRoute, type Route } from '../lib/route';
import type { BoardSession } from '../lib/session';
import type { ConnectionStatus, SyncConnection } from '../lib/sync-connection';

/** The ids of all notes. Re-renders only when a note is added or removed. */
export function useNoteIds(store: BoardStore): readonly string[] {
  return useSyncExternalStore(store.subscribeList, store.getIds);
}

/** One note's state. Re-renders only when that note changes. */
export function useNote(store: BoardStore, id: string): NoteView | undefined {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeNote(id, listener),
    [store, id],
  );
  const getSnapshot = useCallback(() => store.getNote(id), [store, id]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useConnectionStatus(connection: SyncConnection): ConnectionStatus {
  return useSyncExternalStore(connection.subscribe, connection.getStatus);
}

/**
 * Opens the board for as long as the component is mounted. It is `null` on the first render, then
 * the session; the effect form keeps it correct under React's double-invoked development effects.
 */
export function useBoardSession(
  boardId: string,
  create: (boardId: string) => BoardSession = createBrowserSession,
): BoardSession | null {
  const [session, setSession] = useState<BoardSession | null>(null);
  useEffect(() => {
    const opened = create(boardId);
    setSession(opened);
    opened.start();
    return () => {
      opened.dispose();
      setSession(null);
    };
  }, [boardId, create]);
  return session;
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribeLocation, getPathname);
  return useMemo(() => parseRoute(pathname), [pathname]);
}
