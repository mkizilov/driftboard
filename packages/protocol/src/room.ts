import type { ReplicaId } from '@driftboard/crdt';
import type { Message, PresenceState } from './messages';
import type { StampedOp } from './ops';
import { emptyStore, type OpStore } from './store';
import { farewell, flush, openResponder, receive, type Session } from './sync';

/**
 * The server side for one board, as pure functions: the operation store plus one session per
 * connection. Feeding it a connection's messages returns what to send to which connections, the
 * operations to persist and the connections to close. Relaying is `flush`: whenever new operations
 * arrive, every other ready session is sent exactly the operations it lacks, which never includes
 * the operations it sent itself.
 *
 * Presence is relayed the same way but is never stored with the operations. The room only remembers
 * the latest state of each replica that is here, so that a client that joins late is told who is
 * on the board at once; the memory is dropped when the replica leaves. A client that goes silent
 * without leaving is the clients' business: they expire what they have not heard of.
 */
export interface Room {
  readonly serverId: ReplicaId;
  readonly boardId: string;
  readonly store: OpStore;
  /** Sessions by connection id; the transport chooses the ids. */
  readonly sessions: ReadonlyMap<string, Session>;
  /** The latest presence of each replica that is here. In memory only. */
  readonly presence: ReadonlyMap<ReplicaId, PresenceState>;
}

export interface Outgoing {
  readonly conn: string;
  readonly message: Message;
}

export interface RoomStep {
  readonly room: Room;
  /** Messages to send, in order. */
  readonly send: readonly Outgoing[];
  /** Operations that were new to the room; persist them. */
  readonly applied: readonly StampedOp[];
  /** Connections to close once `send` has been written. */
  readonly close: readonly string[];
}

export function createRoom(options: {
  serverId: ReplicaId;
  boardId: string;
  /** Operations loaded from storage. */
  store?: OpStore;
}): Room {
  return {
    serverId: options.serverId,
    boardId: options.boardId,
    store: options.store ?? emptyStore,
    sessions: new Map(),
    presence: new Map(),
  };
}

/** Registers a new connection, which must start with a `hello`. */
export function roomConnect(room: Room, conn: string): Room {
  const sessions = new Map(room.sessions);
  sessions.set(conn, openResponder({ self: room.serverId, boardId: room.boardId }));
  return { ...room, sessions };
}

function unchanged(room: Room): RoomStep {
  return { room, send: [], applied: [], close: [] };
}

/** `message` for every ready session except the one on `except`. */
function tell(
  sessions: ReadonlyMap<string, Session>,
  except: string,
  message: Message,
): Outgoing[] {
  const outgoing: Outgoing[] = [];
  for (const [conn, session] of sessions) {
    if (conn !== except && session.phase === 'ready') outgoing.push({ conn, message });
  }
  return outgoing;
}

function without(
  presence: ReadonlyMap<ReplicaId, PresenceState>,
  replica: ReplicaId,
): ReadonlyMap<ReplicaId, PresenceState> {
  if (!presence.has(replica)) return presence;
  const next = new Map(presence);
  next.delete(replica);
  return next;
}

/** Handles a message from a connection. Messages from unknown connections are ignored. */
export function roomReceive(room: Room, conn: string, message: Message): RoomStep {
  const session = room.sessions.get(conn);
  if (session === undefined) return unchanged(room);

  const step = receive(session, room.store, message);
  const sessions = new Map(room.sessions);
  const send: Outgoing[] = step.send.map((reply) => ({ conn, message: reply }));
  const close: string[] = [];
  let presence = room.presence;
  sessions.set(conn, step.session);

  if (step.session.phase === 'closed') {
    sessions.delete(conn);
    close.push(conn);
    // A client that breaks the protocol is gone: the others hear of it like any other departure.
    const left = farewell(session);
    if (left !== null) {
      presence = without(presence, left.replicaId);
      send.push(...tell(sessions, conn, left));
    }
  } else if (session.phase === 'awaiting-hello' && step.session.phase === 'ready') {
    // The same replica coming back on a new connection replaces its old, probably dead, session.
    for (const [other, otherSession] of sessions) {
      if (other !== conn && otherSession.peer === step.session.peer) {
        sessions.delete(other);
        close.push(other);
      }
    }
    // Tell the newcomer who is here, after the replies to its hello.
    for (const [replica, state] of presence) {
      if (replica !== step.session.peer) {
        send.push({ conn, message: { type: 'presence', replicaId: replica, state } });
      }
    }
  }

  if (step.applied.length > 0) {
    for (const [other, otherSession] of sessions) {
      if (other === conn) continue;
      const flushed = flush(otherSession, step.store);
      sessions.set(other, flushed.session);
      for (const relayed of flushed.send) send.push({ conn: other, message: relayed });
    }
  }

  if (step.presence !== null) {
    const { replicaId: replica, state } = step.presence;
    presence = state === null ? without(presence, replica) : new Map(presence).set(replica, state);
    send.push(...tell(sessions, conn, step.presence));
  }

  return {
    room: { ...room, store: step.store, sessions, presence },
    send,
    applied: step.applied,
    close,
  };
}

/** Forgets a connection that ended and tells the others the replica left. */
export function roomDisconnect(room: Room, conn: string): RoomStep {
  const session = room.sessions.get(conn);
  if (session === undefined) return unchanged(room);
  const sessions = new Map(room.sessions);
  sessions.delete(conn);
  const left = farewell(session);
  if (left === null) return { room: { ...room, sessions }, send: [], applied: [], close: [] };
  return {
    room: { ...room, sessions, presence: without(room.presence, left.replicaId) },
    send: tell(sessions, conn, left),
    applied: [],
    close: [],
  };
}
