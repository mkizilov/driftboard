import { useRef, useState, type CSSProperties } from 'react';
import { useIdentity, usePeers } from '../hooks/use-presence';
import { MAX_NAME_CHARS, type IdentityStore } from '../lib/identity';
import type { LivePresence } from '../lib/presence';

/** This person's own name, which they can change. An empty name is not accepted. */
function NameField({ identity }: { identity: IdentityStore }) {
  const me = useIdentity(identity);
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  return (
    <input
      className="my-name"
      aria-label="Your name"
      value={draft ?? me.name}
      maxLength={MAX_NAME_CHARS}
      onFocus={(event) => {
        cancelled.current = false;
        event.currentTarget.select();
      }}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
      }}
      onBlur={() => {
        if (draft !== null && !cancelled.current) identity.rename(draft);
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** Who is looking at the board: this person first, then everyone else with what they are doing. */
export function PeopleList({ presence }: { presence: LivePresence }) {
  const peers = usePeers(presence.store);
  const me = useIdentity(presence.identity);
  return (
    <div className="people" role="group" aria-label="People on this board">
      <span className="person me" style={{ '--peer': me.color } as CSSProperties}>
        <span className="dot" />
        <NameField identity={presence.identity} />
        <span className="you">(you)</span>
      </span>
      <ul className="others">
        {peers.map((peer) => (
          <li
            key={peer.id}
            className="person"
            data-peer={peer.id}
            style={{ '--peer': peer.color } as CSSProperties}
          >
            <span className="dot" />
            <span className="person-name">{peer.name}</span>
            {peer.editing !== null && <span className="person-editing"> · editing a note</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
