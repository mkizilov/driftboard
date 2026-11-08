import { useState } from 'react';
import { useBoardSession } from '../hooks/use-board';
import { createBrowserSession } from '../lib/browser';
import type { BoardSession } from '../lib/session';
import { Canvas } from './Canvas';
import { PeopleList } from './PeopleList';
import { SyncIndicator } from './SyncIndicator';

function CopyLinkButton() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const link = window.location.href;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // No clipboard access (an insecure page, or permission denied): let the user copy it.
      window.prompt('Copy this link to share the board', link);
    }
  };
  return (
    <button
      type="button"
      className="copy-link"
      onClick={() => {
        void copy();
      }}
    >
      {copied ? 'Link copied' : 'Copy link'}
    </button>
  );
}

export interface BoardPageProps {
  boardId: string;
  /** Opens the board; replaced in tests. Must be a stable function. */
  createSession?: (boardId: string) => Promise<BoardSession>;
}

/**
 * A board: the canvas of notes, whether it is online, syncing or offline, and a link to share it.
 * The board is read from this device first, so it opens with no network.
 */
export function BoardPage({ boardId, createSession = createBrowserSession }: BoardPageProps) {
  const { session, error } = useBoardSession(boardId, createSession);
  if (error !== null) {
    return (
      <p className="loading" role="alert">
        Could not open this board: {error.message}
      </p>
    );
  }
  if (session === null) return <p className="loading">Opening board…</p>;
  return (
    <div className="board-page">
      <header className="board-bar">
        <a className="home-link" href="/">
          driftboard
        </a>
        <SyncIndicator session={session} />
        <PeopleList presence={session.presence} />
        <span className="hint">Double-click the canvas to add a note</span>
        <CopyLinkButton />
      </header>
      <Canvas store={session.store} presence={session.presence} />
    </div>
  );
}
