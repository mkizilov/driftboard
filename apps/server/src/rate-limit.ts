/**
 * A token bucket: `burst` tokens to start with, refilled at `perSecond`, never above `burst`. Each
 * thing a connection sends costs tokens, and a connection that cannot pay has sent too much.
 */
export class TokenBucket {
  readonly #burst: number;
  readonly #perSecond: number;
  readonly #now: () => number;
  #tokens: number;
  #last: number;

  constructor(limit: RateLimit, now: () => number) {
    this.#burst = limit.burst;
    this.#perSecond = limit.perSecond;
    this.#now = now;
    this.#tokens = limit.burst;
    this.#last = now();
  }

  /** Pays `cost` tokens if there are that many; `false` (and nothing paid) if not. */
  take(cost = 1): boolean {
    const now = this.#now();
    const refill = ((now - this.#last) / 1000) * this.#perSecond;
    this.#tokens = Math.min(this.#burst, this.#tokens + Math.max(0, refill));
    this.#last = now;
    if (cost > this.#tokens) return false;
    this.#tokens -= cost;
    return true;
  }
}

export interface RateLimit {
  /** What a connection may send at once; 0 turns this limit off. */
  readonly burst: number;
  /** What it may send per second, over time. */
  readonly perSecond: number;
}

/** What one connection may send. */
export interface RateLimits {
  /** Messages of any kind. */
  readonly messages: RateLimit;
  /** Operations, which cost more to apply than a message costs to read. */
  readonly ops: RateLimit;
}

/**
 * Honest clients send at most about 20 presence updates a second and a message per keystroke, and a
 * long time offline comes as a burst of messages of 500 operations each. These leave several times
 * that room and still stop a flood within a second.
 */
export const DEFAULT_RATE_LIMITS: RateLimits = {
  messages: { burst: 1000, perSecond: 200 },
  ops: { burst: 200_000, perSecond: 10_000 },
};

/** A bucket for `limit`, or `undefined` if the limit is off. */
export function bucketFor(limit: RateLimit, now: () => number): TokenBucket | undefined {
  return limit.burst > 0 ? new TokenBucket(limit, now) : undefined;
}
