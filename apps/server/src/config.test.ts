import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('defaults to loopback, port 22100, a database under the repo .data directory and safe limits', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 22100,
      maxMessageBytes: 1_048_576,
      compactAfterOps: 1000,
      compactIntervalMs: 300_000,
      helloTimeoutMs: 10_000,
    });
    expect(config.dbPath).toMatch(/\/\.data\/driftboard\.sqlite$/);
  });

  it('honours overrides', () => {
    const config = loadConfig({
      DRIFTBOARD_HOST: '::1',
      DRIFTBOARD_PORT: '22111',
      DRIFTBOARD_DB: '/x/y.sqlite',
      DRIFTBOARD_MAX_MESSAGE_BYTES: '4096',
      DRIFTBOARD_COMPACT_AFTER_OPS: '0',
      DRIFTBOARD_COMPACT_INTERVAL_MS: '60000',
      DRIFTBOARD_HELLO_TIMEOUT_MS: '500',
    });
    expect(config).toEqual({
      host: '::1',
      port: 22111,
      dbPath: '/x/y.sqlite',
      maxMessageBytes: 4096,
      compactAfterOps: 0,
      compactIntervalMs: 60_000,
      helloTimeoutMs: 500,
    });
  });

  it('rejects values that are not valid', () => {
    expect(() => loadConfig({ DRIFTBOARD_PORT: 'abc' })).toThrow(/DRIFTBOARD_PORT/);
    expect(() => loadConfig({ DRIFTBOARD_PORT: '70000' })).toThrow(/DRIFTBOARD_PORT/);
    expect(() => loadConfig({ DRIFTBOARD_PORT: '' })).toThrow(/DRIFTBOARD_PORT/);
    expect(() => loadConfig({ DRIFTBOARD_MAX_MESSAGE_BYTES: '10' })).toThrow(/MAX_MESSAGE_BYTES/);
    expect(() => loadConfig({ DRIFTBOARD_COMPACT_AFTER_OPS: '-1' })).toThrow(/COMPACT_AFTER_OPS/);
    expect(() => loadConfig({ DRIFTBOARD_HELLO_TIMEOUT_MS: '1.5' })).toThrow(/HELLO_TIMEOUT_MS/);
  });
});
