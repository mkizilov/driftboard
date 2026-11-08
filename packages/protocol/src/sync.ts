import { VersionVector, type BoardOp, type ReplicaId } from '@driftboard/crdt';
import { MAX_ERROR_MESSAGE_LENGTH, MAX_OPS_PER_MESSAGE, PROTOCOL_VERSION } from './constants';
import type { ErrorCode, ErrorMessage, Hello, Message, Ops, Presence } from './messages';
import { canonicalizeOp, stampOps, type StampedOp } from './ops';
import { storeAdd, storeMissing, storeVector, type OpStore } from './store';

/**
 * Sync logic for one connection, as pure functions: every function takes the current state and
 * returns the next one together with the messages to send and the operations that are new to
 * the application. Nothing here sends, stores or times anything.
 *
 * How it works. Every operation is stamped when its author creates it with `(origin, seq)`; an
 * origin's operations are numbered 1, 2, 3, ... so a version vector (`origin -> count`) says
 * exactly which operations a replica holds. A session keeps `sent`: what the peer is known to
 * hold. It starts as the vector in the peer's `hello`, and grows when we send operations, when the
 * peer sends us operations, and when it acks. Whenever the store may have grown, `flush` sends the
 * operations beyond `sent` and moves `sent` forward, so nothing is sent to a peer twice on one
 * connection, and after a reconnect the new `hello` makes the peer's real holdings the starting
 * point, so exactly what was lost in flight is sent again and nothing else.
 */

export type Role = 'initiator' | 'responder';
export type Phase = 'awaiting-hello' | 'ready' | 'closed';

export interface Session {
  /** The initiator (a client) sends `hello` first; the responder (the server) answers with its own. */
  readonly role: Role;
  readonly self: ReplicaId;
  readonly boardId: string;
  readonly phase: Phase;
  /** The other side's replica id, known once its `hello` has been accepted. */
  readonly peer: ReplicaId | null;
  /** Operations the peer is known to hold, or that were sent to it on this connection. */
  readonly sent: VersionVector;
  /** Operations the peer has confirmed holding. */
  readonly acked: VersionVector;
}

export interface SessionStep {
  readonly session: Session;
  readonly store: OpStore;
  /** Messages to send to the peer, in order. */
  readonly send: readonly Message[];
  /** Operations that were new to the store; apply them to the board. */
  readonly applied: readonly StampedOp[];
  /** A presence update from the peer. */
  readonly presence: Presence | null;
  /** Set when the peer reported an error; the session is closed. */
  readonly peerError: ErrorMessage | null;
}

export function errorMessage(code: ErrorCode, message: string): ErrorMessage {
  return { type: 'error', code, message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH) };
}

export function vectorToWire(vector: VersionVector): [ReplicaId, number][] {
  return vector.entries();
}

export function vectorFromWire(entries: readonly (readonly [ReplicaId, number])[]): VersionVector {
  return VersionVector.from(entries);
}

function vectorOfOps(ops: readonly { origin: ReplicaId; seq: number }[]): VersionVector {
  return VersionVector.from(ops.map((op) => [op.origin, op.seq] as const));
}

export function helloMessage(self: ReplicaId, boardId: string, store: OpStore): Hello {
  return {
    type: 'hello',
    version: PROTOCOL_VERSION,
    replicaId: self,
    boardId,
    versionVector: vectorToWire(storeVector(store)),
  };
}

/** Starts the client side: the session waits for the server's `hello`; send `send` first. */
export function openInitiator(
  options: { self: ReplicaId; boardId: string },
  store: OpStore,
): { session: Session; send: Message[] } {
  const session: Session = {
    role: 'initiator',
    self: options.self,
    boardId: options.boardId,
    phase: 'awaiting-hello',
    peer: null,
    sent: VersionVector.empty,
    acked: VersionVector.empty,
  };
  return { session, send: [helloMessage(options.self, options.boardId, store)] };
}

/** Starts the server side of a new connection, to be fed the client's `hello`. */
export function openResponder(options: { self: ReplicaId; boardId: string }): Session {
  return {
    role: 'responder',
    self: options.self,
    boardId: options.boardId,
    phase: 'awaiting-hello',
    peer: null,
    sent: VersionVector.empty,
    acked: VersionVector.empty,
  };
}

/** Adds operations this replica just created to the store, numbering them after its own last one. */
export function authorOps(
  store: OpStore,
  origin: ReplicaId,
  ops: readonly BoardOp[],
): { store: OpStore; ops: StampedOp[] } {
  const stamped = stampOps(origin, storeVector(store).get(origin) + 1, ops);
  const result = storeAdd(store, stamped);
  if (!result.ok) throw new Error(`Invariant violated: ${result.detail}`);
  return { store: result.store, ops: stamped };
}

