import type { CSSProperties } from 'react';
import { usePeers } from '../hooks/use-presence';
import type { PresenceStore } from '../lib/presence-store';
import { worldToScreen, type Viewport } from '../lib/viewport';

/**
 * The other people's pointers, each labelled with a name and drawn in their colour. Positions are
 * board coordinates, so a pointer stays over the same spot of the board whatever either person's
 * pan or zoom is; the arrow and the label keep their size whatever the zoom.
 */
export function Cursors({ store, viewport }: { store: PresenceStore; viewport: Viewport }) {
  const peers = usePeers(store);
  return (
    <div className="cursors" aria-hidden="true">
      {peers.map((peer) => {
        if (peer.cursor === null) return null;
        const { x, y } = worldToScreen(viewport, peer.cursor);
        const style = { transform: `translate(${x}px, ${y}px)`, '--peer': peer.color };
        return (
          <div key={peer.id} className="cursor" data-peer={peer.id} style={style as CSSProperties}>
            <svg className="cursor-arrow" width="16" height="20" viewBox="0 0 16 20">
              <path
                d="M1 1v14l4-3.5L8 18l2.5-1-3-6.5H13z"
                fill="var(--peer)"
                stroke="#fff"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
            <span className="cursor-label">{peer.name}</span>
          </div>
        );
      })}
    </div>
  );
}
