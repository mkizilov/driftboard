import type { ReplicaId } from '@driftboard/crdt';
import type { Presence } from '@driftboard/protocol';
import { PEER_TIMEOUT_MS } from './presence-timing';
import type { Timers } from './sync-connection';
import type { Point } from './viewport';

/** Someone else on the board. */
export interface Peer {
  readonly id: ReplicaId;
  readonly name: string;
  readonly color: string;
  /** In board coordinates; `null` when the pointer is not over the board. */
  readonly cursor: Point | null;
  /** The note whose text they are editing. */
  readonly editing: string | null;
}

/** What a note needs to know about someone editing it. A cursor that moves does not change it. */
export interface Editor {
  readonly id: ReplicaId;
  readonly name: string;
  readonly color: string;
}

export interface PresenceStoreOptions {
  /** Presence about this replica is ignored. */
  readonly self: ReplicaId;
  /** Milliseconds from any start that never goes backwards (`performance.now`). */
  readonly now: () => number;
  readonly timers: Timers;
  readonly timeoutMs?: number;
}

const NO_PEERS: readonly Peer[] = [];
const NO_EDITORS: readonly Editor[] = [];

const samePeer = (a: Peer, b: Peer): boolean =>
  a.name === b.name &&
  a.color === b.color &&
  a.editing === b.editing &&
  (a.cursor === null || b.cursor === null
    ? a.cursor === b.cursor
    : a.cursor.x === b.cursor.x && a.cursor.y === b.cursor.y);

const sameEditors = (a: readonly Editor[], b: readonly Editor[]): boolean =>
  a.length === b.length &&
  a.every((editor, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      editor.id === other.id &&
      editor.name === other.name &&
      editor.color === other.color
    );
  });

const byName = (a: Peer, b: Peer): number =>
  a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

interface Entry {
  peer: Peer;
  /** When something was last heard from them. */
  seen: number;
}

/**
 * Who else is on the board, as React reads it. Presence is ephemeral: it lives here and nowhere
 * else, and a person is dropped when they say they have left, when the connection is lost
 * (`clear`) or when nothing has been heard of them for `timeoutMs`.
 *
 * Like `BoardStore` it gives out stable snapshots: `getPeers` is the same array until someone
 * arrives, leaves or changes, and `getEditors(noteId)` is the same array until the set of people
 * editing that note changes, so a cursor that moves renders the people list and the cursors but
 * never a note.
 *
 * One timer is pending while anyone is here. It is set for the moment the oldest entry could
 * expire, and when it fires it drops what has expired and is set again; a message that refreshes an
 * entry costs nothing more than noting the time.
 */
export class PresenceStore {
  readonly #options: PresenceStoreOptions;
  readonly #timeoutMs: number;
  readonly #entries = new Map<ReplicaId, Entry>();
  readonly #editors = new Map<string, readonly Editor[]>();
  readonly #listeners = new Set<() => void>();
  readonly #editorListeners = new Map<string, Set<() => void>>();
  #peers: readonly Peer[] = NO_PEERS;
  #timer: unknown = undefined;

  constructor(options: PresenceStoreOptions) {
    this.#options = options;
    this.#timeoutMs = options.timeoutMs ?? PEER_TIMEOUT_MS;
  }

  /** Everyone else, by name. The same array until something about them changes. */
  readonly getPeers = (): readonly Peer[] => this.#peers;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Who is editing the note. The same array until that changes. */
  getEditors(noteId: string): readonly Editor[] {
    return this.#editors.get(noteId) ?? NO_EDITORS;
  }

  subscribeEditors(noteId: string, listener: () => void): () => void {
    let listeners = this.#editorListeners.get(noteId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#editorListeners.set(noteId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.#editorListeners.get(noteId);
      current?.delete(listener);
      if (current?.size === 0) this.#editorListeners.delete(noteId);
    };
  }

  /** A presence message from the server. */
  readonly receive = (message: Presence): void => {
    const id = message.replicaId;
    if (id === this.#options.self) return;
    const existing = this.#entries.get(id);
    const { state } = message;
    if (state === null) {
      if (existing === undefined) return;
      this.#entries.delete(id);
      this.#publish([existing.peer.editing]);
      if (this.#entries.size === 0) this.#cancel();
      return;
    }
    const peer: Peer = {
      id,
      name: state.name,
      color: state.color,
      cursor: state.cursor === null ? null : { x: state.cursor.x, y: state.cursor.y },
      editing: state.editing,
    };
    const seen = this.#options.now();
    if (existing !== undefined && samePeer(existing.peer, peer)) {
      existing.seen = seen;
      return;
    }
    this.#entries.set(id, { peer, seen });
    this.#publish([existing?.peer.editing ?? null, peer.editing]);
    this.#arm();
  };

  /** Forgets everyone, for when the connection is lost: nothing can be known about them now. */
  clear(): void {
    this.#cancel();
    if (this.#entries.size === 0) return;
    const editing = [...this.#entries.values()].map((entry) => entry.peer.editing);
    this.#entries.clear();
    this.#publish(editing);
  }

  /** Stops the timer. */
  dispose(): void {
    this.#cancel();
  }

  /** Rebuilds the snapshots that may have changed, and tells the listeners of the ones that did. */
  #publish(notes: readonly (string | null)[]): void {
    this.#peers =
      this.#entries.size === 0
        ? NO_PEERS
        : [...this.#entries.values()].map((entry) => entry.peer).sort(byName);
    for (const listener of [...this.#listeners]) listener();
    for (const note of new Set(notes)) {
      if (note === null) continue;
      const previous = this.getEditors(note);
      const next = this.#peers
        .filter((peer) => peer.editing === note)
        .map(({ id, name, color }): Editor => ({ id, name, color }));
      if (sameEditors(previous, next)) continue;
      if (next.length === 0) this.#editors.delete(note);
      else this.#editors.set(note, next);
      for (const listener of [...(this.#editorListeners.get(note) ?? [])]) listener();
    }
  }

  #arm(): void {
    if (this.#timer !== undefined || this.#entries.size === 0) return;
    let oldest = Infinity;
    for (const { seen } of this.#entries.values()) oldest = Math.min(oldest, seen);
    const wait = Math.max(0, oldest + this.#timeoutMs - this.#options.now());
    this.#timer = this.#options.timers.setTimeout(() => {
      this.#timer = undefined;
      this.#expire();
    }, wait);
  }

  #expire(): void {
    const now = this.#options.now();
    const editing: (string | null)[] = [];
    for (const [id, { peer, seen }] of this.#entries) {
      if (now - seen < this.#timeoutMs) continue;
      this.#entries.delete(id);
      editing.push(peer.editing);
    }
    if (editing.length > 0) this.#publish(editing);
    // A timer that fires early finds nothing to drop and waits again for what is left.
    this.#arm();
  }

  #cancel(): void {
    if (this.#timer === undefined) return;
    this.#options.timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