/** Sends the peer every operation in the store that it is not known to hold. */
export function flush(
  session: Session,
  store: OpStore,
): { session: Session; send: Message[] } {
  if (session.phase !== 'ready') return { session, send: [] };
  const missing = storeMissing(store, session.sent);
  if (missing.length === 0) return { session, send: [] };
  const send: Message[] = [];
  for (let start = 0; start < missing.length; start += MAX_OPS_PER_MESSAGE) {
    send.push({ type: 'ops', ops: missing.slice(start, start + MAX_OPS_PER_MESSAGE) });
  }
  return { session: { ...session, sent: session.sent.merge(storeVector(store)) }, send };
}

/** Nothing left to send, and the peer has confirmed holding everything this side holds. */
export function isSynced(session: Session, store: OpStore): boolean {
  return (
    session.phase === 'ready' &&
    storeMissing(store, session.sent).length === 0 &&
    storeMissing(store, session.acked).length === 0
  );
}

/** What the server tells the others when this client's connection ends. */
export function farewell(session: Session): Presence | null {
  if (session.role !== 'responder' || session.phase !== 'ready' || session.peer === null) {
    return null;
  }
  return { type: 'presence', replicaId: session.peer, state: null };
}

function idle(session: Session, store: OpStore): SessionStep {
  return { session, store, send: [], applied: [], presence: null, peerError: null };
}

/** A protocol violation: answer with an error and close the session. */
function violation(session: Session, store: OpStore, code: ErrorCode, text: string): SessionStep {
  return {
    ...idle({ ...session, phase: 'closed' }, store),
    send: [errorMessage(code, text)],
  };
}

function onHello(session: Session, store: OpStore, message: Hello): SessionStep {
  // A repeated hello (the network may deliver a message twice) must not trigger a second reply.
  if (session.phase !== 'awaiting-hello') return idle(session, store);
  if (message.version !== PROTOCOL_VERSION) {
    const text = `protocol version ${PROTOCOL_VERSION} required`;
    return violation(session, store, 'unsupported_version', text);
  }
  if (message.boardId !== session.boardId) {
    return violation(session, store, 'wrong_board', 'hello is for another board');
  }
  if (message.replicaId === session.self) {
    return violation(session, store, 'invalid_message', 'replica id is already in use here');
  }
  const known = vectorFromWire(message.versionVector);
  const ready: Session = {
    ...session,
    phase: 'ready',
    peer: message.replicaId,
    sent: known,
    acked: known,
  };
  const reply =
    session.role === 'responder' ? [helloMessage(session.self, session.boardId, store)] : [];
  const flushed = flush(ready, store);
  return { ...idle(flushed.session, store), send: [...reply, ...flushed.send] };
}

function onOps(session: Session, store: OpStore, message: Ops): SessionStep {
  if (session.phase !== 'ready') {
    return violation(session, store, 'unexpected_message', 'ops before hello');
  }
  const stamped: StampedOp[] = [];
  for (const wire of message.ops) {
    try {
      stamped.push({ origin: wire.origin, seq: wire.seq, op: canonicalizeOp(wire.op) });
    } catch {
      const text = `operation ${wire.seq} from ${wire.origin} is not a valid board operation`;
      return violation(session, store, 'invalid_message', text);
    }
  }
  const result = storeAdd(store, stamped);
  if (!result.ok) {
    const code = result.reason === 'gap' ? 'out_of_order' : 'conflicting_op';
    return violation(session, store, code, result.detail);
  }
  // Whatever the peer sent, it holds: never send it back, new or not, and count it as confirmed.
  const held = vectorOfOps(stamped);
  const next: Session = {
    ...session,
    sent: session.sent.merge(held),
    acked: session.acked.merge(held),
  };
  const ack: Message[] =
    result.added.length > 0
      ? [{ type: 'ack', versionVector: vectorToWire(storeVector(result.store)) }]
      : [];
  return { ...idle(next, result.store), send: ack, applied: result.added };
}

/**
 * Handles one message from the peer. Callers must call `flush` for every *other* session that
 * shares the store when `applied` is not empty (the server relays that way, see `room.ts`).
 */
export function receive(session: Session, store: OpStore, message: Message): SessionStep {
  if (session.phase === 'closed') return idle(session, store);
  switch (message.type) {
    case 'hello':
      return onHello(session, store, message);
    case 'ops':
      return onOps(session, store, message);
    case 'ack': {
      if (session.phase !== 'ready') {
        return violation(session, store, 'unexpected_message', 'ack before hello');
      }
      const known = vectorFromWire(message.versionVector);
      const next: Session = {
        ...session,
        acked: session.acked.merge(known),
        sent: session.sent.merge(known),
      };
      return idle(next, store);
    }
    case 'presence': {
      if (session.phase !== 'ready') {
        return violation(session, store, 'unexpected_message', 'presence before hello');
      }
      // A client may only speak for itself; the server relays other replicas' presence to clients.
      if (session.role === 'responder' && message.replicaId !== session.peer) {
        return violation(session, store, 'invalid_message', 'presence for another replica');
      }
      if (message.replicaId === session.self) return idle(session, store);
      return { ...idle(session, store), presence: message };
    }
    case 'error':
      return { ...idle({ ...session, phase: 'closed' }, store), peerError: message };
  }
}
