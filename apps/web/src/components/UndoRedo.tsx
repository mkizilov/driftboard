import { useHistoryShortcuts, useHistoryState } from '../hooks/use-history';
import type { BoardStore } from '../lib/board-store';

/**
 * Undo and redo for this user's own changes, as buttons and, while it is on the page, as
 * Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z.
 */
export function UndoRedo({ store }: { store: BoardStore }) {
  useHistoryShortcuts(store);
  const { canUndo, canRedo } = useHistoryState(store);
  return (
    <div className="history" role="group" aria-label="Undo and redo">
      <button
        type="button"
        title="Undo (Ctrl/Cmd+Z)"
        disabled={!canUndo}
        onClick={() => {
          store.undo();
        }}
      >
        Undo
      </button>
      <button
        type="button"
        title="Redo (Shift+Ctrl/Cmd+Z)"
        disabled={!canRedo}
        onClick={() => {
          store.redo();
        }}
      >
        Redo
      </button>
    </div>
  );
}
