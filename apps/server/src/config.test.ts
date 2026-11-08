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
      maxNoteNodes: 100_000,
      rateLimits: {
        messages: { burst: 1000, perSecond: 200 },
        ops: { burst: 200_000, perSecond: 10_000 },
      },
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
      DRIFTBOARD_RATE_MESSAGE_BURST: '0',
      DRIFTBOARD_RATE_MESSAGES_PER_SECOND: '50',
      DRIFTBOARD_RATE_OP_BURST: '5000',
      DRIFTBOARD_RATE_OPS_PER_SECOND: '100',
      DRIFTBOARD_MAX_NOTE_NODES: '2000',
    });
    expect(config).toEqual({
      host: '::1',
      port: 22111,
      dbPath: '/x/y.sqlite',
      maxMessageBytes: 4096,
      compactAfterOps: 0,
      compactIntervalMs: 60_000,
      helloTimeoutMs: 500,
      maxNoteNodes: 2000,
      rateLimits: {
        messages: { burst: 0, perSecond: 50 },
        ops: { burst: 5000, perSecond: 100 },
      },
    });
  });

  it('serves no files unless it is told where the built web app is', () => {
    expect(loadConfig({}).staticDir).toBeUndefined();
    expect(loadConfig({ DRIFTBOARD_STATIC_DIR: '' }).staticDir).toBeUndefined();
    expect(loadConfig({ DRIFTBOARD_STATIC_DIR: '../web/dist' }).staticDir).toBe('../web/dist');
  });

  it('rejects values that are not valid', () => {
    expect(() => loadConfig({ DRIFTBOARD_PORT: 'abc' })).toThrow(/DRIFTBOARD_PORT/);
    expect(() => loadConfig({ DRIFTBOARD_PORT: '70000' })).toThrow(/DRIFTBOARD_PORT/);
    expect(() => loadConfig({ DRIFTBOARD_PORT: '' })).toThrow(/DRIFTBOARD_PORT/);
    expect(() => loadConfig({ DRIFTBOARD_MAX_MESSAGE_BYTES: '10' })).toThrow(/MAX_MESSAGE_BYTES/);
    expect(() => loadConfig({ DRIFTBOARD_COMPACT_AFTER_OPS: '-1' })).toThrow(/COMPACT_AFTER_OPS/);
    expect(() => loadConfig({ DRIFTBOARD_HELLO_TIMEOUT_MS: '1.5' })).toThrow(/HELLO_TIMEOUT_MS/);
    expect(() => loadConfig({ DRIFTBOARD_RATE_OPS_PER_SECOND: '0' })).toThrow(/OPS_PER_SECOND/);
    expect(() => loadConfig({ DRIFTBOARD_RATE_MESSAGE_BURST: '-5' })).toThrow(/MESSAGE_BURST/);
    expect(() => loadConfig({ DRIFTBOARD_MAX_NOTE_NODES: '0' })).toThrow(/MAX_NOTE_NODES/);
    // More than the clients accept would make them disagree about which characters they hold.
    expect(() => loadConfig({ DRIFTBOARD_MAX_NOTE_NODES: '100001' })).toThrow(/clients accept/);
    expect(loadConfig({ DRIFTBOARD_MAX_NOTE_NODES: '100000' }).maxNoteNodes).toBe(100_000);
  });
});
