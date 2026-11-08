import { useState } from 'react';
import { useBoardSession, useConnectionStatus } from '../hooks/use-board';
import { createBrowserSession } from '../lib/browser';
import type { BoardSession } from '../lib/session';
import { Canvas } from './Canvas';

const STATUS_TEXT = {
  connecting: 'Connecting…',
  online: 'Connected',
  offline: 'Offline, retrying…',
} as const;

function ConnectionBadge({ session }: { session: BoardSession }) {
  const status = useConnectionStatus(session.connection);
  return (
    <span className="connection" data-status={status} role="status">
      {STATUS_TEXT[status]}
    </span>
  );
}

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
  /** Opens the board; replaced in tests. */
  createSession?: (boardId: string) => BoardSession;
}

/** A board: the canvas of notes plus the connection status and a link to share it. */
export function BoardPage({ boardId, createSession = createBrowserSession }: BoardPageProps) {
  const session = useBoardSession(boardId, createSession);
  if (session === null) return <p className="loading">Opening board…</p>;
  return (
    <div className="board-page">
      <header className="board-bar">
        <a className="home-link" href="/">
          driftboard
        </a>
        <ConnectionBadge session={session} />
        <span className="hint">Double-click the canvas to add a note</span>
        <CopyLinkButton />
      </header>
      <Canvas store={session.store} />
    </div>
  );
}
