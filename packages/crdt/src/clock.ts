/** Source of wall-clock time in milliseconds. Always injected; the library never reads the system clock. */
export interface Clock {
  now(): number;
}

export interface ManualClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

/** Deterministic clock for tests and simulations. */
export function createManualClock(startMs = 0): ManualClock {
  let current = startMs;
  return {
    now: () => current,
    set: (ms) => {
      current = ms;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}
