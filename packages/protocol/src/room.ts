import { MAX_NOTE_NODES, type ReplicaId } from '@driftboard/crdt';
import { ledgerAdd, ledgerOf, type NoteLedger } from './ledger';
import type { Message, PresenceState } from './messages';
import type { StampedOp } from './ops';
import { emptyStore, type OpStore } from './store';
import {
  farewell,
  flush,
  openResponder,
  receive,
  violation,
  type Session,
  type SessionStep,
} from './sync';

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
 *
 * The room is also where the board as a whole is held to its limits (see `ledger.ts`): text only
 * for notes that exist, and no note's text beyond `maxNoteNodes` characters. A client that goes
 * past them is treated like one that breaks the protocol.
 *
 * A client may send operations of replicas other than its own: every page load is a new replica, and
 * what an earlier one made and could not send is sent by the next. The server cannot tell whose
 * device that is, but it can refuse operations in the name of a replica that is connected right now,
 * which speaks for itself.
 */
export interface Room {
  readonly serverId: ReplicaId;
  readonly boardId: string;
  readonly store: OpStore;
  /** Sessions by connection id; the transport chooses the ids. */
  readonly sessions: ReadonlyMap<string, Session>;
  /** The latest presence of each replica that is here. In memory only. */
  readonly presence: ReadonlyMap<ReplicaId, PresenceState>;
  /** How big each note's text is; see `ledger.ts`. */
  readonly notes: NoteLedger;
  /** The most characters one note's text may hold. */
  readonly maxNoteNodes: number;
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
  /** Defaults to `MAX_NOTE_NODES`. */
  maxNoteNodes?: number;
}): Room {
  const store = options.store ?? emptyStore;
  return {
    serverId: options.serverId,
    boardId: options.boardId,
    store,
    sessions: new Map(),
    presence: new Map(),
    notes: ledgerOf(store),
    maxNoteNodes: options.maxNoteNodes ?? MAX_NOTE_NODES,
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

/**
 * A refusal if `message` is a `hello` that wants the place of a replica that another connection
 * holds, without the secret that connection said when it came. A reconnect of the same replica
 * (which knows it) still replaces its old connection, which is probably dead; one that only knows
 * the replica id does not push anyone off. A replica that came without a secret can be replaced by
 * anyone, as before.
 */
function takeover(
  room: Room,
  conn: string,
  session: Session,
  message: Message,
): SessionStep | undefined {
  if (message.type !== 'hello' || session.phase !== 'awaiting-hello') return undefined;
  for (const [other, theirs] of room.sessions) {
    if (other === conn || theirs.peer !== message.replicaId) continue;
    if (theirs.peerToken !== null && theirs.peerToken !== (message.token ?? null)) {
      return violation(session, room.store, 'invalid_message', 'the replica id is in use');
    }
  }
  return undefined;
}

/** A refusal if `message` writes in the name of a replica that another connection speaks for. */
function impersonation(
  room: Room,
  conn: string,
  session: Session,
  message: Message,
): SessionStep | undefined {
  if (message.type !== 'ops' || session.phase !== 'ready') return undefined;
  const connected = new Set<ReplicaId>();
  for (const [other, theirs] of room.sessions) {
    if (other !== conn && theirs.peer !== null) connected.add(theirs.peer);
  }
  const forged = message.ops.find((op) => op.origin !== session.peer && connected.has(op.origin));
  if (forged === undefined) return undefined;
  const text = `operation ${forged.seq} is in the name of ${forged.origin}, who is connected`;
  return violation(session, room.store, 'invalid_message', text);
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

  let step =
    takeover(room, conn, session, message) ??
    impersonation(room, conn, session, message) ??
    receive(session, room.store, message);
  let notes = room.notes;
  if (step.applied.length > 0) {
    const checked = ledgerAdd(notes, step.applied, room.maxNoteNodes);
    if (checked.ok) notes = checked.ledger;
    else step = violation(session, room.store, 'invalid_message', checked.detail);
  }
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
    room: { ...room, store: step.store, sessions, presence, notes },
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
