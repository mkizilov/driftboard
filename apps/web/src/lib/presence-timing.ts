/** Most presence updates a client sends per second. */
export const MAX_UPDATES_PER_SECOND = 20;

/** The shortest time between two presence messages: 50 ms. */
export const MIN_INTERVAL_MS = 1000 / MAX_UPDATES_PER_SECOND;

/**
 * How long a client may stay quiet before it repeats its presence anyway. Someone who is not moving
 * sends nothing new, and the others could not tell that from someone who has gone, so the state is
 * sent again every two seconds. A client that connects late also learns of them this way if the
 * server's snapshot was missed.
 */
export const HEARTBEAT_MS = 2000;

/**
 * How long without a word from someone before they are dropped from the board. It has to be
 * several heartbeats, so that one lost or late message does not make a person flicker away: this
 * is three.
 */
export const PEER_TIMEOUT_MS = 6000;
