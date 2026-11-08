import type { ReplicaId } from '@driftboard/crdt';
import type { Message } from './messages';
import type { StampedOp } from './ops';
import { emptyStore, type OpStore } from './store';
import { farewell, flush, openResponder, receive, type Session } from './sync';

/**
 * The server side for one board, as pure functions: the operation store plus one session per
 * connection. Feeding it a connection's messages returns what to send to which connections, the
 * operations to persist and the connections to close. Relaying is `flush`: whenever new operations
 * arrive, every other ready session is sent exactly the operations it lacks, which never includes
 * the operations it sent itself.
 */
export interface Room {
  readonly serverId: ReplicaId;
  readonly boardId: string;
  readonly store: OpStore;
  /** Sessions by connection id; the transport chooses the ids. */
  readonly sessions: ReadonlyMap<string, Session>;
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

/** Handles a message from a connection. Messages from unknown connections are ignored. */
export function roomReceive(room: Room, conn: string, message: Message): RoomStep {
  const session = room.sessions.get(conn);
  if (session === undefined) return unchanged(room);

  const step = receive(session, room.store, message);
  const sessions = new Map(room.sessions);
  const send: Outgoing[] = step.send.map((reply) => ({ conn, message: reply }));
  const close: string[] = [];
  sessions.set(conn, step.session);

  if (step.session.phase === 'closed') {
    sessions.delete(conn);
    close.push(conn);
  } else if (session.phase === 'awaiting-hello' && step.session.phase === 'ready') {
    // The same replica coming back on a new connection replaces its old, probably dead, session.
    for (const [other, otherSession] of sessions) {
      if (other !== conn && otherSession.peer === step.session.peer) {
        sessions.delete(other);
        close.push(other);
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
    for (const [other, otherSession] of sessions) {
      if (other !== conn && otherSession.phase === 'ready') {
        send.push({ conn: other, message: step.presence });
      }
    }
  }

  return {
    room: { ...room, store: step.store, sessions },
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
  const send: Outgoing[] = [];
  if (left !== null) {
    for (const [other, otherSession] of sessions) {
      if (otherSession.phase === 'ready') send.push({ conn: other, message: left });
    }
  }
  return { room: { ...room, sessions }, send, applied: [], close: [] };
}
