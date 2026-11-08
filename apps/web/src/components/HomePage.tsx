import { boardPath } from '../lib/route';
import { navigate, newBoardId } from '../lib/browser';

/** The front page: one button that makes a new board with a random, unguessable id. */
export function HomePage() {
  return (
    <main className="home">
      <h1>driftboard</h1>
      <p>A collaborative sticky-note board. Anyone with the link can edit, even offline.</p>
      <button
        type="button"
        className="create-board"
        onClick={() => {
          navigate(boardPath(newBoardId()));
        }}
      >
        Create a board
      </button>
      <small>The link is the only key to your board, so share it only with people you trust.</small>
    </main>
  );
}
