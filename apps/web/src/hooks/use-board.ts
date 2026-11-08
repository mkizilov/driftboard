import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { NoteView } from '@driftboard/crdt';
import type { BoardStore } from '../lib/board-store';
import { createBrowserSession, getPathname, subscribeLocation } from '../lib/browser';
import { parseRoute, type Route } from '../lib/route';
import type { BoardSession } from '../lib/session';
import type { Persistence } from '../lib/persistence';
import type { SyncConnection, SyncState } from '../lib/sync-connection';

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

/** The connection's status and how many changes the server does not have yet. */
export function useSyncState(connection: SyncConnection): SyncState {
  return useSyncExternalStore(connection.subscribe, connection.getState);
}

/** Why the last write to this device failed, or `null`. */
export function useSaveError(persistence: Persistence): Error | null {
  return useSyncExternalStore(persistence.subscribe, persistence.getError);
}

export interface OpenBoard {
  /** `null` while the board is being read from the device, and after a failure. */
  readonly session: BoardSession | null;
  readonly error: Error | null;
}

const NOT_OPEN: OpenBoard = { session: null, error: null };

/**
 * Opens the board for as long as the component is mounted: reads it from this device, then starts
 * the connection. The effect form keeps it correct under React's double-invoked development
 * effects; a session that finishes opening after the component went away is closed again.
 * `create` must be a stable function, or the board is reopened on every render.
 */
export function useBoardSession(
  boardId: string,
  create: (boardId: string) => Promise<BoardSession> = createBrowserSession,
): OpenBoard {
  const [opened, setOpened] = useState<OpenBoard>(NOT_OPEN);
  useEffect(() => {
    let cancelled = false;
    let session: BoardSession | null = null;
    create(boardId).then(
      (created) => {
        if (cancelled) {
          void created.dispose();
          return;
        }
        session = created;
        setOpened({ session: created, error: null });
        created.start();
      },
      (error: unknown) => {
        if (cancelled) return;
        const failure = error instanceof Error ? error : new Error(String(error));
        setOpened({ session: null, error: failure });
      },
    );
    return () => {
      cancelled = true;
      if (session !== null) void session.dispose();
      setOpened(NOT_OPEN);
    };
  }, [boardId, create]);
  return opened;
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribeLocation, getPathname);
  return useMemo(() => parseRoute(pathname), [pathname]);
}
