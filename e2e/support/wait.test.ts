import { describe, expect, it } from 'vitest';
import { pollUntil, sleep } from './wait';

describe('sleep', () => {
  it('waits about as long as it is told', async () => {
    const before = Date.now();
    await sleep(60);
    expect(Date.now() - before).toBeGreaterThanOrEqual(50);
  });
});

describe('pollUntil', () => {
  it('returns at once what the first read gives', async () => {
    expect(await pollUntil('a value', () => Promise.resolve('here'))).toBe('here');
  });

  it('reads again until something other than undefined comes back', async () => {
    let reads = 0;
    const value = await pollUntil(
      'the third read',
      () => {
        reads += 1;
        return Promise.resolve(reads < 3 ? undefined : reads);
      },
      { intervalMs: 1 },
    );
    expect(value).toBe(3);
    expect(reads).toBe(3);
  });

  it('counts falsy values other than undefined as an answer', async () => {
    expect(await pollUntil('zero', () => Promise.resolve(0))).toBe(0);
    expect(await pollUntil('empty', () => Promise.resolve(''))).toBe('');
    expect(await pollUntil('null', () => Promise.resolve(null))).toBeNull();
  });

  it('says what it waited for when time runs out', async () => {
    await expect(
      pollUntil('a note that never comes', () => Promise.resolve(undefined), {
        timeoutMs: 30,
        intervalMs: 5,
      }),
    ).rejects.toThrow('a note that never comes after 30 ms');
  });

  it('does not read again once it has an answer', async () => {
    let reads = 0;
    await pollUntil('one read', () => {
      reads += 1;
      return Promise.resolve(true);
    });
    await sleep(20);
    expect(reads).toBe(1);
  });

  it('passes on an error from a read', async () => {
    await expect(
      pollUntil('anything', () => Promise.reject(new Error('the page is gone'))),
    ).rejects.toThrow('the page is gone');
  });
});
