import { useCallback, useSyncExternalStore } from 'react';
import type { Identity, IdentityStore } from '../lib/identity';
import type { Editor, Peer, PresenceStore } from '../lib/presence-store';

/** Everyone else on the board. Re-renders when someone arrives, leaves or moves. */
export function usePeers(store: PresenceStore): readonly Peer[] {
  return useSyncExternalStore(store.subscribe, store.getPeers);
}

/** Who is editing one note. Re-renders only when that changes, not when a cursor moves. */
export function useEditors(store: PresenceStore, noteId: string): readonly Editor[] {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeEditors(noteId, listener),
    [store, noteId],
  );
  const getSnapshot = useCallback(() => store.getEditors(noteId), [store, noteId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** This person's own name and colour. */
export function useIdentity(identity: IdentityStore): Identity {
  return useSyncExternalStore(identity.subscribe, identity.getIdentity);
}
