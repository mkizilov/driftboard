import { Board, generateReplicaId, replicaId } from '@driftboard/crdt';
import { stampOps, type PresenceState, type StampedOp } from '@driftboard/protocol';
import type { TextControl } from './caret';
import { IdentityStore } from './identity';
import { createPresence, type PresenceConnection } from './presence';
import { PresenceStore } from './presence-store';
import type { TextEdit } from './text-binding';
import type { ConnectionStatus } from './sync-connection';
import { FakeTimers } from './test-network';

type Direction = 'forward' | 'backward' | 'none';

/**
 * A textarea as far as the code under test can tell. It follows the HTML rule that matters here:
 * giving `value` a different string puts the caret at the end and clears the selection direction
 * (and, as some browsers do, resets the scroll position). What the user types goes in directly.
 * Offsets are UTF-16 units, as in the DOM.
 */
export class FakeTextarea implements TextControl {
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: Direction | null = 'none';
  scrollTop = 0;
  /** How many times the code under test asked for a selection. */
  selectionCalls = 0;
  #value: string;

  constructor(value = '') {
    this.#value = value;
    this.selectionStart = value.length;
    this.selectionEnd = value.length;
  }

  get value(): string {
    return this.#value;
  }

  set value(next: string) {
    if (next === this.#value) return;
    this.#value = next;
    this.selectionStart = next.length;
    this.selectionEnd = next.length;
    this.selectionDirection = 'none';
    this.scrollTop = 0;
  }

  setSelectionRange(start: number, end: number, direction: Direction = 'none'): void {
    this.selectionCalls += 1;
    this.select(start, end, direction);
  }

  /** The user selects text. */
  select(start: number, end: number, direction: Direction = 'none'): void {
    const clamp = (index: number) => Math.min(Math.max(index, 0), this.#value.length);
    this.selectionStart = clamp(Math.min(start, end));
    this.selectionEnd = clamp(Math.max(start, end));
    this.selectionDirection = direction;
  }

  /** The user types, pastes or drops `text`, replacing the selection. */
  replaceSelection(text: string): void {
    const { selectionStart: start, selectionEnd: end } = this;
    this.#value = this.#value.slice(0, start) + text + this.#value.slice(end);
    this.select(start + text.length, start + text.length);
  }

  /** The user presses Backspace. */
  deleteBackward(): void {
    if (this.selectionStart === this.selectionEnd && this.selectionStart > 0) {
      this.select(this.selectionStart - 1, this.selectionStart);
    }
    this.replaceSelection('');
  }
}

/**
 * A replica with its own id (derived from `seed`) and a physical clock that moves a millisecond
 * per reading.
 */
export function replica(seed: number): Board {
  let time = 1_000;
  return new Board({
    replicaId: generateReplicaId((length) =>
      Uint8Array.from({ length }, (_, index) => (seed * 37 + index * 11) % 256),
    ),
    clock: {
      now: () => {
        time += 1;
        return time;
      },
    },
  });
}

/**
 * Presence for one person on a connection the test controls: `set('online')` brings it up, and
 * what it sends is in `sent`. The person's own replica is `self`; others are fed to `store`.
 */
export function testPresence(name = 'Me') {
  const self = replicaId('self');
  const timers = new FakeTimers();
  const identity = new IdentityStore(null, () => Uint8Array.from([0, 0, 0]));
  identity.rename(name);
  const store = new PresenceStore({ self, now: () => timers.now, timers });
  let status: ConnectionStatus = 'offline';
  const listeners = new Set<() => void>();
  const sent: (PresenceState | null)[] = [];
  const connection: PresenceConnection = {
    getStatus: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sendPresence: (state) => {
      if (status !== 'online') return false;
      sent.push(state);
      return true;
    },
  };
  const presence = createPresence({
    store,
    identity,
    connection,
    now: () => timers.now,
    timers,
  });
  return {
    presence,
    store,
    identity,
    timers,
    sent,
    set: (next: ConnectionStatus) => {
      status = next;
      for (const listener of [...listeners]) listener();
    },
    /** Someone else's presence, as the server would relay it. */
    hear: (other: string, state: Partial<PresenceState> | null) => {
      store.receive({
        type: 'presence',
        replicaId: replicaId(other),
        state:
          state === null
            ? null
            : { cursor: null, editing: null, name: other, color: '#e03131', ...state },
      });
    },
  };
}

/** Operations of a replica that made a note and typed `texts` into it, stamped 1, 2, 3, ... */
export function operations(seed: number, texts: readonly string[] = ['abc']): StampedOp[] {
  const board = replica(seed);
  const { id, ops } = board.createNote({ x: 1, y: 2 });
  const all = [...ops];
  for (const text of texts) all.push(...board.editText(id, 0, 0, text));
  return stampOps(board.replicaId, 1, all);
}

/** `ops` sorted by origin and number, so that two lists can be compared. */
export function order(ops: readonly StampedOp[]): StampedOp[] {
  return [...ops].sort((a, b) =>
    a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : a.seq - b.seq,
  );
}

/** Applies an edit in code points to a text, as `Board.editText` does. */
export function applyEdit(text: string, edit: TextEdit): string {
  const characters = [...text];
  characters.splice(edit.start, edit.deleteCount, ...edit.insert);
  return characters.join('');
}
