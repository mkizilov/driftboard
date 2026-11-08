export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface PollOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/**
 * Calls `read` until it gives something other than `undefined`, and returns that. Throws, saying
 * what was being waited for, if that does not happen in time.
 */
export async function pollUntil<T>(
  what: string,
  read: () => Promise<T | undefined>,
  { timeoutMs = 10_000, intervalMs = 50 }: PollOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline)
      throw new Error(`Gave up waiting for ${what} after ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}
