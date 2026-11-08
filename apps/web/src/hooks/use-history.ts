import { useEffect, useSyncExternalStore } from 'react';
import type { HistoryState } from '@driftboard/crdt';
import type { BoardStore } from '../lib/board-store';
import { historyInput, historyShortcut, type HistoryCommand } from '../lib/history-keys';

/** Whether there is anything to undo or redo. Re-renders only when that changes. */
export function useHistoryState(store: BoardStore): HistoryState {
  return useSyncExternalStore(store.subscribeHistory, store.getHistoryState);
}

/**
 * Makes Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z undo and redo on this board, wherever the focus is, and
 * keeps the browser from also undoing inside a note's textarea. The document is changed from
 * outside a textarea (by others, and by undo itself), so the browser's own undo stack for it is
 * wrong and is never allowed to run.
 */
export function useHistoryShortcuts(store: BoardStore): void {
  useEffect(() => {
    const run = (command: HistoryCommand | null, event: Event) => {
      if (command === null) return;
      event.preventDefault();
      if (command === 'undo') store.undo();
      else store.redo();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      run(historyShortcut(event), event);
    };
    const onBeforeInput = (event: InputEvent) => {
      run(historyInput(event), event);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeinput', onBeforeInput);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('beforeinput', onBeforeInput);
    };
  }, [store]);
}
