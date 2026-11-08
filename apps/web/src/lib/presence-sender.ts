import type { PresenceState } from '@driftboard/protocol';
import type { Identity } from './identity';
import { HEARTBEAT_MS, MIN_INTERVAL_MS } from './presence-timing';
import type { Timers } from './sync-connection';
import type { Point } from './viewport';

export interface PresenceSenderOptions {
  /** Sends the state. Returns false when there is no connection to send it on. */
  readonly send: (state: PresenceState) => boolean;
  /** Milliseconds from any start that never goes backwards (`performance.now`). */
  readonly now: () => number;
  readonly timers: Timers;
  readonly identity: Identity;
  readonly minIntervalMs?: number;
  readonly heartbeatMs?: number;
}

/**
 * Decides when this person's presence goes out. Presence is ephemeral: nothing is queued, and
 * nothing is sent while there is no connection.
 *
 * - *Throttle.* At least `minIntervalMs` (50 ms, so at most 20 a second) pass between two messages.
 *   A change that finds the line free goes out at once; changes that come sooner are merged and
 *   the latest state goes out when the interval is over, so the end of a movement is never lost.
 * - *Heartbeat.* With nothing new to say, the state is sent again after `heartbeatMs`, so that the
 *   others can tell someone who is still from someone who is gone.
 * - *Connection.* When a connection is made the state goes out at once, because the server and the
 *   others know nothing of this connection; when it ends everything stops.
 *
 * One timer is ever pending, and it always points at the next time something is due.
 */
export class PresenceSender {
  readonly #send: (state: PresenceState) => boolean;
  readonly #now: () => number;
  readonly #timers: Timers;
  readonly #minIntervalMs: number;
  readonly #heartbeatMs: number;
  #state: PresenceState;
  #connected = false;
  /** Whether the state has changed since it was last sent. */
  #dirty = true;
  #lastSent: number | null = null;
  #timer: unknown = undefined;
  #disposed = false;

  constructor(options: PresenceSenderOptions) {
    this.#send = options.send;
    this.#now = options.now;
    this.#timers = options.timers;
    this.#minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
    this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.#state = { cursor: null, editing: null, ...options.identity };
  }

  /** What would be sent now. */
  getState(): PresenceState {
    return this.#state;
  }

  /** The pointer, in board coordinates, or `null` when it is not over the board. */
  moveCursor(point: Point | null): void {
    // Whole board units are plenty, and moving less than that changes nothing for anyone.
    const cursor = point === null ? null : { x: Math.round(point.x), y: Math.round(point.y) };
    const current = this.#state.cursor;
    if (cursor === null || current === null) {
      if (cursor === current) return;
    } else if (cursor.x === current.x && cursor.y === current.y) {
      return;
    }
    this.#change({ ...this.#state, cursor });
  }

  setEditing(noteId: string | null): void {
    if (noteId === this.#state.editing) return;
    this.#change({ ...this.#state, editing: noteId });
  }

  setIdentity({ name, color }: Identity): void {
    if (name === this.#state.name && color === this.#state.color) return;
    this.#change({ ...this.#state, name, color });
  }

  /** The connection can carry presence (or can no longer). */
  setConnected(connected: boolean): void {
    if (connected === this.#connected) return;
    this.#connected = connected;
    if (connected) {
      // The server and the others know nothing of this connection yet.
      this.#dirty = true;
      this.#lastSent = null;
    }
    this.#schedule();
  }

  /** Stops for good. */
  dispose(): void {
    this.#disposed = true;
    this.#cancel();
  }

  #change(next: PresenceState): void {
    this.#state = next;
    const wasDirty = this.#dirty;
    this.#dirty = true;
    // A pending timer already points at the moment this change will go out.
    if (!wasDirty || this.#timer === undefined) this.#schedule();
  }

  /** Sends if something is due, and otherwise waits for the moment it will be. */
  #schedule(): void {
    this.#cancel();
    if (!this.#connected || this.#disposed) return;
    const now = this.#now();
    const last = this.#lastSent;
    const wait = this.#dirty ? this.#minIntervalMs : this.#heartbeatMs;
    const due = last === null ? now : last + wait;
    if (due <= now) {
      this.#transmit(now);
      return;
    }
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      // Timers can fire a little early, so this works out again what is due.
      this.#schedule();
    }, due - now);
  }

  #transmit(now: number): void {
    if (!this.#send(this.#state)) {
      // There turned out to be no connection. `setConnected(true)` starts everything again.
      this.#connected = false;
      return;
    }
    this.#lastSent = now;
    this.#dirty = false;
    this.#schedule();
  }

  #cancel(): void {
    if (this.#timer === undefined) return;
    this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
